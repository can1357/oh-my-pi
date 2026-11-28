//! PTY-backed interactive command execution exported via N-API.
//!
//! # Overview
//! Provides a stateful PTY session that supports streaming output and stdin
//! passthrough while a command is running.

#[cfg(windows)]
mod conpty;
mod env;
#[cfg(unix)]
mod unix;

use std::{
	collections::HashMap,
	fs::File,
	io::{Read, Write},
	path::Path,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, Instant},
};

use napi::{
	JsString,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
};
use napi_derive::napi;
use omp_shell::output_decode::OutputDecoder;
use parking_lot::Mutex;

use crate::{
	js::into_string,
	ps,
	shell::{BRIDGE_QUEUE_CHUNKS, BridgeItem, FORWARD_STALL_TIMEOUT, pump_chunks},
	task,
};

/// Effective terminal dimensions shared by PTY sessions and screen emulators.
#[napi(object)]
pub struct PtyDimensions {
	pub cols: u16,
	pub rows: u16,
}

impl PtyDimensions {
	fn new(cols: u16, rows: u16) -> Self {
		Self { cols: cols.clamp(20, 400), rows: rows.clamp(5, 200) }
	}
}

/// Truncate and clamp dimensions to the same limits used by PTY start and
/// resize.
#[napi]
pub fn normalize_pty_dimensions(cols: f64, rows: f64) -> PtyDimensions {
	PtyDimensions::new(cols as u16, rows as u16)
}

/// Options for running a command in a PTY session.
#[napi(object)]
pub struct PtyStartOptions<'env> {
	/// Command string to execute.
	pub command:    String,
	/// Working directory for command execution.
	pub cwd:        Option<String>,
	/// Environment variables for this command.
	pub env:        Option<HashMap<String, String>>,
	/// Timeout in milliseconds before cancelling.
	pub timeout_ms: Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:     Option<Unknown<'env>>,
	/// PTY column count.
	pub cols:       Option<u16>,
	/// PTY row count.
	pub rows:       Option<u16>,
	/// Shell binary to use (e.g. "sh", "bash", or an absolute path).
	/// Defaults to "sh" if not provided.
	pub shell:      Option<String>,
}

/// Options for running an executable and argument vector in a PTY session.
#[napi(object)]
pub struct PtyArgvStartOptions<'env> {
	/// Executable name or path.
	pub application: String,
	/// Arguments passed directly to the executable.
	pub args:        Vec<String>,
	/// Working directory for command execution.
	pub cwd:         Option<String>,
	/// Environment variables for this command.
	pub env:         Option<HashMap<String, String>>,
	/// Timeout in milliseconds before cancelling.
	pub timeout_ms:  Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:      Option<Unknown<'env>>,
	/// PTY column count.
	pub cols:        Option<u16>,
	/// PTY row count.
	pub rows:        Option<u16>,
}

/// Result of a PTY command run.
#[napi(object)]
pub struct PtyRunResult {
	/// Exit code when the command completes.
	pub exit_code: Option<i32>,
	/// Whether command was cancelled by signal/user kill.
	pub cancelled: bool,
	/// Whether command timed out.
	pub timed_out: bool,
}

#[derive(Clone)]
enum PtyCommand {
	Shell { command: String, shell: Option<String> },
	Argv { application: String, args: Vec<String> },
}

/// A program to start on a fresh PTY.
struct Spawn<'a> {
	program: &'a str,
	args:    &'a [String],
	/// Its working directory; none, or one that is not a directory, falls
	/// back to the home directory.
	cwd:     Option<&'a Path>,
	env:     &'a env::Env,
}

#[derive(Clone)]
struct PtyRunConfig {
	command: PtyCommand,
	cwd:     Option<String>,
	env:     Option<HashMap<String, String>>,
	cols:    u16,
	rows:    u16,
}

enum ReaderEvent {
	Chunk(String),
	Done,
}

impl BridgeItem for ReaderEvent {
	fn into_text(self) -> Option<String> {
		match self {
			Self::Chunk(text) => Some(text),
			Self::Done => None,
		}
	}
}

enum ControlMessage {
	Input(String),
	Resize {
		cols: u16,
		rows: u16,
	},
	Kill,
	/// The run's cancel token fired (abort signal or timeout).
	Cancelled {
		timed_out: bool,
	},
	/// `on_chunk` failed: nothing is left to deliver output to.
	JsGone,
	/// The waiter thread reaped the child.
	Exited(std::io::Result<i32>),
}

const POST_CANCEL_DRAIN_TIMEOUT: Duration = Duration::from_millis(300);
/// Idle window used only when the child has already exited, the reader has
/// *not* hit EOF, the bridge queue is empty, and no `on_chunk` is in flight.
/// That is a permanently open slave (daemon / extra holder), not slow JS.
/// A reader parked on a full bridge is backpressure and must not use this.
const STUCK_SLAVE_IDLE: Duration = Duration::from_secs(2);
/// Gap between the polite termination wave (TERM to the group/tree, HUP to the
/// child) and SIGKILL, so a child with a TERM/HUP handler can clean up. Same
/// grace a blocking `Child::kill` would spend stalling the control loop.
/// Windows has no polite signal: `TerminateProcess` is immediate.
#[cfg(not(windows))]
const KILL_GRACE: Duration = Duration::from_millis(200);
#[cfg(windows)]
const KILL_GRACE: Duration = Duration::ZERO;
/// How long a terminated run keeps waiting for the child's exit status after
/// SIGKILL before resolving without one. SIGKILL does not guarantee a prompt
/// exit — a child wedged in uninterruptible I/O never dies, and a failed kill
/// leaves it running — so the promise must not wait on it indefinitely. The
/// waiter thread still reaps it whenever it does exit.
#[cfg(not(windows))]
const CANCEL_EXIT_WAIT: Duration = Duration::from_millis(800);
#[cfg(windows)]
const CANCEL_EXIT_WAIT: Duration = POST_CANCEL_DRAIN_TIMEOUT;

struct PtySessionCore {
	control_tx: flume::Sender<ControlMessage>,
}

/// Raw identity of the running (or adopted, not yet resumed) PTY child.
#[derive(Default)]
struct PtyHandles {
	/// Unix pty master fd.
	master_fd: Option<i32>,
	/// Child process id.
	pid:       Option<i32>,
	/// Master adopted by [`PtySession::adopt`], consumed by `resume`.
	#[cfg(unix)]
	pending:   Option<std::os::fd::OwnedFd>,
	/// Output pause control of the running session.
	#[cfg(unix)]
	output:    Option<Arc<OutputGate>>,
}

/// Stateful PTY session for interactive stdin/stdout passthrough.
#[napi]
pub struct PtySession {
	core:    Arc<Mutex<Option<PtySessionCore>>>,
	handles: Arc<Mutex<PtyHandles>>,
}

impl Default for PtySession {
	fn default() -> Self {
		Self::new()
	}
}

#[napi]
impl PtySession {
	#[napi(constructor)]
	pub fn new() -> Self {
		Self { core: Arc::new(Mutex::new(None)), handles: Arc::default() }
	}

	/// Wrap an inherited pty master fd and its child pid (e.g. kept across
	/// `execReplace`); call `resume` to drive it like a started session.
	#[napi(factory)]
	pub fn adopt(master_fd: i32, pid: i32) -> Result<Self> {
		#[cfg(unix)]
		{
			use std::os::fd::{FromRawFd, OwnedFd};
			if master_fd < 0 || pid <= 0 {
				return Err(Error::from_reason("PtySession.adopt: invalid master fd or pid"));
			}
			// SAFETY: the caller hands over ownership of the inherited master fd.
			let fd = unsafe { OwnedFd::from_raw_fd(master_fd) };
			// Re-arm CLOEXEC (cleared for the exec) and restore the blocking mode
			// the reader thread expects.
			// SAFETY: fcntl on the fd owned above with scalar arguments.
			unsafe {
				libc::fcntl(master_fd, libc::F_SETFD, libc::FD_CLOEXEC);
				let flags = libc::fcntl(master_fd, libc::F_GETFL);
				if flags >= 0 {
					libc::fcntl(master_fd, libc::F_SETFL, flags & !libc::O_NONBLOCK);
				}
			}
			let session = Self::new();
			*session.handles.lock() = PtyHandles {
				master_fd: Some(master_fd),
				pid:       Some(pid),
				pending:   Some(fd),
				output:    None,
			};
			Ok(session)
		}
		#[cfg(not(unix))]
		{
			let _ = (master_fd, pid);
			Err(Error::from_reason("PtySession.adopt is unsupported on this platform"))
		}
	}

