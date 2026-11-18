//! The deliberately small git-CLI escape hatch.
//!
//! Three categories are allowed to spawn `git`, per the hybrid policy:
//! - **Credential-bound network transfers** — clone/fetch/push must reuse the
//!   user's ssh config and credential helpers, which are subprocess-based by
//!   design; no library reaches auth parity (and gitoxide has no send-pack).
//! - **Reftable ref access** — no in-process reftable implementation exists.
//! - **Whole-worktree status/untracked walks** — a subprocess contains gitoxide
//!   worker-thread spawn failures under host resource exhaustion.
//!
//! The runner ports the hardened subprocess contract of the TS wrapper:
//! non-interactive env (`GIT_TERMINAL_PROMPT=0`, askpass rejection, `LC_ALL`
//! handling), `--no-optional-locks` for reads, fsmonitor/untracked-cache
//! disabled for writes, ambient `GIT_DIR`-family vars stripped, bounded output
//! capture, bounded post-exit pipe draining, and deadline + SIGTERM→SIGKILL
//! termination via tokio.

#[cfg(unix)]
use std::os::fd::AsRawFd as AsRawPipe;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle as AsRawPipe;
use std::{
	ffi::OsStr,
	path::Path,
	process::Stdio,
	sync::{Arc, Mutex},
	time::Duration,
};

use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use super::GitRepo;
use crate::{
	error::{Error, Result},
	types::{CloneOptions, PushOptions},
};

/// Default deadline for local git plumbing via the fallback runner.
pub const COMMAND_TIMEOUT: Duration = Duration::from_mins(5);
/// Default deadline for network transfers (`clone`/`fetch`/`push`); large-repo
/// transfers legitimately outlive [`COMMAND_TIMEOUT`].
pub const NETWORK_TIMEOUT: Duration = Duration::from_mins(30);
/// Deadline for synchronous plumbing on render paths (reftable HEAD reads):
/// a stalled invocation degrades instead of freezing the UI.
pub const SYNC_TIMEOUT: Duration = Duration::from_secs(5);
/// Maximum captured bytes per stream before truncation.
pub const OUTPUT_LIMIT_BYTES: usize = 8 * 1024 * 1024;

const TERMINATE_GRACE: Duration = Duration::from_secs(5);
/// Descendants can retain the pipes after git exits; do not wait for their EOF.
const DRAIN_GRACE: Duration = Duration::from_secs(1);
/// Idle synchronous readers must notice output collection without waiting for
/// EOF.
const READER_POLL_INTERVAL: Duration = Duration::from_millis(50);
const TRUNCATION_MARKER: &str = "\n[git subprocess output truncated at the capture limit]\n";

/// Publish each chunk so a bounded drain can return the bytes already captured.
#[derive(Default)]
struct OutputCapture {
	retained:  Vec<u8>,
	truncated: bool,
	closed:    bool,
}

impl OutputCapture {
	/// Stop a reader once its caller has collected the output.
	fn append(&mut self, bytes: &[u8], limit: usize) -> bool {
		if self.closed {
			return false;
		}
		if !self.truncated {
			let keep = bytes.len().min(limit - self.retained.len());
			self.retained.extend_from_slice(&bytes[..keep]);
			self.truncated = keep < bytes.len();
		}
		true
	}

	fn take(&mut self) -> String {
		self.closed = true;
		let mut text = String::from_utf8_lossy_owned(std::mem::take(&mut self.retained));
		if self.truncated {
			text.push_str(TRUNCATION_MARKER);
		}
		text
	}
}

/// Captured result of a completed git invocation.
#[derive(Debug, Clone)]
pub(crate) struct CliOutput {
	/// Process exit code (`124` designates a deadline kill).
	pub exit_code: i32,
	/// Captured stdout, possibly truncated.
	pub stdout:    String,
	/// Captured stderr, possibly truncated.
	pub stderr:    String,
}

impl CliOutput {
	/// Convert a non-zero exit into [`Error::Cli`].
	pub fn into_checked(self, args: &[String]) -> Result<Self> {
		if self.exit_code == 0 {
			return Ok(self);
		}
		Err(Error::Cli {
			command:   format!("git {}", args.join(" ")),
			exit_code: self.exit_code,
			stdout:    self.stdout,
			stderr:    self.stderr,
		})
	}
}

/// Options for one fallback invocation.
#[derive(Debug, Default)]
pub(crate) struct RunOptions {
	/// Prefix `--no-optional-locks` instead of pinning fsmonitor/untracked-cache
	/// off.
	pub read_only: bool,
	/// Deadline; [`COMMAND_TIMEOUT`] when unset.
	pub timeout:   Option<Duration>,
	/// Bytes piped to stdin (commit messages, `update-ref --stdin` scripts).
	pub stdin:     Option<Vec<u8>>,
	/// Cooperative cancellation: the child is terminated when triggered.
	pub cancel:    Option<CancellationToken>,
}

