//! `NativeHost`: the engine's [`Host`] over the real OS.

use std::{
	hash::{BuildHasher, RandomState},
	io::{self, IsTerminal, Write},
	task::{Context, Poll},
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use bstr::{BStr, BString, ByteSlice};
#[cfg(unix)]
use pi_shell::bash::CpuTimes;
use pi_shell::{
	bash::{
		ControlHandle, Deadline, Event, ExitStatus, ExtProc, File, Fs, IntrinsicId, Invocation,
		ModeId, NativeRef, ResolveCtx, Resolved, Rlimit, SpawnFuture, SpawnSpec, StdFd,
		SystemTimeLike, Task, Timer, TtyInfo, UserInfo, Verdict, Vpid,
	},
	sys::{Exits, NativeSpawner, Sessions, SpawnConfig, StdFs, std_stream},
};

use crate::{pending_fs::PendingFs, signals::Signals, timer::Timers};

/// The real OS as the engine's host: `std::fs`, the process-group spawner,
/// the process's own stdio, and an optional JSON-lines event sink.
pub struct NativeHost {
	/// `StdFs`, or `PendingFs<StdFs>` under `PI_SHELL_FS=pending`.
	fs:        Box<dyn Fs>,
	spawner:   NativeSpawner,
	events:    Option<Box<dyn Write>>,
	start:     Instant,
	random:    RandomState,
	draws:     u64,
	timers:    Timers,
	signals:   Signals,
	/// Inherited fds above 2, handed to the shell once at creation.
	inherited: Vec<(i32, Box<dyn File>)>,
	/// Signals ignored when the first process of this shell started; a
	/// process the fault injector re-executes inherits `trap ''`
	/// dispositions too, so it takes the set over instead of asking the OS.
	ignored:   pi_shell::bash::SigSet,
	/// [`pi_shell::bash::Host::user`], read once: the ids, groups and the
	/// process's `USER`/`HOME` never change in obash (a startup asked for it
	/// five times: 20 id and `getgroups` syscalls).
	user:      std::cell::OnceCell<UserInfo>,
	/// The shell caught OS signals go to ([`Self::bind_signals`]): every
	/// external this host spawns hands them over when its exit is observed.
	bridge:    Option<(ControlHandle, Vpid)>,
}

impl NativeHost {
	/// Host writing events as JSON lines to `events`, if given; with
	/// `pending_fs` every fs operation answers `Pending` before completing;
	/// `inherited` are the process's open fds above 2 ([`inherited_fds`]);
	/// `ignored` the signals ignored on entry ([`ignored_on_entry`], or the
	/// first process's set after a fault-injector re-exec); the clock starts
	/// at `elapsed_ns` (non-zero when a re-executed process continues a
	/// shell, so deadlines and `$SECONDS` carry on).
	///
	/// Called once during process startup, before any worker threads exist:
	/// the process mask can therefore be read by setting and restoring it.
	#[cfg_attr(
		not(unix),
		expect(
			clippy::default_constructed_unit_structs,
			reason = "`Signals` (and the spawner) are unit structs off Unix and stateful on Unix"
		)
	)]
	pub fn new(
		events: Option<Box<dyn Write>>,
		pending_fs: bool,
		inherited: Vec<(i32, Box<dyn File>)>,
		ignored: pi_shell::bash::SigSet,
		elapsed_ns: u64,
	) -> Self {
		// Unlike an embedded host, this standalone process is still
		// single-threaded here, and nothing in it changes the mask later:
		// read and restore it directly rather than forking a helper.
		#[cfg(unix)]
		// SAFETY: umask has no preconditions; nothing can create files
		// concurrently before this host starts its workers.
		let umask = Some(unsafe {
			let mask = libc::umask(0);
			libc::umask(mask);
			mask as u32
		});
		#[cfg(not(unix))]
		let umask = None;
		let std_fs = StdFs { umask };
		let fs: Box<dyn Fs> = if pending_fs {
			Box::new(PendingFs(std_fs))
		} else {
			Box::new(std_fs)
		};
		Self {
			fs,
			// A non-interactive bash keeps its children in its own process
			// group and session (they share its terminal: `read < /dev/tty`
			// in a nested shell works). The drive loop parks in a `Parker`,
			// which waits for the exits itself (Linux).
			spawner: NativeSpawner::new(SpawnConfig {
				sessions: Sessions::Inherit,
				exits: Exits::Park,
				#[cfg(unix)]
				umask,
				..SpawnConfig::default()
			}),
			events,
			start: Instant::now()
				.checked_sub(Duration::from_nanos(elapsed_ns))
				.unwrap_or_else(Instant::now),
			random: RandomState::new(),
			draws: 0,
			timers: Timers::default(),
			signals: Signals::default(),
			inherited,
			ignored,
			user: std::cell::OnceCell::new(),
			bridge: None,
		}
	}

	/// Deliver the OS signals caught before an external's exit to the root
	/// vproc `root` of the shell `ctl` controls as soon as the engine
	/// observes that exit, before the command after it runs. bash handles a
	/// signal that arrived while it waited for a foreground child before
	/// its next command; obash's run loop forwards caught signals only
	/// between steps, and a step that reaps the child would otherwise run
	/// on into the next command first (`/bin/kill -USR1 $$; echo after`
	/// printed `after` without the trap's output). Called by `main` and
	/// the fault injector right after `Shell::create` / `Shell::restore`;
	/// externals spawned for an earlier shell keep its handle.
	pub fn bind_signals(&mut self, ctl: ControlHandle, root: Vpid) {
		self.bridge = Some((ctl, root));
	}

	/// The signals ignored on entry this host reports
	/// ([`pi_shell::bash::Host::ignored_signals`]); the fault injector passes
	/// them to the process it re-executes (Unix only).
	#[cfg(unix)]
	pub const fn entry_ignored(&self) -> pi_shell::bash::SigSet {
		self.ignored
	}

	/// Forward OS signals captured by active traps to the root vproc.
	#[cfg_attr(
		not(unix),
		expect(clippy::missing_const_for_fn, reason = "the Unix version drains an atomic")
	)]
	pub fn dispatch_signals(ctl: &pi_shell::bash::ControlHandle, root: pi_shell::bash::Vpid) {
		Signals::dispatch(ctl, root);
	}

	/// Flush the event sink.
	pub fn flush(&mut self) -> io::Result<()> {
		self.events.as_mut().map_or(Ok(()), |w| w.flush())
	}
}