	/// Unix pty master fd of the running session, for `execReplace` keepFds.
	#[napi]
	pub fn master_fd(&self) -> Option<i32> {
		self.handles.lock().master_fd
	}

	/// Process id of the running session's child.
	#[napi]
	pub fn pid(&self) -> Option<i32> {
		self.handles.lock().pid
	}

	/// Whether the program in the terminal waits on the user's keys.
	///
	/// `true` while echo is off (a password prompt such as `sudo`'s, or a
	/// full-screen program like `less`) or, on Linux, while a foreground
	/// process is blocked reading the terminal (a `[y/N]` prompt). `false` when
	/// no session runs or, on Linux, no foreground process reads the terminal.
	/// `null` when an echoing line prompt cannot be told from a busy program:
	/// always on macOS and Windows, and on Linux when a foreground process
	/// cannot be inspected (one running setuid).
	#[cfg_attr(
		not(unix),
		allow(clippy::missing_const_for_fn, reason = "unix reads the terminal at runtime")
	)]
	#[napi]
	pub fn awaits_input(&self) -> Option<bool> {
		#[cfg(unix)]
		{
			input_wait::probe(&self.handles)
		}
		#[cfg(not(unix))]
		{
			None
		}
	}

	/// Start a shell command, stream output chunks, and report the spawned child
	/// PID.
	#[napi]
	pub fn start<'env>(
		&self,
		env: &'env Env,
		options: PtyStartOptions<'env>,
		#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
		on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
		#[napi(ts_arg_type = "((error: Error | null, pid: number) => void) | undefined | null")]
		on_start: Option<ThreadsafeFunction<u32>>,
	) -> Result<PromiseRaw<'env, PtyRunResult>> {
		let dimensions = PtyDimensions::new(options.cols.unwrap_or(120), options.rows.unwrap_or(40));
		let run_config = PtyRunConfig {
			command: PtyCommand::Shell { command: options.command, shell: options.shell },
			cwd:     options.cwd,
			env:     options.env,
			cols:    dimensions.cols,
			rows:    dimensions.rows,
		};
		let handles = Arc::clone(&self.handles);
		self.launch(env, "pty.start", options.timeout_ms, options.signal, move |tx, rx, ct| {
			run_pty_sync(run_config, on_chunk, on_start, tx, rx, ct, &handles)
		})
	}

	/// Start an executable with separate arguments, stream output chunks, and
	/// report the spawned child PID.
	#[napi]
	pub fn start_argv<'env>(
		&self,
		env: &'env Env,
		options: PtyArgvStartOptions<'env>,
		#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
		on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
		#[napi(ts_arg_type = "((error: Error | null, pid: number) => void) | undefined | null")]
		on_start: Option<ThreadsafeFunction<u32>>,
	) -> Result<PromiseRaw<'env, PtyRunResult>> {
		let dimensions = PtyDimensions::new(options.cols.unwrap_or(120), options.rows.unwrap_or(40));
		let run_config = PtyRunConfig {
			command: PtyCommand::Argv { application: options.application, args: options.args },
			cwd:     options.cwd,
			env:     options.env,
			cols:    dimensions.cols,
			rows:    dimensions.rows,
		};
		let handles = Arc::clone(&self.handles);
		self.launch(env, "pty.start", options.timeout_ms, options.signal, move |tx, rx, ct| {
			run_pty_sync(run_config, on_chunk, on_start, tx, rx, ct, &handles)
		})
	}

	/// Drive an adopted session: stream output chunks and resolve when the
	/// child exits (exit code via `waitpid`).
	#[napi]
	pub fn resume<'env>(
		&self,
		env: &'env Env,
		#[napi(ts_arg_type = "(error: Error | null, chunk: string) => void")]
		on_chunk: ThreadsafeFunction<String, UnknownReturnValue>,
	) -> Result<PromiseRaw<'env, PtyRunResult>> {
		#[cfg(unix)]
		{
			let pid = {
				let handles = self.handles.lock();
				if handles.pending.is_none() {
					return Err(Error::from_reason("PtySession.resume: no adopted PTY to resume"));
				}
				handles.pid.unwrap_or(0)
			};
			let handles = Arc::clone(&self.handles);
			self.launch(env, "pty.resume", None, None, move |tx, rx, ct| {
				// Taken on the control thread: if that thread cannot start, the
				// adopted master stays pending and `master_fd`/`pid` stay accurate.
				let Some(fd) = handles.lock().pending.take() else {
					return Err(Error::from_reason("PtySession.resume: no adopted PTY to resume"));
				};
				run_adopted_sync(fd, pid, Some(on_chunk), tx, rx, ct, &handles)
			})
		}
		#[cfg(not(unix))]
		{
			let _ = (env, on_chunk);
			Err(Error::from_reason("PtySession.resume is unsupported on this platform"))
		}
	}

	/// Write raw input bytes to PTY stdin.
	#[napi]
	pub fn write(&self, data: JsString) -> Result<()> {
		self.send_control(ControlMessage::Input(into_string(data)?))
	}

	/// Resize the active PTY.
	#[napi]
	pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
		let dimensions = PtyDimensions::new(cols, rows);
		self.send_control(ControlMessage::Resize { cols: dimensions.cols, rows: dimensions.rows })
	}

	/// Force-kill the active PTY command.
	#[napi]
	pub fn kill(&self) -> Result<()> {
		self.send_control(ControlMessage::Kill)
	}

	/// Stop reading output without closing the master. Resolves once every
	/// chunk read before the pause has been delivered to `onChunk`, including
	/// partial UTF-8 held by the decoder (flushed lossily); unread bytes stay in
	/// the kernel buffer. Input, resize, kill and child-exit handling keep
	/// working. No-op (resolved) when no session runs or output is already
	/// paused. A run whose child exits while paused stops waiting for output
	/// as for a slave held open elsewhere, leaving the unread bytes unread.
	///
	/// Windows: `ConPTY` output is a blocking pipe read that cannot be
	/// interrupted without losing its bytes, so this resolves immediately and
	/// reading continues.
	#[napi(ts_return_type = "Promise<void>")]
	pub fn pause_output<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, ()>> {
		#[cfg(unix)]
		let stopped = self
			.handles
			.lock()
			.output
			.clone()
			.and_then(|gate| gate.pause());
		#[cfg(not(unix))]
		let stopped: Option<tokio::sync::oneshot::Receiver<()>> = None;
		task::future(env, "pty.pause_output", async move {
			if let Some(stopped) = stopped {
				// A dropped sender means the run ended; nothing is left to deliver.
				let _ = stopped.await;
			}
			Ok(())
		})
	}

	/// Restart reading output after `pauseOutput()`. No-op when not paused.
	#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
	#[napi]
	pub fn resume_output(&self) {
		#[cfg(unix)]
		let gate = self.handles.lock().output.clone();
		#[cfg(unix)]
		if let Some(gate) = gate {
			gate.resume();
		}
	}
}

