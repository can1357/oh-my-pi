//! Tests of the embedded shell (`super`), by area. Tests that drive a session
//! directly (rather than through [`Shell`] or [`execute_shell`]) use
//! [`ShellSessionCore::run_test`] with a [`TestStdio`].

#[cfg(unix)]
use std::os::unix::process::ExitStatusExt as _;

use tokio::process::Command;

use super::*;
use crate::proctree;

mod builtins;
mod env_cwd;
mod process_control;
mod redirections;
mod session;

/// The standard streams of a command a test runs on a session directly;
/// `None` is the null device.
#[derive(Default)]
struct TestStdio {
	stdin:  Option<fs::File>,
	stdout: Option<fs::File>,
	stderr: Option<fs::File>,
}

impl TestStdio {
	/// Every stream the null device.
	fn null() -> Self {
		Self::default()
	}

	/// Read stdin from (a duplicate of) `file`.
	fn stdin(mut self, file: &fs::File) -> Self {
		self.stdin = Some(file.try_clone().expect("clone test stdin"));
		self
	}

	/// Write stdout to (a duplicate of) `file`.
	fn stdout(mut self, file: &fs::File) -> Self {
		self.stdout = Some(file.try_clone().expect("clone test stdout"));
		self
	}

	/// Write stderr to (a duplicate of) `file`.
	fn stderr(mut self, file: &fs::File) -> Self {
		self.stderr = Some(file.try_clone().expect("clone test stderr"));
		self
	}

	/// The session streams of one run (duplicates; the session closes them
	/// when the run ends).
	fn run_stdio(&self) -> RunStdio {
		let open = |file: &Option<fs::File>| {
			Some(match file {
				Some(file) => file.try_clone().expect("clone test stream"),
				None => null_file().expect("null device"),
			})
		};
		RunStdio { stdin: open(&self.stdin), stdout: open(&self.stdout), stderr: open(&self.stderr) }
	}
}

impl ShellSessionCore {
	/// Run `command` with `stdio` and no cancellation.
	async fn run_test(
		&mut self,
		command: impl Into<String>,
		stdio: &TestStdio,
	) -> std::result::Result<RunOutcome, SessionError> {
		self
			.run_test_with(command, stdio, CancellationToken::new())
			.await
	}

	/// Run `command` with `stdio`, stopped by `cancel`.
	async fn run_test_with(
		&mut self,
		command: impl Into<String>,
		stdio: &TestStdio,
		cancel: CancellationToken,
	) -> std::result::Result<RunOutcome, SessionError> {
		let outcome = self
			.session
			.run_with(RunOptions::new(command), stdio.run_stdio(), cancel)
			.await?;
		self.cwd.clone_from(&outcome.cwd);
		Ok(outcome)
	}

	/// The shell's working directory after the last command.
	fn working_dir(&self) -> std::path::PathBuf {
		std::path::PathBuf::from(self.cwd.to_str_lossy().into_owned())
	}
}

/// Everything written to the capture file `file`.
fn read_capture(mut file: &fs::File) -> String {
	use std::io::{Read as _, Seek as _};
	file.rewind().expect("rewind capture");
	let mut text = String::new();
	file.read_to_string(&mut text).expect("read capture");
	text
}

/// A run's exit status.
const fn exit_code(outcome: &RunOutcome) -> i32 {
	outcome.status
}

/// A fresh session as [`Shell`] creates one, with no session env.
async fn default_session() -> ShellSessionCore {
	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	create_session(&config).await.expect("create_session")
}

/// 8.3 short spelling of `path` (`GetShortPathNameW`).
#[cfg(windows)]
fn short_name_of(path: &std::path::Path) -> std::path::PathBuf {
	use std::os::windows::ffi::{OsStrExt, OsStringExt};
	let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
	// SAFETY: `wide` is NUL-terminated; a null buffer with length 0 asks
	// only for the required size.
	let needed = unsafe {
		windows_sys::Win32::Storage::FileSystem::GetShortPathNameW(
			wide.as_ptr(),
			std::ptr::null_mut(),
			0,
		)
	};
	assert!(needed > 0, "GetShortPathNameW failed for {}", path.display());
	let mut buf = vec![0u16; needed as usize];
	// SAFETY: `wide` is NUL-terminated and `buf` is writable for
	// `buf.len()` u16s.
	let written = unsafe {
		windows_sys::Win32::Storage::FileSystem::GetShortPathNameW(
			wide.as_ptr(),
			buf.as_mut_ptr(),
			buf.len() as u32,
		)
	};
	assert!(written > 0, "GetShortPathNameW fill failed for {}", path.display());
	buf.truncate(written as usize);
	std::path::PathBuf::from(std::ffi::OsString::from_wide(&buf))
}