impl pi_shell::bash::Host for NativeHost {
	fn resolve(&mut self, name: &BStr, mode: ModeId, why: ResolveCtx<'_>) -> Resolved {
		if why.has_slash {
			return Resolved::NotFound;
		}
		IntrinsicId::lookup(name, mode).map_or(Resolved::NotFound, Resolved::Intrinsic)
	}

	fn start(&mut self, _cmd: &NativeRef, _inv: Invocation<'_>) -> io::Result<Box<dyn Task>> {
		Err(io::ErrorKind::Unsupported.into())
	}

	fn restore_task(&mut self, _cmd: &NativeRef, _state: &[u8]) -> io::Result<Box<dyn Task>> {
		Err(io::ErrorKind::Unsupported.into())
	}

	/// Launches at once (a local process, no I/O to wait for): the future is
	/// already complete.
	fn spawn(&mut self, spec: SpawnSpec<'_>) -> SpawnFuture {
		let spawned = self.spawner.spawn(spec).map(|child| -> Box<dyn ExtProc> {
			match &self.bridge {
				Some((ctl, root)) => Box::new(SignalsOnExit { child, ctl: ctl.clone(), root: *root }),
				None => child,
			}
		});
		Box::pin(std::future::ready(spawned))
	}

	/// Unix spawns fork: the child opens any path of the host's filesystem.
	fn child_opens(&mut self, _path: &BStr) -> bool {
		cfg!(unix)
	}

	fn signal_process(
		&mut self,
		pid: i32,
		signal: Option<pi_shell::bash::Signal>,
	) -> io::Result<()> {
		#[cfg(unix)]
		{
			let number =
				signal.map_or(0, |sig| i32::from(sig.number(pi_shell::bash::Platform::current())));
			// SAFETY: kill accepts integer process and signal numbers.
			if unsafe { libc::kill(pid, number) } == 0 {
				Ok(())
			} else {
				Err(io::Error::last_os_error())
			}
		}
		#[cfg(not(unix))]
		{
			let _ = (pid, signal);
			Err(io::ErrorKind::Unsupported.into())
		}
	}

	fn ignored_signals(&self) -> pi_shell::bash::SigSet {
		self.ignored
	}

	fn set_signal_trap(
		&mut self,
		signal: pi_shell::bash::Signal,
		action: Option<&BStr>,
	) -> io::Result<bool> {
		self.signals.set(signal, action)
	}