impl PtySession {
	/// Register the control channel and run `run` on a dedicated thread.
	fn launch<'env>(
		&self,
		env: &'env Env,
		tag: &'static str,
		timeout_ms: Option<u32>,
		signal: Option<Unknown<'env>>,
		run: impl FnOnce(
			flume::Sender<ControlMessage>,
			flume::Receiver<ControlMessage>,
			task::CancelToken,
		) -> Result<PtyRunResult>
		+ Send
		+ 'static,
	) -> Result<PromiseRaw<'env, PtyRunResult>> {
		let ct = task::CancelToken::new(timeout_ms, signal);
		let core = Arc::clone(&self.core);

		// Register control channel synchronously so write()/kill() work
		// immediately.
		let (control_tx, control_rx) = flume::unbounded::<ControlMessage>();
		{
			let mut guard = core.lock();
			if guard.is_some() {
				return Err(Error::from_reason("PTY session already running"));
			}
			*guard = Some(PtySessionCore { control_tx: control_tx.clone() });
		}
		task::future(env, tag, async move {
			// Run the PTY control loop on a dedicated OS thread rather than
			// Tokio's bounded blocking pool so long-lived PTYs never starve
			// short `spawn_blocking` tasks or subsequent PTY starts.
			// Enter the active Tokio runtime handle on that thread because
			// `drive_pty` spawns async cancel and output-pump tasks via
			// `napi::tokio::spawn`.
			let rt_handle = napi::tokio::runtime::Handle::current();
			let (done_tx, done_rx) = tokio::sync::oneshot::channel();
			let spawn_res = std::thread::Builder::new()
				.name("pi-pty-ctrl".into())
				.stack_size(512 * 1024)
				.spawn(move || {
					let _guard = rt_handle.enter();
					let result = crate::crash_handler::blocking_task_panic_scope(|| {
						std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
							run(control_tx, control_rx, ct)
						}))
					});
					let mapped = match result {
						Ok(res) => res,
						Err(payload) => {
							let msg = payload
								.downcast_ref::<&str>()
								.copied()
								.or_else(|| payload.downcast_ref::<String>().map(String::as_str))
								.unwrap_or("unknown panic");
							Err(Error::from_reason(format!("PTY control thread panicked: {msg}")))
						},
					};
					let _ = done_tx.send(mapped);
				});
			let run_result = match spawn_res {
				Ok(_) => done_rx
					.await
					.map_err(|err| Error::from_reason(format!("PTY execution task failed: {err}")))
					.flatten(),
				Err(err) => {
					Err(Error::from_reason(format!("Failed to spawn PTY control thread: {err}")))
				},
			};

			let mut guard = core.lock();
			*guard = None;
			drop(guard);

			run_result
		})
	}

	fn send_control(&self, message: ControlMessage) -> Result<()> {
		let guard = self.core.lock();
		let core = guard
			.as_ref()
			.ok_or_else(|| Error::from_reason("PTY session is not running"))?;
		core
			.control_tx
			.send(message)
			.map_err(|_| Error::from_reason("PTY session is no longer available"))
	}
}

/// Master side of a PTY: the pseudoterminal's master fd (Unix), or the
/// pseudoconsole (Windows).
#[cfg(unix)]
struct PtyMaster(std::os::fd::OwnedFd);
#[cfg(windows)]
struct PtyMaster(conpty::Console);

impl PtyMaster {
	fn resize(&self, cols: u16, rows: u16) {
		#[cfg(unix)]
		{
			use std::os::fd::AsRawFd;
			let size = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
			// SAFETY: TIOCSWINSZ reads one `winsize` from a valid pointer.
			unsafe { libc::ioctl(self.0.as_raw_fd(), libc::TIOCSWINSZ, &size) };
		}
		#[cfg(windows)]
		let _ = self.0.resize(cols, rows);
	}

	#[cfg(unix)]
	fn process_group_leader(&self) -> Option<i32> {
		use std::os::fd::AsRawFd;
		// SAFETY: tcgetpgrp on the owned master fd.
		let pgid = unsafe { libc::tcgetpgrp(self.0.as_raw_fd()) };
		(pgid > 0).then_some(pgid)
	}
}

/// Detection behind [`PtySession::awaits_input`].
#[cfg(unix)]
mod input_wait {
	use std::mem::MaybeUninit;

	use parking_lot::Mutex;

	use super::PtyHandles;

	/// See [`super::PtySession::awaits_input`].
	pub fn probe(handles: &Mutex<PtyHandles>) -> Option<bool> {
		// Teardown clears `master_fd` under this lock before closing the fd, so
		// it stays open while the guard is held.
		let guard = handles.lock();
		let Some(fd) = guard.master_fd else {
			return Some(false);
		};
		if !echoes(fd)? {
			return Some(true);
		}
		#[cfg(target_os = "linux")]
		{
			let foreground = linux::Foreground::read(fd, guard.pid?)?;
			drop(guard);
			foreground.reads_terminal()
		}
		#[cfg(not(target_os = "linux"))]
		{
			// No per-process syscall state: an echoing line prompt looks like a
			// busy program.
			None
		}
	}

	/// Whether the terminal echoes typed keys; `None` when its mode is
	/// unreadable.
	fn echoes(master_fd: i32) -> Option<bool> {
		let mut termios = MaybeUninit::<libc::termios>::uninit();
		// SAFETY: tcgetattr writes a whole `termios` on success.
		if unsafe { libc::tcgetattr(master_fd, termios.as_mut_ptr()) } != 0 {
			return None;
		}
		// SAFETY: initialized by the successful tcgetattr above.
		let termios = unsafe { termios.assume_init() };
		Some((termios.c_lflag & libc::ECHO) != 0)
	}

	#[cfg(target_os = "linux")]
	mod linux {
		use std::{ffi::CStr, io::ErrorKind, os::unix::fs::MetadataExt};

		use omp_shell::proctree::Process;

		/// The terminal's foreground process group and the device its slave is.
		pub struct Foreground {
			leader: i32,
			group:  i32,
			slave:  u64,
		}

		impl Foreground {
			/// Read from the open master; `leader` is the session's child. `None`
			/// when the group or the slave cannot be read.
			pub fn read(master_fd: i32, leader: i32) -> Option<Self> {
				// SAFETY: tcgetpgrp on an open fd.
				let group = unsafe { libc::tcgetpgrp(master_fd) };
				if group <= 0 {
					return None;
				}
				let mut name: [libc::c_char; 64] = [0; 64];
				// SAFETY: ptsname_r writes a NUL-terminated name of at most
				// `name.len()` bytes.
				if unsafe { libc::ptsname_r(master_fd, name.as_mut_ptr(), name.len()) } != 0 {
					return None;
				}
				// SAFETY: NUL-terminated by the successful ptsname_r above.
				let path = unsafe { CStr::from_ptr(name.as_ptr()) };
				let slave = std::fs::metadata(path.to_str().ok()?).ok()?.rdev();
				Some(Self { leader, group, slave })
			}

			/// Whether a foreground process is blocked reading the terminal, from
			/// `/proc/<pid>/syscall`; `None` when one is not ours to inspect.
			pub fn reads_terminal(&self) -> Option<bool> {
				let Some(leader) = Process::from_pid(self.leader) else {
					return Some(false);
				};
				// `/dev/tty`: the controlling terminal under its generic name.
				let console = libc::makedev(5, 0);
				let mut unknown = false;
				for process in leader.live_descendants().into_iter().chain([leader]) {
					if process.group_id() != Some(self.group) {
						continue;
					}
					let pid = process.pid();
					let syscall = match std::fs::read_to_string(format!("/proc/{pid}/syscall")) {
						Ok(syscall) => syscall,
						Err(error) => {
							// Gone by now is no wait; a setuid process hides what it
							// waits on.
							unknown |= error.kind() == ErrorKind::PermissionDenied;
							continue;
						},
					};
					let Some(fd) = blocked_read_fd(&syscall) else {
						continue;
					};
					let Ok(file) = std::fs::metadata(format!("/proc/{pid}/fd/{fd}")) else {
						continue;
					};
					if file.rdev() == self.slave || file.rdev() == console {
						return Some(true);
					}
				}
				if unknown { None } else { Some(false) }
			}
		}

		/// The fd a `/proc/<pid>/syscall` line shows blocked in `read`/`readv`:
		/// `<nr> 0x<fd> …`; `running` or `-1 …` outside a syscall.
		fn blocked_read_fd(syscall: &str) -> Option<u32> {
			let mut fields = syscall.split_whitespace();
			let nr: libc::c_long = fields.next()?.parse().ok()?;
			if nr != libc::SYS_read && nr != libc::SYS_readv {
				return None;
			}
			u32::from_str_radix(fields.next()?.strip_prefix("0x")?, 16).ok()
		}
	}
}