#[cfg(windows)]
const LONG_DIR_NAME: &str = "pi-shell-long-name-probe";

/// A fresh directory whose long name has a distinct 8.3 alias, as
/// `(guard, long, short)`. `None` when the volume does not generate short
/// names, since no spelling split can exist there.
#[cfg(windows)]
fn short_alias_fixture() -> Option<(tempfile::TempDir, std::path::PathBuf, std::path::PathBuf)> {
	let root = tempfile::tempdir().expect("tempdir");
	let long = root.path().join(LONG_DIR_NAME);
	std::fs::create_dir(&long).expect("create long-named dir");
	let short = short_name_of(&long);
	(short.file_name() != long.file_name()).then_some((root, long, short))
}

/// A temp directory reachable through an 8.3 alias, as
/// `(short, long, guard)`. Existing profile aliases survive after new 8.3
/// creation is disabled, so the host TEMP is preferred; otherwise a fresh
/// alias is made when the volume still creates them.
#[cfg(windows)]
fn short_temp_fixture()
-> Option<(std::path::PathBuf, std::path::PathBuf, Option<tempfile::TempDir>)> {
	let host_temp = std::env::temp_dir();
	let expanded_host_temp = crate::windows::expand_to_long_path(&host_temp);
	if host_temp != expanded_host_temp {
		return Some((host_temp, expanded_host_temp, None));
	}
	let (root, long, short) = short_alias_fixture()?;
	Some((short, crate::windows::expand_to_long_path(&long), Some(root)))
}

/// Runs `cd "$TEMP"` and asserts the shell cwd, `PWD`, and every temp var
/// share the long spelling `expected`.
#[cfg(windows)]
async fn assert_cd_temp_matches_pwd(shell: &mut ShellSessionCore, expected: &std::path::Path) {
	let expected_str = expected.to_string_lossy().into_owned();
	let result = shell
		.run_test("cd \"$TEMP\"", &TestStdio::null())
		.await
		.expect("cd inherited TEMP");
	assert_eq!(exit_code(&result), 0);
	assert_eq!(shell.working_dir(), expected);
	for key in ["TEMP", "TMP", "TMPDIR", "PWD"] {
		let output = tempfile::tempfile().expect("variable capture");
		let result = shell
			.run_test(format!("printf '%s' \"${key}\""), &TestStdio::null().stdout(&output))
			.await
			.expect("read shell variable");
		assert_eq!(exit_code(&result), 0, "{key}");
		assert_eq!(read_capture(&output), expected_str, "{key}");
	}
}

#[cfg(unix)]
async fn kill_test_context() -> (ShellSessionCore, TestStdio) {
	(default_session().await, TestStdio::null())
}

