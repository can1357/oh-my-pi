//! The host seam: every side effect of the engine.
//!
//! **Threading rule.** [`Host::resolve`], [`Host::start`] and
//! [`Host::restore_task`] are synchronous and must not do I/O beyond a
//! registry lookup. [`Host::spawn`] returns a [`SpawnFuture`] the engine
//! polls like any other pending operation: an immediate local launch
//! returns an already-complete future, while a spawn that must first ask a
//! provider (a remote path, a URL) awaits it without blocking the engine.
//! Anything that can touch a remote path goes through [`Fs`], [`File`] or
//! that future, none of which block. [`Task::poll`] and
//! [`ExtProc::poll_wait`] must not block either.

use std::{
	future::Future,
	io,
	pin::Pin,
	sync::Arc,
	task::{Context, Poll},
};

use bstr::{BStr, BString};
use serde::{Deserialize, Serialize};

use crate::bash::{
	event::Event,
	fd::FdRef,
	fs::{File, Fs, OpenFlags},
	ids::{CmdTag, IntrinsicId, JobId, ModeId, NativeRef, ToolRef, Vpid},
	signal::{SigSet, Signal},
};

/// A point on the host's monotonic clock ([`Host::now_ns`]), in ns.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Deadline(pub u64);

/// An armed timer ([`Host::timer`]). Dropping it cancels the timer.
pub trait Timer: Send {
	/// `Ready` once the deadline has passed; otherwise registers `cx`'s
	/// waker, which the host wakes at the deadline. Never blocks.
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<()>;
}

/// The pending launch of an external ([`Host::spawn`]).
///
/// Owned (`'static`) and [`Send`]: it holds nothing of the [`SpawnSpec`] it
/// was made from, so the engine keeps it across steps and polls it with
/// the engine's waker. The process exists only once it resolves to
/// `Ok`: dropping the future (a cancel, a suspend) before then spawns
/// nothing. An error resolves it exactly as a synchronous spawn failure
/// would (`ENOEXEC` and the other OS errors keep their meaning).
pub type SpawnFuture = Pin<Box<dyn Future<Output = io::Result<Box<dyn ExtProc>>> + Send + 'static>>;