/// Pause control for the PTY output reader thread.
///
/// The reader polls the master together with a wake pipe and only reads once
/// the master is readable and no pause is pending, so nothing is consumed past
/// the pause point. Pause promises resolve once the bytes read before the
/// pause (`sent`) have reached `on_chunk` (`delivered`); coalescing in the
/// pump only concatenates text, so byte counts line up.
#[cfg(unix)]
struct OutputGate {
	state:   Mutex<GateState>,
	resumed: parking_lot::Condvar,
	wake_rx: std::os::fd::OwnedFd,
	wake_tx: std::os::fd::OwnedFd,
}

#[cfg(unix)]
#[derive(Default)]
struct GateState {
	/// Waiters of a pause the reader has not reached yet.
	requested:     Option<Vec<tokio::sync::oneshot::Sender<()>>>,
	/// The reader is parked until `resume`/`close`.
	paused:        bool,
	/// Text bytes the reader had queued when it last paused.
	paused_at:     u64,
	/// Text bytes `on_chunk` has accepted.
	delivered:     u64,
	/// Paused waiters still waiting for `delivered` to reach their target.
	draining:      Vec<(u64, tokio::sync::oneshot::Sender<()>)>,
	/// Nothing more reaches `on_chunk` (pump gone): waiters resolve at once.
	undeliverable: bool,
	/// The run is over: pauses resolve at once, a parked reader exits.
	closed:        bool,
}

#[cfg(unix)]
impl OutputGate {
	fn new() -> std::io::Result<Self> {
		use std::os::fd::{FromRawFd, OwnedFd};
		let mut fds = [0; 2];
		// SAFETY: `pipe` writes two fds into the valid two-element array.
		if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
			return Err(std::io::Error::last_os_error());
		}
		// SAFETY: `pipe` just returned these fds; nothing else owns them.
		let (wake_rx, wake_tx) =
			unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
		for fd in fds {
			// SAFETY: fcntl with scalar arguments on the fds owned above. Both
			// ends stay out of exec'd images and never block.
			unsafe {
				libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
				let flags = libc::fcntl(fd, libc::F_GETFL);
				if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
					return Err(std::io::Error::last_os_error());
				}
			}
		}
		Ok(Self { state: Mutex::default(), resumed: parking_lot::Condvar::new(), wake_rx, wake_tx })
	}

	/// Interrupt the reader's poll.
	fn wake(&self) {
		use std::os::fd::AsRawFd;
		// SAFETY: one-byte write from a valid buffer; a full pipe already
		// guarantees a pending wakeup.
		unsafe { libc::write(self.wake_tx.as_raw_fd(), [1u8].as_ptr().cast(), 1) };
	}

	/// Request a pause; `None` when there is nothing to wait for.
	fn pause(&self) -> Option<tokio::sync::oneshot::Receiver<()>> {
		let mut state = self.state.lock();
		if state.closed {
			return None;
		}
		let (tx, rx) = tokio::sync::oneshot::channel();
		if let Some(waiters) = &mut state.requested {
			waiters.push(tx);
		} else if state.paused {
			if state.undeliverable || state.delivered >= state.paused_at {
				return None;
			}
			let target = state.paused_at;
			state.draining.push((target, tx));
		} else {
			state.requested = Some(vec![tx]);
			drop(state);
			self.wake();
		}
		Some(rx)
	}

	fn resume(&self) {
		let mut state = self.state.lock();
		if state.paused {
			state.paused = false;
			self.resumed.notify_all();
		}
	}

	/// `on_chunk` accepted `bytes` more text bytes.
	fn delivered(&self, bytes: usize) {
		let mut state = self.state.lock();
		state.delivered += bytes as u64;
		let delivered = state.delivered;
		state.draining.retain(|(target, _)| *target > delivered);
		// Dropping a sender resolves its pause promise.
	}

	/// The pump stopped: no later byte reaches `on_chunk`.
	fn undeliverable(&self) {
		let mut state = self.state.lock();
		state.undeliverable = true;
		state.draining.clear();
	}

	/// End of the run: resolve every pause and release a parked reader.
	fn close(&self) {
		let mut state = self.state.lock();
		state.closed = true;
		state.requested = None;
		state.draining.clear();
		self.resumed.notify_all();
	}

	fn pause_requested(&self) -> bool {
		self.state.lock().requested.is_some()
	}

	/// Reader side of a pause: record the pause point `sent`, then park until
	/// `resume` (true) or `close` (false). `forwarding` false means nothing
	/// queued will ever be delivered.
	fn hold(&self, sent: u64, forwarding: bool) -> bool {
		let mut state = self.state.lock();
		let waiters = state.requested.take().unwrap_or_default();
		if forwarding && !state.undeliverable && state.delivered < sent {
			state
				.draining
				.extend(waiters.into_iter().map(|tx| (sent, tx)));
		} else {
			// Everything sent is delivered (or never will be): resolve now, not
			// when this frame ends after the park below.
			drop(waiters);
		}
		state.paused = true;
		state.paused_at = sent;
		while state.paused && !state.closed {
			self.resumed.wait(&mut state);
		}
		state.paused = false;
		!state.closed
	}

	/// Block until `fd` is readable (true) or the gate was woken (false).
	fn wait_readable(&self, fd: i32) -> std::io::Result<bool> {
		use std::os::fd::AsRawFd;
		let wake_fd = self.wake_rx.as_raw_fd();
		let mut fds = [libc::pollfd { fd, events: libc::POLLIN, revents: 0 }, libc::pollfd {
			fd:      wake_fd,
			events:  libc::POLLIN,
			revents: 0,
		}];
		loop {
			// SAFETY: polls the two valid `pollfd` entries above.
			if unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) } >= 0 {
				break;
			}
			let error = std::io::Error::last_os_error();
			if error.kind() != std::io::ErrorKind::Interrupted {
				return Err(error);
			}
		}
		if fds[1].revents != 0 {
			let mut sink = [0u8; 64];
			// SAFETY: reads into the valid local buffer; the pipe is nonblocking.
			while unsafe { libc::read(wake_fd, sink.as_mut_ptr().cast(), sink.len()) } > 0 {}
			// Re-check the gate before reading so a pending pause wins.
			return Ok(false);
		}
		// POLLHUP/POLLERR also land here: the read reports EOF or the error.
		Ok(fds[0].revents != 0)
	}
}

/// Clears the session's output gate and closes it when [`drive_pty`] returns.
#[cfg(unix)]
struct GateGuard<'a> {
	gate:    Arc<OutputGate>,
	handles: &'a Mutex<PtyHandles>,
}

#[cfg(unix)]
impl Drop for GateGuard<'_> {
	fn drop(&mut self) {
		self.handles.lock().output = None;
		self.gate.close();
	}
}

/// Everything [`drive_pty`] needs from a spawned or adopted PTY child.
struct PtyIo {
	master:    PtyMaster,
	/// Output side of the master. Unix polls it alongside the pause wakeup
	/// before each read.
	reader:    File,
	writer:    File,
	child_pid: Option<i32>,
	/// Blocks until the child exits; returns its exit code.
	wait:      Box<dyn FnOnce() -> std::io::Result<i32> + Send>,
}

/// Drive an adopted master fd and child pid until the child exits.
#[cfg(unix)]
fn run_adopted_sync(
	fd: std::os::fd::OwnedFd,
	pid: i32,
	on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
	control_tx: flume::Sender<ControlMessage>,
	control_rx: flume::Receiver<ControlMessage>,
	ct: task::CancelToken,
	handles: &Mutex<PtyHandles>,
) -> Result<PtyRunResult> {
	let clone = |what: &str| {
		fd.try_clone()
			.map(File::from)
			.map_err(|err| Error::from_reason(format!("Failed to create PTY {what}: {err}")))
	};
	let reader = clone("reader")?;
	let writer = clone("writer")?;
	let io = PtyIo {
		master: PtyMaster(fd),
		reader,
		writer,
		child_pid: Some(pid),
		wait: Box::new(move || wait_pid_exit_code(pid)),
	};
	drive_pty(io, on_chunk, control_tx, control_rx, ct, handles)
}

