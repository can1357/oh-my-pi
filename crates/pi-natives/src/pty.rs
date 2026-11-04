//! PTY-backed interactive command execution exported via N-API.
//!
//! # Overview
//! Provides a stateful PTY session that supports streaming output and stdin
//! passthrough while a command is running.

use std::{
	collections::HashMap,
	io::Write,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	time::{Duration, Instant},
};

use napi::{
	JsString,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
};
use napi_derive::napi;
use parking_lot::Mutex;
use pi_shell::output_decode::OutputDecoder;
use portable_pty::{CommandBuilder, ExitStatus, PtyPair, PtySize, native_pty_system};

use crate::{
	js::into_string,
	ps,
	shell::{
		BRIDGE_QUEUE_CHUNKS, BridgeItem, FORWARD_STALL_TIMEOUT, PumpEnd, pump_chunks,
		undelivered_output_error,
	},
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
	Exited(std::io::Result<ExitStatus>),
}

const POST_CANCEL_DRAIN_TIMEOUT: Duration = Duration::from_millis(300);
/// Idle window used only when the child has already exited, the reader has
/// *not* hit EOF, the bridge queue is empty, no `on_chunk` is in flight, and
/// the reader has handed over what the terminal held when the child had
/// gone. That is a permanently open slave (daemon / extra holder), not slow
/// JS or a starved reader. A reader parked on a full bridge is backpressure
/// and must not use this.
const STUCK_SLAVE_IDLE: Duration = Duration::from_secs(2);
/// Gap between the polite termination wave (TERM to the group/tree, HUP to the
/// child) and SIGKILL, so a child with a TERM/HUP handler can clean up. Same
/// grace portable-pty's `Child::kill` used to spend blocking the control loop.
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

/// Stateful PTY session for interactive stdin/stdout passthrough.
#[napi]
pub struct PtySession {
	core: Arc<Mutex<Option<PtySessionCore>>>,
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
		Self { core: Arc::new(Mutex::new(None)) }
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
		self.start_config(env, run_config, options.timeout_ms, options.signal, on_chunk, on_start)
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
		self.start_config(env, run_config, options.timeout_ms, options.signal, on_chunk, on_start)
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
}

