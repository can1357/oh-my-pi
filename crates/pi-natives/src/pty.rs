//! PTY-backed interactive command execution exported via N-API.
//!
//! # Overview
//! Provides a stateful PTY session that supports streaming output and stdin
//! passthrough while a command is running.

use std::{
	collections::HashMap,
	io::{Read, Write},
	str,
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
use parking_lot::Mutex;
use portable_pty::{Child, CommandBuilder, PtySize, native_pty_system};

use crate::{js::into_string, ps, task};

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

enum ControlMessage {
	Input(String),
	Resize { cols: u16, rows: u16 },
	Kill,
}

const CONTROL_MESSAGES_PER_TICK: usize = 64;
/// Capacity of the reader→JS queue. One queued chunk is at most one PTY read
/// (≤64 KiB), so the Rust side holds ~4 MiB before the reader thread's `send`
/// parks — which fills the OS PTY buffer and backpressures the child instead of
/// buffering the surplus in process memory. Same bound as the non-PTY bash
/// bridge (#4078). A separate `pump_pty_chunks` task `call_async`s so the
/// control loop never waits on JS (input/resize/kill/`try_wait` stay live).
const READER_QUEUE_CHUNKS: usize = 64;
const POST_CANCEL_DRAIN_TIMEOUT: Duration = Duration::from_millis(300);
/// Idle window used only when the child has already exited, the reader has
/// *not* hit EOF, the bridge queue is empty, and no `on_chunk` is in flight.
/// That is a permanently open slave (daemon / extra holder), not slow JS.
/// A reader parked on a full bridge is backpressure and must not use this.
const STUCK_SLAVE_IDLE: Duration = Duration::from_secs(2);
/// How long a cancelled run polls for its SIGKILL'd child before handing the
/// reap off to a detached thread rather than blocking the PTY promise.
#[cfg(not(windows))]
const CANCEL_REAP_TIMEOUT: Duration = Duration::from_millis(500);
#[cfg(not(windows))]
const CANCEL_REAP_POLL_INTERVAL: Duration = Duration::from_millis(5);

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
		let run_config = PtyRunConfig {
			command: PtyCommand::Shell { command: options.command, shell: options.shell },
			cwd:     options.cwd,
			env:     options.env,
			cols:    options.cols.unwrap_or(120).clamp(20, 400),
			rows:    options.rows.unwrap_or(40).clamp(5, 200),
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
		let run_config = PtyRunConfig {
			command: PtyCommand::Argv { application: options.application, args: options.args },
			cwd:     options.cwd,
			env:     options.env,
			cols:    options.cols.unwrap_or(120).clamp(20, 400),
			rows:    options.rows.unwrap_or(40).clamp(5, 200),
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
		self.send_control(ControlMessage::Resize {
			cols: cols.clamp(20, 400),
			rows: rows.clamp(5, 200),
		})
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

		// Register control channel synchronously so write()/kill() work immediately.
		let (control_tx, control_rx) = flume::unbounded::<ControlMessage>();
		{
			let mut guard = core.lock();
			if guard.is_some() {
				return Err(Error::from_reason("PTY session already running"));
			}
			*guard = Some(PtySessionCore { control_tx });
		}
		task::future(env, "pty.start", async move {
			let run_result = tokio::task::spawn_blocking(move || {
				run_pty_sync(run_config, on_chunk, on_start, control_rx, ct)
			})
			.await;

			let mut guard = core.lock();
			*guard = None;
			drop(guard);

			match run_result {
				Ok(inner) => inner,
				Err(err) => Err(Error::from_reason(format!("PTY execution task failed: {err}"))),
			}
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

fn terminate_pty_processes(
	child: &mut Box<dyn Child + Send + Sync>,
	child_pid: Option<i32>,
	process_group_id: Option<i32>,
) {
	let mut targets = ps::TerminationTargets::new();
	if let Some(pgid) = process_group_id {
		targets.add_pgid(pgid);
	}
	if let Some(pid) = child_pid {
		targets.add_pid(pid);
	}

	targets.signal(ps::TERM_SIGNAL);
	let _ = child.kill();
	targets.signal(ps::KILL_SIGNAL);
}
fn run_pty_sync(
	config: PtyRunConfig,
	on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
	on_start: Option<ThreadsafeFunction<u32>>,
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
	if let Some(env) = config.env.as_ref() {
		for (key, value) in env {
			cmd.env(key, value);
		}
	}
	ct.heartbeat()
		.map_err(|err| Error::from_reason(format!("PTY setup cancelled before spawn: {err}")))?;

	let mut child = pair
		.slave
		.spawn_command(cmd)
		.map_err(|err| Error::from_reason(format!("Failed to spawn PTY command: {err}")))?;
	drop(pair.slave);
	let child_process_id = child.process_id();
	let child_pid = child_process_id.and_then(|value| i32::try_from(value).ok());
	if let Some(callback) = on_start.as_ref() {
		callback.call(Ok(child_process_id.unwrap_or(0)), ThreadsafeFunctionCallMode::NonBlocking);
	}
	// No heartbeat check here: `child` now owns a real, already-`exec`'d OS
	// process, and bailing out via `?` at this point would drop `pair`
	// (closing the pty master) without ever killing or reaping it — the
	// master hangup delivers SIGHUP to the child (it's the pty's session
	// leader), which kills it almost immediately, but nothing calls
	// wait()/try_wait() afterward, so it leaks as a permanent zombie. A
	// cancellation here is instead picked up on the main loop's first
	// iteration below, which already kills and reaps correctly.

	let master = pair.master;
	let mut writer = master
		.take_writer()
		.map_err(|err| Error::from_reason(format!("Failed to create PTY writer: {err}")))?;
	// ConPTY sends ESC[6n (cursor position query) and blocks until we reply.
	// Reply with cursor at 1,1 so it unblocks the child spawn.
	// Only needed on Windows; on Unix/macOS this would corrupt stdin.
	#[cfg(windows)]
	{
		let _ = writer.write_all(b"\x1b[1;1R");
		let _ = writer.flush();
	}
	let mut reader = master
		.try_clone_reader()
		.map_err(|err| Error::from_reason(format!("Failed to create PTY reader: {err}")))?;

	let (reader_tx, reader_rx) = flume::bounded::<ReaderEvent>(READER_QUEUE_CHUNKS);
	let queued = reader_tx.clone();
	let reader_thread = std::thread::spawn(move || {
		const REPLACEMENT: &str = "\u{FFFD}";
		const BUF: usize = 65536;
		let mut buf = vec![0u8; BUF + 4];
		let mut it = 0;
		loop {
			match reader.read(&mut buf[it..BUF]) {
				Ok(0) => {
					break;
				},
				Ok(n) => {
					it += n;
					while it > 0 {
						let pending = &buf[..it];
						match str::from_utf8(pending) {
							Ok(text) => {
								if reader_tx
									.send(ReaderEvent::Chunk(text.to_string()))
									.is_err()
								{
									return;
								}
								it = 0;
								break;
							},
							Err(err) => {
								let valid_up_to = err.valid_up_to();
								if valid_up_to > 0 {
									// SAFETY: [..valid_up_to] is guaranteed valid UTF-8 by valid_up_to().
									let text = unsafe { str::from_utf8_unchecked(&pending[..valid_up_to]) };
									if reader_tx
										.send(ReaderEvent::Chunk(text.to_string()))
										.is_err()
									{
										return;
									}
									buf.copy_within(valid_up_to..it, 0);
									it -= valid_up_to;
								}
								match err.error_len() {
									Some(invalid_len) => {
										if reader_tx
											.send(ReaderEvent::Chunk(REPLACEMENT.to_string()))
											.is_err()
										{
											return;
										}
										buf.copy_within(invalid_len..it, 0);
										it -= invalid_len;
									},
									None => {
										break;
									},
								}
							},
						}
					}
				},
				Err(_) => {
					break;
				},
			}
		}
		for chunk in buf[..it].utf8_chunks() {
			let valid = chunk.valid();
			if !valid.is_empty()
				&& reader_tx
					.send(ReaderEvent::Chunk(valid.to_string()))
					.is_err()
			{
				return;
			}
			if !chunk.invalid().is_empty()
				&& reader_tx
					.send(ReaderEvent::Chunk(REPLACEMENT.to_string()))
					.is_err()
			{
				return;
			}
		}
		let _ = reader_tx.send(ReaderEvent::Done);
	});

	#[cfg(unix)]
	let process_group_id = master.process_group_leader().filter(|pgid| *pgid > 0);
	#[cfg(not(unix))]
	let process_group_id: Option<i32> = None;
	let js_gone = Arc::new(AtomicBool::new(false));
	let in_js = Arc::new(AtomicBool::new(false));
	let (pump_done_tx, pump_done_rx) = flume::bounded::<()>(1);
	let pump_task = {
		let js_gone = Arc::clone(&js_gone);
		let in_js = Arc::clone(&in_js);
		napi::tokio::spawn(async move {
			pump_pty_chunks(
				reader_rx,
				async move |payload| {
					let Some(callback) = on_chunk.as_ref() else {
						return true;
					};
					let ok = callback.call_async(Ok(payload)).await.is_ok();
					if !ok {
						js_gone.store(true, Ordering::Release);
					}
					ok
				},
				Some(in_js.as_ref()),
			)
			.await;
			let _ = pump_done_tx.send(());
		})
	};
	let abort_pump = pump_task.abort_handle();

	let mut timed_out = false;
	let mut cancelled = false;
	let mut exit_code: Option<i32> = None;
	let mut terminate_requested = false;
	let mut reader_drain_deadline: Option<Instant> = None;
	while exit_code.is_none() {
		if js_gone.load(Ordering::Acquire) && !terminate_requested {
			cancelled = true;
			terminate_pty_processes(&mut child, child_pid, process_group_id);
			terminate_requested = true;
			reader_drain_deadline = Some(Instant::now() + POST_CANCEL_DRAIN_TIMEOUT);
		}
		if !terminate_requested && let Err(err) = ct.heartbeat() {
			let message = err.to_string();
			timed_out = message.contains("Timeout");
			cancelled = !timed_out;
			terminate_pty_processes(&mut child, child_pid, process_group_id);
			terminate_requested = true;
			reader_drain_deadline = Some(Instant::now() + POST_CANCEL_DRAIN_TIMEOUT);
		}

		for _ in 0..CONTROL_MESSAGES_PER_TICK {
			match control_rx.try_recv() {
				Ok(ControlMessage::Input(data)) => {
					let _ = writer.write_all(data.as_bytes());
					let _ = writer.flush();
				},
				Ok(ControlMessage::Resize { cols, rows }) => {
					let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
				},
				Ok(ControlMessage::Kill) => {
					cancelled = true;
					if !terminate_requested {
						terminate_pty_processes(&mut child, child_pid, process_group_id);
						terminate_requested = true;
						reader_drain_deadline = Some(Instant::now() + POST_CANCEL_DRAIN_TIMEOUT);
					}
				},
				Err(flume::TryRecvError::Empty | flume::TryRecvError::Disconnected) => break,
			}
		}
		if exit_code.is_none()
			&& let Some(status) = child
				.try_wait()
				.map_err(|err| Error::from_reason(format!("Failed checking PTY status: {err}")))?
		{
			exit_code = Some(i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
			break;
		}

		if let Some(deadline) = reader_drain_deadline
			&& Instant::now() >= deadline
		{
			break;
		}
		let wait_duration = reader_drain_deadline.map_or(Duration::from_millis(16), |deadline| {
			deadline
				.saturating_duration_since(Instant::now())
				.min(Duration::from_millis(16))
		});
		match control_rx.recv_timeout(wait_duration) {
			Ok(ControlMessage::Input(data)) => {
				let _ = writer.write_all(data.as_bytes());
				let _ = writer.flush();
			},
			Ok(ControlMessage::Resize { cols, rows }) => {
				let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
			},
			Ok(ControlMessage::Kill) => {
				cancelled = true;
				if !terminate_requested {
					terminate_pty_processes(&mut child, child_pid, process_group_id);
					terminate_requested = true;
					reader_drain_deadline = Some(Instant::now() + POST_CANCEL_DRAIN_TIMEOUT);
				}
			},
			Err(flume::RecvTimeoutError::Timeout | flume::RecvTimeoutError::Disconnected) => {},
		}
	}
	if exit_code.is_none() {
		// `std::process::Child` (what `portable-pty` wraps on Unix) never waits on
		// `Drop`, so a child left unwaited here leaks as a permanent zombie.
		//
		// On Windows, child.wait() can hang indefinitely in ConPTY.
		// Poll try_wait() with a short timeout instead.
		#[cfg(windows)]
		if !terminate_requested {
			let wait_start = Instant::now();
			while exit_code.is_none() && wait_start.elapsed() < Duration::from_secs(5) {
				if let Some(status) = child
					.try_wait()
					.map_err(|err| Error::from_reason(format!("Failed checking PTY status: {err}")))?
				{
					exit_code = Some(i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
					break;
				}
				std::thread::sleep(Duration::from_millis(50));
			}
		}
		#[cfg(not(windows))]
		if terminate_requested {
			// SIGKILL does not guarantee a prompt exit — a child wedged in
			// uninterruptible I/O never reaps, and a kill that failed leaves it
			// running — so blocking here would pin this `spawn_blocking` worker
			// and the promise well past the caller's deadline. Poll briefly, then
			// hand the reap to a detached thread so cancellation still returns.
			let deadline = Instant::now() + CANCEL_REAP_TIMEOUT;
			while exit_code.is_none() {
				if let Some(status) = child
					.try_wait()
					.map_err(|err| Error::from_reason(format!("Failed checking PTY status: {err}")))?
				{
					exit_code = Some(i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
					break;
				}
				if Instant::now() >= deadline {
					break;
				}
				std::thread::sleep(CANCEL_REAP_POLL_INTERVAL);
			}
			if exit_code.is_none() {
				std::thread::spawn(move || {
					let _ = child.wait();
				});
			}
		} else {
			let status = child
				.wait()
				.map_err(|err| Error::from_reason(format!("Failed waiting PTY process: {err}")))?;
			exit_code = Some(i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
		}
	}
	// --- Teardown ---

	// Step 1: Close the ConPTY input pipe first.
	// Per Microsoft docs, close the input handle before calling ClosePseudoConsole.
	// This signals to ConPTY that no more input will arrive, allowing its internal
	// I/O threads to finish processing and eventually close the output pipe.
	drop(writer);

	// Step 2: Drop master so the reader sees EOF if the slave is gone, then
	// drain JS. Successful finite runs wait until every accepted chunk has
	// reached `on_chunk` (#7421). A reader parked on backpressure is not
	// aborted. A descendant holding the slave open is the existing no-join
	// case and is the only path that may skip an unbounded wait.
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

/// Drain `rx`, greedily coalescing queued chunks into ≤64 KiB batches, and
/// feed each batch to `forward`, awaiting its completion before pulling more.
/// Mirrors `shell.rs` `pump_chunks` (#4078): JS consumption backpressures the
/// bounded reader queue; the PTY control loop never calls into napi.
async fn pump_pty_chunks(
	rx: flume::Receiver<ReaderEvent>,
	mut forward: impl AsyncFnMut(String) -> bool,
	busy: Option<&AtomicBool>,
) {
	const MAX_BATCH_BYTES: usize = 64 * 1024;
	const INITIAL_BATCH_CAP: usize = 8 * 1024;
	let mut batch = String::with_capacity(INITIAL_BATCH_CAP);
	let set_busy = |value: bool| {
		if let Some(busy) = busy {
			busy.store(value, Ordering::Release);
		}
	};
	loop {
		let first = match rx.recv_async().await {
			Ok(ReaderEvent::Chunk(text)) => {
				// Hold the idle-check flag before coalesce/forward so a drained
				// queue is not mistaken for a stuck-open slave.
				set_busy(true);
				text
			},
			Ok(ReaderEvent::Done) | Err(_) => break,
		};
		batch.push_str(&first);
		let mut done = false;
		while batch.len() < MAX_BATCH_BYTES {
			match rx.try_recv() {
				Ok(ReaderEvent::Chunk(more)) => batch.push_str(&more),
				Ok(ReaderEvent::Done) => {
					done = true;
					break;
				},
				Err(_) => break,
			}
		}
		let payload = std::mem::replace(&mut batch, String::with_capacity(INITIAL_BATCH_CAP));
		let keep_going = payload.is_empty() || forward(payload).await;
		set_busy(false);
		if !keep_going {
			return;
		}
		if done {
			return;
		}
	}
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

	use tokio::time;

	use super::{
		POST_CANCEL_DRAIN_TIMEOUT, READER_QUEUE_CHUNKS, ReaderEvent, STUCK_SLAVE_IDLE,
		await_pty_output_drain, pump_pty_chunks,
	};

	/// Regression for the PTY sibling of #4078: a stalled JS consumer
	/// (`forward`) must not let the reader queue grow without bound, and chunks
	/// must arrive losslessly and in order. Copied from
	/// `bridge_pump_bounds_queue_and_delivers_all_bytes`.
	#[tokio::test(flavor = "multi_thread")]
	async fn pty_pump_bounds_queue_and_delivers_all_bytes() {
		const CHUNKS: usize = 512;
		const CHUNK_BYTES: usize = 4096;
		let (tx, rx) = flume::bounded::<ReaderEvent>(READER_QUEUE_CHUNKS);
		let producer = tokio::spawn(async move {
			let mut expected = String::with_capacity(CHUNKS * CHUNK_BYTES);
			let mut max_queued = 0usize;
			for i in 0..CHUNKS {
				let chunk = format!("[{i:06}]{}", "x".repeat(CHUNK_BYTES - 8));
				expected.push_str(&chunk);
				tx.send_async(ReaderEvent::Chunk(chunk))
					.await
					.expect("pump should outlive the producer");
				max_queued = max_queued.max(tx.len());
			}
			tx.send_async(ReaderEvent::Done)
				.await
				.expect("pump should accept Done");
			(expected, max_queued)
		});

		let mut received = String::with_capacity(CHUNKS * CHUNK_BYTES);
		time::timeout(
			Duration::from_secs(30),
			pump_pty_chunks(
				rx,
				async |payload: String| {
					received.push_str(&payload);
					time::sleep(Duration::from_micros(500)).await;
					true
				},
				None,
			),
		)
		.await
		.expect("pump should finish once the producer hangs up");

		let (expected, max_queued) = producer.await.expect("producer task");
		assert!(
			max_queued <= READER_QUEUE_CHUNKS,
			"PTY reader queue grew past its bound: {max_queued} chunks",
		);
		assert_eq!(received.len(), expected.len(), "bytes were dropped or duplicated");
		assert_eq!(received, expected, "chunks must arrive losslessly and in order");
	}

	/// When JS dies (`forward` fails), the pump must drop its receiver so parked
	/// sends fail fast — the PTY reader keeps draining the child instead of
	/// wedging it on a full bridge queue.
	#[tokio::test(flavor = "multi_thread")]
	async fn pty_pump_death_disconnects_channel_without_blocking_senders() {
		let (tx, rx) = flume::bounded::<ReaderEvent>(4);
		let pump = tokio::spawn(pump_pty_chunks(rx, async |_payload: String| false, None));
		let producer = tokio::spawn(async move {
			let mut disconnected = 0usize;
			for _ in 0..64 {
				if tx
					.send_async(ReaderEvent::Chunk("x".repeat(1024)))
					.await
					.is_err()
				{
					disconnected += 1;
				}
			}

			disconnected
		});
		let disconnected = time::timeout(Duration::from_secs(5), producer)
			.await
			.expect("sends must not park once the consumer died")
			.expect("producer task");
		assert!(disconnected > 0, "channel should disconnect after the pump stops");
		time::timeout(Duration::from_secs(5), pump)
			.await
			.expect("pump should exit after forward fails")
			.expect("pump task");
	}
	#[test]
	fn drain_waits_for_slow_js_after_reader_eof() {
		let (pump_tx, pump_rx) = flume::bounded(1);
		let reader = std::thread::spawn(|| {});
		let (queued, _) = flume::bounded::<ReaderEvent>(READER_QUEUE_CHUNKS);
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
		let (reader_tx, reader_rx) = flume::bounded::<ReaderEvent>(READER_QUEUE_CHUNKS);
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
		let (queued, _) = flume::bounded::<ReaderEvent>(READER_QUEUE_CHUNKS);
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
		let (queued, _rx) = flume::bounded::<ReaderEvent>(READER_QUEUE_CHUNKS);
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
		let (queued, _) = flume::bounded::<ReaderEvent>(READER_QUEUE_CHUNKS);
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
		let (queued, _) = flume::bounded::<ReaderEvent>(READER_QUEUE_CHUNKS);
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
		let (queued, _) = flume::bounded::<ReaderEvent>(READER_QUEUE_CHUNKS);
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
			// contain spaces and parens, so bound it by the first `(` and last `)`.
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
			let (_tx, rx) = flume::unbounded();
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
			if run_pty_sync(config, None, None, rx, ct).is_ok() {
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