/// Blocking `waitpid` for `pid`; a signal death reports exit code 1, as a
/// spawned child's does.
#[cfg(unix)]
fn wait_pid_exit_code(pid: i32) -> std::io::Result<i32> {
	let mut status = 0;
	loop {
		// SAFETY: blocking waitpid on a specific pid with a valid out pointer.
		if unsafe { libc::waitpid(pid, &mut status, 0) } == pid {
			break;
		}
		let error = std::io::Error::last_os_error();
		if error.kind() != std::io::ErrorKind::Interrupted {
			return Err(error);
		}
	}
	Ok(if libc::WIFEXITED(status) {
		libc::WEXITSTATUS(status)
	} else {
		1
	})
}

fn run_pty_sync(
	config: PtyRunConfig,
	on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
	on_start: Option<ThreadsafeFunction<u32>>,
	control_tx: flume::Sender<ControlMessage>,
	control_rx: flume::Receiver<ControlMessage>,
	ct: task::CancelToken,
	handles: &Mutex<PtyHandles>,
) -> Result<PtyRunResult> {
	let (program, args) = match config.command {
		PtyCommand::Shell { command, shell } => {
			let shell = shell.unwrap_or_else(|| "sh".to_owned());
			let lower = shell.to_lowercase();
			let flag = if lower.ends_with("cmd.exe") || lower.ends_with("cmd") {
				"/c"
			} else if lower.contains("powershell") || lower.contains("pwsh") {
				"-Command"
			} else {
				"-lc"
			};
			(shell, vec![flag.to_owned(), command])
		},
		PtyCommand::Argv { application, args } => (application, args),
	};
	// Drop repo-location overrides before the explicit env below is applied:
	// the terminal's `git` rediscovers the repository from `cwd`, while a
	// caller-supplied value still wins.
	let mut env = env::Env::inherited();
	env.remove(&omp_shell::shell::GIT_REPO_LOCATION_ENV_VARS);
	for (key, value) in config.env.iter().flatten() {
		env.set(key, value);
	}
	let spawn = Spawn {
		program: &program,
		args:    &args,
		cwd:     config.cwd.as_deref().map(Path::new),
		env:     &env,
	};
	ct.heartbeat()
		.map_err(|err| Error::from_reason(format!("PTY setup cancelled before openpty: {err}")))?;
	let spawn_failed =
		|err: std::io::Error| Error::from_reason(format!("Failed to spawn PTY command: {err}"));

	#[cfg(unix)]
	let (master, mut child) = {
		let size = omp_shell::bash::TtyInfo { rows: config.rows, cols: config.cols };
		let (master, slave, _) = omp_shell::sys::tty::open_pty(Some(size))
			.map_err(|err| Error::from_reason(format!("Failed to open PTY: {err}")))?;
		ct.heartbeat()
			.map_err(|err| Error::from_reason(format!("PTY setup cancelled before spawn: {err}")))?;
		(master, unix::spawn(slave, &spawn).map_err(spawn_failed)?)
	};
	#[cfg(unix)]
	let child_process_id = child.id();

	#[cfg(windows)]
	let (pty, process) = {
		// Opening a pseudoconsole can hang indefinitely when the console
		// subsystem isn't properly initialized. Use a short startup timeout so
		// the Promise rejects instead of hanging forever.
		const PTY_STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
		let (tx, rx) = flume::bounded(1);
		let (cols, rows) = (config.cols, config.rows);
		std::thread::spawn(move || {
			let _ = tx.send(conpty::open(cols, rows));
		});
		let pty = match rx.recv_timeout(PTY_STARTUP_TIMEOUT) {
			Ok(Ok(pty)) => pty,
			Ok(Err(e)) => return Err(Error::from_reason(format!("Failed to open PTY: {e}"))),
			Err(_) => {
				return Err(Error::from_reason(
					"PTY creation timed out (5s). ConPTY may be unavailable on this system.",
				));
			},
		};
		ct.heartbeat()
			.map_err(|err| Error::from_reason(format!("PTY setup cancelled before spawn: {err}")))?;
		let process = conpty::launch(&pty.console, &spawn).map_err(spawn_failed)?;
		(pty, process)
	};
	#[cfg(windows)]
	let child_process_id = process.pid();

	let child_pid = i32::try_from(child_process_id).ok();
	if let Some(callback) = on_start.as_ref() {
		callback.call(Ok(child_process_id), ThreadsafeFunctionCallMode::NonBlocking);
	}
	// No heartbeat check here: the child is now a real, already-`exec`'d OS
	// process, and bailing out via `?` at this point would drop the master
	// without ever killing or reaping it — the master hangup delivers SIGHUP
	// to the child (it's the pty's session leader), which kills it almost
	// immediately, but nothing calls wait() afterward, so it leaks as a
	// permanent zombie. A cancellation here is instead delivered by the
	// cancel forwarder below (immediately, for an already-aborted token) and
	// handled by the control loop, which kills, and whose waiter thread
	// reaps, correctly.

	// Unix: plain dups of the master fd, so teardown writes nothing to the
	// terminal (a newline written there after the child is gone would be
	// echoed back into the output as a stray blank line).
	#[cfg(unix)]
	let io = {
		let clone = |what: &str| {
			master
				.try_clone()
				.map(File::from)
				.map_err(|err| Error::from_reason(format!("Failed to create PTY {what}: {err}")))
		};
		let (reader, writer) = (clone("reader")?, clone("writer")?);
		PtyIo {
			master: PtyMaster(master),
			reader,
			writer,
			child_pid,
			wait: Box::new(move || child.wait().map(|status| status.code().unwrap_or(1))),
		}
	};
	#[cfg(windows)]
	let io = {
		let conpty::Pty { console, input: mut writer, output: reader } = pty;
		// ConPTY sends ESC[6n (cursor position query) and blocks until we reply.
		// Reply with cursor at 1,1 so it unblocks the child spawn.
		let _ = writer.write_all(b"\x1b[1;1R");
		let _ = writer.flush();
		PtyIo {
			master: PtyMaster(console),
			reader,
			writer,
			child_pid,
			wait: Box::new(move || {
				process
					.wait()
					.map(|code| i32::try_from(code).unwrap_or(i32::MAX))
			}),
		}
	};
	drive_pty(io, on_chunk, control_tx, control_rx, ct, handles)
}