/// Build the hardened argv prefix.
///
/// Reads get `--no-optional-locks`, which already keeps them from rewriting
/// the index, so they keep the repository's fsmonitor and untracked cache: a
/// whole-worktree status on a large repo polled by every open session is far
/// cheaper with both. Writes pin both off so a transient subprocess never
/// mutates fsmonitor/untracked-cache state in the index.
fn hardened_args(args: &[String], read_only: bool) -> Vec<String> {
	let mut out = Vec::with_capacity(args.len() + 4);
	if read_only {
		if !args.iter().any(|arg| arg == "--no-optional-locks") {
			out.push("--no-optional-locks".to_owned());
		}
	} else {
		for pin in ["core.fsmonitor=false", "core.untrackedCache=false"] {
			out.push("-c".to_owned());
			out.push(pin.to_owned());
		}
	}
	out.extend(args.iter().cloned());
	out
}

/// Environment sink for the two command builders. `std::process::Command` and
/// `tokio::process::Command` share no trait, and duplicating the contract per
/// builder is how the synchronous path silently lost the `LC_ALL` removal that
/// [`is_dubious_ownership`] depends on.
trait EnvSink {
	fn set(&mut self, key: &str, value: &str);
	fn unset(&mut self, key: &str);
}

impl EnvSink for std::process::Command {
	fn set(&mut self, key: &str, value: &str) {
		self.env(key, value);
	}

	fn unset(&mut self, key: &str) {
		self.env_remove(key);
	}
}

impl EnvSink for tokio::process::Command {
	fn set(&mut self, key: &str, value: &str) {
		self.env(key, value);
	}

	fn unset(&mut self, key: &str) {
		self.env_remove(key);
	}
}

/// Apply the non-interactive environment contract to a command builder:
/// prompts rejected, editors disabled, ambient repo-location and pathspec
/// overrides stripped, `LC_MESSAGES=C` for parseable errors while preserving a
/// UTF-8 character locale. `LC_ALL` must go: it outranks `LC_MESSAGES`, so
/// leaving it inherited would hand back localized diagnostics.
///
/// The `*_PATHSPECS` variables are global pathspec modes, so an inherited
/// `GIT_LITERAL_PATHSPECS=1` would make the `:(literal)` magic this crate
/// builds match a filename containing that prefix (i.e. nothing), and
/// `GIT_ICASE_PATHSPECS=1` would match case variants the caller did not ask
/// for. Explicit magic is only explicit once they are gone.
fn apply_env(cmd: &mut impl EnvSink) {
	for stripped in [
		"GIT_DIR",
		"GIT_COMMON_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_LITERAL_PATHSPECS",
		"GIT_GLOB_PATHSPECS",
		"GIT_NOGLOB_PATHSPECS",
		"GIT_ICASE_PATHSPECS",
	] {
		cmd.unset(stripped);
	}
	if let Some(lc_all) = std::env::var_os("LC_ALL") {
		let lc_all = lc_all.to_string_lossy().into_owned();
		if is_utf8_locale(&lc_all) {
			cmd.set("LC_CTYPE", &lc_all);
		}
	}
	cmd.unset("LC_ALL");
	cmd.set("LC_MESSAGES", "C");
	cmd.set("GIT_OPTIONAL_LOCKS", "0");
	cmd.set("GIT_ASKPASS", "true");
	cmd.set("GIT_EDITOR", "true");
	cmd.set("GIT_TERMINAL_PROMPT", "0");
	cmd.set("SSH_ASKPASS", "false");
}

/// Loose match for a UTF-8 character locale (`en_US.UTF-8`, `C.utf8`, …).
fn is_utf8_locale(value: &str) -> bool {
	let lower = value.to_ascii_lowercase();
	["utf-8", "utf8"].iter().any(|needle| {
		lower
			.split(['.', '_', '-', '@'])
			.any(|part| part == *needle)
			|| lower.ends_with(needle)
			|| lower.contains(&format!(".{needle}"))
	})
}

/// Start `cmd` in a new session with no controlling terminal, the embedded
/// shell's policy for externals. Without it git and everything it starts (ssh,
/// credential helpers, signers, hooks) share the host's terminal: any of them
/// can read the user's keystrokes and the terminal's protocol replies out from
/// under the TUI, or prompt on it. Detached, a `/dev/tty` open fails
/// (`ENXIO`), so a prompt errors out instead.
#[cfg(unix)]
pub(crate) fn detach_from_terminal(cmd: &mut std::process::Command) {
	std::os::unix::process::CommandExt::setsid(cmd, true);
}

#[cfg(not(unix))]
#[allow(
	clippy::needless_pass_by_ref_mut,
	reason = "no controlling terminal to detach from off unix; the signature matches the unix \
	          variant"
)]
pub(crate) const fn detach_from_terminal(_cmd: &mut std::process::Command) {}