	fn fs(&mut self) -> &mut dyn Fs {
		&mut *self.fs
	}

	fn stdio(&mut self, fd: StdFd) -> Option<Box<dyn File>> {
		std_stream(fd)
	}

	fn now_ns(&self) -> u64 {
		self.start.elapsed().as_nanos() as u64
	}

	fn timer(&mut self, at: Deadline) -> Box<dyn Timer> {
		self.timers.arm(self.start + Duration::from_nanos(at.0))
	}

	fn wall(&self) -> SystemTimeLike {
		let d = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap_or_default();
		SystemTimeLike { secs: d.as_secs() as i64, nanos: d.subsec_nanos() }
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
			unsafe { libc::getppid() as u32 }
		}
		#[cfg(not(unix))]
		0
	}

	fn user(&self) -> UserInfo {
		self.user.get_or_init(read_user).clone()
	}

	fn login_shell(&self) -> Option<BString> {
		read_login_shell()
	}

	fn login_shell_initializer(&self) -> Option<fn() -> Option<BString>> {
		Some(read_login_shell)
	}

	fn umask(&self) -> u32 {
		// The spawner read it at creation: externals then match the process
		// mask and take the `posix_spawn` path.
		self.spawner.umask().unwrap_or(0o022)
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

	fn tty(&mut self, fd: i32) -> Option<TtyInfo> {
		let is_tty = match fd {
			0 => io::stdin().is_terminal(),
			1 => io::stdout().is_terminal(),
			2 => io::stderr().is_terminal(),
			_ => false,
		};
		if !is_tty {
			return None;
		}
		#[cfg(unix)]
		{
			let mut ws = libc::winsize { ws_row: 0, ws_col: 0, ws_xpixel: 0, ws_ypixel: 0 };
			// SAFETY: TIOCGWINSZ writes one `winsize` into the valid pointer.
			if unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &raw mut ws) } == 0 {
				return Some(TtyInfo { rows: ws.ws_row, cols: ws.ws_col });
			}
		}
		Some(TtyInfo { rows: 24, cols: 80 })
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

	fn inherited_fds(&mut self) -> Vec<(i32, Box<dyn File>)> {
		std::mem::take(&mut self.inherited)
	}

	fn rlimit(&self, res: Rlimit) -> io::Result<(Option<u64>, Option<u64>)> {
		pi_shell::sys::rlimit::get(res)
	}

	#[cfg(unix)]
	fn cpu_times(&self) -> io::Result<CpuTimes> {
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
		Ok(CpuTimes { user_ns, sys_ns, child_user_ns, child_sys_ns })
	}

	fn event(&mut self, ev: &Event<'_>) -> Verdict {
		if let Some(w) = self.events.as_mut() {
			// A broken event sink must not change what the script does.
			let _ = serde_json::to_writer(&mut *w, ev)
				.map_err(io::Error::from)
				.and_then(|()| w.write_all(b"\n"));
		}
		Verdict::Continue
	}
}

/// An external spawned by a [`NativeHost`] bound to a shell
/// ([`NativeHost::bind_signals`]): when its exit is observed, the OS signals
/// caught until then reach the shell's control first, so the engine (which
/// checks the control word before every op) handles them before the next
/// command. A signal the child sent to the shell before exiting is pending
/// in this process by then: the handler runs before the call that observed
/// the exit returns.
struct SignalsOnExit {
	child: Box<dyn ExtProc>,
	ctl:   ControlHandle,
	root:  Vpid,
}

impl ExtProc for SignalsOnExit {
	fn pid(&self) -> u32 {
		self.child.pid()
	}

	fn poll_wait(&mut self, cx: &mut Context<'_>) -> Poll<ExitStatus> {
		let status = std::task::ready!(self.child.poll_wait(cx));
		Signals::dispatch(&self.ctl, self.root);
		Poll::Ready(status)
	}

	fn signal(&mut self, sig: pi_shell::bash::Signal) -> io::Result<()> {
		self.child.signal(sig)
	}

	fn stop(&mut self) -> io::Result<()> {
		self.child.stop()
	}

	fn cont(&mut self) -> io::Result<()> {
		self.child.cont()
	}
}

/// The signals this process ignores now: call at startup, before any trap,
/// for the set [`NativeHost::new`] reports as ignored on entry.
#[cfg_attr(
	not(unix),
	expect(clippy::missing_const_for_fn, reason = "the Unix version queries sigaction")
)]
pub fn ignored_on_entry() -> pi_shell::bash::SigSet {
	Signals::ignored()
}