#[cfg(unix)]
fn pseudo_terminal_session() -> (std::os::fd::OwnedFd, fs::File) {
	use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd};

	let mut master = -1;
	let mut slave = -1;
	// SAFETY: openpty initializes two new owned file descriptors on success;
	// the null name, termios, and winsize pointers request defaults.
	let opened = unsafe {
		libc::openpty(
			&mut master,
			&mut slave,
			std::ptr::null_mut(),
			std::ptr::null_mut(),
			std::ptr::null_mut(),
		)
	};
	assert_eq!(opened, 0, "openpty");
	// SAFETY: openpty returned unique descriptors on success.
	let master = unsafe { OwnedFd::from_raw_fd(master) };
	// SAFETY: openpty returned unique descriptors on success.
	let slave = unsafe { fs::File::from_raw_fd(slave) };
	// SAFETY: this re-exec test process inherited its parent's process
	// group, so it is not a process-group leader and may create a session.
	assert_ne!(unsafe { libc::setsid() }, -1, "setsid");
	// SAFETY: slave is a live pseudo-terminal descriptor owned by this
	// process; fd 0 is deliberately replaced only in this isolated test.
	assert_eq!(unsafe { libc::dup2(slave.as_raw_fd(), libc::STDIN_FILENO) }, 0, "dup2 stdin");
	// The ioctl request parameter's integer type differs between platforms.
	let tiocsctty = libc::TIOCSCTTY as _;
	// SAFETY: this session has no controlling terminal and fd 0 is the
	// pseudo-terminal slave, so TIOCSCTTY establishes it as controlling.
	assert_eq!(unsafe { libc::ioctl(libc::STDIN_FILENO, tiocsctty, 0) }, 0, "TIOCSCTTY");
	for signal in [libc::SIGTTOU, libc::SIGHUP] {
		// SAFETY: this isolated test process deliberately ignores terminal
		// background-write stops and hangups while fg hands the
		// pseudo-terminal to a job. The dispositions cannot escape the
		// re-exec test process.
		let previous = unsafe { libc::signal(signal, libc::SIG_IGN) };
		assert_ne!(previous, libc::SIG_ERR, "ignore terminal job-control signal {signal}");
	}
	crate::sys::dispositions_changed();
	(master, slave)
}

#[cfg(unix)]
async fn interactive_kill_test_context(terminal_stdin: &fs::File) -> (ShellSessionCore, TestStdio) {
	let mut session = default_session().await;
	let stdio = TestStdio::null().stdin(terminal_stdin);
	let enabled = session.run_test("set -m", &stdio).await.expect("set -m");
	assert_eq!(enabled.status, 0, "job control could not be enabled");
	(session, stdio)
}

/// Shell-quotes an argument when building a command string for a test.
///
/// Mirrors what the `timeout`/`nohup` builtins do when they rebuild a
/// command line; kept local because it exists only to construct these
/// fixtures.
fn quote_arg(arg: &str) -> String {
	if arg.is_empty() {
		return "''".to_string();
	}
	if arg
		.chars()
		.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':' | '+'))
	{
		return arg.to_string();
	}
	let escaped = arg.replace('\'', "'\"'\"'");
	format!("'{escaped}'")
}

async fn execute_captured(command: String) -> (ShellExecuteResult, String) {
	let (tx, rx) = flume::unbounded();
	let result = execute_shell(
		ShellExecuteOptions { command, ..Default::default() },
		Some(tx),
		CancelToken::default(),
	)
	.await
	.expect("shell execution");
	let output = rx.try_iter().collect();
	(result, output)
}