/// Run `git` asynchronously with bounded capture and a deadline.
/// Non-zero exits are returned in [`CliOutput`], not raised.
pub(crate) async fn run(cwd: &Path, args: &[String], options: &RunOptions) -> Result<CliOutput> {
	let argv = hardened_args(args, options.read_only);
	let mut cmd = tokio::process::Command::new("git");
	cmd.args(&argv)
		.current_dir(cwd)
		.stdin(if options.stdin.is_some() {
			Stdio::piped()
		} else {
			Stdio::null()
		})
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.kill_on_drop(true);
	apply_env(&mut cmd);
	detach_from_terminal(cmd.as_std_mut());
	let mut child = cmd.spawn().map_err(|err| spawn_error(cwd, err))?;

	if let Some(stdin) = &options.stdin
		&& let Some(mut pipe) = child.stdin.take()
	{
		use tokio::io::AsyncWriteExt;
		// A child that exits early (e.g. usage error) closes the pipe;
		// that is its answer, not ours to fail on.
		let _ = pipe.write_all(stdin).await;
		let _ = pipe.shutdown().await;
	}

	let stdout = child.stdout.take().expect("stdout piped");
	let stderr = child.stderr.take().expect("stderr piped");
	let stdout_capture = Arc::new(Mutex::new(OutputCapture::default()));
	let stderr_capture = Arc::new(Mutex::new(OutputCapture::default()));
	let mut stdout_task = tokio::spawn(read_capped(stdout, Arc::clone(&stdout_capture)));
	let mut stderr_task = tokio::spawn(read_capped(stderr, Arc::clone(&stderr_capture)));

	let timeout = options.timeout.unwrap_or(COMMAND_TIMEOUT);
	let cancel = options.cancel.clone().unwrap_or_default();
	let exit = tokio::select! {
		status = tokio::time::timeout(timeout, child.wait()) => match status {
			Ok(status) => status.map_err(Error::Io)?,
			Err(_elapsed) => {
				terminate(&mut child).await;
				stdout_task.abort();
				stderr_task.abort();
				return Err(Error::CliTimeout { command: format!("git {}", argv.join(" ")) });
			},
		},
		() = cancel.cancelled() => {
			terminate(&mut child).await;
			stdout_task.abort();
			stderr_task.abort();
			return Err(Error::Canceled);
		},
	};

	// Both readers run concurrently and share one post-exit deadline, even if
	// descendants retain both pipes. A drain timeout keeps the captured bytes.
	let drained = tokio::time::timeout(DRAIN_GRACE, async {
		(&mut stdout_task)
			.await
			.map_err(|err| Error::backend("git run", err))??;
		(&mut stderr_task)
			.await
			.map_err(|err| Error::backend("git run", err))??;
		Ok::<_, Error>(())
	})
	.await;
	stdout_task.abort();
	stderr_task.abort();
	if let Ok(result) = drained {
		result?;
	}
	let stdout = stdout_capture.lock().unwrap().take();
	let stderr = stderr_capture.lock().unwrap().take();
	Ok(CliOutput { exit_code: exit.code().unwrap_or(-1), stdout, stderr })
}

/// Run `git` asynchronously and map a non-zero exit to [`Error::Cli`].
pub(crate) async fn run_checked(
	cwd: &Path,
	args: &[String],
	options: &RunOptions,
) -> Result<CliOutput> {
	run(cwd, args, options).await?.into_checked(args)
}

/// Whether `err` means the git binary could not be launched at all (missing
/// binary or deleted cwd), as opposed to git running and failing. Callers with
/// an in-process fallback (e.g. porcelain status) branch on this.
pub(crate) fn is_spawn_failure(err: &Error) -> bool {
	matches!(err, Error::Backend { context: "git spawn", .. })
}

/// Whether captured output hit [`OUTPUT_LIMIT_BYTES`] and therefore lost
/// bytes. Callers whose output is a value rather than a diagnostic (path
/// lists) must retry in-process or fail, never return the short result.
pub(crate) fn is_truncated(text: &str) -> bool {
	text.ends_with(TRUNCATION_MARKER)
}

/// Whether git refused the checkout under its `safe.directory` ownership
/// check (`fatal: detected dubious ownership`, exit 128), which happens
/// whenever the process user differs from the checkout owner — a
/// host-mounted repository inside a container is the common case.
///
/// `open::open_options` opens user-chosen checkouts with `Trust::Full` on
/// purpose, so the in-process walk has no such objection: a caller with a
/// gitoxide fallback must take it rather than surface an error the
/// library-backed path would never have produced.
///
/// [`apply_env`] pins `LC_MESSAGES=C` and drops the `LC_ALL` that would
/// outrank it, so the English wording is what git emits. `safe.directory` is
/// matched as well: it is a config key, so it survives translation even if a
/// host manages to localize the diagnostic anyway.
pub(crate) fn is_dubious_ownership(err: &Error) -> bool {
	matches!(
		err,
		Error::Cli { exit_code: 128, stderr, .. }
			if stderr.contains("dubious ownership") || stderr.contains("safe.directory")
	)
}

/// Whether `err` describes a CLI that could not do the work at all while the
/// in-process gitoxide path still can.
pub(crate) fn prefers_in_process(err: &Error) -> bool {
	is_spawn_failure(err) || is_dubious_ownership(err)
}