/// The open fds above 2 this process inherited (`obash ./x 3<file`), taken
/// over as files; call before the process opens any fd of its own. They
/// become close-on-exec: the engine passes them to externals itself.
///
/// Only descriptors without close-on-exec count: `exec` closed every one
/// that had it, so such a descriptor was opened in this process before
/// `main` (by the runtime or a library loaded into it, such as cango's
/// file-access tracer, which keeps its log at fd 256 under
/// `DYLD_INSERT_LIBRARIES`). Taken over, it would be a host fd no snapshot
/// can carry, and every snapshot of the shell would be skipped.
#[cfg(unix)]
pub fn inherited_fds() -> Vec<(i32, Box<dyn File>)> {
	use std::os::fd::FromRawFd;

	let dir = if cfg!(target_os = "linux") {
		"/proc/self/fd"
	} else {
		"/dev/fd"
	};
	let Ok(entries) = std::fs::read_dir(dir) else {
		return Vec::new();
	};
	let mut fds: Vec<i32> = entries
		.filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
		.filter(|&fd| fd > 2)
		.collect();
	fds.sort_unstable();
	// The listing's own descriptor is closed by now (F_GETFD fails); one
	// with close-on-exec set is this process's own (see above).
	fds.retain(|&fd| {
		// SAFETY: F_GETFD only reads the descriptor flags.
		let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
		flags != -1 && flags & libc::FD_CLOEXEC == 0
	});
	fds.into_iter()
		.map(|fd| {
			// SAFETY: F_SETFD sets the descriptor flags; it changes no ownership.
			unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
			// SAFETY: the fd is open and inherited (close-on-exec was clear),
			// so nothing else in this process owns it.
			let file = unsafe { std::fs::File::from_raw_fd(fd) };
			(fd, Box::new(pi_shell::sys::StdFile::new(file)) as Box<dyn File>)
		})
		.collect()
}

/// No inherited fds are taken over off Unix.
#[cfg(not(unix))]
pub fn inherited_fds() -> Vec<(i32, Box<dyn File>)> {
	Vec::new()
}

fn read_login_shell() -> Option<BString> {
	#[cfg(unix)]
	{
		// SAFETY: getuid has no preconditions.
		login_shell(unsafe { libc::getuid() })
			.or_else(|| std::env::var_os("SHELL").map(|v| BString::from(v.as_encoded_bytes())))
	}
	#[cfg(not(unix))]
	std::env::var_os("SHELL").map(|v| BString::from(v.as_encoded_bytes()))
}

/// The login shell of `uid` from the password database (bash sets `SHELL`
/// from it when the environment has none).
#[cfg(unix)]
fn login_shell(uid: libc::uid_t) -> Option<BString> {
	let mut buf = vec![0u8; 4096];
	let mut pw = std::mem::MaybeUninit::<libc::passwd>::zeroed();
	let mut found: *mut libc::passwd = std::ptr::null_mut();
	// SAFETY: every pointer is valid for the call; `buf` holds the strings
	// `pw` points into and outlives their use below.
	let rc = unsafe {
		libc::getpwuid_r(uid, pw.as_mut_ptr(), buf.as_mut_ptr().cast(), buf.len(), &raw mut found)
	};
	if rc != 0 || found.is_null() {
		return None;
	}
	// SAFETY: getpwuid_r succeeded, so `pw` is initialized and `pw_shell`
	// is null or a NUL-terminated string inside `buf`.
	let shell = unsafe { pw.assume_init().pw_shell };
	if shell.is_null() {
		return None;
	}
	// SAFETY: see above.
	let bytes = unsafe { std::ffi::CStr::from_ptr(shell) }.to_bytes();
	(!bytes.is_empty()).then(|| BString::from(bytes))
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
	let name = if cfg!(windows) {
		var("USERNAME")
	} else {
		var("USER")
	};
	let home = if cfg!(windows) {
		var("USERPROFILE")
	} else {
		var("HOME")
	};
	UserInfo { uid, euid, gid, groups: groups(), name, home }
}

/// The process's supplementary group ids (`GROUPS`); empty where the
/// platform has none or `getgroups` fails.
#[cfg_attr(
	not(unix),
	expect(clippy::missing_const_for_fn, reason = "the Unix body calls getgroups")
)]
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