/// Everything the engine needs from its environment.
///
/// `obash` implements it over the OS (`NativeHost`); an embedding host
/// over its tool registry, its VFS and its sandbox; the testkit with fakes.
pub trait Host {
	/// Resolve a command name before PATH search (functions and aliases are
	/// already handled by the engine).
	fn resolve(&mut self, name: &BStr, mode: ModeId, why: ResolveCtx) -> Resolved;
	/// Start a native command (Rust callout or device) as a [`Task`].
	fn start(&mut self, cmd: &NativeRef, inv: Invocation<'_>) -> io::Result<Box<dyn Task>>;
	/// Resume a task from the bytes its [`Task::checkpoint`] produced before a
	/// snapshot. An error makes the task [`Lost`](crate::bash::Lost) (status
	/// 137).
	fn restore_task(&mut self, cmd: &NativeRef, state: &[u8]) -> io::Result<Box<dyn Task>>;
	/// Spawn an external program.
	///
	/// Reads what it needs from `spec` before returning (the future cannot
	/// borrow it: owned parts such as [`StdioSpec`] are moved out, the rest
	/// copied only when the launch has to wait). The engine polls the future
	/// with its waker until the process exists, applies the result as the
	/// spawn's outcome and drops the future on a cancel or suspend before
	/// it resolved; the host must not start the process before then.
	fn spawn(&mut self, spec: SpawnSpec<'_>) -> SpawnFuture;
	/// Whether a spawned process can open `path` (absolute) itself
	/// ([`SpawnSpec::redirs`]). Asked when the open of a background job's
	/// lone external's redirection would wait (a FIFO without its other
	/// end): `true` lets the engine spawn the program at once, with its
	/// `$!` known, and leave the open to the process. The default is
	/// `false` (the engine opens it and the job waits): a host that spawns
	/// through a real `fork` opts in for the paths of its own filesystem.
	fn child_opens(&mut self, _path: &BStr) -> bool {
		false
	}
	/// Send a signal to an OS process or process group (B10). `None` probes
	/// existence and permission without delivering a signal (`kill -0`).
	/// Negative and zero targets follow the host platform's process-group
	/// semantics.
	///
	/// The `kill` builtin calls it only for pids that are not virtual
	/// processes of this shell (vprocs and jobs go over the virtual signal
	/// bus). The default denies with `Unsupported`, which `kill` reports:
	/// a sandboxing host opts in deliberately.
	fn signal_process(&mut self, _pid: i32, _signal: Option<crate::bash::Signal>) -> io::Result<()> {
		Err(io::ErrorKind::Unsupported.into())
	}
	/// Signals ignored when the shell started (B10). A non-interactive bash
	/// cannot trap them, and externals inherit them as ignored. Hosts without
	/// OS signals (08's agent shells) keep the default: none.
	fn ignored_signals(&self) -> SigSet {
		SigSet::EMPTY
	}
	/// Update the host's OS disposition for a root-shell signal trap (B10).
	/// `None` restores the original disposition, an empty action ignores the
	/// signal, and any other action catches it and delivers it through the
	/// shell's [`ControlHandle::signal`](crate::bash::ControlHandle::signal) on
	/// the virtual bus. Returns `false` when the signal was ignored on entry
	/// and cannot be changed (the trap is then recorded as ignored). Hosts
	/// without OS signals keep the default: accept and do nothing.
	fn set_signal_trap(&mut self, _signal: Signal, _action: Option<&BStr>) -> io::Result<bool> {
		Ok(true)
	}
	/// zsh has no POSIX rule against trapping a signal ignored on entry:
	/// later [`Self::set_signal_trap`] calls for `signal` change it, and
	/// `None` restores the default disposition. Its current disposition
	/// stays as it is. Hosts without OS signals keep the default: nothing.
	fn forget_ignored(&mut self, _signal: Signal) {}
	/// The filesystem (hookable: VFS, devices, `/dev/fd`, `/dev/tcp`).
	fn fs(&mut self) -> &mut dyn Fs;
	/// The shell's own standard stream `fd`; `None` leaves it closed.
	///
	/// Called by [`Shell::create`](crate::bash::Shell::create) and again by
	/// [`Shell::restore`](crate::bash::Shell::restore), so a restored shell
	/// writes to the new process's streams.
	fn stdio(&mut self, fd: StdFd) -> Option<Box<dyn File>>;
	/// Monotonic clock in ns (`SECONDS`, `time`, event timestamps, budgets).
	fn now_ns(&self) -> u64;
	/// Arm a timer that becomes ready once [`Host::now_ns`] reaches `at`
	/// (B9: `read -t`, `TMOUT`).
	///
	/// The engine polls the returned [`Timer`] with its waker, like a
	/// [`Task`]; the host wakes that waker at the deadline. Dropping the timer
	/// cancels it (a `read -t` that got its input early leaves nothing armed).
	/// Hosts share one timer thread or wheel between all timers; a test host
	/// fires timers on its virtual clock, so timeouts are deterministic.
	fn timer(&mut self, at: Deadline) -> Box<dyn Timer>;
	/// Wall clock (`EPOCHSECONDS`, `printf %(…)T`).
	fn wall(&self) -> SystemTimeLike;
	/// Random bits (`SRANDOM`, the `RANDOM` seed); seedable in tests.
	fn random(&mut self) -> u64;
	/// `$$`, read once at create and persisted.
	fn shell_pid(&self) -> u32;
	/// `$PPID`.
	fn ppid(&self) -> u32;
	/// Current user (`~`, `$UID`, `$EUID`).
	fn user(&self) -> UserInfo;
	/// The current user's login shell from the password database, for
	/// `SHELL`. [`Shell::create`](crate::bash::Shell::create) and the in-engine
	/// nested shell call it only when `SHELL` is not imported (as bash
	/// does): the lookup can be slow (an IPC to the directory service on
	/// macOS), so it stays off the startup path otherwise. `None` (the
	/// default) leaves `SHELL` unset.
	fn login_shell(&self) -> Option<BString> {
		None
	}
	/// A host-independent initializer for the same value as
	/// [`Host::login_shell`]. A supporting store can memoize it on first
	/// observation instead of querying the password database at startup.
	/// It must remain valid after this host is dropped. Other hosts keep
	/// the eager lookup by returning `None`.
	fn login_shell_initializer(&self) -> Option<fn() -> Option<BString>> {
		None
	}
	/// The file-creation mask the shell starts with (bash takes the
	/// process's): [`Shell::create`](crate::bash::Shell::create) records it as
	/// the shell's `umask`, which externals and created files get. A host
	/// whose shells have no process of their own keeps the default, `0o022`.
	fn umask(&self) -> u32 {
		0o022
	}
	/// `$HOSTNAME`.
	fn hostname(&self) -> BString;
	/// `uname`'s system name, release and machine (zsh's `CPUTYPE` and the
	/// release in `OSTYPE`); `None` (the default) when the host has no OS
	/// of its own to report.
	fn uname(&self) -> Option<(BString, BString, BString)> {
		None
	}
	/// Terminal information for `fd`; `None` when it is not a terminal (agent
	/// shells).
	fn tty(&mut self, fd: i32) -> Option<TtyInfo>;
	/// Terminal control: modes, window size, the foreground process group,
	/// the shell's own tty (zsh's `SHTTY`) and new ptys
	/// ([`Terminal`](crate::bash::Terminal)). `None` (the default): this
	/// host's shells have no terminals (agent shells, test hosts), and ZLE,
	/// job control's terminal handoff and `zpty` report that.
	fn terminal(&mut self) -> Option<&mut dyn crate::bash::Terminal> {
		None
	}
	/// OS stream sockets ([`Sockets`](crate::bash::Sockets)): zsh's
	/// `zsocket`, `ztcp` and `zftp`. `None` (the default): this host's
	/// shells may not open sockets (agent shells, test hosts), and those
	/// builtins report the operation as unsupported.
	fn sockets(&mut self) -> Option<&mut dyn crate::bash::Sockets> {
		None
	}
	/// UTC offset in seconds and zone abbreviation at `unix_s`, in the zone
	/// the shell's `TZ` names (`None`: `TZ` unset, the host's zone). Used by
	/// `printf '%(…)T'` and prompt time escapes.
	fn tz_offset(&self, tz: Option<&BStr>, unix_s: i64) -> (i32, BString);
	/// Open fds above 2 the shell's process inherited from whoever started
	/// it (`$SHELL ./x 3<file`), with their numbers. `Shell::create` puts
	/// them into the root vproc's fd table, as bash keeps inherited fds.
	/// Hosts that start shells without such fds return none (the default).
	fn inherited_fds(&mut self) -> Vec<(i32, Box<dyn File>)> {
		Vec::new()
	}
	/// CPU time used by the shell's process and its waited-for children
	/// (`times`). Hosts that cannot measure it return `Unsupported`.
	fn cpu_times(&self) -> io::Result<CpuTimes> {
		Err(io::ErrorKind::Unsupported.into())
	}
	/// The host's current soft and hard limit for `res` (`None`: unlimited),
	/// the base of `ulimit`. The engine keeps per-vproc changes itself and
	/// hands them to externals in [`SpawnSpec::rlimits`]; it never changes
	/// the host process's limits. Hosts without resource limits (Windows)
	/// return `Unsupported`.
	fn rlimit(&self, _res: Rlimit) -> io::Result<(Option<u64>, Option<u64>)> {
		Err(io::ErrorKind::Unsupported.into())
	}
	/// The system's login sessions (the utmpx `USER_PROCESS` entries zsh's
	/// `zsh/watch` scans with `getutxent`) and the utmpx file's
	/// modification time. Hosts without a login database refuse with
	/// `Unsupported`: `log` and `$watch` then report nothing, as zsh does
	/// when it cannot `stat` the utmpx file.
	fn logins(&self) -> io::Result<Logins> {
		Err(io::ErrorKind::Unsupported.into())
	}
	/// Mirror of the pipes pipelines create (`a | b`), asked once per
	/// pipeline started: each pipe between two stages is offered to
	/// [`PipeTap::open`], and the [`PipeMirror`] it returns gets a copy of
	/// every byte written into the pipe. `None` (the default) taps nothing.
	/// Only the engine's own pipes are offered: an external's output still
	/// reaches a tapped pipe through the host's pump, but a pipe the host
	/// itself connects is not seen.
	fn pipe_tap(&mut self) -> Option<Arc<dyn PipeTap>> {
		None
	}
	/// Observe an event, synchronously at a safepoint.
	///
	/// Must not re-enter the [`Shell`](crate::bash::Shell). The event borrows
	/// engine memory: copy what you keep. The script, mode, node and span are
	/// looked up only when read ([`Event::run`], [`Event::mode`],
	/// [`Event::node`], [`Event::span`], serialization), so a host that
	/// ignores them pays nothing for them.
	fn event(&mut self, ev: &Event<'_>) -> Verdict;
}

/// How a command name resolved.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Resolved {
	/// Engine-native builtin.
	Intrinsic(IntrinsicId),
	/// Host callout: the engine returns [`Step::Call`](crate::bash::Step::Call).
	Tool(ToolRef),
	/// Native command: [`Host::start`] returns a [`Task`].
	Native(NativeRef),
	/// Device command; same [`Task`] shape, the host decides routing.
	Device(NativeRef),
	/// `bash`/`sh`/`zsh` run in-engine as a fresh-state subshell.
	SelfShell,
	/// External program at this absolute path.
	External(BString),
	/// Unknown to the host: the engine searches PATH through [`Fs`], then
	/// reports "command not found" (127).
	NotFound,
}

/// Context of a [`Host::resolve`] call.
#[derive(Clone, Copy, Debug)]
pub struct ResolveCtx {
	/// The name contains a `/` (no PATH search).
	pub has_slash: bool,
	/// Which construct asks.
	pub via:       Via,
}

/// Construct that triggered a resolution.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, strum::VariantNames)]
#[strum(serialize_all = "snake_case")]
pub enum Via {
	/// Ordinary command position.
	Plain,
	/// `command name`.
	Command,
	/// `command -p name` (default PATH).
	CommandP,
	/// `builtin name`.
	Builtin,
	/// `exec name`.
	Exec,
	/// `type`/`command -v` lookups (no execution follows).
	Type,
}

crate::bash::packed_names::packed_names!(Via);

/// Arguments of [`Host::start`].
pub struct Invocation<'a> {
	/// Command name and arguments, after expansion.
	pub argv:      &'a [BString],
	/// Environment of the command.
	pub env:       &'a EnvView,
	/// Working directory.
	pub cwd:       &'a BStr,
	/// fds 0, 1, 2.
	pub stdio:     [FdRef; 3],
	/// Further fds (`3>file cmd`).
	pub extra_fds: &'a [(i32, FdRef)],
	/// Output tag of this execution.
	pub tag:       CmdTag,
	/// Virtual process running it.
	pub vpid:      Vpid,
	/// File-creation mask: the shell's `umask`.
	pub umask:     u32,
}

/// A native command running on host threads or inline.
pub trait Task: Send {
	/// Poll for the exit status. **Must not block**: wake the context's waker
	/// when progress is possible.
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<i32>;
	/// Deliver a signal (TERM/INT/KILL mean cancel).
	fn signal(&mut self, sig: Signal);
	/// Whole-job pause.
	fn pause(&mut self) {}
	/// Resume after [`Task::pause`].
	fn resume(&mut self) {}
	/// Serialize enough state to resume after a snapshot; `None` (the default)
	/// makes the task [`Lost`](crate::bash::Lost) on externalize. Resumed
	/// through [`Host::restore_task`].
	fn checkpoint(&mut self) -> Option<Vec<u8>> {
		None
	}
}

/// Arguments of [`Host::spawn`].
pub struct SpawnSpec<'a> {
	/// Absolute program path.
	pub path:        &'a BStr,
	/// Argument vector (`argv[0]` included).
	pub argv:        &'a [BString],
	/// Environment.
	pub env:         &'a EnvView,
	/// Working directory.
	pub cwd:         &'a BStr,
	/// fds 0, 1, 2.
	pub stdio:       [StdioSpec; 3],
	/// Further fds; Unix only (Windows hosts fail with `Unsupported`).
	pub extra_fds:   Vec<(i32, StdioSpec)>,
	/// Process group placement.
	pub pgroup:      PgroupSpec,
	/// Output tag of this execution.
	pub tag:         CmdTag,
	/// Virtual process the external belongs to.
	pub vpid:        Vpid,
	/// File-creation mask.
	pub umask:       u32,
	/// Signals ignored on entry (inherited ignores, `trap '' SIG`).
	pub sigmask_ign: SigSet,
	/// Resource limits `ulimit` changed in the vproc (or its parents):
	/// `(resource, soft, hard)`, `None` meaning unlimited; the host applies
	/// them in the child before exec.
	pub rlimits:     &'a [(Rlimit, Option<u64>, Option<u64>)],
	/// Lineage of the vproc: which host-labeled subshell tree the external
	/// belongs to, and whether that tree is detached.
	pub lineage:     Lineage,
	/// Redirections the process applies itself, after `stdio` and
	/// `extra_fds` are in place and before it execs ([`ChildRedirs`]). The
	/// engine asks only for paths [`Host::child_opens`] accepted; `None`
	/// for every other spawn.
	pub redirs:      Option<ChildRedirs>,
	/// The terminal of the session the external belongs to (a `zpty`
	/// slave, on its stdio) rather than the shell's: the child leads a new
	/// session (`setsid`), so its `/dev/tty` cannot reach the shell's
	/// terminal; `pgroup` is not applied. It does not claim the pty as its
	/// controlling terminal: a session leader's exit hangs its controlling
	/// terminal up for every holder, cutting the zpty off from the shell
	/// (zsh's long-lived zpty child shell is the leader there; the engine
	/// has no such process). `None` for every other spawn. Hosts that
	/// cannot do this on their platform fail the spawn with `Unsupported`.
	pub ctty:        Option<OsHandle>,
}