/// Synchronous bounded runner with a caller-chosen deadline; render paths pass
/// [`SYNC_TIMEOUT`] so a stalled git cannot freeze the UI. Stdout/stderr are
/// drained concurrently with capped retention, so output larger than the OS
/// pipe buffer can never stall the child into a spurious timeout.
pub(crate) fn run_sync(cwd: &Path, args: &[String], timeout: Duration) -> Result<CliOutput> {
	run_sync_capped(cwd, args, timeout, OUTPUT_LIMIT_BYTES)
}

/// Stdin and environment for a [`run_sync_write`] invocation.
pub(crate) struct SyncWrite<'a> {
	/// Bytes piped to the child's stdin, then closed.
	pub stdin: &'a [u8],
	/// Variables set after [`apply_env`], so they win over its contract.
	pub env:   &'a [(&'a str, &'a OsStr)],
}

/// Synchronous runner for local write plumbing (fsmonitor/untracked-cache
/// pinned off) that feeds `input.stdin` and sets `input.env` on the child.
pub(crate) fn run_sync_write(
	cwd: &Path,
	args: &[String],
	timeout: Duration,
	input: &SyncWrite<'_>,
) -> Result<CliOutput> {
	run_sync_impl(cwd, args, timeout, OUTPUT_LIMIT_BYTES, Some(input))
}

/// [`run_sync`] with an explicit retention cap. The cap is a parameter rather
/// than a constant read inside the reader threads so a test can exercise the
/// truncation contract on one call without lowering the limit for every other
/// invocation in the process.
pub(crate) fn run_sync_capped(
	cwd: &Path,
	args: &[String],
	timeout: Duration,
	limit: usize,
) -> Result<CliOutput> {
	run_sync_impl(cwd, args, timeout, limit, None)
}

/// Shared synchronous runner: read-only when `write` is `None`.
fn run_sync_impl(
	cwd: &Path,
	args: &[String],
	timeout: Duration,
	limit: usize,
	write: Option<&SyncWrite<'_>>,
) -> Result<CliOutput> {
	let argv = hardened_args(args, write.is_none());
	let mut cmd = std::process::Command::new("git");
	cmd.args(&argv)
		.current_dir(cwd)
		.stdin(if write.is_some() {
			Stdio::piped()
		} else {
			Stdio::null()
		})
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());
	apply_env(&mut cmd);
	detach_from_terminal(&mut cmd);
	if let Some(write) = write {
		for (key, value) in write.env {
			cmd.env(key, value);
		}
	}
	let mut child = cmd.spawn().map_err(|err| spawn_error(cwd, err))?;
	let stdout = spawn_sync_reader("git-cli-stdout", child.stdout.take(), limit);
	let stderr = spawn_sync_reader("git-cli-stderr", child.stderr.take(), limit);
	std::thread::scope(|scope| {
		// The writer runs beside the deadline loop: a child that stops reading
		// must still be killed on time, and the kill closes the pipe, which
		// unblocks the writer before the scope joins it.
		if let Some(write) = write
			&& let Some(mut pipe) = child.stdin.take()
		{
			let writer = std::thread::Builder::new()
				.name("git-cli-stdin".into())
				.spawn_scoped(scope, move || {
					use std::io::Write;
					// A child that exits early closes the pipe; its exit status
					// is the answer, not this write error.
					let _ = pipe.write_all(write.stdin);
				});
			if let Err(err) = writer {
				// The dropped pipe reads as an empty input; the child must not
				// act on it.
				let _ = child.kill();
				let _ = child.wait();
				return Err(Error::backend("git spawn stdin writer", err));
			}
		}
		wait_sync(&argv, child, stdout, stderr, timeout)
	})
}

/// Deadline loop and output collection for [`run_sync_impl`].
fn wait_sync(
	argv: &[String],
	mut child: std::process::Child,
	stdout: Option<SyncReader>,
	stderr: Option<SyncReader>,
	timeout: Duration,
) -> Result<CliOutput> {
	let deadline = std::time::Instant::now() + timeout;
	let status = loop {
		match child.try_wait()? {
			Some(status) => break Some(status),
			None if std::time::Instant::now() >= deadline => {
				let _ = child.kill();
				let _ = child.wait();
				break None;
			},
			None => std::thread::sleep(Duration::from_millis(10)),
		}
	};
	// Git exiting does not imply EOF: descendants can retain either pipe. Give
	// both readers one bounded grace period, then collect their current buffers.
	// Collection closes each capture; polling readers notice it even without
	// EOF.
	let readers = [stdout, stderr];
	let drain_deadline = std::time::Instant::now() + DRAIN_GRACE;
	while readers
		.iter()
		.flatten()
		.any(|reader| !reader.thread.is_finished())
		&& std::time::Instant::now() < drain_deadline
	{
		std::thread::sleep(Duration::from_millis(10));
	}
	let [stdout, stderr] = readers.map(|reader| {
		reader.map_or_default(|reader| {
			if reader.thread.is_finished() {
				let _ = reader.thread.join();
			}
			reader.output.lock().unwrap().take()
		})
	});
	let Some(status) = status else {
		return Err(Error::CliTimeout { command: format!("git {}", argv.join(" ")) });
	};
	Ok(CliOutput { exit_code: status.code().unwrap_or(-1), stdout, stderr })
}