/// Waits until `pid` runs as `expected`. Each poll walks the whole process
/// table, which takes seconds on a loaded host, so the bound is generous;
/// it stays below the 30 s lifetime of the process-test children.
#[cfg(unix)]
async fn wait_for_process_name(pid: i32, expected: &str) {
	time::timeout(Duration::from_secs(20), async {
		loop {
			if pi_builtins::ProcInfo::all().into_iter().any(|process| {
				process.pid() == pid
					&& process.match_name() == expected
					&& process.status() == pi_builtins::ProcessStatus::Running
			}) {
				return;
			}
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("child did not enter expected executable");
}

#[cfg(unix)]
fn test_executable(name: &str) -> std::path::PathBuf {
	use std::os::unix::fs::PermissionsExt as _;

	std::env::var_os("PATH")
		.and_then(|path| {
			std::env::split_paths(&path)
				.map(|directory| directory.join(name))
				.find(|candidate| {
					candidate.metadata().is_ok_and(|metadata| {
						metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
					})
				})
		})
		.unwrap_or_else(|| panic!("{name} executable on PATH"))
}

#[cfg(unix)]
fn process_test_command(prefix: &str) -> (tempfile::TempDir, std::path::PathBuf, String) {
	let dir = tempfile::tempdir().expect("process test directory");
	let name = format!("{prefix}{}", std::process::id());
	let command = dir.path().join(&name);
	let test_binary = std::env::current_exe().expect("current test executable");
	std::os::unix::fs::symlink(test_binary, &command).expect("test executable symlink");
	(dir, command, name)
}

#[cfg(unix)]
fn process_test_child(command: &std::path::Path, duration: Duration) -> Command {
	let duration_ms = u64::try_from(duration.as_millis()).expect("test duration fits u64");
	let mut child = Command::new(command);
	child
		.args(["--ignored", "--exact", "shell::tests::process_test_sleeper"])
		.env("PI_SHELL_PROCESS_TEST_SLEEP_MS", duration_ms.to_string())
		.stdout(std::process::Stdio::null())
		.stderr(std::process::Stdio::null());
	child
}

#[cfg(unix)]
struct PidfileProcessCleanup(Vec<std::path::PathBuf>);

#[cfg(unix)]
impl Drop for PidfileProcessCleanup {
	fn drop(&mut self) {
		for pidfile in &self.0 {
			if let Some(process) = fs::read_to_string(pidfile)
				.ok()
				.and_then(|pid| pid.trim().parse::<i32>().ok())
				.and_then(proctree::Process::from_pid)
			{
				let _ = process.kill_tree(Some(libc::SIGKILL));
			}
		}
	}
}

async fn run_isolated_kill_test(test_name: &str, marker: &str, own_process_group: bool) {
	let mut command =
		tokio::process::Command::new(std::env::current_exe().expect("current test executable"));
	command.args(["--exact", test_name]).env(marker, "1");
	#[cfg(unix)]
	if own_process_group {
		command.process_group(0);
	}
	#[cfg(not(unix))]
	let _ = own_process_group;
	let status = command.status().await.expect("isolated test process");
	assert!(status.success(), "isolated kill test failed: {status}");
}

fn shell_test_lock() -> &'static TokioMutex<()> {
	static LOCK: TokioMutex<()> = TokioMutex::const_new(());
	&LOCK
}

/// Runs `command` under [`shell_test_lock`] and returns its result and
/// output.
#[cfg(unix)]
async fn run_command_capture(
	command: &str,
	cwd: Option<&std::path::Path>,
	minimizer: Option<minimizer::MinimizerOptions>,
	cancel_token: CancelToken,
) -> (ShellExecuteResult, String) {
	let _guard = shell_test_lock().lock().await;
	capture_unlocked(command, cwd, minimizer, cancel_token).await
}

/// [`run_command_capture`] that fails once the run outlasts `limit`. The
/// limit starts when the lock is held: in a single-process `cargo test`,
/// the wait behind slower shell tests took up the limit of a fast one.
#[cfg(unix)]
async fn run_command_capture_within(
	limit: Duration,
	command: &str,
	cwd: Option<&std::path::Path>,
	minimizer: Option<minimizer::MinimizerOptions>,
	cancel_token: CancelToken,
) -> Result<(ShellExecuteResult, String), time::error::Elapsed> {
	let _guard = shell_test_lock().lock().await;
	time::timeout(limit, capture_unlocked(command, cwd, minimizer, cancel_token)).await
}

/// Runs `command` and collects its streamed output; the caller holds
/// [`shell_test_lock`].
#[cfg(unix)]
async fn capture_unlocked(
	command: &str,
	cwd: Option<&std::path::Path>,
	minimizer: Option<minimizer::MinimizerOptions>,
	cancel_token: CancelToken,
) -> (ShellExecuteResult, String) {
	let (tx, rx) = flume::unbounded::<String>();
	let options = ShellExecuteOptions {
		command: command.to_string(),
		cwd: cwd.map(|path| path.to_string_lossy().into_owned()),
		minimizer,
		..Default::default()
	};
	let result = execute_shell(options, Some(tx), cancel_token)
		.await
		.expect("execute_shell");
	let mut output = String::new();
	while let Ok(chunk) = rx.recv_async().await {
		output.push_str(&chunk);
	}
	(result, output)
}

#[cfg(unix)]
fn unique_temp_dir(prefix: &str) -> std::path::PathBuf {
	let mut path = std::env::temp_dir();
	let nonce = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.expect("system time")
		.as_nanos();
	path.push(format!("pi-shell-{prefix}-{}-{nonce}", std::process::id()));
	std::fs::create_dir_all(&path).expect("create temp dir");
	path
}

/// Runs `command` on a dedicated single-worker runtime and fails after five
/// seconds.
#[cfg(unix)]
fn capture_on_single_worker(command: &'static str) -> (ShellExecuteResult, String) {
	capture_on_runtime(command, None, 512)
		.expect("read must not wait on a blocking worker it cannot get")
}

/// Runs `command` in `cwd` on a dedicated single-worker runtime whose
/// blocking pool holds `max_blocking_threads`; fails once the run outlasts
/// five seconds. The deadline lives on the calling thread, so it still
/// fires when a builtin blocks the runtime's only worker, and starts once
/// this thread holds [`shell_test_lock`].
#[cfg(unix)]
fn capture_on_runtime(
	command: &'static str,
	cwd: Option<std::path::PathBuf>,
	max_blocking_threads: usize,
) -> Result<(ShellExecuteResult, String), std::sync::mpsc::RecvTimeoutError> {
	let _guard = shell_test_lock().blocking_lock();
	let (tx, rx) = std::sync::mpsc::channel();
	std::thread::spawn(move || {
		let runtime = tokio::runtime::Builder::new_multi_thread()
			.worker_threads(1)
			.max_blocking_threads(max_blocking_threads)
			.enable_all()
			.build()
			.expect("single-worker runtime");
		let _ = tx.send(runtime.block_on(capture_unlocked(
			command,
			cwd.as_deref(),
			None,
			CancelToken::default(),
		)));
	});
	rx.recv_timeout(Duration::from_secs(5))
}

#[cfg(unix)]
fn printf_minimizer(
	settings_path: &std::path::Path,
	max_capture_bytes: Option<u32>,
) -> minimizer::MinimizerOptions {
	std::fs::write(
		settings_path,
		r#"
schema_version = 1

[filters.printf]
match_command = "^printf$"
replace = [{ pattern = "hello", replacement = "HI" }]
"#,
	)
	.expect("write settings");
	minimizer::MinimizerOptions {
		enabled: Some(true),
		settings_path: Some(settings_path.to_string_lossy().into_owned()),
		max_capture_bytes,
		..Default::default()
	}
}

/// Lets in-flight writes land, empties `path`, and reports whether anything
/// wrote to it again: a background `yes` still running refills it within
/// milliseconds.
async fn still_written(path: &std::path::Path) -> bool {
	time::sleep(Duration::from_millis(300)).await;
	std::fs::File::options()
		.write(true)
		.open(path)
		.and_then(|file| file.set_len(0))
		.expect("truncate output");
	time::sleep(Duration::from_millis(300)).await;
	std::fs::metadata(path).expect("stat output").len() > 0
}

/// Runs `command` on a fresh shell with pipe taps, collecting its output.
fn run_tapped(
	command: &str,
	cancel: CancelToken,
) -> (Arc<PipeTaps>, tokio::task::JoinHandle<Result<ShellRunResult>>, flume::Receiver<String>) {
	let taps = Arc::new(PipeTaps::new());
	let (tx, rx) = flume::unbounded::<String>();
	let options = ShellRunOptions {
		command: command.into(),
		pipe_taps: Some(Arc::clone(&taps)),
		..Default::default()
	};
	let run = tokio::spawn(async move { Shell::new(None).run(options, Some(tx), cancel).await });
	(taps, run, rx)
}

/// Everything a finished run printed.
async fn collect_output(rx: &flume::Receiver<String>) -> String {
	let mut output = String::new();
	while let Ok(chunk) = rx.recv_async().await {
		output.push_str(&chunk);
	}
	output
}

#[cfg(unix)]
#[test]
#[ignore = "spawned by process-control tests"]
fn process_test_sleeper() {
	let Ok(duration_ms) = std::env::var("PI_SHELL_PROCESS_TEST_SLEEP_MS") else {
		return;
	};
	let duration_ms = duration_ms
		.parse()
		.expect("valid process test sleep duration");
	std::thread::sleep(Duration::from_millis(duration_ms));
}