/// The redirections a spawned process applies itself ([`SpawnSpec::redirs`]).
///
/// Bash's forked child opens a redirection's file after the fork, so a
/// background `cmd > fifo &` has its pid (`$!`) while the open waits for the
/// FIFO's other end, and the shell runs on. The engine hands these over for
/// the lone external of a background job whose redirection open would wait
/// ([`Host::child_opens`]).
///
/// `spawn` must return once the process exists, without waiting for the
/// opens (or the exec) to complete. The process applies `list` in order;
/// when an entry fails it writes that entry's `diag`, the error's
/// description (`strerror`) and a newline to its fd 2 and exits with
/// status 1. When the exec fails it writes `exec_diag`, the description and
/// a newline and exits with 127 (not found) or 126 (any other error), as
/// bash's child does. The engine's `ENOEXEC` fallback cannot run after this
/// return; a host may refuse the deferred spawn to let the engine apply the
/// redirections and retry when the executable may need that fallback.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChildRedirs {
	/// The redirections, in order.
	pub list:      Vec<ChildRedir>,
	/// What precedes an exec failure's description (`bash: line 1: cmd: `).
	pub exec_diag: BString,
}

/// One redirection of [`ChildRedirs`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChildRedir {
	/// Open `path` (absolute) with `flags` and creation mode `mode` (the
	/// `umask` already applied) onto each of `fds`.
	Open {
		/// The fds it becomes (two for `&>`).
		fds:   Vec<i32>,
		/// Absolute path.
		path:  BString,
		/// How to open it.
		flags: OpenFlags,
		/// Creation mode.
		mode:  u32,
		/// What precedes a failure's description (`bash: line 1: f: `).
		diag:  BString,
	},
	/// Make `fd` a copy of `src` (`fd>&src`, `/dev/fd/src`).
	Dup {
		/// The fd set.
		fd:   i32,
		/// The fd copied.
		src:  i32,
		/// What precedes a failure's description (`bash: line 1: 9: `).
		diag: BString,
	},
	/// Close `fd` (`fd>&-`, the source of a move `fd>&src-`).
	Close {
		/// The fd closed.
		fd: i32,
	},
}