struct SyncReader {
	thread: std::thread::JoinHandle<()>,
	output: Arc<Mutex<OutputCapture>>,
}

/// Drain a child stream on a helper thread, mirroring [`read_capped`].
///
/// `None` when the stream is absent or the thread cannot be spawned (e.g.
/// under the same memory pressure that motivates the CLI path); dropping the
/// stream then closes the pipe, so a chatty child fails with EPIPE and
/// surfaces as a non-zero exit instead of a hang.
fn spawn_sync_reader(
	name: &'static str,
	stream: Option<impl std::io::Read + AsRawPipe + Send + 'static>,
	limit: usize,
) -> Option<SyncReader> {
	let stream = stream?;
	let output = Arc::new(Mutex::new(OutputCapture::default()));
	let capture = Arc::clone(&output);
	let thread = std::thread::Builder::new()
		.name(name.into())
		.spawn(move || read_capped_sync(stream, limit, &capture))
		.ok()?;
	Some(SyncReader { thread, output })
}

/// Synchronous mirror of [`read_capped`]: drain without blocking the child,
/// checking for collection between bounded waits even when the pipe stays open.
fn read_capped_sync(
	mut stream: impl std::io::Read + AsRawPipe,
	limit: usize,
	output: &Mutex<OutputCapture>,
) {
	let mut buf = [0u8; 8 * 1024];
	while !output.lock().unwrap().closed {
		match sync_pipe_ready(&stream) {
			Ok(true) => {},
			Ok(false) => continue,
			Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
			Err(_) => break,
		}
		let n = match stream.read(&mut buf) {
			Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
			Ok(0) | Err(_) => break,
			Ok(n) => n,
		};
		if !output.lock().unwrap().append(&buf[..n], limit) {
			break;
		}
	}
}

/// Only this thread reads the pipe, so readable bytes cannot be consumed
/// between the readiness check and `read`.
#[cfg(unix)]
fn sync_pipe_ready(stream: &impl AsRawPipe) -> std::io::Result<bool> {
	let mut fd = libc::pollfd { fd: stream.as_raw_fd(), events: libc::POLLIN, revents: 0 };
	// SAFETY: fd points to one initialized pollfd; the stream owns its
	// descriptor throughout this bounded wait.
	let ready =
		unsafe { libc::poll(&raw mut fd, 1, READER_POLL_INTERVAL.as_millis() as libc::c_int) };
	if ready < 0 {
		Err(std::io::Error::last_os_error())
	} else {
		Ok(ready > 0)
	}
}

#[cfg(windows)]
fn sync_pipe_ready(stream: &impl AsRawPipe) -> std::io::Result<bool> {
	let mut available = 0;
	// SAFETY: the stream owns this pipe handle. A zero-size peek writes only
	// the byte count, without consuming data or waiting for a writer.
	let ok = unsafe {
		windows_sys::Win32::System::Pipes::PeekNamedPipe(
			stream.as_raw_handle(),
			std::ptr::null_mut(),
			0,
			std::ptr::null_mut(),
			&raw mut available,
			std::ptr::null_mut(),
		)
	};
	if ok == 0 {
		return Err(std::io::Error::last_os_error());
	}
	if available == 0 {
		std::thread::sleep(READER_POLL_INTERVAL);
	}
	Ok(available > 0)
}

fn spawn_error(cwd: &Path, err: std::io::Error) -> Error {
	if err.kind() == std::io::ErrorKind::NotFound {
		// A deleted cwd also surfaces as spawn ENOENT; only blame the binary
		// when the working directory actually exists.
		let message = if cwd.exists() {
			"git is not installed.".to_owned()
		} else {
			format!("working directory does not exist: {}", cwd.display())
		};
		return Error::backend("git spawn", message);
	}
	Error::Io(err)
}

/// Read a stream to completion, capping retention at [`OUTPUT_LIMIT_BYTES`]
/// while continuing to drain so the child never blocks on a full pipe.
async fn read_capped(
	mut stream: impl tokio::io::AsyncRead + Unpin,
	output: Arc<Mutex<OutputCapture>>,
) -> Result<()> {
	let mut buf = [0u8; 8 * 1024];
	loop {
		let n = stream.read(&mut buf).await.map_err(Error::Io)?;
		if n == 0 {
			break;
		}
		if !output.lock().unwrap().append(&buf[..n], OUTPUT_LIMIT_BYTES) {
			break;
		}
	}
	Ok(())
}

