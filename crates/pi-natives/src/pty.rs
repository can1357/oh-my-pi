//! PTY-backed interactive command execution exported via N-API.
//!
//! # Overview
//! Provides a stateful PTY session that supports streaming output and stdin
//! passthrough while a command is running.

use std::{
	collections::HashMap,
	io::{Read, Write},
	str,
	sync::Arc,
	time::{Duration, Instant},
};

use napi::{
	JsString,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
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
const READER_EVENTS_PER_TICK: usize = 256;
const POST_CANCEL_DRAIN_TIMEOUT: Duration = Duration::from_millis(300);
const POST_EXIT_DRAIN_TIMEOUT: Duration = Duration::from_millis(300);
/// How long a cancelled run polls for its SIGKILL'd child before handing the
/// reap off to a detached thread rather than blocking the PTY promise.
#[cfg(not(windows))]
const CANCEL_REAP_TIMEOUT: Duration = Duration::from_millis(500);
#[cfg(not(windows))]
const CANCEL_REAP_POLL_INTERVAL: Duration = Duration::from_millis(5);
#[cfg(not(windows))]
const FINAL_READER_DRAIN_TIMEOUT: Duration = Duration::from_millis(50);

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
		on_chunk: Option<ThreadsafeFunction<String>>,
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
		on_chunk: Option<ThreadsafeFunction<String>>,
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
		on_chunk: Option<ThreadsafeFunction<String>>,
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
	on_chunk: Option<ThreadsafeFunction<String>>,
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

	let (reader_tx, reader_rx) = flume::unbounded::<ReaderEvent>();
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
								let _ = reader_tx.send(ReaderEvent::Chunk(text.to_string()));
								it = 0;
								break;
							},
							Err(err) => {
								let valid_up_to = err.valid_up_to();
								if valid_up_to > 0 {
									// SAFETY: [..valid_up_to] is guaranteed valid UTF-8 by valid_up_to().
									let text = unsafe { str::from_utf8_unchecked(&pending[..valid_up_to]) };
									let _ = reader_tx.send(ReaderEvent::Chunk(text.to_string()));
									buf.copy_within(valid_up_to..it, 0);
									it -= valid_up_to;
								}
								match err.error_len() {
									Some(invalid_len) => {
										let _ = reader_tx.send(ReaderEvent::Chunk(REPLACEMENT.to_string()));
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
			if !valid.is_empty() {
				let _ = reader_tx.send(ReaderEvent::Chunk(valid.to_string()));
			}
			if !chunk.invalid().is_empty() {
				let _ = reader_tx.send(ReaderEvent::Chunk(REPLACEMENT.to_string()));
			}
		}
		let _ = reader_tx.send(ReaderEvent::Done);
	});

	#[cfg(unix)]
	let process_group_id = master.process_group_leader().filter(|pgid| *pgid > 0);
	#[cfg(not(unix))]
	let process_group_id: Option<i32> = None;
	let mut timed_out = false;
	let mut cancelled = false;
	let mut reader_done = false;
	let mut exit_code: Option<i32> = None;
	let mut terminate_requested = false;
	let mut reader_drain_deadline: Option<Instant> = None;
	while exit_code.is_none() || !reader_done {
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

		for _ in 0..READER_EVENTS_PER_TICK {
			match reader_rx.try_recv() {
				Ok(ReaderEvent::Chunk(chunk)) => emit_chunk(&chunk, on_chunk.as_ref()),
				Ok(ReaderEvent::Done) => {
					reader_done = true;
					break;
				},
				Err(flume::TryRecvError::Empty) => break,
				Err(flume::TryRecvError::Disconnected) => {
					reader_done = true;
					break;
				},
			}
		}
		if exit_code.is_none()
			&& let Some(status) = child
				.try_wait()
				.map_err(|err| Error::from_reason(format!("Failed checking PTY status: {err}")))?
		{
			exit_code = Some(i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
			if !reader_done && reader_drain_deadline.is_none() {
				reader_drain_deadline = Some(Instant::now() + POST_EXIT_DRAIN_TIMEOUT);
			}
		}

		if let Some(deadline) = reader_drain_deadline
			&& Instant::now() >= deadline
		{
			break;
		}
		if exit_code.is_none() || !reader_done {
			let wait_duration = reader_drain_deadline.map_or(Duration::from_millis(16), |deadline| {
				deadline
					.saturating_duration_since(Instant::now())
					.min(Duration::from_millis(16))
			});
			match reader_rx.recv_timeout(wait_duration) {
				Ok(ReaderEvent::Chunk(chunk)) => emit_chunk(&chunk, on_chunk.as_ref()),
				Ok(ReaderEvent::Done) => reader_done = true,
				Err(flume::RecvTimeoutError::Timeout) => {},
				Err(flume::RecvTimeoutError::Disconnected) => {
					reader_done = true;
					if exit_code.is_none() {
						std::thread::sleep(wait_duration);
					}
				},
			}
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

	// Step 2: Drain the reader thread.
	// After the child exits and input is closed, ConPTY should flush remaining
	// output and signal EOF on the output pipe, causing the reader thread to exit.
	// On Windows, use a generous timeout to accommodate ConPTY's async teardown.
	if !reader_done {
		#[cfg(windows)]
		let drain_timeout = Duration::from_millis(500);
		#[cfg(not(windows))]
		let drain_timeout = FINAL_READER_DRAIN_TIMEOUT;
		let finalize_deadline = Instant::now() + drain_timeout;
		while Instant::now() < finalize_deadline {
			let remaining = finalize_deadline.saturating_duration_since(Instant::now());
			let wait_duration = remaining.min(Duration::from_millis(5));
			match reader_rx.recv_timeout(wait_duration) {
				Ok(ReaderEvent::Chunk(chunk)) => emit_chunk(&chunk, on_chunk.as_ref()),
				Ok(ReaderEvent::Done) => {
					reader_done = true;
					break;
				},
				Err(flume::RecvTimeoutError::Timeout) => {},
				Err(flume::RecvTimeoutError::Disconnected) => {
					reader_done = true;
					break;
				},
			}
		}
	}

	// Step 3: Drop master (calls ClosePseudoConsole on Windows).
	// ClosePseudoConsole can deadlock if ConPTY tries to flush output
	// while nobody is reading the pipe (microsoft/terminal#1810).
	// Always offload to a background thread on Windows, then wait with
	// a timeout so the thread is reclaimed when ClosePseudoConsole
	// completes cleanly. If it hangs, we walk away — the thread leaks,
	// but the main thread never blocks.
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

	// Step 4: Join reader thread if it finished.
	// A detached descendant can keep the PTY slave open forever; do not block
	// completion waiting on join when the reader thread did not reach EOF.
	if reader_done {
		let _ = reader_thread.join();
	}
	Ok(PtyRunResult { exit_code, cancelled, timed_out })
}

fn emit_chunk(text: &str, callback: Option<&ThreadsafeFunction<String>>) {
	if let Some(callback) = callback {
		callback.call(Ok(text.to_string()), ThreadsafeFunctionCallMode::NonBlocking);
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