/// Host lineage of a virtual process.
///
/// Inherited by every vproc it creates (subshells, pipeline stages, background
/// jobs, nested shells) and handed to the host with each external it spawns
/// ([`SpawnSpec::lineage`]).
///
/// A host callout sets it for the subshells it starts
/// ([`ShellApi::run_subshell_in`](crate::bash::ShellApi::run_subshell_in)), the
/// way a program like `timeout` or `nohup` places its child: the label is the
/// child's process group ([`SigTarget::Label`](crate::bash::SigTarget::Label)
/// signals it, [`Shell::label_live`](crate::bash::Shell::label_live) watches
/// it), and a detached tree outlives the shell's cancellation and teardown.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Lineage {
	/// Host-chosen label of the innermost labeled subshell tree; 0 outside
	/// any. A labeled subshell inside another replaces its parent's label.
	pub label:    u32,
	/// The tree is detached (`nohup`): once set, every descendant keeps it.
	/// [`ControlHandle::cancel`](crate::bash::ControlHandle::cancel) leaves
	/// detached vprocs and their externals running, and a host must not
	/// signal or kill a detached external when its [`ExtProc`] is dropped
	/// (shell teardown); it still delivers [`ExtProc::signal`], which the
	/// engine sends only for signals aimed at the tree (`kill`).
	pub detached: bool,
}