/// SIGTERM, grace period, then SIGKILL.
async fn terminate(child: &mut tokio::process::Child) {
	#[cfg(unix)]
	if let Some(pid) = child.id() {
		// SAFETY: plain kill(2) on a pid we own; no memory is touched.
		unsafe {
			libc::kill(pid as i32, libc::SIGTERM);
		}
		if tokio::time::timeout(TERMINATE_GRACE, child.wait())
			.await
			.is_ok()
		{
			return;
		}
	}
	let _ = child.kill().await;
	let _ = tokio::time::timeout(TERMINATE_GRACE, child.wait()).await;
}

// ═══════════════════════════════════════════════════════════════════════════
// Network operations (public API)
// ═══════════════════════════════════════════════════════════════════════════

impl GitRepo {
	/// Push the current branch (branch-scoped: never follows tags).
	///
	/// `--no-follow-tags` overrides a user's `push.followTags = true`, which
	/// would otherwise ride every reachable annotated tag along with the
	/// branch — rejected refs on remotes the user cannot tag (e.g. PR-head
	/// forks) would fail the call after the branch itself already updated.
	pub async fn push(
		&self,
		options: &PushOptions,
		cancel: Option<CancellationToken>,
	) -> Result<()> {
		let mut args = vec!["push".to_owned(), "--no-follow-tags".to_owned()];
		if options.force_with_lease {
			args.push("--force-with-lease".to_owned());
		}
		if let Some(remote) = &options.remote {
			args.push(remote.clone());
		}
		if let Some(refspec) = &options.refspec {
			args.push(refspec.clone());
		}
		run_checked(self.root(), &args, &RunOptions {
			timeout: Some(NETWORK_TIMEOUT),
			cancel,
			..RunOptions::default()
		})
		.await?;
		Ok(())
	}

	/// Fetch `+source:target` from a remote.
	pub async fn fetch(
		&self,
		remote: &str,
		source: &str,
		target: &str,
		timeout: Option<Duration>,
		cancel: Option<CancellationToken>,
	) -> Result<()> {
		let args = vec!["fetch".to_owned(), remote.to_owned(), format!("+{source}:{target}")];
		run_checked(self.root(), &args, &RunOptions {
			timeout: Some(timeout.unwrap_or(NETWORK_TIMEOUT)),
			cancel,
			..RunOptions::default()
		})
		.await?;
		Ok(())
	}
}