/// Stream output, apply control messages, and tear down once the child exits
/// or the run is terminated.
fn drive_pty(
	io: PtyIo,
	on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
	control_tx: flume::Sender<ControlMessage>,
	control_rx: flume::Receiver<ControlMessage>,
	ct: task::CancelToken,
	handles: &Mutex<PtyHandles>,
) -> Result<PtyRunResult> {
	let PtyIo { master, mut reader, mut writer, child_pid, wait } = io;
	#[cfg(unix)]
	let gate = Arc::new(
		OutputGate::new()
			.map_err(|err| Error::from_reason(format!("Failed to create PTY output gate: {err}")))?,
	);
	{
		let mut handles = handles.lock();
		handles.pid = child_pid;
		#[cfg(unix)]
		{
			use std::os::fd::AsRawFd;
			handles.master_fd = Some(master.0.as_raw_fd());
			handles.output = Some(Arc::clone(&gate));
		}
	}
	#[cfg(unix)]
	let _gate_guard = GateGuard { gate: Arc::clone(&gate), handles };

	// The reader→JS queue is bounded like the bash bridge (#4078): a full queue
	// parks the reader's `send`, filling the OS PTY buffer and backpressuring
	// the child. A separate pump task `call_async`s so the control loop never
	// waits on JS (input/resize/kill/exit stay live).
	let (reader_tx, reader_rx) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
	let queued = reader_tx.clone();
	#[cfg(unix)]
	let reader_gate = Arc::clone(&gate);
	let reader_thread = std::thread::spawn(move || {
		const BUF: usize = 65536;
		let mut buf = vec![0u8; BUF];
		let mut decoder = OutputDecoder::new();
		// Once the pump is gone (JS failed, or a wedged `on_chunk` hit the
		// stall timeout) keep reading and discard: the child must not block on
		// a full PTY buffer that nothing drains (#12657).
		let mut forwarding = true;
		// Text bytes handed to the pump, for pause delivery tracking.
		#[cfg(unix)]
		let mut sent = 0u64;
		loop {
			#[cfg(unix)]
			{
				use std::os::fd::AsRawFd;
				if reader_gate.pause_requested() {
					if forwarding {
						let rest = decoder.finish();
						if !rest.is_empty() {
							sent += rest.len() as u64;
							forwarding = reader_tx.send(ReaderEvent::Chunk(rest)).is_ok();
						}
					}
					if !reader_gate.hold(sent, forwarding) {
						// The run ended while paused: leave the rest unread.
						return;
					}
					continue;
				}
				match reader_gate.wait_readable(reader.as_raw_fd()) {
					Ok(true) => {},
					Ok(false) => continue,
					Err(_) => break,
				}
			}
			match reader.read(&mut buf) {
				Ok(0) => break,
				Err(error)
					if matches!(
						error.kind(),
						std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
					) => {},
				Err(_) => break,
				Ok(n) if forwarding => {
					let text = decoder.push(&buf[..n]);
					if !text.is_empty() {
						#[cfg(unix)]
						{
							sent += text.len() as u64;
						}
						forwarding = reader_tx.send(ReaderEvent::Chunk(text)).is_ok();
					}
				},
				Ok(_) => {},
			}
		}
		if !forwarding {
			return;
		}
		let rest = decoder.finish();
		if !rest.is_empty() && reader_tx.send(ReaderEvent::Chunk(rest)).is_err() {
			return;
		}
		let _ = reader_tx.send(ReaderEvent::Done);
	});

	// Pin the kill targets before the waiter thread can reap the child: after
	// the reap its pid may be recycled, and a pid-only signal (a lookup at
	// cancellation time, or a cloned killer handle) would hit whatever
	// process took it (#4605). The child is only ever signalled through
	// `pinned_child`.
	let mut targets = ps::TerminationTargets::new();
	#[cfg(unix)]
	if let Some(pgid) = master.process_group_leader().filter(|pgid| *pgid > 0) {
		targets.add_pgid(pgid);
	}
	let pinned_child = child_pid.and_then(omp_shell::proctree::Process::from_pid);
	if let Some(process) = &pinned_child {
		targets.add_process(process.clone());
	}
	// Exit, cancellation and JS failure all arrive as control messages, so the
	// loop below parks in `recv` instead of polling `try_wait`/`heartbeat` on a
	// timer: an idle session costs no wakeups, and exit is seen immediately.
	// `wait` also guarantees the reap even after the run stops waiting for a
	// SIGKILL'd child (`std::process::Child` never waits on `Drop`).
	let exit_tx = control_tx.clone();
	std::thread::spawn(move || {
		let _ = exit_tx.send(ControlMessage::Exited(wait()));
	});
	let cancel_tx = control_tx.clone();
	let cancel_task = napi::tokio::spawn(async move {
		let timed_out = matches!(ct.wait().await, task::AbortReason::Timeout);
		let _ = cancel_tx.send(ControlMessage::Cancelled { timed_out });
	});
	let in_js = Arc::new(AtomicBool::new(false));
	let (pump_done_tx, pump_done_rx) = flume::bounded::<()>(1);
	let pump_task = {
		let in_js = Arc::clone(&in_js);
		#[cfg(unix)]
		let gate = Arc::clone(&gate);
		#[cfg(unix)]
		let pump_gate = Arc::clone(&gate);
		napi::tokio::spawn(async move {
			pump_chunks(
				reader_rx,
				FORWARD_STALL_TIMEOUT,
				Some(in_js.as_ref()),
				async move |payload| {
					#[cfg(unix)]
					let len = payload.len();
					let ok = match on_chunk.as_ref() {
						Some(callback) => callback.call_async(Ok(payload)).await.is_ok(),
						None => true,
					};
					if !ok {
						let _ = control_tx.send(ControlMessage::JsGone);
						return false;
					}
					#[cfg(unix)]
					pump_gate.delivered(len);
					true
				},
			)
			.await;
			#[cfg(unix)]
			gate.undeliverable();
			let _ = pump_done_tx.send(());
		})
	};
	let abort_pump = pump_task.abort_handle();

	let mut timed_out = false;
	let mut cancelled = false;
	// Set when termination starts: SIGKILL is due at `kill_at` (or as soon as
	// the child exits, for the rest of its group), and the run stops waiting
	// for an exit status at `give_up_at`.
	let mut kill_at: Option<Instant> = None;
	let mut give_up_at: Option<Instant> = None;
	let status = loop {
		let next = match kill_at.or(give_up_at) {
			Some(deadline) => control_rx.recv_deadline(deadline),
			None => control_rx
				.recv()
				.map_err(|_| flume::RecvTimeoutError::Disconnected),
		};
		let terminate = match next {
			Ok(ControlMessage::Input(data)) => {
				let _ = writer.write_all(data.as_bytes());
				let _ = writer.flush();
				false
			},
			Ok(ControlMessage::Resize { cols, rows }) => {
				master.resize(cols, rows);
				false
			},
			Ok(ControlMessage::Kill) => {
				cancelled = true;
				true
			},
			// The first termination cause decides `cancelled`/`timed_out`.
			Ok(ControlMessage::JsGone) if give_up_at.is_none() => {
				cancelled = true;
				true
			},
			Ok(ControlMessage::Cancelled { timed_out: by_timeout }) if give_up_at.is_none() => {
				timed_out = by_timeout;
				cancelled = !by_timeout;
				true
			},
			Ok(ControlMessage::JsGone | ControlMessage::Cancelled { .. }) => false,
			Ok(ControlMessage::Exited(status)) => {
				if kill_at.is_some() {
					targets.signal(ps::KILL_SIGNAL);
				}
				break Some(status);
			},
			Err(flume::RecvTimeoutError::Timeout) if kill_at.take().is_some() => {
				targets.signal(ps::KILL_SIGNAL);
				false
			},
			// `give_up_at` passed; disconnect cannot happen while the waiter
			// thread still holds its sender.
			Err(_) => break None,
		};
		if terminate && give_up_at.is_none() {
			targets.signal(ps::TERM_SIGNAL);
			// The hangup a closing terminal delivers: interactive shells ignore
			// SIGTERM but exit on SIGHUP. On Windows TERM already terminated it.
			#[cfg(unix)]
			if let Some(process) = &pinned_child {
				let _ = process.signal(libc::SIGHUP);
			}
			let now = Instant::now();
			kill_at = Some(now + KILL_GRACE);
			give_up_at = Some(now + KILL_GRACE + CANCEL_EXIT_WAIT);
		}
	};
	cancel_task.abort();
	let exit_code = status
		.transpose()
		.map_err(|err| Error::from_reason(format!("Failed waiting PTY process: {err}")))?;
	// --- Teardown ---

	// Step 1: Close the ConPTY input pipe first.
	// Per Microsoft docs, close the input handle before calling
	// ClosePseudoConsole. This signals to ConPTY that no more input will
	// arrive, allowing its internal I/O threads to finish processing and
	// eventually close the output pipe.
	drop(writer);

	// Step 2: Drop master so the reader sees EOF if the slave is gone, then
	// drain JS. Successful finite runs wait until every accepted chunk has
	// reached `on_chunk` (#7421). A reader parked on backpressure is not
	// aborted. A descendant holding the slave open is the existing no-join
	// case and is the only path that may skip an unbounded wait.
	// Cleared before the master closes: `awaits_input` uses the fd under this
	// lock, and a closed fd number can be reused by an unrelated file.
	{
		let mut handles = handles.lock();
		handles.master_fd = None;
		handles.pid = None;
	}
	#[cfg(windows)]
	{
		let (drop_tx, drop_rx) = flume::unbounded::<()>();
		std::thread::spawn(move || {
			drop(master);
			let _ = drop_tx.send(());
		});
		let _ = drop_rx.recv_timeout(Duration::from_secs(2));
	}
	#[cfg(not(windows))]
	{
		drop(master);
	}
	await_pty_output_drain(
		pump_done_rx,
		reader_thread,
		queued,
		&in_js,
		cancelled || timed_out,
		|| abort_pump.abort(),
	);
	drop(pump_task);
	Ok(PtyRunResult { exit_code, cancelled, timed_out })
}