/// CPU times of [`Host::cpu_times`], in nanoseconds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CpuTimes {
	/// User time of the shell's process.
	pub user_ns:       u64,
	/// System time of the shell's process.
	pub sys_ns:        u64,
	/// User time of waited-for children.
	pub child_user_ns: u64,
	/// System time of waited-for children.
	pub child_sys_ns:  u64,
}

/// One login session of the system's utmpx database ([`Host::logins`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Login {
	/// `ut_user`.
	pub user: BString,
	/// `ut_line`: the terminal (`console`, `ttys001`).
	pub line: BString,
	/// `ut_host`: where the session comes from (empty for a local one).
	pub host: BString,
	/// `ut_tv.tv_sec`: the login time, seconds since the epoch.
	pub time: i64,
}

/// The utmpx database as `zsh/watch` reads it ([`Host::logins`]).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Logins {
	/// Modification time of the utmpx file, seconds since the epoch.
	pub mtime:   i64,
	/// The `USER_PROCESS` entries, in the database's order.
	pub entries: Vec<Login>,
}

/// A resource `ulimit` reads and sets ([`Host::rlimit`],
/// [`SpawnSpec::rlimits`]); bash's option letter in brackets.
#[derive(
	Clone,
	Copy,
	Debug,
	PartialEq,
	Eq,
	Hash,
	Serialize,
	Deserialize,
	strum::EnumIter,
	strum::VariantNames,
)]
pub enum Rlimit {
	/// Core file size (`-c`), blocks of 512 bytes in bash's display.
	Core,
	/// Data segment (`-d`).
	Data,
	/// File size (`-f`).
	Fsize,
	/// Locked memory (`-l`).
	Memlock,
	/// Resident set (`-m`).
	Rss,
	/// Stack (`-s`).
	Stack,
	/// CPU seconds (`-t`).
	Cpu,
	/// User processes (`-u`).
	Nproc,
	/// Open files (`-n`).
	Nofile,
	/// Virtual memory / address space (`-v`).
	Vmem,
	/// File locks (`-x`).
	Locks,
	/// Pending signals (`-i`).
	Sigpending,
	/// POSIX message queues (`-q`).
	Msgqueue,
	/// Scheduling priority (`-e`).
	Nice,
	/// Real-time priority (`-r`).
	Rtprio,
	/// Real-time CPU microseconds (`-R`).
	Rttime,
	/// Pseudo-terminals (`-P`).
	Npts,
	/// Kqueues (`-k`).
	Kqueues,
	/// Socket buffer size (`-b`).
	Sbsize,
	/// Threads (`-T`).
	Threads,
	/// Swap (`-w`).
	Swap,
}