/// Clone `url` into `target_dir`, removing the partial clone on any failure.
///
/// Shallow (`--depth 1 --single-branch`) unless a specific SHA is pinned:
/// a shallow clone only fetches the tip, so checking out a non-tip commit
/// would fail with "reference is not a tree".
pub async fn clone(
	url: &str,
	target_dir: &Path,
	options: &CloneOptions,
	cancel: Option<CancellationToken>,
) -> Result<()> {
	let absolute = std::path::absolute(target_dir)?;
	let parent = absolute
		.parent()
		.map_or_else(|| absolute.clone(), Path::to_owned);
	tokio::fs::create_dir_all(&parent).await?;

	let shallow = options.sha.is_none();
	let mut args = vec!["clone".to_owned()];
	if shallow {
		args.push("--depth".to_owned());
		args.push("1".to_owned());
	}
	if let Some(ref_name) = &options.ref_name {
		args.push("--branch".to_owned());
		args.push(ref_name.clone());
		args.push("--single-branch".to_owned());
	} else if shallow {
		args.push("--single-branch".to_owned());
	}
	args.push(url.to_owned());
	args.push(absolute.to_string_lossy().into_owned());

	let run_options = RunOptions {
		timeout: Some(options.timeout.unwrap_or(NETWORK_TIMEOUT)),
		cancel: cancel.clone(),
		..RunOptions::default()
	};
	let outcome = run_checked(&parent, &args, &run_options).await;
	if let Err(err) = outcome {
		let _ = tokio::fs::remove_dir_all(&absolute).await;
		return Err(err);
	}

	if let Some(sha) = &options.sha {
		let checkout = run_checked(&absolute, &["checkout".to_owned(), sha.clone()], &RunOptions {
			cancel,
			..RunOptions::default()
		})
		.await;
		if checkout.is_err() {
			let _ = tokio::fs::remove_dir_all(&absolute).await;
			return Err(Error::backend(
				"git clone",
				format!("failed to checkout SHA {sha} in cloned repository {url}"),
			));
		}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[cfg(unix)]
	struct PipeHolder(tempfile::TempDir);

	#[cfg(unix)]
	impl PipeHolder {
		fn new() -> Self {
			Self(tempfile::tempdir().expect("tempdir"))
		}

		fn args() -> [String; 3] {
			[
				"-c".to_owned(),
				r#"alias.leak=!sh -c 'printf "out\n"; printf "err\n" >&2; sleep 20 & echo $! > sleep.pid'"#
					.to_owned(),
				"leak".to_owned(),
			]
		}
	}

	#[cfg(unix)]
	impl Drop for PipeHolder {
		fn drop(&mut self) {
			if let Ok(pid) = std::fs::read_to_string(self.0.path().join("sleep.pid"))
				&& let Ok(pid) = pid.trim().parse::<libc::pid_t>()
				&& pid > 0
			{
				// SAFETY: the pid belongs to the fixture's background sleep.
				unsafe {
					libc::kill(pid, libc::SIGKILL);
				}
			}
		}
	}

	#[cfg(unix)]
	#[test]
	fn sync_runner_bounds_drain_when_a_descendant_holds_pipes() {
		let fixture = PipeHolder::new();
		let started = std::time::Instant::now();
		let out = run_sync(fixture.0.path(), &PipeHolder::args(), SYNC_TIMEOUT).expect("run alias");
		assert!(started.elapsed() < Duration::from_secs(10), "drain outlived git");
		assert_eq!(out.exit_code, 0, "alias failed: {out:?}");
		assert_eq!(out.stdout, "out\n");
		assert_eq!(out.stderr, "err\n");
	}

	#[cfg(unix)]
	#[test]
	fn sync_readers_exit_after_repeated_calls_while_descendant_holds_pipes() {
		let fixtures = [PipeHolder::new(), PipeHolder::new(), PipeHolder::new()];
		let mut captures = Vec::new();
		for fixture in &fixtures {
			let args = PipeHolder::args();
			let mut cmd = std::process::Command::new("git");
			cmd.args(&args)
				.current_dir(fixture.0.path())
				.stdin(Stdio::null())
				.stdout(Stdio::piped())
				.stderr(Stdio::piped());
			apply_env(&mut cmd);
			detach_from_terminal(&mut cmd);
			let mut child = cmd.spawn().expect("spawn alias");
			let stdout = spawn_sync_reader("git-cli-stdout", child.stdout.take(), OUTPUT_LIMIT_BYTES)
				.expect("stdout reader");
			let stderr = spawn_sync_reader("git-cli-stderr", child.stderr.take(), OUTPUT_LIMIT_BYTES)
				.expect("stderr reader");
			captures.extend([Arc::clone(&stdout.output), Arc::clone(&stderr.output)]);
			let out = wait_sync(&args, child, Some(stdout), Some(stderr), SYNC_TIMEOUT)
				.expect("wait for alias");
			assert_eq!(out.exit_code, 0, "alias failed: {out:?}");
			assert_eq!(out.stdout, "out\n");
			assert_eq!(out.stderr, "err\n");
		}
		let deadline = std::time::Instant::now() + Duration::from_secs(1);
		// After wait_sync drops its readers, only this test and any still-live
		// reader threads own the captures. No global counter races other tests.
		while captures
			.iter()
			.any(|capture| Arc::strong_count(capture) > 1)
			&& std::time::Instant::now() < deadline
		{
			std::thread::sleep(Duration::from_millis(10));
		}
		let live_readers = captures
			.iter()
			.filter(|capture| Arc::strong_count(capture) > 1)
			.count();
		assert_eq!(live_readers, 0, "reader threads survived output collection");
		for fixture in &fixtures {
			let pid: libc::pid_t = std::fs::read_to_string(fixture.0.path().join("sleep.pid"))
				.expect("sleep pid")
				.trim()
				.parse()
				.expect("numeric pid");
			// SAFETY: signal 0 only probes the fixture process, without killing
			// it.
			assert_eq!(unsafe { libc::kill(pid, 0) }, 0, "pipe holder exited before readers");
		}
	}

	#[test]
	fn sync_reader_exits_after_collection_while_pipe_stays_open() {
		use std::io::Write;

		let (read, mut write) = std::io::pipe().expect("pipe");
		let reader =
			spawn_sync_reader("git-cli-test", Some(read), OUTPUT_LIMIT_BYTES).expect("reader");
		write.write_all(b"out\n").expect("write output");
		let deadline = std::time::Instant::now() + Duration::from_secs(1);
		while reader.output.lock().unwrap().retained.len() < 4 && std::time::Instant::now() < deadline
		{
			std::thread::sleep(Duration::from_millis(10));
		}
		assert_eq!(reader.output.lock().unwrap().take(), "out\n");
		let deadline = std::time::Instant::now() + Duration::from_secs(1);
		while !reader.thread.is_finished() && std::time::Instant::now() < deadline {
			std::thread::sleep(Duration::from_millis(10));
		}
		assert!(reader.thread.is_finished(), "reader thread survived output collection");
		reader.thread.join().expect("reader finished");
		drop(write);
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn async_runner_bounds_drain_when_a_descendant_holds_pipes() {
		let fixture = PipeHolder::new();
		let started = std::time::Instant::now();
		let out = run(fixture.0.path(), &PipeHolder::args(), &RunOptions {
			read_only: true,
			timeout: Some(SYNC_TIMEOUT),
			..RunOptions::default()
		})
		.await
		.expect("run alias");
		assert!(started.elapsed() < Duration::from_secs(10), "drain outlived git");
		assert_eq!(out.exit_code, 0, "alias failed: {out:?}");
		assert_eq!(out.stdout, "out\n");
		assert_eq!(out.stderr, "err\n");
	}

	/// Set on the re-executed child; carries the fixture repository it should
	/// probe. Its presence is what tells the test body which side it is on.
	const ENV_PROBE_REPO: &str = "PI_VCS_TEST_ENV_PROBE_REPO";

	/// Asks git to report the ambient variables it was started with. A `!`-alias
	/// is the only way to make git print its own environment.
	const ENV_PROBE_ALIAS: &str = r#"!printf 'LC_ALL=[%s] LC_CTYPE=[%s] LC_MESSAGES=[%s] LITERAL=[%s] ICASE=[%s]' "$LC_ALL" "$LC_CTYPE" "$LC_MESSAGES" "$GIT_LITERAL_PATHSPECS" "$GIT_ICASE_PATHSPECS""#;

	/// A git left in the host's process group shares its terminal and can read
	/// the TUI's keystrokes and terminal replies (Tern TSP events leaked into
	/// the composer with their leading bytes missing). Both runners must start
	/// it in its own session.
	#[cfg(unix)]
	#[tokio::test]
	async fn runners_start_git_outside_the_host_process_group() {
		let dir = tempfile::tempdir().expect("tempdir");
		let args = ["-c".to_owned(), "alias.pgid=!ps -o pgid= -p $$".to_owned(), "pgid".to_owned()];
		// SAFETY: getpgrp has no preconditions.
		let host = unsafe { libc::getpgrp() };
		let sync = run_sync(dir.path(), &args, SYNC_TIMEOUT).expect("sync runner");
		let spawned = run(dir.path(), &args, &RunOptions::default())
			.await
			.expect("async runner");
		for out in [sync, spawned] {
			assert_eq!(out.exit_code, 0, "alias failed: {out:?}");
			let pgid: i32 = out.stdout.trim().parse().expect("pgid");
			assert_ne!(pgid, host, "git shares the host's process group: {out:?}");
		}
	}

	/// Two guarantees this crate builds on top of, both of which depend on what
	/// the child process actually receives:
	///
	/// - The ownership fallback reads git's diagnostic, and `LC_ALL` outranks
	///   `LC_MESSAGES`, so an inherited one hands back a translated message that
	///   [`is_dubious_ownership`] cannot match.
	/// - The `:(literal)` magic this crate builds is only explicit once the
	///   global pathspec modes are gone; `GIT_LITERAL_PATHSPECS=1` would turn
	///   the prefix into filename text and match nothing.
	///
	/// Asserted through [`run_sync`] rather than [`apply_env`] directly, because
	/// the regression this covers was the synchronous builder not calling the
	/// helper. The variables have to be present before the process starts, and
	/// `set_var` in a running test binary is observable by every other thread,
	/// so the probe runs in a re-executed copy of this test binary spawned with
	/// them already in its environment.
	#[test]
	fn sync_runner_pins_message_locale_and_scrubs_pathspec_modes() {
		if let Some(repo) = std::env::var_os(ENV_PROBE_REPO) {
			let out = run_sync(
				Path::new(&repo),
				&["-c".to_owned(), format!("alias.envprobe={ENV_PROBE_ALIAS}"), "envprobe".to_owned()],
				SYNC_TIMEOUT,
			)
			.expect("run alias");

			assert_eq!(out.exit_code, 0, "alias failed: {out:?}");
			assert!(out.stdout.contains("LC_ALL=[]"), "LC_ALL leaked: {out:?}");
			assert!(out.stdout.contains("LC_MESSAGES=[C]"), "messages not pinned: {out:?}");
			// The character locale is preserved so paths keep round-tripping as
			// UTF-8; only the message locale is forced.
			assert!(
				out.stdout.contains("LC_CTYPE=[fr_FR.UTF-8]"),
				"UTF-8 character locale dropped: {out:?}"
			);
			assert!(out.stdout.contains("LITERAL=[]"), "literal pathspec mode leaked: {out:?}");
			assert!(out.stdout.contains("ICASE=[]"), "icase pathspec mode leaked: {out:?}");
			return;
		}

		let dir = tempfile::tempdir().expect("tempdir");
		let init = std::process::Command::new("git")
			.args(["init", "-q", "-b", "main"])
			.current_dir(dir.path())
			.status()
			.expect("spawn git init");
		assert!(init.success(), "git init failed");

		let name = format!(
			"{}::sync_runner_pins_message_locale_and_scrubs_pathspec_modes",
			module_path!()
				.split_once("::")
				.expect("crate-qualified module path")
				.1
		);
		let child = std::process::Command::new(std::env::current_exe().expect("test binary"))
			.args(["--exact", &name, "--nocapture", "--test-threads=1"])
			.env(ENV_PROBE_REPO, dir.path())
			.env("LC_ALL", "fr_FR.UTF-8")
			.env("GIT_LITERAL_PATHSPECS", "1")
			.env("GIT_ICASE_PATHSPECS", "1")
			.output()
			.expect("re-exec test binary");
		assert!(
			child.status.success(),
			"environment probe failed:\n{}{}",
			String::from_utf8_lossy(&child.stdout),
			String::from_utf8_lossy(&child.stderr)
		);
	}
}