/// Wait for the JS pump after the child has exited and the master is dropped.
///
/// `queued` is a clone of the reader sender, used only to see whether the
/// bridge still holds bytes (backpressure vs open slave). It is dropped as
/// soon as the reader has exited so the pump is not left parked on `recv`.
///
/// Cancel/timeout must not pin the promise on a slow callback. A successful
/// finite run must not resolve until accepted output reached `on_chunk`
/// (#7421). After reader EOF, wait for the pump with no idle timeout. A
/// reader parked on a full bridge is backpressure, not a hang. Only a
/// permanently open slave (EOF never arrives, queue empty, no in-flight
/// callback) may skip the unbounded wait. `stop_pump` is invoked on every
/// abandonment path, then this waits up to `POST_CANCEL_DRAIN_TIMEOUT` for
/// the pump task to observe abort so `start()` does not resolve while
/// `call_async` is still in Rust. An already-queued napi callback can still
/// run once; TSFN work lives on the JS thread.
fn await_pty_output_drain(
	pump_done_rx: flume::Receiver<()>,
	reader_thread: std::thread::JoinHandle<()>,
	queued: flume::Sender<ReaderEvent>,
	in_js: &AtomicBool,
	abandon_slow_js: bool,
	stop_pump: impl FnOnce(),
) {
	let mut stop_pump = Some(stop_pump);

	if abandon_slow_js {
		if let Some(stop_pump) = stop_pump.take() {
			stop_pump();
		}
		drop(queued);
		let _ = pump_done_rx.recv_timeout(POST_CANCEL_DRAIN_TIMEOUT);
		if reader_thread.is_finished() {
			let _ = reader_thread.join();
		}
		return;
	}

	loop {
		if reader_thread.is_finished() {
			drop(queued);
			// Unbounded by design (#7421, same as shell.rs `drain_handle.await`).
			let _ = pump_done_rx.recv();
			let _ = reader_thread.join();
			return;
		}

		match pump_done_rx.recv_timeout(STUCK_SLAVE_IDLE) {
			Ok(()) | Err(flume::RecvTimeoutError::Disconnected) => {
				if reader_thread.is_finished() {
					let _ = reader_thread.join();
				}
				return;
			},
			Err(flume::RecvTimeoutError::Timeout) => {
				if reader_thread.is_finished() {
					continue;
				}
				if queued.is_empty() && !in_js.load(Ordering::Acquire) {
					if let Some(stop_pump) = stop_pump.take() {
						stop_pump();
					}
					drop(queued);
					let _ = pump_done_rx.recv_timeout(POST_CANCEL_DRAIN_TIMEOUT);
					return;
				}
			},
		}
	}
}

#[cfg(test)]
mod reader_queue_tests {
	use std::{
		sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
		},
		time::{Duration, Instant},
	};

	use super::{
		BRIDGE_QUEUE_CHUNKS, POST_CANCEL_DRAIN_TIMEOUT, ReaderEvent, STUCK_SLAVE_IDLE,
		await_pty_output_drain,
	};

	#[test]
	fn drain_waits_for_slow_js_after_reader_eof() {
		let (pump_tx, pump_rx) = flume::bounded(1);
		let reader = std::thread::spawn(|| {});
		let (queued, _) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
		let in_js = AtomicBool::new(false);
		std::thread::spawn(move || {
			std::thread::sleep(Duration::from_millis(2500));
			let _ = pump_tx.send(());
		});
		let start = Instant::now();
		await_pty_output_drain(pump_rx, reader, queued, &in_js, false, || {});
		assert!(
			start.elapsed() >= Duration::from_millis(2400),
			"must not time out a slow callback after reader EOF",
		);
	}

	#[test]
	fn drain_drops_sender_clone_after_reader_eof_so_pump_unblocks() {
		let (reader_tx, reader_rx) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
		let queued = reader_tx.clone();
		drop(reader_tx);
		let (pump_tx, pump_rx) = flume::bounded(1);
		std::thread::spawn(move || {
			let _ = reader_rx.recv();
			let _ = pump_tx.send(());
		});
		let reader = std::thread::spawn(|| {});
		let deadline = Instant::now() + Duration::from_secs(1);
		while !reader.is_finished() && Instant::now() < deadline {
			std::thread::sleep(Duration::from_millis(1));
		}
		assert!(reader.is_finished(), "reader fixture must have exited");
		let in_js = AtomicBool::new(false);
		let start = Instant::now();
		await_pty_output_drain(pump_rx, reader, queued, &in_js, false, || {});
		assert!(
			start.elapsed() < STUCK_SLAVE_IDLE,
			"holding the sender clone after EOF parks the pump until idle timeout",
		);
	}

	#[test]
	fn drain_gives_up_only_on_open_slave_idle() {
		let (_pump_tx, pump_rx) = flume::bounded::<()>(1);
		let reader = std::thread::spawn(|| {
			std::thread::park();
		});
		let (queued, _) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
		let in_js = AtomicBool::new(false);
		let stopped = AtomicBool::new(false);
		let start = Instant::now();
		await_pty_output_drain(pump_rx, reader, queued, &in_js, false, || {
			stopped.store(true, Ordering::Release);
		});
		let elapsed = start.elapsed();
		assert!(elapsed >= STUCK_SLAVE_IDLE);
		assert!(elapsed < STUCK_SLAVE_IDLE + Duration::from_secs(2));
		assert!(stopped.load(Ordering::Acquire), "open slave must stop the pump");
	}

	#[test]
	fn drain_does_not_treat_queued_backpressure_as_stuck_slave() {
		let (pump_tx, pump_rx) = flume::bounded(1);
		let reader = std::thread::spawn(std::thread::park);
		let (queued, _rx) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
		queued
			.send(ReaderEvent::Chunk("x".into()))
			.expect("queue accepts a chunk");
		let in_js = AtomicBool::new(false);
		std::thread::spawn(move || {
			std::thread::sleep(Duration::from_millis(2500));
			let _ = pump_tx.send(());
		});
		let start = Instant::now();
		await_pty_output_drain(pump_rx, reader, queued, &in_js, false, || {});
		assert!(
			start.elapsed() >= Duration::from_millis(2400),
			"queued output is backpressure, not a stuck slave",
		);
	}

	#[test]
	fn drain_does_not_treat_in_flight_callback_as_stuck_slave() {
		let (pump_tx, pump_rx) = flume::bounded(1);
		let reader = std::thread::spawn(std::thread::park);
		let (queued, _) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
		let in_js = Arc::new(AtomicBool::new(true));
		let in_js_flag = Arc::clone(&in_js);
		std::thread::spawn(move || {
			std::thread::sleep(Duration::from_millis(2500));
			in_js_flag.store(false, Ordering::Release);
			let _ = pump_tx.send(());
		});
		let start = Instant::now();
		await_pty_output_drain(pump_rx, reader, queued, &in_js, false, || {});
		assert!(
			start.elapsed() >= Duration::from_millis(2400),
			"an in-flight on_chunk is slow JS, not a stuck slave",
		);
	}

	#[test]
	fn drain_cancel_does_not_wait_for_slow_js() {
		let (_pump_tx, pump_rx) = flume::bounded::<()>(1);
		let reader = std::thread::spawn(std::thread::park);
		let (queued, _) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
		let in_js = AtomicBool::new(true);
		let stopped = AtomicBool::new(false);
		let start = Instant::now();
		await_pty_output_drain(pump_rx, reader, queued, &in_js, true, || {
			stopped.store(true, Ordering::Release);
		});
		assert!(
			start.elapsed() < Duration::from_secs(2),
			"cancel must not pin the promise on a stalled callback",
		);
		assert!(start.elapsed() >= POST_CANCEL_DRAIN_TIMEOUT);
		assert!(stopped.load(Ordering::Acquire), "cancel must stop the pump");
	}

	#[test]
	fn drain_cancel_returns_once_pump_observes_stop() {
		let (pump_tx, pump_rx) = flume::bounded::<()>(1);
		let reader = std::thread::spawn(std::thread::park);
		let (queued, _) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
		let in_js = AtomicBool::new(true);
		let start = Instant::now();
		await_pty_output_drain(pump_rx, reader, queued, &in_js, true, move || {
			drop(pump_tx);
		});
		assert!(
			start.elapsed() < POST_CANCEL_DRAIN_TIMEOUT,
			"after stop disconnects the pump, cancel must not sit out the full drain timeout",
		);
	}
}