crate::bash::packed_names::packed_names!(Rlimit);

/// How a spawned external gets one standard stream.
pub enum StdioSpec {
	/// Pass this OS handle through.
	Inherit(OsHandle),
	/// `/dev/null`.
	Null,
	/// Closed in the process (the script closed it: `cmd 2>&-`), as bash's
	/// child inherits it. A host that cannot express a closed standard
	/// stream gives the null device.
	Closed,
	/// Engine fd object without an OS handle (in-memory pipe, VFS file): the
	/// host creates an OS pipe and pumps between it and this object.
	Pipe(FdRef),
	/// A host file the host can wire up itself.
	File(Box<dyn File>),
}

/// A running external process.
pub trait ExtProc: Send {
	/// OS process id.
	fn pid(&self) -> u32;
	/// Poll for exit. Must not block.
	///
	/// `Ready` only once the process has exited **and** every output pump
	/// of a `StdioSpec::Pipe` stdout/stderr has delivered all bytes up to the
	/// child's end of file into its [`FdRef`]: the engine reads a command
	/// substitution's capture as soon as the exit is observed.
	fn poll_wait(&mut self, cx: &mut Context<'_>) -> Poll<ExitStatus>;
	/// Poll for the next state change: a stop or continue the host observed
	/// since the last poll (each reported once; a stop and continue both
	/// unseen report the later one), else the exit as [`ExtProc::poll_wait`]
	/// reports it. Must not block. Job control (`set -m`) waits with this:
	/// a stopped foreground job hands the terminal back to the shell, zsh's
	/// `waitpid(WUNTRACED)`. The default reports exits only (a host whose
	/// processes never stop on their own).
	fn poll_event(&mut self, cx: &mut Context<'_>) -> Poll<ProcEvent> {
		self.poll_wait(cx).map(ProcEvent::Exited)
	}
	/// The OS process group the process was placed in when it leads or
	/// joined one ([`PgroupSpec`]); `None` when it shares the shell's group
	/// or the host has no process groups. A [`PgroupSpec::Job`] join the OS
	/// refused (the group emptied) leaves the process leading its own: this
	/// is the group job control signals and hands the terminal to.
	fn pgid(&self) -> Option<u32> {
		None
	}
	/// Signal the process group (Unix) or Job Object (Windows).
	fn signal(&mut self, sig: Signal) -> io::Result<()>;
	/// Stop the process group (job pause).
	fn stop(&mut self) -> io::Result<()>;
	/// Continue after [`ExtProc::stop`].
	fn cont(&mut self) -> io::Result<()>;
}

/// Opens a [`PipeMirror`] per pipeline pipe ([`Host::pipe_tap`]).
pub trait PipeTap: Send + Sync {
	/// A new pipe from stage `producer` to stage `consumer` (their source
	/// text as written); `None` leaves this pipe untapped.
	fn open(&self, producer: &BStr, consumer: &BStr) -> Option<Arc<dyn PipeMirror>>;
}

/// Receives the bytes crossing one tapped pipe.
///
/// Called with the pipe's lock held, from the thread writing into it: both
/// methods must be quick and must not touch the shell.
pub trait PipeMirror: Send + Sync {
	/// `bytes` were written into the pipe (in order; each byte once).
	fn write(&self, bytes: &[u8]);
	/// The pipe carries no more: its last writer or its last reader is gone.
	/// Called once.
	fn close(&self);
}

/// How an external process ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ExitStatus {
	/// Normal exit with this code.
	Exited(i32),
	/// Killed by a signal.
	Signaled(Signal),
	/// Killed by a signal number not represented by [`Signal`].
	SignaledRaw(i32),
}