impl PtySession {
	fn start_config<'env>(
		&self,
		env: &'env Env,
		run_config: PtyRunConfig,
		timeout_ms: Option<u32>,
		signal: Option<Unknown<'env>>,
		on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
		on_start: Option<ThreadsafeFunction<u32>>,
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
		task::future(env, "pty.start", async move {
			let run_result = tokio::task::spawn_blocking(move || {
				run_pty_sync(run_config, on_chunk, on_start, control_tx, control_rx, ct)
			})
			.await;

			let mut guard = core.lock();
			*guard = None;
			drop(guard);

			run_result
				.map_err(|err| Error::from_reason(format!("PTY execution task failed: {err}")))
				.flatten()
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

// Under test, the terminal setup step to fail, to prove no setup step can
// fail once the child exists.
#[cfg(test)]
thread_local! {
	static FAIL_SETUP_STEP: std::cell::Cell<Option<u8>> = const { std::cell::Cell::new(None) };
}

/// Fails terminal setup step `$step` when a test asks for it. It compiles to
/// nothing outside the tests.
#[cfg(test)]
macro_rules! setup_fault {
	($step:expr) => {
		if FAIL_SETUP_STEP.with(std::cell::Cell::get) == Some($step) {
			return Err(Error::from_reason(format!(
				"injected terminal setup failure at step {}",
				$step
			)));
		}
	};
}

#[cfg(not(test))]
macro_rules! setup_fault {
	($step:expr) => {};
}

fn run_pty_sync(
	config: PtyRunConfig,
	on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
	on_start: Option<ThreadsafeFunction<u32>>,
	control_tx: flume::Sender<ControlMessage>,
	control_rx: flume::Receiver<ControlMessage>,
	ct: task::CancelToken,
) -> Result<PtyRunResult> {
	let pty_system = native_pty_system();
	ct.heartbeat()
		.map_err(|err| Error::from_reason(format!("PTY setup cancelled before openpty: {err}")))?;

	const PTY_STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
	let pair = if cfg!(windows) {
		// Windows ConPTY openpty() can hang indefinitely when the console
		// subsystem isn't properly initialized. Use a short startup timeout
		// so the Promise rejects instead of hanging forever.
		let (tx, rx) = flume::unbounded();
		std::thread::spawn(move || {
			let result = pty_system.openpty(PtySize {
				rows:         config.rows,
				cols:         config.cols,
				pixel_width:  0,
				pixel_height: 0,
			});
			let _ = tx.send(result);
		});
		match rx.recv_timeout(PTY_STARTUP_TIMEOUT) {
			Ok(Ok(pair)) => pair,
			Ok(Err(e)) => return Err(Error::from_reason(format!("Failed to open PTY: {e}"))),
			Err(_) => {
				return Err(Error::from_reason(
					"PTY creation timed out (5s). ConPTY may be unavailable on this system.",
				));
			},
		}
	} else {
		pty_system
			.openpty(PtySize {
				rows:         config.rows,
				cols:         config.cols,
				pixel_width:  0,
				pixel_height: 0,
			})
			.map_err(|err| Error::from_reason(format!("Failed to open PTY: {err}")))?
	};

	let mut cmd = match config.command {
		PtyCommand::Shell { command, shell } => {
			let shell = shell.as_deref().unwrap_or("sh");
			let mut cmd = CommandBuilder::new(shell);
			let lower = shell.to_lowercase();
			if lower.ends_with("cmd.exe") || lower.ends_with("cmd") {
				cmd.arg("/c");
			} else if lower.contains("powershell") || lower.contains("pwsh") {
				cmd.arg("-Command");
			} else {
				cmd.arg("-lc");
			}
			cmd.arg(command);
			cmd
		},
		PtyCommand::Argv { application, args } => {
			let mut cmd = CommandBuilder::new(application);
			for arg in args {
				cmd.arg(arg);
			}
			cmd
		},
	};
	if let Some(cwd) = config.cwd.as_ref() {
		cmd.cwd(cwd);
	}
	// `CommandBuilder` starts from this process's environment, so drop
	// repo-location overrides before the explicit env below is applied: the
	// terminal's `git` rediscovers the repository from `cwd`, while a
	// caller-supplied value still wins.
	for name in pi_shell::shell::GIT_REPO_LOCATION_ENV_VARS {
		cmd.env_remove(name);
	}
	if let Some(env) = config.env.as_ref() {
		for (key, value) in env {
			cmd.env(key, value);
		}
	}
	ct.heartbeat()
		.map_err(|err| Error::from_reason(format!("PTY setup cancelled before spawn: {err}")))?;

	// Every handle on the terminal is taken before the child exists: a
	// failure here leaves no process behind, where after the spawn it would
	// drop the master without a kill or a wait and leave a zombie.
	let PtyPair { master, slave } = pair;
	setup_fault!(1);
	let mut writer = master
		.take_writer()
		.map_err(|err| Error::from_reason(format!("Failed to create PTY writer: {err}")))?;
	// On Unix the reader waits for output with `poll` and only then reads it,
	// so a read is always short and the drain can tell it apart from a wait
	// (see `read_terminal`).
	setup_fault!(2);
	#[cfg(unix)]
	let reader = master
		.as_raw_fd()
		.ok_or_else(|| {
			Error::from_reason("Failed to create PTY reader: the master has no descriptor")
		})
		.and_then(|fd| {
			// SAFETY: `fd` is the master's descriptor, open while `master` lives;
			// it is only duplicated here.
			unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) }
				.try_clone_to_owned()
				.map_err(|err| Error::from_reason(format!("Failed to create PTY reader: {err}")))
		})?;
	#[cfg(not(unix))]
	let mut reader = master
		.try_clone_reader()
		.map_err(|err| Error::from_reason(format!("Failed to create PTY reader: {err}")))?;
	// A second handle on the master counts what the terminal holds once the
	// master itself is dropped (see the drain). A host out of descriptors
	// fails the run here rather than leave the drain a count of zero for a
	// terminal that still holds output.
	setup_fault!(3);
	#[cfg(unix)]
	let unread_probe = reader
		.try_clone()
		.map_err(|err| Error::from_reason(format!("Failed to create PTY reader: {err}")))?;

	let mut child = slave
		.spawn_command(cmd)
		.map_err(|err| Error::from_reason(format!("Failed to spawn PTY command: {err}")))?;
	drop(slave);
	let child_process_id = child.process_id();
	let child_pid = child_process_id.and_then(|value| i32::try_from(value).ok());
	if let Some(callback) = on_start.as_ref() {
		callback.call(Ok(child_process_id.unwrap_or(0)), ThreadsafeFunctionCallMode::NonBlocking);
	}
	// No heartbeat check, and no other `?`, from here on: `child` now owns a
	// real, already-`exec`'d OS process, and bailing out at this point would
	// drop the master without ever killing or reaping it — the
	// master hangup delivers SIGHUP to the child (it's the pty's session
	// leader), which kills it almost immediately, but nothing calls
	// wait() afterward, so it leaks as a permanent zombie. A cancellation
	// here is instead delivered by the cancel forwarder below (immediately,
	// for an already-aborted token) and handled by the control loop, which
	// kills, and whose waiter thread reaps, correctly.

	// ConPTY sends ESC[6n (cursor position query) and blocks until we reply.
	// Reply with cursor at 1,1 so it unblocks the child spawn.
	// Only needed on Windows; on Unix/macOS this would corrupt stdin.
	#[cfg(windows)]
	{
		let _ = writer.write_all(b"\x1b[1;1R");
		let _ = writer.flush();
	}

	// The reader→JS queue is bounded like the bash bridge (#4078): a full queue
	// parks the reader's `send`, filling the OS PTY buffer and backpressuring
	// the child. A separate pump task `call_async`s so the control loop never
	// waits on JS (input/resize/kill/exit stay live).
	let (reader_tx, reader_rx) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
	let queued = reader_tx.clone();
	let progress = Arc::new(ReaderProgress::default());
	// Shared with the drain, which flushes a partial character the terminal
	// will not complete before it leaves a terminal a daemon holds open.
	let decoder = Arc::new(Mutex::new(OutputDecoder::new()));
	let reader_thread = std::thread::spawn({
		let progress = Arc::clone(&progress);
		let decoder = Arc::clone(&decoder);
		move || {
			const BUF: usize = 65536;
			let mut buf = vec![0u8; BUF];
			// Once the pump is gone (JS failed, or a wedged `on_chunk` hit the
			// stall timeout) keep reading and discard: the child must not block
			// on a full PTY buffer that nothing drains (#12657).
			let mut forwarding = true;
			loop {
				#[cfg(unix)]
				let read = read_terminal(&reader, &mut buf, &progress);
				#[cfg(not(unix))]
				let read = std::io::Read::read(&mut reader, &mut buf).inspect(|&n| {
					progress.read.fetch_add(n as u64, Ordering::AcqRel);
				});
				let n = match read {
					Ok(0) | Err(_) => break,
					Ok(n) => n,
				};
				if forwarding {
					// Held across the send, so the drain's flush of the decoder
					// queues its text after every chunk decoded before it.
					let mut decoder = decoder.lock();
					let text = decoder.push(&buf[..n]);
					forwarding = text.is_empty() || progress.hand(&reader_tx, text);
				}
				progress.handed.fetch_add(n as u64, Ordering::AcqRel);
				#[cfg(unix)]
				progress.answer(|| pty_unread_bytes(&reader));
			}
			if !forwarding {
				return;
			}
			if !hand_rest(&decoder, &progress, &reader_tx) {
				return;
			}
			let _ = reader_tx.send(ReaderEvent::Done);
		}
	});

	// Pin the kill targets before the waiter thread can reap the child: after
	// the reap its pid may be recycled, and a pid-only signal (a lookup at
	// cancellation time, or portable-pty's `clone_killer`) would hit whatever
	// process took it (#4605). The child is only ever signalled through
	// `pinned_child`.
	let mut targets = ps::TerminationTargets::new();
	#[cfg(unix)]
	if let Some(pgid) = master.process_group_leader().filter(|pgid| *pgid > 0) {
		targets.add_pgid(pgid);
	}
	let pinned_child = child_pid.and_then(pi_shell::process::Process::from_pid);
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
		let _ = exit_tx.send(ControlMessage::Exited(child.wait()));
	});
	let cancel_tx = control_tx.clone();
	let cancel_task = napi::tokio::spawn(async move {
		let timed_out = matches!(ct.wait().await, task::AbortReason::Timeout);
		let _ = cancel_tx.send(ControlMessage::Cancelled { timed_out });
	});
	let (pump_done_tx, pump_done_rx) = flume::bounded::<PumpEnd>(1);
	let pump_task = {
		let progress = Arc::clone(&progress);
		napi::tokio::spawn(async move {
			let end = pump_chunks(reader_rx, FORWARD_STALL_TIMEOUT, async move |payload| {
				let len = payload.len() as u64;
				if let Some(callback) = on_chunk.as_ref()
					&& callback.call_async(Ok(payload)).await.is_err()
				{
					let _ = control_tx.send(ControlMessage::JsGone);
					return false;
				}
				progress.forwarded_text.fetch_add(len, Ordering::AcqRel);
				true
			})
			.await;
			let _ = pump_done_tx.send(end);
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
				let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
				false
			},
			Ok(ControlMessage::Kill) => {
				cancelled = true;
				true
			},
			// The first termination cause decides `cancelled`/`timed_out`.
			Ok(ControlMessage::JsGone) if give_up_at.is_none() => true,
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
		.map_err(|err| Error::from_reason(format!("Failed waiting PTY process: {err}")))?
		.map(|status| i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
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
	// case and is the only path that may skip an unbounded wait, once what the
	// terminal held when the child had gone has reached `on_chunk`;
	// `unread_probe` counts that output.
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
	#[cfg(unix)]
	let unread = || pty_unread_bytes(&unread_probe);
	// ConPTY gives no count of unread output, and the reader there reads
	// blocking, so it cannot tell a read in flight from a wait either.
	#[cfg(not(unix))]
	let unread = || 0;
	let interrupted = cancelled || timed_out;
	let pump_end = await_pty_output_drain(
		pump_done_rx,
		reader_thread,
		queued,
		&progress,
		&decoder,
		unread,
		interrupted,
		|| abort_pump.abort(),
	);
	drop(pump_task);
	if let Some(error) = lost_terminal_output(pump_end, interrupted) {
		return Err(error);
	}
	Ok(PtyRunResult { exit_code, cancelled, timed_out })
}

/// Queues what `decoder` holds at the end of the output (a partial character
/// becomes U+FFFD); `false` once the pump is gone. The decoder stays locked
/// until that text is queued and counted, as for every chunk, so the drain
/// never flushes an empty decoder and counts the handed text without it.
fn hand_rest(
	decoder: &Mutex<OutputDecoder>,
	progress: &ReaderProgress,
	queue: &flume::Sender<ReaderEvent>,
) -> bool {
	let mut decoder = decoder.lock();
	let rest = decoder.finish();
	rest.is_empty() || progress.hand(queue, rest)
}

/// The error of a terminal run whose output was lost, from how its pump
/// ended. A callback that failed or stalled lost output: the run fails
/// whatever else ended the command (a kill, a timeout, or the failure itself),
/// so a later cancellation never hides the loss. A pump that panicked fails a
/// run that was not interrupted; an interrupted run stops its pump itself.
fn lost_terminal_output(pump_end: Option<PumpEnd>, interrupted: bool) -> Option<Error> {
	let lost = match pump_end? {
		end @ (PumpEnd::ConsumerGone | PumpEnd::Stalled) => end,
		PumpEnd::Panicked if !interrupted => PumpEnd::Panicked,
		PumpEnd::Panicked | PumpEnd::Drained => return None,
	};
	undelivered_output_error(lost)
}

/// How far the PTY reader thread and the pump have got. The drain compares
/// them with what the terminal held when the child had gone, to tell a reader
/// or a callback that is still delivering that output from a slave a daemon
/// holds open.
#[derive(Default)]
struct ReaderProgress {
	/// Odd while a read is taking output from the terminal and counting it in
	/// `read` (Unix; see `read_terminal`).
	reads:          AtomicU64,
	/// Bytes read from the terminal.
	read:           AtomicU64,
	/// Of those, bytes decoded (a partial character the decoder holds
	/// included) and their text queued, or dropped once the pump is gone.
	handed:         AtomicU64,
	/// Text queued for the pump.
	handed_text:    AtomicU64,
	/// Text the pump has delivered to `on_chunk`.
	forwarded_text: AtomicU64,
	/// Set by the drain to ask the reader what it is owed (see `answer`).
	asked:          AtomicBool,
	/// One more than the reader's answer; `0` until it answers.
	answered:       AtomicU64,
}

impl ReaderProgress {
	/// Queues `text` for the pump; `false` once the pump is gone.
	fn hand(&self, queue: &flume::Sender<ReaderEvent>, text: String) -> bool {
		let len = text.len() as u64;
		let sent = queue.send(ReaderEvent::Chunk(text)).is_ok();
		if sent {
			self.handed_text.fetch_add(len, Ordering::AcqRel);
		}
		sent
	}

	/// Between two reads, answers the drain if it asked: what has been read,
	/// plus what the terminal holds. The reader is the only one taking output,
	/// so the two agree however long counting the second takes; a reader that
	/// keeps reading would otherwise change the first while the drain counts.
	#[cfg(unix)]
	fn answer(&self, unread: impl FnOnce() -> u64) {
		if self.asked.swap(false, Ordering::AcqRel) {
			let owed = self.read.load(Ordering::Acquire).saturating_add(unread());
			self
				.answered
				.store(owed.saturating_add(1), Ordering::Release);
		}
	}
}

/// Reads the next output from the terminal into `buf` and counts it in
/// `progress.read`.
///
/// It waits for output with `poll` and reads only once some is there, so a
/// read never waits: `progress.reads` is odd only from just before a read
/// until its bytes are counted. While it is even, every byte taken from the
/// terminal so far is counted, which a blocking read could not tell apart
/// from a wait for output that has not come.
#[cfg(unix)]
fn read_terminal(
	terminal: &std::os::fd::OwnedFd,
	buf: &mut [u8],
	progress: &ReaderProgress,
) -> std::io::Result<usize> {
	use std::os::fd::AsRawFd as _;
	let fd = terminal.as_raw_fd();
	loop {
		let mut ready = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
		// SAFETY: `ready` is one valid `pollfd` for the call.
		if unsafe { libc::poll(&raw mut ready, 1, -1) } < 0 {
			let err = std::io::Error::last_os_error();
			if err.kind() == std::io::ErrorKind::Interrupted {
				continue;
			}
			return Err(err);
		}
		progress.reads.fetch_add(1, Ordering::AcqRel);
		// SAFETY: `buf` is writable for `buf.len()` bytes, and `fd` stays open
		// for the call.
		let read = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
		let read = if read < 0 {
			Err(std::io::Error::last_os_error())
		} else {
			progress.read.fetch_add(read as u64, Ordering::AcqRel);
			Ok(read as usize)
		};
		progress.reads.fetch_add(1, Ordering::AcqRel);
		match read {
			Err(err)
				if matches!(
					err.kind(),
					std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
				) => {},
			read => return read,
		}
	}
}

/// Bytes the terminal holds that its master has not read yet; `0` when the
/// count fails.
#[cfg(unix)]
fn pty_unread_bytes(master: &std::os::fd::OwnedFd) -> u64 {
	use std::os::fd::AsRawFd as _;
	let mut unread: libc::c_int = 0;
	// SAFETY: `FIONREAD` writes one `c_int` through the pointer, which is
	// valid for the call; the descriptor is owned by `master`.
	let status = unsafe { libc::ioctl(master.as_raw_fd(), libc::FIONREAD, &raw mut unread) };
	if status < 0 {
		0
	} else {
		u64::try_from(unread).unwrap_or(0)
	}
}

/// Wait for the JS pump after the child has exited and the master is dropped;
/// the pump's end when it ended on its own, `None` when this stopped it.
///
/// `queued` is a clone of the reader sender. It is dropped as soon as the
/// reader has exited so the pump is not left parked on `recv`.
///
/// Cancel/timeout must not pin the promise on a slow callback. A successful
/// finite run must not resolve until accepted output reached `on_chunk`
/// (#7421). After reader EOF, wait for the pump with no idle timeout. Only a
/// permanently open slave may skip the unbounded wait, and only after what
/// the terminal held when this started has reached `on_chunk`: every idle
/// window, once the reader has handed over every byte it had read and the
/// terminal held (`unread`) then, this flushes a partial character the
/// decoder holds (the terminal will not complete it), waits for the text
/// handed so far to be delivered, and stops the pump. A reader the scheduler
/// starved is still owed those bytes, so it is not cut off; a daemon that
/// keeps writing, however slowly `on_chunk` takes its output, cannot keep the
/// run open past them. `stop_pump` is invoked on every abandonment path, then
/// this waits up to `POST_CANCEL_DRAIN_TIMEOUT` for the pump task to observe
/// abort so `start()` does not resolve while `call_async` is still in Rust.
/// An already-queued napi callback can still run once; TSFN work lives on
/// the JS thread.
fn await_pty_output_drain(
	pump_done_rx: flume::Receiver<PumpEnd>,
	reader_thread: std::thread::JoinHandle<()>,
	queued: flume::Sender<ReaderEvent>,
	progress: &ReaderProgress,
	decoder: &Mutex<OutputDecoder>,
	unread: impl Fn() -> u64,
	abandon_slow_js: bool,
	stop_pump: impl FnOnce(),
) -> Option<PumpEnd> {
	/// How often the final wait looks at the pump's progress.
	const DELIVERY_POLL: Duration = Duration::from_millis(10);

	let finish = |reader_thread: std::thread::JoinHandle<()>| {
		if reader_thread.is_finished() {
			let _ = reader_thread.join();
		}
	};
	if abandon_slow_js {
		stop_pump();
		drop(queued);
		let end = pump_done_rx.recv_timeout(POST_CANCEL_DRAIN_TIMEOUT).ok();
		finish(reader_thread);
		return end;
	}

	// What the reader owes: what it has read, and what the terminal holds. A
	// read in progress has taken output that `read` does not count yet, so the
	// count has to be taken between reads. A reader waiting for output, or for
	// room in the queue, reads nothing, and the count is taken here; a reader
	// that keeps reading answers the question itself between two reads.
	progress.asked.store(true, Ordering::Release);
	let owed = loop {
		let answered = progress.answered.load(Ordering::Acquire);
		if answered != 0 {
			break answered - 1;
		}
		let reads = progress.reads.load(Ordering::Acquire);
		if reads.is_multiple_of(2) {
			let owed = progress
				.read
				.load(Ordering::Acquire)
				.saturating_add(unread());
			if progress.reads.load(Ordering::Acquire) == reads {
				break owed;
			}
		}
		if reader_thread.is_finished() {
			break 0;
		}
		match pump_done_rx.recv_timeout(DELIVERY_POLL) {
			Ok(end) => {
				finish(reader_thread);
				return Some(end);
			},
			// The pump sends how it ended before it drops its sender.
			Err(flume::RecvTimeoutError::Disconnected) => {
				finish(reader_thread);
				return Some(PumpEnd::Panicked);
			},
			Err(flume::RecvTimeoutError::Timeout) => {},
		}
	};
	loop {
		if reader_thread.is_finished() {
			drop(queued);
			// Unbounded by design (#7421, same as shell.rs `drain_handle.await`).
			let end = pump_done_rx.recv().unwrap_or(PumpEnd::Panicked);
			let _ = reader_thread.join();
			return Some(end);
		}

		match pump_done_rx.recv_timeout(STUCK_SLAVE_IDLE) {
			Ok(end) => {
				finish(reader_thread);
				return Some(end);
			},
			Err(flume::RecvTimeoutError::Disconnected) => {
				finish(reader_thread);
				return Some(PumpEnd::Panicked);
			},
			Err(flume::RecvTimeoutError::Timeout) => {
				if reader_thread.is_finished() || progress.handed.load(Ordering::Acquire) < owed {
					continue;
				}
			},
		}

		// The reader owes nothing more. The reader holds the decoder while it
		// decodes and queues, so its text is all counted and queued here, and
		// the flushed rest goes after it.
		let delivered = {
			let mut decoder = decoder.lock();
			let rest = decoder.finish();
			let handed = progress.handed_text.load(Ordering::Acquire);
			if rest.is_empty() {
				handed
			} else {
				let len = rest.len() as u64;
				if queued.send(ReaderEvent::Chunk(rest)).is_err() {
					handed
				} else {
					handed + len
				}
			}
		};
		while progress.forwarded_text.load(Ordering::Acquire) < delivered {
			match pump_done_rx.recv_timeout(DELIVERY_POLL) {
				Ok(end) => {
					finish(reader_thread);
					return Some(end);
				},
				Err(flume::RecvTimeoutError::Disconnected) => {
					finish(reader_thread);
					return Some(PumpEnd::Panicked);
				},
				Err(flume::RecvTimeoutError::Timeout) => {},
			}
		}
		stop_pump();
		drop(queued);
		let _ = pump_done_rx.recv_timeout(POST_CANCEL_DRAIN_TIMEOUT);
		return None;
	}
}

#[cfg(test)]
mod reader_queue_tests {
	use std::{
		sync::{
			Arc, OnceLock,
			atomic::{AtomicBool, Ordering},
		},
		time::{Duration, Instant},
	};

	use parking_lot::Mutex;
	use pi_shell::output_decode::OutputDecoder;

	use super::{
		BRIDGE_QUEUE_CHUNKS, POST_CANCEL_DRAIN_TIMEOUT, PumpEnd, ReaderEvent, ReaderProgress,
		STUCK_SLAVE_IDLE, await_pty_output_drain, hand_rest, lost_terminal_output,
	};

	/// At the end of the output the reader queues what its decoder holds. While
	/// that send waits on a full queue it must keep the decoder: the drain
	/// takes the decoder to flush it and counts the text handed so far, and it
	/// found an empty decoder and a count without the rest, so it could stop
	/// the pump with the final U+FFFD still unqueued.
	#[test]
	fn the_end_of_output_keeps_the_decoder_until_its_rest_is_queued() {
		const PARTIAL: [u8; 2] = [0xe2, 0x82];
		let (queue, rx) = flume::bounded::<ReaderEvent>(1);
		queue
			.send(ReaderEvent::Chunk("full".to_owned()))
			.expect("fill the queue");
		let decoder = Arc::new(Mutex::new(OutputDecoder::new()));
		assert!(decoder.lock().push(&PARTIAL).is_empty(), "the decoder holds the partial character");
		let progress = Arc::new(ReaderProgress::default());
		let reader = std::thread::spawn({
			let decoder = Arc::clone(&decoder);
			let progress = Arc::clone(&progress);
			move || hand_rest(&decoder, &progress, &queue)
		});
		let deadline = Instant::now() + Duration::from_secs(10);
		loop {
			let Some(mut held) = decoder.try_lock() else {
				// The reader holds the decoder while it waits to queue the rest.
				break;
			};
			assert!(
				!held.finish().is_empty(),
				"the reader let go of the decoder before its rest was queued"
			);
			// The reader has not taken the rest yet: put it back.
			assert!(held.push(&PARTIAL).is_empty());
			drop(held);
			assert!(Instant::now() < deadline, "the reader never took the decoder");
			std::thread::sleep(Duration::from_millis(1));
		}
		let mut queued = Vec::new();
		while queued.len() < 2 {
			match rx
				.recv_timeout(Duration::from_secs(10))
				.expect("the reader queues the rest")
			{
				ReaderEvent::Chunk(text) => queued.push(text),
				ReaderEvent::Done => panic!("no end marker was sent"),
			}
		}
		assert!(reader.join().expect("reader thread"), "the pump is still there");
		assert_eq!(queued, ["full", "\u{FFFD}"]);
		assert_eq!(progress.handed_text.load(Ordering::Acquire), "\u{FFFD}".len() as u64);
	}

	/// A callback that failed or stalled lost output, so the run fails even
	/// when a kill or a timeout ended the command afterwards; before, the later
	/// cancellation resolved the run as cancelled. A pump the run stopped
	/// itself (none reported) or one that delivered everything loses nothing.
	#[test]
	fn lost_output_fails_the_run_whatever_ended_it() {
		for interrupted in [false, true] {
			for end in [PumpEnd::ConsumerGone, PumpEnd::Stalled] {
				let error = lost_terminal_output(Some(end), interrupted)
					.unwrap_or_else(|| panic!("{end:?}, interrupted {interrupted}: must fail"));
				assert!(error.reason.contains("not all delivered"), "{}", error.reason);
			}
			assert!(lost_terminal_output(Some(PumpEnd::Drained), interrupted).is_none());
			assert!(lost_terminal_output(None, interrupted).is_none());
		}
		assert!(lost_terminal_output(Some(PumpEnd::Panicked), false).is_some());
		assert!(lost_terminal_output(Some(PumpEnd::Panicked), true).is_none());
	}

	/// The drain with an empty decoder and a terminal that holds nothing
	/// unread.
	fn drain(
		pump_done_rx: flume::Receiver<PumpEnd>,
		reader_thread: std::thread::JoinHandle<()>,
		queued: flume::Sender<ReaderEvent>,
		progress: &ReaderProgress,
		abandon_slow_js: bool,
		stop_pump: impl FnOnce(),
	) -> Option<PumpEnd> {
		let decoder = Mutex::new(OutputDecoder::new());
		await_pty_output_drain(
			pump_done_rx,
			reader_thread,
			queued,
			progress,
			&decoder,
			|| 0,
			abandon_slow_js,
			stop_pump,
		)
	}

	/// A pump that forwards each queued chunk after `delay`, counting it, until
	/// `stopped`; it returns what it forwarded.
	fn fake_pump(
		rx: flume::Receiver<ReaderEvent>,
		progress: Arc<ReaderProgress>,
		stopped: Arc<AtomicBool>,
		delay: Duration,
	) -> std::thread::JoinHandle<String> {
		std::thread::spawn(move || {
			let mut forwarded = String::new();
			while !stopped.load(Ordering::Acquire) {
				let Ok(ReaderEvent::Chunk(text)) = rx.recv_timeout(Duration::from_millis(10)) else {
					continue;
				};
				std::thread::sleep(delay);
				progress
					.forwarded_text
					.fetch_add(text.len() as u64, Ordering::AcqRel);
				forwarded.push_str(&text);
			}
			forwarded
		})
	}

	#[test]
	fn drain_waits_for_slow_js_after_reader_eof() {
		let (pump_tx, pump_rx) = flume::bounded(1);
		let reader = std::thread::spawn(|| {});
		let (queued, _) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
		std::thread::spawn(move || {
			std::thread::sleep(Duration::from_millis(2500));
			let _ = pump_tx.send(PumpEnd::Drained);
		});
		let start = Instant::now();
		let end = drain(pump_rx, reader, queued, &ReaderProgress::default(), false, || {});
		assert!(
			start.elapsed() >= Duration::from_millis(2400),
			"must not time out a slow callback after reader EOF",
		);
		assert_eq!(end, Some(PumpEnd::Drained));
	}

	#[test]
	fn drain_drops_sender_clone_after_reader_eof_so_pump_unblocks() {
		let (reader_tx, reader_rx) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
		let queued = reader_tx.clone();
		drop(reader_tx);
		let (pump_tx, pump_rx) = flume::bounded(1);
		std::thread::spawn(move || {
			let _ = reader_rx.recv();
			let _ = pump_tx.send(PumpEnd::Drained);
		});
		let reader = std::thread::spawn(|| {});
		let deadline = Instant::now() + Duration::from_secs(1);
		while !reader.is_finished() && Instant::now() < deadline {
			std::thread::sleep(Duration::from_millis(1));
		}
		assert!(reader.is_finished(), "reader fixture must have exited");
		let start = Instant::now();
		drain(pump_rx, reader, queued, &ReaderProgress::default(), false, || {});
		assert!(
			start.elapsed() < STUCK_SLAVE_IDLE,
			"holding the sender clone after EOF parks the pump until idle timeout",
		);
	}

	#[test]
	fn drain_gives_up_only_on_open_slave_idle() {
		let (_pump_tx, pump_rx) = flume::bounded::<PumpEnd>(1);
		let reader = std::thread::spawn(|| {
			std::thread::park();
		});
		let (queued, _) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
		let stopped = AtomicBool::new(false);
		let start = Instant::now();
		drain(pump_rx, reader, queued, &ReaderProgress::default(), false, || {
			stopped.store(true, Ordering::Release);
		});
		let elapsed = start.elapsed();
		assert!(elapsed >= STUCK_SLAVE_IDLE);
		assert!(elapsed < STUCK_SLAVE_IDLE + Duration::from_secs(2));
		assert!(stopped.load(Ordering::Acquire), "open slave must stop the pump");
	}

	/// A reader the scheduler starved: the child has gone and the terminal
	/// still holds 5 bytes, which the reader hands over only after the idle
	/// window. The drain cut it off at the first idle window, dropping them.
	/// It must wait for them, and still leave the open slave after.
	#[test]
	fn drain_waits_for_a_starved_reader_to_hand_over_the_terminal_output() {
		let (_pump_tx, pump_rx) = flume::bounded::<PumpEnd>(1);
		let progress = Arc::new(ReaderProgress::default());
		let late = STUCK_SLAVE_IDLE + Duration::from_secs(1);
		let reader = std::thread::spawn({
			let progress = Arc::clone(&progress);
			move || {
				std::thread::sleep(late);
				progress.read.fetch_add(5, Ordering::AcqRel);
				progress.handed.fetch_add(5, Ordering::AcqRel);
				// The slave stays open.
				std::thread::park();
			}
		});
		let (queued, _) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
		let decoder = Mutex::new(OutputDecoder::new());
		let stopped_at = OnceLock::new();
		let start = Instant::now();
		await_pty_output_drain(
			pump_rx,
			reader,
			queued,
			&progress,
			&decoder,
			|| 5,
			false,
			|| {
				let _ = stopped_at.set(start.elapsed());
			},
		);
		let stopped_at = *stopped_at.get().expect("the open slave is still left");
		assert!(
			stopped_at >= late,
			"cut the reader off at {stopped_at:?}, before it handed over the terminal's output",
		);
		assert!(stopped_at < late + STUCK_SLAVE_IDLE + Duration::from_secs(2));
	}

	/// A read that has taken 21 bytes from the terminal (so it counts none
	/// unread) but has not counted them when the drain starts, and counts
	/// them only after the idle window. The drain took the counts at that
	/// moment as everything owed and cut the reader off with the 21 bytes. It
	/// must wait for the read to count them.
	#[test]
	fn drain_waits_for_a_read_in_progress_to_count_its_bytes() {
		let (_pump_tx, pump_rx) = flume::bounded::<PumpEnd>(1);
		let progress = Arc::new(ReaderProgress::default());
		progress.reads.fetch_add(1, Ordering::AcqRel);
		let late = STUCK_SLAVE_IDLE + Duration::from_secs(1);
		let reader = std::thread::spawn({
			let progress = Arc::clone(&progress);
			move || {
				std::thread::sleep(late);
				progress.read.fetch_add(21, Ordering::AcqRel);
				progress.reads.fetch_add(1, Ordering::AcqRel);
				std::thread::sleep(Duration::from_millis(100));
				progress.handed.fetch_add(21, Ordering::AcqRel);
				// The slave stays open.
				std::thread::park();
			}
		});
		let (queued, _) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
		let decoder = Mutex::new(OutputDecoder::new());
		let stopped_at = OnceLock::new();
		let start = Instant::now();
		await_pty_output_drain(
			pump_rx,
			reader,
			queued,
			&progress,
			&decoder,
			|| 0,
			false,
			|| {
				let _ = stopped_at.set(start.elapsed());
			},
		);
		let stopped_at = *stopped_at.get().expect("the open slave is still left");
		assert!(
			stopped_at >= late + Duration::from_millis(100),
			"cut the reader off at {stopped_at:?}, before its read in progress handed its bytes over",
		);
	}

	/// A reader that never stops reading (a daemon writing every few
	/// milliseconds), with a count of unread output that takes 50 ms: every
	/// count the drain took spanned a read, so it retried for ever. The reader
	/// answers between two reads instead, and the drain must finish.
	#[cfg(unix)]
	#[test]
	fn drain_takes_the_count_from_a_reader_that_never_stops_reading() {
		let (_pump_tx, pump_rx) = flume::bounded::<PumpEnd>(1);
		let (queued, _) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
		let progress = Arc::new(ReaderProgress::default());
		let done = Arc::new(AtomicBool::new(false));
		let reader = std::thread::spawn({
			let progress = Arc::clone(&progress);
			let done = Arc::clone(&done);
			move || {
				while !done.load(Ordering::Acquire) {
					progress.reads.fetch_add(1, Ordering::AcqRel);
					progress.read.fetch_add(100, Ordering::AcqRel);
					progress.reads.fetch_add(1, Ordering::AcqRel);
					progress.handed.fetch_add(100, Ordering::AcqRel);
					progress.answer(|| 100);
					std::thread::sleep(Duration::from_millis(1));
				}
			}
		});
		let (done_tx, done_rx) = flume::bounded(1);
		let stopped = Arc::new(AtomicBool::new(false));
		std::thread::spawn({
			let progress = Arc::clone(&progress);
			let stopped = Arc::clone(&stopped);
			move || {
				let decoder = Mutex::new(OutputDecoder::new());
				let slow_count = || {
					std::thread::sleep(Duration::from_millis(50));
					100
				};
				await_pty_output_drain(
					pump_rx,
					reader,
					queued,
					&progress,
					&decoder,
					slow_count,
					false,
					|| {
						stopped.store(true, Ordering::Release);
					},
				);
				let _ = done_tx.send(());
			}
		});
		let ended = done_rx.recv_timeout(STUCK_SLAVE_IDLE + Duration::from_secs(20));
		done.store(true, Ordering::Release);
		assert!(ended.is_ok(), "the drain kept counting what a busy reader owed");
		assert!(stopped.load(Ordering::Acquire), "the open slave must stop the pump");
	}

	/// A daemon that holds the slave open and writes without end, into a
	/// callback that takes 50 ms per chunk: the queue is never empty and a
	/// callback is nearly always in flight, so the drain waited for ever. It
	/// must stop once what was queued when the reader owed nothing more has
	/// been delivered.
	#[test]
	fn drain_stops_for_a_daemon_that_writes_forever() {
		let (reader_tx, reader_rx) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
		let queued = reader_tx.clone();
		let (_pump_tx, pump_rx) = flume::bounded::<PumpEnd>(1);
		let progress = Arc::new(ReaderProgress::default());
		let pump_stopped = Arc::new(AtomicBool::new(false));
		let pump = fake_pump(
			reader_rx,
			Arc::clone(&progress),
			Arc::clone(&pump_stopped),
			Duration::from_millis(50),
		);
		let reader = std::thread::spawn({
			let progress = Arc::clone(&progress);
			move || {
				loop {
					progress.read.fetch_add(100, Ordering::AcqRel);
					if !progress.hand(&reader_tx, "y".repeat(100)) {
						return;
					}
					progress.handed.fetch_add(100, Ordering::AcqRel);
				}
			}
		});
		let (done_tx, done_rx) = flume::bounded(1);
		let start = Instant::now();
		std::thread::spawn({
			let progress = Arc::clone(&progress);
			let pump_stopped = Arc::clone(&pump_stopped);
			move || {
				let decoder = Mutex::new(OutputDecoder::new());
				await_pty_output_drain(
					pump_rx,
					reader,
					queued,
					&progress,
					&decoder,
					|| 100,
					false,
					|| {
						pump_stopped.store(true, Ordering::Release);
					},
				);
				let _ = done_tx.send(());
			}
		});
		let ended = done_rx.recv_timeout(STUCK_SLAVE_IDLE + Duration::from_secs(20));
		pump_stopped.store(true, Ordering::Release);
		assert!(ended.is_ok(), "the drain waited for the daemon for {:?}", start.elapsed());
		assert!(!pump.join().expect("pump fixture").is_empty());
	}

	/// A command that writes the first two bytes of a three-byte character,
	/// leaving a descendant that holds the terminal open: the decoder held the
	/// two bytes, and the drain left the slave without them. It must flush
	/// them, as the reader does at EOF, and deliver the replacement character.
	#[test]
	fn drain_flushes_a_partial_character_before_leaving_an_open_slave() {
		let (reader_tx, reader_rx) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
		let queued = reader_tx.clone();
		let (_pump_tx, pump_rx) = flume::bounded::<PumpEnd>(1);
		let progress = Arc::new(ReaderProgress::default());
		let decoder = Mutex::new(OutputDecoder::new());
		assert_eq!(decoder.lock().push(&[0xe2, 0x82]), "", "the decoder holds a partial character");
		progress.read.fetch_add(2, Ordering::AcqRel);
		progress.handed.fetch_add(2, Ordering::AcqRel);
		let pump_stopped = Arc::new(AtomicBool::new(false));
		let pump =
			fake_pump(reader_rx, Arc::clone(&progress), Arc::clone(&pump_stopped), Duration::ZERO);
		let reader = std::thread::spawn(move || {
			let _reader_tx = reader_tx;
			// The slave stays open.
			std::thread::park();
		});
		await_pty_output_drain(
			pump_rx,
			reader,
			queued,
			&progress,
			&decoder,
			|| 0,
			false,
			|| {
				pump_stopped.store(true, Ordering::Release);
			},
		);
		pump_stopped.store(true, Ordering::Release);
		assert_eq!(pump.join().expect("pump fixture"), "\u{FFFD}");
	}

	#[test]
	fn drain_does_not_treat_queued_backpressure_as_stuck_slave() {
		let (pump_tx, pump_rx) = flume::bounded(1);
		let reader = std::thread::spawn(std::thread::park);
		let (queued, _rx) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
		let progress = ReaderProgress::default();
		assert!(progress.hand(&queued, "x".into()), "queue accepts a chunk");
		std::thread::spawn(move || {
			std::thread::sleep(Duration::from_millis(2500));
			let _ = pump_tx.send(PumpEnd::Drained);
		});
		let start = Instant::now();
		drain(pump_rx, reader, queued, &progress, false, || {});
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
		let progress = Arc::new(ReaderProgress::default());
		// One chunk taken by the pump and not yet back from `on_chunk`.
		progress.handed_text.fetch_add(1, Ordering::AcqRel);
		std::thread::spawn({
			let progress = Arc::clone(&progress);
			move || {
				std::thread::sleep(Duration::from_millis(2500));
				progress.forwarded_text.fetch_add(1, Ordering::AcqRel);
				let _ = pump_tx.send(PumpEnd::Drained);
			}
		});
		let start = Instant::now();
		drain(pump_rx, reader, queued, &progress, false, || {});
		assert!(
			start.elapsed() >= Duration::from_millis(2400),
			"an in-flight on_chunk is slow JS, not a stuck slave",
		);
	}

	#[test]
	fn drain_reports_a_pump_that_stalled() {
		let (pump_tx, pump_rx) = flume::bounded(1);
		let reader = std::thread::spawn(|| {});
		let (queued, _) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
		pump_tx.send(PumpEnd::Stalled).expect("pump end");
		assert_eq!(
			drain(pump_rx, reader, queued, &ReaderProgress::default(), false, || {}),
			Some(PumpEnd::Stalled)
		);
	}

	#[test]
	fn drain_cancel_does_not_wait_for_slow_js() {
		let (_pump_tx, pump_rx) = flume::bounded::<PumpEnd>(1);
		let reader = std::thread::spawn(std::thread::park);
		let (queued, _) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
		let stopped = AtomicBool::new(false);
		let start = Instant::now();
		drain(pump_rx, reader, queued, &ReaderProgress::default(), true, || {
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
		let (pump_tx, pump_rx) = flume::bounded::<PumpEnd>(1);
		let reader = std::thread::spawn(std::thread::park);
		let (queued, _) = flume::bounded::<ReaderEvent>(BRIDGE_QUEUE_CHUNKS);
		let start = Instant::now();
		drain(pump_rx, reader, queued, &ReaderProgress::default(), true, move || {
			drop(pump_tx);
		});
		assert!(
			start.elapsed() < POST_CANCEL_DRAIN_TIMEOUT,
			"after stop disconnects the pump, cancel must not sit out the full drain timeout",
		);
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
			if run_pty_sync(config, None, None, tx, rx, ct).is_ok() {
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

	/// Children of this process named `sleep`, in any state.
	fn sleep_children() -> HashSet<u32> {
		let my_pid = std::process::id();
		let mut pids = HashSet::new();
		let Ok(entries) = std::fs::read_dir("/proc") else {
			return pids;
		};
		for entry in entries.flatten() {
			let Some(pid) = entry
				.file_name()
				.to_str()
				.and_then(|name| name.parse::<u32>().ok())
			else {
				continue;
			};
			let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
				continue;
			};
			let (Some(open), Some(close)) = (stat.find('('), stat.rfind(')')) else {
				continue;
			};
			let ppid = stat[close + 1..].split_whitespace().nth(1);
			if stat.get(open + 1..close) == Some(STORM_CHILD_COMM)
				&& ppid.and_then(|ppid| ppid.parse::<u32>().ok()) == Some(my_pid)
			{
				pids.insert(pid);
			}
		}
		pids
	}

	/// Every terminal setup step that can fail (the writer, the reader, the
	/// unread-count handle) must fail before the child exists. They ran after
	/// the spawn, so a failure dropped the master with no kill and no wait:
	/// the child died of the hangup and stayed a zombie of this process.
	#[test]
	fn a_failed_terminal_setup_step_leaves_no_child() {
		let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
		let _runtime = runtime.enter();
		let before = sleep_children();
		for step in 1..=3 {
			super::FAIL_SETUP_STEP.with(|fail| fail.set(Some(step)));
			let (tx, rx) = flume::unbounded();
			let config = PtyRunConfig {
				command: PtyCommand::Argv {
					application: STORM_CHILD_COMM.to_string(),
					args:        vec!["30".to_string()],
				},
				cwd:     None,
				env:     None,
				cols:    80,
				rows:    24,
			};
			let result =
				run_pty_sync(config, None, None, tx, rx, task::CancelToken::new(Some(30_000), None));
			super::FAIL_SETUP_STEP.with(|fail| fail.set(None));
			let error = result
				.err()
				.unwrap_or_else(|| panic!("step {step}: the injected failure must fail the run"));
			assert!(error.reason.contains("injected"), "step {step}: {}", error.reason);
		}
		// Let a hangup that killed a child land.
		thread::sleep(Duration::from_millis(500));
		let left: Vec<u32> = sleep_children().difference(&before).copied().collect();
		assert!(left.is_empty(), "failed setup left children behind: {left:?}");
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