#[cfg(all(test, unix))]
mod output_gate_tests {
	use std::{
		sync::Arc,
		time::{Duration, Instant},
	};

	use super::OutputGate;

	/// A pause whose output is already delivered resolves while the reader is
	/// parked, not only once `resume` lets it go.
	#[test]
	fn delivered_pause_resolves_while_reader_is_held() {
		let gate = Arc::new(OutputGate::new().unwrap());
		gate.delivered(5);
		let mut stopped = gate
			.pause()
			.expect("a running reader has a pause to wait for");
		let reader = {
			let gate = Arc::clone(&gate);
			std::thread::spawn(move || gate.hold(5, true))
		};
		let deadline = Instant::now() + Duration::from_secs(5);
		while matches!(stopped.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty)) {
			assert!(Instant::now() < deadline, "pause never resolved while the reader was held");
			std::thread::sleep(Duration::from_millis(5));
		}
		gate.resume();
		assert!(reader.join().unwrap(), "resume releases the reader");
	}
}

#[cfg(all(test, unix))]
mod input_wait_tests {
	use std::thread;

	use super::*;

	/// What `awaits_input` reports for `script` on a PTY, sampled every 50ms
	/// for a second once the session started.
	fn observe(script: &str) -> Vec<Option<bool>> {
		let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
		let handles = Arc::new(Mutex::new(PtyHandles::default()));
		let (tx, rx) = flume::unbounded();
		let config = PtyRunConfig {
			command: PtyCommand::Argv {
				application: "/bin/sh".to_string(),
				args:        vec!["-c".to_string(), script.to_string()],
			},
			cwd:     None,
			env:     None,
			cols:    80,
			rows:    24,
		};
		let run = {
			let handles = Arc::clone(&handles);
			let tx = tx.clone();
			let runtime = runtime.handle().clone();
			// `run_pty_sync` spawns its pump on the ambient Tokio runtime.
			thread::spawn(move || {
				let _runtime = runtime.enter();
				run_pty_sync(config, None, None, tx, rx, task::CancelToken::new(None, None), &handles)
			})
		};
		while handles.lock().master_fd.is_none() {
			thread::sleep(Duration::from_millis(10));
		}
		let samples = (0..20)
			.map(|_| {
				thread::sleep(Duration::from_millis(50));
				input_wait::probe(&handles)
			})
			.collect();
		let _ = tx.send(ControlMessage::Kill);
		let _ = run.join();
		samples
	}

	#[test]
	fn echo_off_awaits_input() {
		assert_eq!(observe("stty -echo; sleep 5").last(), Some(&Some(true)));
	}

	#[test]
	fn line_prompt_awaits_input_where_detectable() {
		let expected = if cfg!(target_os = "linux") {
			Some(true)
		} else {
			None
		};
		assert_eq!(observe("printf 'Proceed? [y/N] '; read answer").last(), Some(&expected));
	}

	#[test]
	fn busy_program_never_awaits_input() {
		let samples = observe("sleep 5");
		assert!(!samples.contains(&Some(true)), "{samples:?}");
		let expected = if cfg!(target_os = "linux") {
			Some(false)
		} else {
			None
		};
		assert_eq!(samples.last(), Some(&expected));
	}
}

#[cfg(all(test, target_os = "linux"))]
mod zombie_repro_tests {
	//! Reproduces the leaked-zombie race fixed above: a PTY session cancelled
	//! (timed out) shortly after spawn used to abandon its child unreaped, and
	//! `std::process::Child` never waits on `Drop`, so the process stuck around
	//! as a permanent zombie.
	//!
	//! `#[ignore]`d: it saturates every core to provoke the scheduler races, so
	//! it must run alone. `cargo nextest run --run-ignored ignored-only
	//! --test-threads=1 -E 'test(zombie_repro_tests)'`

	use std::{
		collections::HashSet,
		sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
		},
		thread,
	};

	use super::*;

	const STORM_CHILD_COMM: &str = "sleep";

	/// Zombie PIDs parented to this test process and spawned as
	/// `STORM_CHILD_COMM`. The comm filter keeps a sibling test's
	/// exited-before-wait child from counting as a leak here.
	fn zombie_child_pids() -> HashSet<u32> {
		let my_pid = std::process::id();
		let mut pids = HashSet::new();
		let Ok(entries) = std::fs::read_dir("/proc") else {
			return pids;
		};
		for entry in entries.flatten() {
			let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
				continue;
			};
			let Ok(pid) = name.parse::<u32>() else {
				continue;
			};
			let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
				continue;
			};
			// `/proc/[pid]/stat` is `pid (comm) state ppid ...`; comm can itself
			// contain spaces and parens, so bound it by the first `(` and last
			// `)`.
			let (Some(open), Some(close)) = (stat.find('('), stat.rfind(')')) else {
				continue;
			};
			if stat.get(open + 1..close) != Some(STORM_CHILD_COMM) {
				continue;
			}
			let fields: Vec<&str> = stat[close + 1..].split_whitespace().collect();
			let (Some(state), Some(ppid)) = (fields.first(), fields.get(1)) else {
				continue;
			};
			if *state == "Z" && ppid.parse::<u32>() == Ok(my_pid) {
				pids.insert(pid);
			}
		}
		pids
	}

	struct StormOutcome {
		leaked:  usize,
		spawned: usize,
	}

	/// Run `iterations` PTY sessions cancelled ~1ms after spawn while every core
	/// is kept contended.
	fn run_cancel_storm(iterations: usize) -> StormOutcome {
		let before = zombie_child_pids();
		// `run_pty_sync` spawns its pump and cancel forwarder on the ambient
		// Tokio runtime (in production, the napi one it runs under).
		let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
		let _runtime = runtime.enter();

		let stop = Arc::new(AtomicBool::new(false));
		let busy: Vec<_> = (0..thread::available_parallelism().map_or(8, |n| n.get()))
			.map(|_| {
				let stop = Arc::clone(&stop);
				thread::spawn(move || {
					while !stop.load(Ordering::Relaxed) {
						std::hint::spin_loop();
					}
				})
			})
			.collect();

		let mut spawned = 0;
		for _ in 0..iterations {
			let (tx, rx) = flume::unbounded();
			let ct = task::CancelToken::new(Some(1), None);
			let config = PtyRunConfig {
				command: PtyCommand::Argv {
					application: STORM_CHILD_COMM.to_string(),
					args:        vec!["5".to_string()],
				},
				cwd:     None,
				env:     None,
				cols:    80,
				rows:    24,
			};
			// Pre-spawn heartbeats bail with `Err`, so `Ok` means this iteration
			// reached the post-spawn cancellation path.
			if run_pty_sync(config, None, None, tx, rx, ct, &Mutex::default()).is_ok() {
				spawned += 1;
			}
		}

		stop.store(true, Ordering::Relaxed);
		for handle in busy {
			let _ = handle.join();
		}
		// Let a slow reap land so only truly abandoned processes are counted.
		thread::sleep(Duration::from_millis(200));
		let leaked = zombie_child_pids().difference(&before).count();
		StormOutcome { leaked, spawned }
	}

	#[test]
	#[ignore]
	fn cancelled_pty_sessions_do_not_leak_zombies() {
		const ITERATIONS: usize = 60;
		let StormOutcome { leaked, spawned } = run_cancel_storm(ITERATIONS);
		assert_eq!(leaked, 0, "cancelled PTY sessions leaked {leaked} zombie process(es)");
		// Checked second so a real leak reports as one: a clean run only proves
		// something if children were actually spawned to begin with.
		assert!(
			spawned >= ITERATIONS / 3,
			"only {spawned}/{ITERATIONS} iterations reached the post-spawn cancellation path; the \
			 storm is not exercising the reap"
		);
	}
}