/// A state change of a running external ([`ExtProc::poll_event`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ProcEvent {
	/// It ended.
	Exited(ExitStatus),
	/// It stopped on this signal (`STOP`, `TSTP`, `TTIN`, `TTOU`).
	Stopped(Signal),
	/// It continued after a stop (`SIGCONT`).
	Continued,
}

/// Process-group placement of a spawned external.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PgroupSpec {
	/// Lead a new process group for this job.
	New(JobId),
	/// Join the existing group `pgid` (later stages of a pipeline).
	Join(u32),
	/// Job control (zsh/bash `MONITOR` in the interactive shell): the
	/// external belongs to a job whose process group the shell manages. It
	/// leads a new group (`join: None`, the job's first process) or joins
	/// the job's group `join` (leading its own when the OS refuses the join,
	/// [`ExtProc::pgid`]). A foreground job (`terminal`) takes the shell's
	/// terminal (`tcsetpgrp`) in the child before it execs and in the shell
	/// after the spawn, so neither side races the other (zsh `entersubsh`
	/// and `addproc`). The process host (`Sessions::Inherit`) honours it
	/// while it keeps other externals in its own group; hosts without
	/// terminal job control place it as [`PgroupSpec::New`].
	Job {
		/// The job's process group, once its first process leads one.
		join:     Option<u32>,
		/// A foreground job: the shell's terminal (zsh `SHTTY`, an
		/// [`OsHandle`] of [`crate::bash::Terminal`]) the job's group takes.
		terminal: Option<OsHandle>,
	},
}

/// Current user.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct UserInfo {
	/// Real uid.
	pub uid:    u32,
	/// Effective uid.
	pub euid:   u32,
	/// Real gid.
	pub gid:    u32,
	/// Supplementary group ids (`getgroups`), for `GROUPS`.
	pub groups: Vec<u32>,
	/// Login name.
	pub name:   BString,
	/// Home directory.
	pub home:   BString,
}

/// Terminal facts for `-t`, `COLUMNS`, `LINES`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TtyInfo {
	/// Rows.
	pub rows: u16,
	/// Columns.
	pub cols: u16,
}

/// Wall-clock instant (since the Unix epoch).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct SystemTimeLike {
	/// Whole seconds.
	pub secs:  i64,
	/// Nanoseconds within the second.
	pub nanos: u32,
}

/// A host's answer to an event.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Verdict {
	/// Keep running.
	Continue,
	/// Pause the shell at this safepoint (breakpoints, stepping).
	Pause,
	/// Cancel the shell with this signal.
	Cancel(Signal),
}

/// One of the shell's own standard streams.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
pub enum StdFd {
	/// fd 0.
	Stdin,
	/// fd 1.
	Stdout,
	/// fd 2.
	Stderr,
}

impl StdFd {
	/// The fd number.
	pub const fn fd(self) -> i32 {
		match self {
			Self::Stdin => 0,
			Self::Stdout => 1,
			Self::Stderr => 2,
		}
	}
}

/// Raw OS handle (a Unix fd or a Windows `HANDLE`), as an integer so it can
/// cross the seam and be serialized; only the host that produced it may
/// interpret it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct OsHandle(pub u64);

/// Environment of one command: exported variables plus per-command
/// assignments, sorted by name. Cheap to clone.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EnvView(Arc<[(BString, BString)]>);

impl EnvView {
	/// View over `pairs`; later duplicates win.
	pub fn new(mut pairs: Vec<(BString, BString)>) -> Self {
		pairs.reverse();
		pairs.sort_by(|a, b| a.0.cmp(&b.0));
		pairs.dedup_by(|later, earlier| later.0 == earlier.0);
		Self(pairs.into())
	}

	/// Value of `name`.
	pub fn get(&self, name: &[u8]) -> Option<&BStr> {
		let i = self
			.0
			.binary_search_by(|(k, _)| k.as_slice().cmp(name))
			.ok()?;
		Some(BStr::new(&self.0[i].1))
	}

	/// `(name, value)` pairs in name order.
	pub fn iter(&self) -> impl ExactSizeIterator<Item = (&BStr, &BStr)> {
		self.0.iter().map(|(k, v)| (BStr::new(k), BStr::new(v)))
	}

	/// Number of variables.
	pub fn len(&self) -> usize {
		self.0.len()
	}

	/// Whether the environment is empty.
	pub fn is_empty(&self) -> bool {
		self.0.is_empty()
	}
}
