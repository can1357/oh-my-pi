//! Runtime-agnostic brush shell execution.

#[cfg(windows)]
use std::collections::HashSet;
use std::{
	collections::HashMap,
	fs,
	io::{self},
	str,
	sync::Arc,
	time::Duration,
};

use anyhow::{Error, Result};
use brush_core::{
	ExecutionControlFlow, ExecutionExitCode, ExecutionParameters, ExecutionResult,
	ProcessGroupPolicy, ProfileLoadBehavior, RcLoadBehavior, Shell as BrushShell, ShellValue,
	ShellVariable, SourceInfo, SpawnObserver,
	env::EnvironmentScope,
	openfiles::{self, OpenFile, OpenFiles},
};
use bytes::Bytes;
use flume::Sender;
use pi_builtins::{BuiltinSet, default_builtins};
#[cfg(not(unix))]
use tokio::io::AsyncReadExt as _;
use tokio::{sync::Mutex as TokioMutex, time};
use tokio_util::sync::CancellationToken;

#[cfg(windows)]
use crate::windows::configure_windows_path;
use crate::{
	cancel::{AbortReason, AbortToken, CancelToken},
	minimizer, process,
};

struct ShellSessionCore {
	shell: BrushShell,
}

impl Drop for ShellSessionCore {
	fn drop(&mut self) {
		terminate_internal_background_jobs(&mut self.shell);
	}
}

#[derive(Clone, Default)]
struct ShellAbortState(Arc<TokioMutex<Option<AbortToken>>>);

impl ShellAbortState {
	async fn set(&self, abort_token: AbortToken) {
		*self.0.lock().await = Some(abort_token);
	}

	async fn clear(&self) {
		*self.0.lock().await = None;
	}

	async fn abort(&self) {
		let abort_token = self.0.lock().await.clone();
		if let Some(abort_token) = abort_token {
			abort_token.abort(AbortReason::Signal);
		}
	}
}

fn shell_working_dir_matches(shell: &BrushShell, cwd: &str) -> bool {
	let requested = std::path::Path::new(cwd);
	if !requested.is_absolute() {
		return false;
	}
	let current = shell.working_dir();
	current == requested
}

fn set_shell_working_dir_if_changed(shell: &mut BrushShell, cwd: &str) -> Result<()> {
	if shell_working_dir_matches(shell, cwd) {
		return Ok(());
	}
	shell
		.set_working_dir(cwd)
		.map_err(|err| Error::msg(format!("Failed to set cwd: {err}")))
}

#[derive(Clone)]
struct ShellConfig {
	session_env:   Option<HashMap<String, String>>,
	snapshot_path: Option<String>,
	minimizer:     Option<minimizer::MinimizerConfig>,
}

#[derive(Debug, Clone, Default)]
pub struct ShellOptions {
	pub session_env:   Option<HashMap<String, String>>,
	pub snapshot_path: Option<String>,
	pub minimizer:     Option<minimizer::MinimizerOptions>,
}

struct ShellRunConfig {
	command:   String,
	cwd:       Option<String>,
	env:       Option<HashMap<String, String>>,
	minimizer: Option<minimizer::MinimizerConfig>,
}

#[derive(Debug, Clone, Default)]
pub struct ShellRunOptions {
	pub command:    String,
	pub cwd:        Option<String>,
	pub env:        Option<HashMap<String, String>>,
	pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MinimizerResult {
	pub filter:        String,
	pub text:          String,
	pub original_text: String,
	pub input_bytes:   u32,
	pub output_bytes:  u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ShellRunResult {
	pub exit_code:   Option<i32>,
	pub cancelled:   bool,
	pub timed_out:   bool,
	pub minimized:   Option<MinimizerResult>,
	pub working_dir: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ShellExecuteOptions {
	pub command:       String,
	pub cwd:           Option<String>,
	pub env:           Option<HashMap<String, String>>,
	pub session_env:   Option<HashMap<String, String>>,
	pub timeout_ms:    Option<u32>,
	pub snapshot_path: Option<String>,
	pub minimizer:     Option<minimizer::MinimizerOptions>,
}

pub type ShellExecuteResult = ShellRunResult;

pub struct Shell {
	session:     Arc<TokioMutex<Option<ShellSessionCore>>>,
	abort_state: ShellAbortState,
	config:      ShellConfig,
}

impl Shell {
	#[must_use]
	pub fn new(options: Option<ShellOptions>) -> Self {
		let config = match options {
			None => ShellConfig { session_env: None, snapshot_path: None, minimizer: None },
			Some(opt) => {
				let minimizer = opt
					.minimizer
					.as_ref()
					.map(minimizer::MinimizerConfig::from_options);
				ShellConfig {
					session_env: opt.session_env,
					snapshot_path: opt.snapshot_path,
					minimizer,
				}
			},
		};
		Self {
			session: Arc::new(TokioMutex::new(None)),
			abort_state: ShellAbortState::default(),
			config,
		}
	}

	pub async fn run(
		&self,
		options: ShellRunOptions,
		on_chunk: Option<Sender<String>>,
		mut cancel_token: CancelToken,
	) -> Result<ShellRunResult> {
		let run_config = ShellRunConfig {
			command:   options.command,
			cwd:       options.cwd,
			env:       options.env,
			minimizer: self.config.minimizer.clone(),
		};
		run_shell_session(
			self.session.clone(),
			self.abort_state.clone(),
			self.config.clone(),
			run_config,
			on_chunk,
			&mut cancel_token,
		)
		.await
	}

	pub async fn abort(&self) {
		self.abort_state.abort().await;
	}

	/// Number of live background jobs (running `&`/`nohup` children) tracked by
	/// the persistent session. Completed jobs are reaped first via a silent
	/// `JobManager::poll()` (no job-control notifications), so the count
	/// reflects only processes still alive. Returns 0 when no session core is
	/// materialized. The host uses this to decide whether to retain a per-call
	/// shell whose background children are still running instead of dropping it
	/// (which would SIGKILL them on kill-on-drop).
	pub async fn live_background_job_count(&self) -> u32 {
		let mut guard = self.session.lock().await;
		let Some(core) = guard.as_mut() else {
			return 0;
		};
		let jobs = core.shell.jobs_mut();
		// Fail closed: a poll error leaves the job table in an unknown state, so
		// report 0 (drop the shell) rather than pin a retained session forever on
		// stale `representative_pid()` entries.
		if jobs.poll().is_err() {
			return 0;
		}
		u32::try_from(
			jobs
				.jobs
				.iter()
				.filter(|job| job.representative_pid().is_some())
				.count(),
		)
		.unwrap_or(u32::MAX)
	}
}

pub async fn execute_shell(
	options: ShellExecuteOptions,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancelToken,
) -> Result<ShellExecuteResult> {
	let minimizer = options
		.minimizer
		.as_ref()
		.map(minimizer::MinimizerConfig::from_options);
	let config = ShellConfig {
		session_env:   options.session_env,
		snapshot_path: options.snapshot_path,
		minimizer:     minimizer.clone(),
	};
	let run_config =
		ShellRunConfig { command: options.command, cwd: options.cwd, env: options.env, minimizer };
	run_shell_oneshot(config, run_config, on_chunk, cancel_token).await
}

/// Optional per-stream raw byte sinks for [`execute_shell_streams`].
///
/// When a sink is `Some`, that stream's pipe is drained directly into the
/// channel with no UTF-8 decoding and no merging. When `None`, the
/// corresponding pipe is still drained (to avoid blocking the child) but
/// its bytes are dropped.
#[derive(Default)]
pub struct StreamSinks {
	pub stdout: Option<Sender<Bytes>>,
	pub stderr: Option<Sender<Bytes>>,
}

/// One-shot execution that delivers stdout/stderr as raw byte chunks.
///
/// Bytes are delivered on separate channels with no UTF-8 decoding and no
/// merging. The minimizer is intentionally disabled — its
/// `MinimizerResult.text` contract presumes a single merged transcript.
pub async fn execute_shell_streams(
	options: ShellExecuteOptions,
	streams: StreamSinks,
	cancel_token: CancelToken,
) -> Result<ShellExecuteResult> {
	let config = ShellConfig {
		session_env:   options.session_env,
		snapshot_path: options.snapshot_path,
		minimizer:     None,
	};
	let run_config = ShellRunConfig {
		command:   options.command,
		cwd:       options.cwd,
		env:       options.env,
		minimizer: None,
	};
	run_shell_oneshot_streams(config, run_config, streams, cancel_token).await
}

async fn run_shell_session(
	session: Arc<TokioMutex<Option<ShellSessionCore>>>,
	abort_state: ShellAbortState,
	config: ShellConfig,
	run_config: ShellRunConfig,
	on_chunk: Option<Sender<String>>,
	ct: &mut CancelToken,
) -> Result<ShellRunResult> {
	let tokio_cancel = CancellationToken::new();
	let spawn_registry = Arc::new(process::SpawnRegistry::new());
	let process_cancel_bridge = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		let spawn_registry = spawn_registry.clone();
		async move {
			tokio_cancel.cancelled().await;
			terminate_run(&spawn_registry).await;
		}
	});

	let mut run_task = tokio::spawn({
		let session = session.clone();
		let abort_state = abort_state.clone();
		let tokio_cancel = tokio_cancel.clone();
		let at = ct.emplace_abort_token();
		let spawn_registry = spawn_registry.clone();
		async move {
			let mut session_guard = session.lock().await;

			let session = match &mut *session_guard {
				Some(session) => session,
				None => session_guard.insert(
					create_session_for_run(
						&config,
						Some(spawn_registry.clone()),
						Some(tokio_cancel.clone()),
					)
					.await?,
				),
			};
			abort_state.set(at).await;
			run_shell_command(session, &run_config, on_chunk, tokio_cancel, spawn_registry).await
		}
	});

	let res = tokio::select! {
		res = &mut run_task => res,
		reason = ct.wait() => {
			tokio_cancel.cancel();
			let graceful = time::timeout(Duration::from_secs(2), &mut run_task).await;
			if graceful.is_err() {
				run_task.abort();
				let _ = run_task.await;
			}
			abort_state.clear().await;
			// Use try_lock to avoid deadlocking if another task holds the session.
			// If we can't acquire the lock, the session will be cleaned up when the
			// holding task finishes.
			if let Ok(mut guard) = session.try_lock() {
				*guard = None;
			}
			let _ = process_cancel_bridge.await;
			return Ok(ShellRunResult {
				exit_code:   None,
				cancelled:   matches!(reason, AbortReason::Signal),
				timed_out:   matches!(reason, AbortReason::Timeout),
				minimized:   None,
				working_dir: None,
			});
		}
	};
	let res =
		res.unwrap_or_else(|err| Err(Error::msg(format!("Shell execution task failed: {err}"))));
	process_cancel_bridge.abort();
	let _ = process_cancel_bridge.await;
	abort_state.clear().await;

	let keepalive = res.as_ref().is_ok_and(|(exec, ..)| session_keepalive(exec));
	if !keepalive {
		*session.lock().await = None;
	}
	let (exec, minimized, working_dir) = res?;
	Ok(ShellRunResult {
		exit_code: Some(exit_code(&exec)),
		cancelled: false,
		timed_out: false,
		working_dir,
		minimized,
	})
}

async fn run_shell_oneshot(
	config: ShellConfig,
	run_config: ShellRunConfig,
	on_chunk: Option<Sender<String>>,
	ct: CancelToken,
) -> Result<ShellExecuteResult> {
	let tokio_cancel = CancellationToken::new();
	let spawn_registry = Arc::new(process::SpawnRegistry::new());
	let process_cancel_bridge = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		let spawn_registry = spawn_registry.clone();
		async move {
			tokio_cancel.cancelled().await;
			terminate_run(&spawn_registry).await;
		}
	});

	let mut task = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		let spawn_registry = spawn_registry.clone();
		async move {
			let mut session = create_session_for_run(
				&config,
				Some(spawn_registry.clone()),
				Some(tokio_cancel.clone()),
			)
			.await?;
			run_shell_command(&mut session, &run_config, on_chunk, tokio_cancel, spawn_registry).await
		}
	});

	let run_result = tokio::select! {
		result = &mut task => result,
		reason = ct.wait() => {
			tokio_cancel.cancel();
			let graceful = time::timeout(Duration::from_secs(2), &mut task).await;
			if graceful.is_err() {
				task.abort();
				let _ = task.await;
			}
			let _ = process_cancel_bridge.await;
			return Ok(ShellExecuteResult {
				exit_code:   None,
				cancelled:   matches!(reason, AbortReason::Signal),
				timed_out:   matches!(reason, AbortReason::Timeout),
				minimized:   None,
				working_dir: None,
			});
		},
	};

	process_cancel_bridge.abort();
	let _ = process_cancel_bridge.await;
	let res = run_result
		.unwrap_or_else(|err| Err(Error::msg(format!("Shell execution task failed: {err}"))));
	let (exec, minimized, working_dir) = res?;
	Ok(ShellExecuteResult {
		exit_code: Some(exit_code(&exec)),
		cancelled: false,
		timed_out: false,
		working_dir,
		minimized,
	})
}

async fn run_shell_oneshot_streams(
	config: ShellConfig,
	run_config: ShellRunConfig,
	streams: StreamSinks,
	ct: CancelToken,
) -> Result<ShellExecuteResult> {
	let tokio_cancel = CancellationToken::new();
	let spawn_registry = Arc::new(process::SpawnRegistry::new());
	let process_cancel_bridge = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		let spawn_registry = spawn_registry.clone();
		async move {
			tokio_cancel.cancelled().await;
			terminate_run(&spawn_registry).await;
		}
	});

	let mut task = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		let spawn_registry = spawn_registry.clone();
		async move {
			let mut session = create_session_for_run(
				&config,
				Some(spawn_registry.clone()),
				Some(tokio_cancel.clone()),
			)
			.await?;
			run_shell_command_streams(&mut session, &run_config, streams, tokio_cancel, spawn_registry)
				.await
		}
	});

	let run_result = tokio::select! {
		result = &mut task => result,
		reason = ct.wait() => {
			tokio_cancel.cancel();
			let graceful = time::timeout(Duration::from_secs(2), &mut task).await;
			if graceful.is_err() {
				task.abort();
				let _ = task.await;
			}
			let _ = process_cancel_bridge.await;
			return Ok(ShellExecuteResult {
				exit_code: None,
				cancelled: matches!(reason, AbortReason::Signal),
				timed_out: matches!(reason, AbortReason::Timeout),
				minimized: None,
				working_dir: None,
			});
		},
	};

	process_cancel_bridge.abort();
	let _ = process_cancel_bridge.await;
	let res = run_result
		.unwrap_or_else(|err| Err(Error::msg(format!("Shell execution task failed: {err}"))));
	let (exec, working_dir) = res?;
	Ok(ShellExecuteResult {
		exit_code: Some(exit_code(&exec)),
		cancelled: false,
		timed_out: false,
		working_dir,
		minimized: None,
	})
}

fn null_file() -> Result<OpenFile> {
	openfiles::null().map_err(|err| Error::msg(format!("Failed to create null file: {err}")))
}

const fn exit_code(result: &ExecutionResult) -> i32 {
	match result.exit_code {
		ExecutionExitCode::Success => 0,
		ExecutionExitCode::GeneralError => 1,
		ExecutionExitCode::InvalidUsage => 2,
		ExecutionExitCode::Unimplemented => 99,
		ExecutionExitCode::CannotExecute => 126,
		ExecutionExitCode::NotFound => 127,
		ExecutionExitCode::Interrupted => 130,
		ExecutionExitCode::BrokenPipe => 141,
		ExecutionExitCode::Custom(code) => code as i32,
	}
}

#[cfg(windows)]
const fn normalize_env_key(key: &str) -> &str {
	if key.eq_ignore_ascii_case("PATH") {
		"PATH"
	} else {
		key
	}
}

#[cfg(not(windows))]
const fn normalize_env_key(key: &str) -> &str {
	key
}

#[cfg(windows)]
fn merge_path_values(existing: &str, incoming: &str) -> String {
	let mut merged = Vec::new();
	let mut seen = HashSet::new();
	push_unique_paths(&mut merged, &mut seen, existing);
	push_unique_paths(&mut merged, &mut seen, incoming);

	std::env::join_paths(merged.iter())
		.map_or_else(|_| merged.join(";"), |paths| paths.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn push_unique_paths(merged: &mut Vec<String>, seen: &mut HashSet<String>, value: &str) {
	for segment in std::env::split_paths(value) {
		let segment_str = segment.to_string_lossy().into_owned();
		let normalized = normalize_path_segment(&segment_str);
		if normalized.is_empty() {
			continue;
		}
		if seen.insert(normalized) {
			merged.push(segment_str);
		}
	}
}

#[cfg(windows)]
fn normalize_path_segment(segment: &str) -> String {
	let trimmed = segment.trim().trim_matches('"');
	if trimmed.is_empty() {
		return String::new();
	}

	let mut normalized = std::path::PathBuf::new();
	for component in std::path::Path::new(trimmed).components() {
		normalized.push(component.as_os_str());
	}

	normalized.to_string_lossy().to_ascii_lowercase()
}

#[cfg(not(windows))]
fn merge_path_values(_existing: &str, incoming: &str) -> String {
	incoming.to_string()
}

#[cfg(test)]
async fn create_session(config: &ShellConfig) -> Result<ShellSessionCore> {
	create_session_for_run(config, None, None).await
}

/// Copies the host environment into `shell`, merging duplicate `PATH` values
/// and registering the merged `PATH` last.
///
/// Entries whose key or value is not valid Unicode are skipped: a corrupt
/// entry carries no usable meaning, and `std::env::vars()` — the naive way to
/// read the host environment — panics on the first one before any command can
/// run. `vars_os()` yields the raw entries without panicking, leaving the
/// skip decision here.
fn copy_env_into_shell(
	shell: &mut BrushShell,
	env: impl Iterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> Result<()> {
	let mut merged_path: Option<String> = None;
	for (key, value) in env {
		// A key or value that cannot be decoded as Unicode is unusable; drop
		// it rather than panicking startup for a corrupt host environment.
		let (Some(key), Some(value)) = (key.to_str(), value.to_str()) else {
			continue;
		};
		let normalized_key = normalize_env_key(key);
		if should_skip_env_var(normalized_key) {
			continue;
		}
		if normalized_key == "PATH" {
			merged_path = Some(match merged_path {
				Some(existing) => merge_path_values(&existing, value),
				None => value.to_string(),
			});
			continue;
		}
		let mut var = ShellVariable::new(ShellValue::String(value.to_string()));
		var.export();
		shell
			.env_mut()
			.set_global(normalized_key, var)
			.map_err(|err| Error::msg(format!("Failed to set env: {err}")))?;
	}

	#[cfg(windows)]
	if merged_path.is_none()
		&& let Some(value) = std::env::var_os("Path").or_else(|| std::env::var_os("PATH"))
	{
		merged_path = Some(value.to_string_lossy().into_owned());
	}

	if let Some(path_value) = &merged_path {
		let mut var = ShellVariable::new(ShellValue::String(path_value.clone()));
		var.export();
		shell
			.env_mut()
			.set_global("PATH", var)
			.map_err(|err| Error::msg(format!("Failed to set env: {err}")))?;
	}

	Ok(())
}

async fn create_session_for_run(
	config: &ShellConfig,
	spawn_registry: Option<Arc<process::SpawnRegistry>>,
	cancel_token: Option<CancellationToken>,
) -> Result<ShellSessionCore> {
	let mut shell = BrushShell::builder()
		.do_not_inherit_env(true)
		.profile(ProfileLoadBehavior::Skip)
		.rc(RcLoadBehavior::Skip)
		.builtins(default_builtins(BuiltinSet::BashMode))
		.build()
		.await
		.map_err(|err| Error::msg(format!("Failed to initialize shell: {err}")))?;

	if let Some(exec_builtin) = shell.builtin_mut("exec") {
		exec_builtin.disabled = true;
	}
	if let Some(suspend_builtin) = shell.builtin_mut("suspend") {
		suspend_builtin.disabled = true;
	}
	// Process inspection and control (see `pi_builtins::process_builtins`).
	// `nohup` is withheld when PI_DISABLE_NOHUP_BUILTIN asks for the system one;
	// `kill` already comes from the default set, where our richer implementation
	// replaced brush's.
	for (name, registration) in pi_builtins::process_builtins() {
		if name == "nohup" && nohup_builtin_disabled(config) {
			continue;
		}
		shell.register_builtin(name, registration);
	}
	// In-process command-line utility builtins (see
	// `pi_builtins::utility_builtins`): consistent, cross-platform implementations
	// that run without spawning a process and resolve paths against the shell
	// working directory. The whole set can be disabled (falling back to system
	// binaries) via PI_DISABLE_UUTILS_BUILTINS; the destructive trio additionally
	// honors PI_DISABLE_UUTILS_DESTRUCTIVE, and `rm`/`mv` have their own switches.
	if !uutils_env_disabled(config, "PI_DISABLE_UUTILS_BUILTINS") {
		let destructive_disabled = uutils_env_disabled(config, "PI_DISABLE_UUTILS_DESTRUCTIVE");
		let rm_disabled =
			destructive_disabled || uutils_env_disabled(config, "PI_DISABLE_RM_BUILTIN");
		let mv_disabled =
			destructive_disabled || uutils_env_disabled(config, "PI_DISABLE_MV_BUILTIN");
		for (name, registration) in pi_builtins::utility_builtins() {
			let disabled = match name {
				"rm" => rm_disabled,
				"mv" => mv_disabled,
				// ln can clobber existing files via -f; gate it with the destructive set.
				"ln" => destructive_disabled,
				_ => false,
			};
			if !disabled {
				shell.register_builtin(name, registration);
			}
		}
	}

	copy_env_into_shell(&mut shell, std::env::vars_os())?;

	if let Some(env) = config.session_env.as_ref() {
		for (key, value) in env {
			let normalized_key = normalize_env_key(key);
			if should_skip_env_var(normalized_key) {
				continue;
			}
			let mut var = ShellVariable::new(ShellValue::String(value.clone()));
			var.export();
			shell
				.env_mut()
				.set_global(normalized_key, var)
				.map_err(|err| Error::msg(format!("Failed to set env: {err}")))?;
		}
	}
	apply_env_fallback(&mut shell)?;
	// `nohup` is registered above, with the rest of the process builtins.

	#[cfg(windows)]
	configure_windows_path(&mut shell)?;

	if let Some(snapshot_path) = config.snapshot_path.as_ref() {
		source_snapshot(&mut shell, snapshot_path, spawn_registry, cancel_token).await?;
	}

	Ok(ShellSessionCore { shell })
}

async fn source_snapshot(
	shell: &mut BrushShell,
	snapshot_path: &str,
	spawn_registry: Option<Arc<process::SpawnRegistry>>,
	cancel_token: Option<CancellationToken>,
) -> Result<()> {
	let mut params = shell.default_exec_params();
	let source_info = SourceInfo::from("pi-natives:snapshot");
	params.set_fd(OpenFiles::STDIN_FD, null_file()?);
	params.set_fd(OpenFiles::STDOUT_FD, null_file()?);
	params.set_fd(OpenFiles::STDERR_FD, null_file()?);
	if let Some(cancel_token) = cancel_token {
		params.set_cancel_token(cancel_token);
	}
	if let Some(spawn_registry) = spawn_registry {
		params.set_spawn_observer(spawn_registry);
	}

	let escaped = snapshot_path.replace('\'', "'\\''");
	let command = format!("source '{escaped}'");
	shell
		.run_string(command, &source_info, &params)
		.await
		.map_err(|err| Error::msg(format!("Failed to source snapshot: {err}")))?;
	Ok(())
}

#[derive(Clone, Copy)]
enum CommandCaptureMode {
	Streaming,
	Buffered { max_capture_bytes: usize },
}

struct CommandRunOutput {
	result:   ExecutionResult,
	buffered: Option<BufferedOutput>,
}

struct ChainCapture {
	original_text: String,
	text:          String,
	input_bytes:   usize,
	changed:       bool,
}

impl ChainCapture {
	const fn new() -> Self {
		Self {
			original_text: String::new(),
			text:          String::new(),
			input_bytes:   0,
			changed:       false,
		}
	}

	fn push(&mut self, original: &str, original_input_bytes: usize, minimized: &str, changed: bool) {
		self.original_text.push_str(original);
		self.text.push_str(minimized);
		self.input_bytes = self.input_bytes.saturating_add(original_input_bytes);
		self.changed |= changed;
	}
}

async fn run_shell_command(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	spawn_registry: Arc<process::SpawnRegistry>,
) -> Result<(ExecutionResult, Option<MinimizerResult>, Option<String>)> {
	if let Some(cwd) = options.cwd.as_deref() {
		set_shell_working_dir_if_changed(&mut session.shell, cwd)?;
	}

	let env_scope_pushed = apply_command_env(&mut session.shell, options.env.as_ref())?;

	let minimizer_mode = if let Some(config) = options.minimizer.as_ref() {
		minimizer::engine::mode_for(&options.command, config)
	} else {
		minimizer::engine::MinimizerMode::None
	};

	let result = match minimizer_mode {
		minimizer::engine::MinimizerMode::SegmentedChain => {
			run_shell_command_segmented_chain(session, options, on_chunk, cancel_token, spawn_registry)
				.await
		},
		minimizer::engine::MinimizerMode::WholeCommand | minimizer::engine::MinimizerMode::None => {
			run_shell_command_single(
				session,
				options,
				on_chunk,
				cancel_token,
				spawn_registry,
				minimizer_mode,
			)
			.await
		},
	};

	if env_scope_pushed {
		session
			.shell
			.env_mut()
			.pop_scope(EnvironmentScope::Command)
			.map_err(|err| Error::msg(format!("Failed to pop env scope: {err}")))?;
	}

	result.map(|(exec, minimized)| {
		let working_dir = Some(session.shell.working_dir().to_string_lossy().into_owned());
		(exec, minimized, working_dir)
	})
}

async fn run_shell_command_single(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	spawn_registry: Arc<process::SpawnRegistry>,
	minimizer_mode: minimizer::engine::MinimizerMode,
) -> Result<(ExecutionResult, Option<MinimizerResult>)> {
	debug_assert!(!matches!(minimizer_mode, minimizer::engine::MinimizerMode::SegmentedChain));

	let params = session.shell.default_exec_params();
	let capture_mode = match minimizer_mode {
		minimizer::engine::MinimizerMode::WholeCommand => {
			let Some(config) = options.minimizer.as_ref() else {
				return Err(Error::msg("Missing minimizer config for whole-command mode"));
			};
			CommandCaptureMode::Buffered { max_capture_bytes: config.max_capture_bytes as usize }
		},
		minimizer::engine::MinimizerMode::None => CommandCaptureMode::Streaming,
		minimizer::engine::MinimizerMode::SegmentedChain => CommandCaptureMode::Streaming,
	};

	let command_run = run_shell_command_once(
		session,
		options.command.clone(),
		params,
		on_chunk,
		cancel_token,
		spawn_registry,
		capture_mode,
	)
	.await?;

	let mut minimized_out = None;
	if let Some(buffered) = command_run.buffered
		&& let Some(config) = options.minimizer.as_ref()
	{
		// When the capture cap is exceeded the output was streamed raw and never
		// buffered, so nothing was minimized — leave `minimized` absent, matching
		// every other passthrough path and `apply_shell_minimizer`. Previously a
		// `too-large` result with empty `text`/`original_text` was emitted, which a
		// consumer keying off `minimized` presence could mistake for a real rewrite
		// that produced empty output.
		if !buffered.exceeded {
			let minimized = match minimizer_mode {
				minimizer::engine::MinimizerMode::WholeCommand => minimizer::apply(
					&options.command,
					&buffered.text,
					exit_code(&command_run.result),
					config,
				),
				minimizer::engine::MinimizerMode::None => {
					minimizer::MinimizerOutput::passthrough(&buffered.text)
				},
				minimizer::engine::MinimizerMode::SegmentedChain => {
					minimizer::MinimizerOutput::passthrough(&buffered.text)
				},
			};
			// Surface telemetry only when the filter actually rewrote the output
			// and kept the original buffer — same contract as `apply_shell_minimizer`
			// in `pi-natives`. A supported filter that runs but leaves the output
			// unchanged (e.g. a short `git diff --name-only`) reports `changed:
			// false` with no `original_text` and must NOT set `minimized`, or API
			// consumers keying off `result.minimized` are misled. The separate
			// `too-large` reason path above is unaffected.
			if minimized.changed
				&& let Some(original_text) = minimized.original_text
			{
				let output_bytes = u32::try_from(minimized.text.len()).unwrap_or(u32::MAX);
				minimized_out = Some(MinimizerResult {
					filter: minimized.filter.to_string(),
					text: minimized.text,
					original_text,
					input_bytes: u32::try_from(minimized.input_bytes).unwrap_or(u32::MAX),
					output_bytes,
				});
			}
		}
	}

	Ok((command_run.result, minimized_out))
}

async fn run_shell_command_segmented_chain(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	spawn_registry: Arc<process::SpawnRegistry>,
) -> Result<(ExecutionResult, Option<MinimizerResult>)> {
	let Some(config) = options.minimizer.as_ref() else {
		return run_shell_command_single(
			session,
			options,
			on_chunk,
			cancel_token,
			spawn_registry,
			minimizer::engine::MinimizerMode::None,
		)
		.await;
	};

	// When minimizer is disabled, don't segment — stream the original single path.
	if !config.enabled {
		return run_shell_command_single(
			session,
			options,
			on_chunk,
			cancel_token,
			spawn_registry,
			minimizer::engine::MinimizerMode::None,
		)
		.await;
	}

	let minimizer::plan::CommandPlan::Chain { segments } =
		minimizer::plan::analyze(&options.command)
	else {
		return run_shell_command_single(
			session,
			options,
			on_chunk,
			cancel_token,
			spawn_registry,
			minimizer::engine::MinimizerMode::None,
		)
		.await;
	};

	let params = session.shell.default_exec_params();
	let mut aggregate = Some(ChainCapture::new());
	let mut previous_succeeded = true;
	let mut last_result = None;
	let max_capture_bytes = config.max_capture_bytes as usize;
	for segment in segments {
		if segment.run_if_previous_succeeded && !previous_succeeded {
			continue;
		}

		let mut segment_params = params.clone();
		segment_params.suppress_errexit = segment.suppress_errexit;
		let capture_mode = if aggregate.is_some() {
			CommandCaptureMode::Buffered { max_capture_bytes }
		} else {
			CommandCaptureMode::Streaming
		};

		let command_run = run_shell_command_once(
			session,
			segment.command.clone(),
			segment_params,
			on_chunk.clone(),
			cancel_token.clone(),
			spawn_registry.clone(),
			capture_mode,
		)
		.await?;

		let exit = exit_code(&command_run.result);
		previous_succeeded = exit == 0;

		if let Some(buffered) = command_run.buffered {
			if buffered.exceeded {
				// Cap exceeded mid-chain: output streamed raw, drop the buffered
				// aggregate so the remaining segments stream too. No minimization
				// happened, so we emit no `minimized` telemetry (see below).
				aggregate = None;
			} else if let Some(capture) = aggregate.as_mut() {
				let next_input_bytes = capture.input_bytes.saturating_add(buffered.input_bytes);
				if next_input_bytes > max_capture_bytes {
					aggregate = None;
				} else {
					let minimized = minimizer::apply(&segment.command, &buffered.text, exit, config);
					capture.push(
						&buffered.text,
						buffered.input_bytes,
						&minimized.text,
						minimized.changed,
					);
				}
			}
		} else if aggregate.is_some() {
			aggregate = None;
		}

		let keep_running = session_keepalive(&command_run.result) && !cancel_token.is_cancelled();
		last_result = Some(command_run.result);
		if !keep_running {
			break;
		}
	}

	let Some(result) = last_result else {
		return Err(Error::msg("Segmented chain executed no segments"));
	};

	let minimized_out = aggregate
		// Only surface telemetry when the segmented chain actually rewrote the
		// output; a `chain-noop` capture (`changed == false`) must yield `None`,
		// matching the public `ShellRunResult.minimized` contract.
		.filter(|capture| capture.changed)
		.map(|capture| {
			let minimized = minimizer::chain_output(
				capture.text,
				capture.original_text,
				capture.input_bytes,
				capture.changed,
			);
			MinimizerResult {
				filter:        minimized.filter.to_string(),
				text:          minimized.text,
				original_text: minimized.original_text.unwrap_or_default(),
				input_bytes:   u32::try_from(minimized.input_bytes).unwrap_or(u32::MAX),
				output_bytes:  u32::try_from(minimized.output_bytes).unwrap_or(u32::MAX),
			}
		});
	// A chain that overflowed the aggregate cap streamed its output raw and was
	// not minimized — `minimized_out` stays `None`, matching the whole-command
	// path and `apply_shell_minimizer`. (Previously a `too-large` result with
	// empty `text` was emitted, a footgun for consumers keying off presence.)

	Ok((result, minimized_out))
}

async fn run_shell_command_once(
	session: &mut ShellSessionCore,
	mut command: String,
	mut params: ExecutionParameters,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	spawn_registry: Arc<process::SpawnRegistry>,
	capture_mode: CommandCaptureMode,
) -> Result<CommandRunOutput> {
	let (reader_file, writer_file) = pipe_to_files("output")?;

	let stdout_file = OpenFile::from(
		writer_file
			.try_clone()
			.map_err(|err| Error::msg(format!("Failed to clone pipe: {err}")))?,
	);
	let stderr_file = OpenFile::from(writer_file);

	params.set_fd(OpenFiles::STDIN_FD, null_file()?);
	params.set_fd(OpenFiles::STDOUT_FD, stdout_file);
	params.set_fd(OpenFiles::STDERR_FD, stderr_file);
	params.process_group_policy = ProcessGroupPolicy::NewProcessGroup;
	params.set_cancel_token(cancel_token.clone());
	params.set_spawn_observer(spawn_registry.clone());
	let reader_cancel = CancellationToken::new();
	let (activity_tx, activity_rx) = flume::bounded::<()>(1);
	let reader_callback = on_chunk;
	let mut reader_handle = tokio::spawn({
		let reader_cancel = reader_cancel.clone();
		async move {
			match capture_mode {
				CommandCaptureMode::Buffered { max_capture_bytes } => {
					let output = read_output_buffered(
						reader_file,
						reader_callback,
						reader_cancel,
						activity_tx,
						max_capture_bytes,
					)
					.await;
					Result::<OutputRead>::Ok(OutputRead::Buffered(output))
				},
				CommandCaptureMode::Streaming => {
					Box::pin(read_output(reader_file, reader_callback, reader_cancel, activity_tx))
						.await;
					Result::<OutputRead>::Ok(OutputRead::Streaming)
				},
			}
		}
	});
	// Let pipeline consumers flush output after cancellation kills their
	// producers. The outer run cancellation remains bounded, and this delayed
	// fallback still releases readers whose writers never close.
	const CANCEL_READER_GRACE: Duration = Duration::from_millis(500);
	let cancel_bridge = tokio::spawn({
		let cancel_token = cancel_token.clone();
		let reader_cancel = reader_cancel.clone();
		async move {
			cancel_token.cancelled().await;
			time::sleep(CANCEL_READER_GRACE).await;
			reader_cancel.cancel();
		}
	});
	ensure_trailing_newline_for_heredoc(&mut command);
	let source_info = SourceInfo::from("pi-natives:command");
	let result = session
		.shell
		.run_string(command, &source_info, &params)
		.await;

	if cancel_token.is_cancelled() {
		terminate_background_jobs(&mut session.shell);
	}

	drop(params);

	// The foreground command can complete while background jobs keep the
	// stdout/stderr pipe open. Don't hang forever waiting for EOF; drain output
	// for a short period, then cancel.
	const POST_EXIT_IDLE: Duration = Duration::from_millis(250);
	const POST_EXIT_MAX: Duration = Duration::from_secs(2);
	const READER_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(250);

	let mut reader_finished = false;
	let mut reader_output = None;
	let mut idle_timer = Box::pin(time::sleep(POST_EXIT_IDLE));
	let mut max_timer = Box::pin(time::sleep(POST_EXIT_MAX));

	loop {
		tokio::select! {
			res = &mut reader_handle => {
				if let Ok(Ok(output)) = res {
					reader_output = Some(output);
				}
				reader_finished = true;
				break;
			}
			msg = activity_rx.recv_async() => {
				if msg.is_err() {
					break;
				}
				idle_timer.as_mut().reset(time::Instant::now() + POST_EXIT_IDLE);
			}
			() = &mut idle_timer => break,
			() = &mut max_timer => break,
		}
	}

	if !reader_finished {
		reader_cancel.cancel();
		match time::timeout(READER_SHUTDOWN_TIMEOUT, &mut reader_handle).await {
			Ok(Ok(Ok(output))) => reader_output = Some(output),
			Ok(_) => {},
			Err(_) => {
				reader_handle.abort();
				let _ = reader_handle.await;
			},
		}
	}
	cancel_bridge.abort();
	let _ = cancel_bridge.await;

	let result = result.map_err(|err| Error::msg(format!("Shell execution failed: {err}")))?;
	let buffered = match reader_output {
		Some(OutputRead::Buffered(output)) => Some(output),
		Some(OutputRead::Streaming) | None => None,
	};
	Ok(CommandRunOutput { result, buffered })
}

async fn run_shell_command_streams(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	streams: StreamSinks,
	cancel_token: CancellationToken,
	spawn_registry: Arc<process::SpawnRegistry>,
) -> Result<(ExecutionResult, Option<String>)> {
	if let Some(cwd) = options.cwd.as_deref() {
		set_shell_working_dir_if_changed(&mut session.shell, cwd)?;
	}

	let env_scope_pushed = apply_command_env(&mut session.shell, options.env.as_ref())?;

	let (stdout_reader, stdout_writer) = pipe_to_files("stdout")?;
	let (stderr_reader, stderr_writer) = pipe_to_files("stderr")?;

	let stdout_file = OpenFile::from(stdout_writer);
	let stderr_file = OpenFile::from(stderr_writer);

	let mut params = session.shell.default_exec_params();
	params.set_fd(OpenFiles::STDIN_FD, null_file()?);
	params.set_fd(OpenFiles::STDOUT_FD, stdout_file);
	params.set_fd(OpenFiles::STDERR_FD, stderr_file);
	params.process_group_policy = ProcessGroupPolicy::NewProcessGroup;
	params.set_cancel_token(cancel_token.clone());
	params.set_spawn_observer(spawn_registry.clone());
	let reader_cancel = CancellationToken::new();
	let (activity_tx, activity_rx) = flume::bounded::<()>(1);

	let StreamSinks { stdout: stdout_sink, stderr: stderr_sink } = streams;
	let mut stdout_handle = tokio::spawn(Box::pin(read_output_bytes(
		stdout_reader,
		stdout_sink,
		reader_cancel.clone(),
		activity_tx.clone(),
	)));
	let mut stderr_handle = tokio::spawn(Box::pin(read_output_bytes(
		stderr_reader,
		stderr_sink,
		reader_cancel.clone(),
		activity_tx,
	)));

	let cancel_bridge = tokio::spawn({
		let cancel_token = cancel_token.clone();
		let reader_cancel = reader_cancel.clone();
		async move {
			cancel_token.cancelled().await;
			reader_cancel.cancel();
		}
	});
	let mut command = options.command.clone();
	ensure_trailing_newline_for_heredoc(&mut command);
	let source_info = SourceInfo::from("pi-shell:streams");
	let result = session
		.shell
		.run_string(command, &source_info, &params)
		.await;

	if cancel_token.is_cancelled() {
		terminate_background_jobs(&mut session.shell);
	}

	if env_scope_pushed {
		session
			.shell
			.env_mut()
			.pop_scope(EnvironmentScope::Command)
			.map_err(|err| Error::msg(format!("Failed to pop env scope: {err}")))?;
	}

	drop(params);

	const POST_EXIT_IDLE: Duration = Duration::from_millis(250);
	const POST_EXIT_MAX: Duration = Duration::from_secs(2);
	const READER_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(250);

	let mut stdout_finished = false;
	let mut stderr_finished = false;
	let mut idle_timer = Box::pin(time::sleep(POST_EXIT_IDLE));
	let mut max_timer = Box::pin(time::sleep(POST_EXIT_MAX));

	loop {
		if stdout_finished && stderr_finished {
			break;
		}
		tokio::select! {
			res = &mut stdout_handle, if !stdout_finished => {
				let _ = res;
				stdout_finished = true;
			}
			res = &mut stderr_handle, if !stderr_finished => {
				let _ = res;
				stderr_finished = true;
			}
			msg = activity_rx.recv_async() => {
				if msg.is_err() {
					break;
				}
				idle_timer.as_mut().reset(time::Instant::now() + POST_EXIT_IDLE);
			}
			() = &mut idle_timer => break,
			() = &mut max_timer => break,
		}
	}

	if !stdout_finished || !stderr_finished {
		reader_cancel.cancel();
	}
	if !stdout_finished
		&& time::timeout(READER_SHUTDOWN_TIMEOUT, &mut stdout_handle)
			.await
			.is_err()
	{
		stdout_handle.abort();
		let _ = stdout_handle.await;
	}
	if !stderr_finished
		&& time::timeout(READER_SHUTDOWN_TIMEOUT, &mut stderr_handle)
			.await
			.is_err()
	{
		stderr_handle.abort();
		let _ = stderr_handle.await;
	}
	cancel_bridge.abort();
	let _ = cancel_bridge.await;

	let result = result.map_err(|err| Error::msg(format!("Shell execution failed: {err}")))?;
	let working_dir = Some(session.shell.working_dir().to_string_lossy().into_owned());
	Ok((result, working_dir))
}

async fn read_output_bytes(
	reader: fs::File,
	sink: Option<Sender<Bytes>>,
	cancel_token: CancellationToken,
	activity: Sender<()>,
) {
	const BUF: usize = 65536;

	#[cfg(unix)]
	let Ok(reader) = register_nonblocking_pipe(reader) else {
		return;
	};
	#[cfg(not(unix))]
	let mut reader = tokio::fs::File::from_std(reader);

	loop {
		let mut buf = vec![0u8; BUF];
		#[cfg(unix)]
		let n = {
			let Ok(mut readiness) = (tokio::select! {
				ready = reader.readable() => ready,
				() = cancel_token.cancelled() => break,
			}) else {
				break;
			};
			match readiness.try_io(|inner| read_nonblocking(inner.get_ref(), &mut buf)) {
				Ok(Ok(0)) => break,
				Ok(Ok(n)) => n,
				Ok(Err(e)) if e.kind() == io::ErrorKind::Interrupted => continue,
				Ok(Err(_)) => break,
				Err(_would_block) => continue,
			}
		};
		#[cfg(not(unix))]
		let n = {
			let read_future = reader.read(&mut buf);
			tokio::pin!(read_future);
			match tokio::select! {
				res = &mut read_future => res,
				() = cancel_token.cancelled() => break,
			} {
				Ok(0) => break,
				Ok(n) => n,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(_) => break,
			}
		};
		let _ = activity.try_send(());
		buf.truncate(n);
		if let Some(sink) = sink.as_ref()
			&& sink.send(Bytes::from(buf)).is_err()
		{
			// Receiver dropped — stop forwarding and let the pipe close.
			break;
		}
	}
}

impl SpawnObserver for process::SpawnRegistry {
	fn on_spawn(&self, pid: i32, pgid: Option<i32>) {
		// Pin a stable process reference *now*, before the pid can be recycled.
		// On Windows an open handle keeps the pid slot reserved for the lifetime
		// of the handle; on Linux the pidfd carries identity; on macOS the
		// recorded start-time triple detects impersonation. Deferring the open
		// to `build_targets` (as the old code did) let a recycled pid resolve
		// to an unrelated process — issue #4605.
		let process = process::Process::from_pid(pid);
		self.record(pgid, process);
	}
}

// Escalating TERM -> KILL waves over the processes this run spawned, scoped via
// the per-run `SpawnRegistry`. The kill set is rebuilt each wave so a child
// spawned in a grace window — or a grandchild whose recorded parent already
// exited but whose process group is still live — is still reaped, and the loop
// stops as soon as the run's whole tree is gone. Scoping to the registry (vs a
// process-global descendant diff) is what keeps a cancel from reaping a
// concurrent run's children in a shared host process.
async fn terminate_run(registry: &process::SpawnRegistry) {
	const WAVES: u32 = 3;
	let mut saw_targets = false;
	for wave in 0..WAVES {
		let targets = registry.build_targets();
		if targets.is_empty() {
			if saw_targets || wave + 1 == WAVES {
				return;
			}
		} else {
			saw_targets = true;
			let signal = if wave == 0 {
				process::TERM_SIGNAL
			} else {
				process::KILL_SIGNAL
			};
			targets.signal(signal);
		}
		if wave + 1 < WAVES {
			let pause = if wave == 0 {
				Duration::from_millis(75)
			} else {
				Duration::from_millis(150)
			};
			time::sleep(pause).await;
		}
	}
}
fn terminate_internal_background_jobs(shell: &mut BrushShell) {
	for job in &mut shell.jobs_mut().jobs {
		job.abort_internal_tasks();
	}
}

fn terminate_background_jobs(shell: &mut BrushShell) {
	let mut targets = process::TerminationTargets::new();
	terminate_internal_background_jobs(shell);
	for job in &shell.jobs().jobs {
		if let Some(pgid) = job.process_group_id() {
			targets.add_pgid(pgid);
		}
		if let Some(pid) = job.representative_pid() {
			targets.add_pid(pid);
		}
	}
	if targets.is_empty() {
		// Shell-internal jobs were aborted above. Pure descendant cleanup is
		// handled by `process_cancel_bridge` while the cancel was in flight;
		// without job-tracked pgids or pids there is nothing else to signal here.
		return;
	}

	targets.signal(process::TERM_SIGNAL);
	tokio::spawn(async move {
		time::sleep(Duration::from_millis(150)).await;
		targets.signal(process::KILL_SIGNAL);
	});
}

/// Apply per-command environment variables onto a freshly pushed
/// `Command` scope. Returns `true` when a scope was pushed (so the caller
/// can pop it after the command runs), `false` when there were no vars and
/// the existing scopes remain untouched.
fn apply_command_env(
	shell: &mut BrushShell,
	env: Option<&HashMap<String, String>>,
) -> Result<bool> {
	let Some(env) = env else {
		return Ok(false);
	};
	shell.env_mut().push_scope(EnvironmentScope::Command);
	for (key, value) in env {
		let normalized_key = normalize_env_key(key);
		if should_skip_env_var(normalized_key) {
			continue;
		}
		let mut var = ShellVariable::new(ShellValue::String(value.clone()));
		var.export();
		if let Err(err) = shell
			.env_mut()
			.add(normalized_key, var, EnvironmentScope::Command)
		{
			let _ = shell.env_mut().pop_scope(EnvironmentScope::Command);
			return Err(Error::msg(format!("Failed to set env: {err}")));
		}
	}
	Ok(true)
}

/// Define `env` as a shell variable expanding to the literal `$env` so that
/// brush-core's POSIX parameter expansion preserves PowerShell-style
/// `$env:NAME` references when commands are dispatched through brush to a
/// PowerShell (or any) subprocess. The variable is not exported, so it only
/// influences brush's own expansion; the child process environment is
/// unaffected.
///
/// User-driven assignments (`env=prod; echo "$env:8080"`) push their own
/// binding in the command scope and shadow this global default, preserving
/// the bash POSIX contract for callers that genuinely use a variable named
/// `env`.
fn apply_env_fallback(shell: &mut BrushShell) -> Result<()> {
	if shell.env().get("env").is_some() {
		return Ok(());
	}
	let var = ShellVariable::new(ShellValue::String("$env".to_string()));
	shell
		.env_mut()
		.set_global("env", var)
		.map_err(|err| Error::msg(format!("Failed to set env fallback: {err}")))
}

fn is_macos_malloc_stack_logging_var(key: &str) -> bool {
	matches!(key, "MallocStackLogging" | "MallocStackLoggingNoCompact")
}

fn should_skip_env_var(key: &str) -> bool {
	if key.starts_with("BASH_FUNC_") && key.ends_with("%%") {
		return true;
	}
	if is_macos_malloc_stack_logging_var(key) {
		return true;
	}

	matches!(
		key,
		"BASH_ENV"
			| "ENV"
			| "HISTFILE"
			| "HISTTIMEFORMAT"
			| "HISTCMD"
			| "PS0"
			| "PS1"
			| "PS2"
			| "PS4"
			| "BRUSH_PS_ALT"
			| "READLINE_LINE"
			| "READLINE_POINT"
			| "BRUSH_VERSION"
			| "BASH"
			| "BASHOPTS"
			| "BASH_ALIASES"
			| "BASH_ARGV0"
			| "BASH_CMDS"
			| "BASH_SOURCE"
			| "BASH_SUBSHELL"
			| "BASH_VERSINFO"
			| "BASH_VERSION"
			| "SHELLOPTS"
			| "SHLVL"
			| "SHELL"
			| "COMP_WORDBREAKS"
			| "DIRSTACK"
			| "EPOCHREALTIME"
			| "EPOCHSECONDS"
			| "FUNCNAME"
			| "GROUPS"
			| "IFS"
			| "LINENO"
			| "MACHTYPE"
			| "OSTYPE"
			| "OPTERR"
			| "OPTIND"
			| "PIPESTATUS"
			| "PPID"
			| "PWD"
			| "OLDPWD"
			| "RANDOM"
			| "SRANDOM"
			| "SECONDS"
			| "UID"
			| "EUID"
			| "HOSTNAME"
			| "HOSTTYPE"
	)
}

fn ensure_trailing_newline_for_heredoc(command: &mut String) {
	if command.ends_with('\n') || !command.as_bytes().windows(2).any(|window| window == b"<<") {
		return;
	}
	command.push('\n');
}

const fn session_keepalive(result: &ExecutionResult) -> bool {
	match result.next_control_flow {
		ExecutionControlFlow::Normal => true,
		ExecutionControlFlow::BreakLoop { .. } => false,
		ExecutionControlFlow::ContinueLoop { .. } => false,
		ExecutionControlFlow::ReturnFromFunctionOrScript => false,
		ExecutionControlFlow::ExitShell => false,
	}
}

enum OutputRead {
	Streaming,
	Buffered(BufferedOutput),
}

struct BufferedOutput {
	text:        String,
	input_bytes: usize,
	exceeded:    bool,
}

async fn read_output(
	reader: fs::File,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	activity: Sender<()>,
) {
	const REPLACEMENT: &str = "\u{FFFD}";
	const BUF: usize = 65536;
	let mut buf = vec![0u8; BUF + 4]; // +4 for max UTF-8 char
	let mut it = 0;

	#[cfg(unix)]
	let Ok(reader) = register_nonblocking_pipe(reader) else {
		return;
	};
	#[cfg(not(unix))]
	let reader = tokio::fs::File::from_std(reader);
	#[cfg(not(unix))]
	tokio::pin!(reader);

	loop {
		#[cfg(unix)]
		let n = {
			let Ok(mut readiness) = (tokio::select! {
				ready = reader.readable() => ready,
				() = cancel_token.cancelled() => break,
			}) else {
				break;
			};
			match readiness.try_io(|inner| read_nonblocking(inner.get_ref(), &mut buf[it..BUF])) {
				Ok(Ok(0)) => break,
				Ok(Ok(n)) => n,
				Ok(Err(e)) if e.kind() == io::ErrorKind::Interrupted => continue,
				Ok(Err(_)) => break,
				Err(_would_block) => continue,
			}
		};
		#[cfg(not(unix))]
		let n = {
			let read_future = reader.read(&mut buf[it..BUF]);
			tokio::pin!(read_future);
			match tokio::select! {
				res = &mut read_future => res,
				() = cancel_token.cancelled() => break,
			} {
				Ok(0) => break, // EOF
				Ok(n) => n,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(_) => break,
			}
		};
		if n > 0 {
			let _ = activity.try_send(());
		}
		it += n;

		// Consume as much of `pending` as is decodable *right now*.
		while it > 0 {
			let pending = &buf[..it];
			match str::from_utf8(pending) {
				Ok(text) => {
					emit_chunk(text, on_chunk.as_ref()).await;
					it = 0;
					break;
				},
				Err(err) => {
					let p = err.valid_up_to();
					if p > 0 {
						// SAFETY: [..p] is guaranteed valid UTF-8 by valid_up_to().
						let text = unsafe { str::from_utf8_unchecked(&pending[..p]) };
						emit_chunk(text, on_chunk.as_ref()).await;
						// copy p..it to the beginning of the buffer
						buf.copy_within(p..it, 0);
						it -= p;
					}

					match err.error_len() {
						Some(p) => {
							// Invalid byte sequence: emit replacement and drop those bytes.
							emit_chunk(REPLACEMENT, on_chunk.as_ref()).await;
							// copy p..it to the beginning of the buffer
							buf.copy_within(p..it, 0);
							it -= p;
							// continue loop in case more bytes remain after the
							// invalid sequence
						},
						None => {
							// Incomplete UTF-8 sequence at end: keep bytes for next read.
							break;
						},
					}
				},
			}
		}
	}

	// Flush whatever is left at EOF (including an incomplete final sequence).
	for chunk in buf[..it].utf8_chunks() {
		let valid = chunk.valid();
		if !valid.is_empty() {
			emit_chunk(valid, on_chunk.as_ref()).await;
		}
		if !chunk.invalid().is_empty() {
			emit_chunk(REPLACEMENT, on_chunk.as_ref()).await;
		}
	}
}

async fn read_output_buffered(
	reader: fs::File,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	activity: Sender<()>,
	max_capture_bytes: usize,
) -> BufferedOutput {
	const REPLACEMENT: &str = "\u{FFFD}";
	const BUF: usize = 65536;
	let mut buf = vec![0u8; BUF];
	let mut input_bytes = 0usize;
	let mut captured = Vec::new();
	let mut exceeded = false;
	// Pending bytes from a prior read that ended mid-UTF-8 sequence. We hold
	// them back so we emit only valid UTF-8 to the streaming callback while
	// still capturing every byte into `captured` for post-processing.
	let mut pending = Vec::<u8>::new();

	#[cfg(unix)]
	let Ok(reader) = register_nonblocking_pipe(reader) else {
		return BufferedOutput { text: String::new(), input_bytes: 0, exceeded: true };
	};
	#[cfg(not(unix))]
	let reader = tokio::fs::File::from_std(reader);
	#[cfg(not(unix))]
	tokio::pin!(reader);

	loop {
		#[cfg(unix)]
		let n = {
			let Ok(mut readiness) = (tokio::select! {
				ready = reader.readable() => ready,
				() = cancel_token.cancelled() => break,
			}) else {
				break;
			};
			match readiness.try_io(|inner| read_nonblocking(inner.get_ref(), &mut buf)) {
				Ok(Ok(0)) => break,
				Ok(Ok(n)) => n,
				Ok(Err(e)) if e.kind() == io::ErrorKind::Interrupted => continue,
				Ok(Err(_)) => break,
				Err(_would_block) => continue,
			}
		};
		#[cfg(not(unix))]
		let n = {
			let read_future = reader.read(&mut buf);
			tokio::pin!(read_future);
			match tokio::select! {
				res = &mut read_future => res,
				() = cancel_token.cancelled() => break,
			} {
				Ok(0) => break,
				Ok(n) => n,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(_) => break,
			}
		};
		if n > 0 {
			let _ = activity.try_send(());
			input_bytes = input_bytes.saturating_add(n);
		}
		// Once `exceeded`, the post-process minimizer is bypassed (see the
		// `!output.exceeded` gate at the call site), so further appends just
		// grow `captured` without serving any purpose. Stop accumulating to
		// bound peak memory on commands that produce very large output.
		if !exceeded {
			if captured.len().saturating_add(n) > max_capture_bytes {
				exceeded = true;
			} else {
				captured.extend_from_slice(&buf[..n]);
			}
		}

		// Stream whatever is validly decodable *right now* to the callback,
		// carrying incomplete trailing UTF-8 bytes over to the next iteration.
		if let Some(cb) = on_chunk.as_ref() {
			pending.extend_from_slice(&buf[..n]);
			while !pending.is_empty() {
				match str::from_utf8(&pending) {
					Ok(text) => {
						emit_chunk(text, Some(cb)).await;
						pending.clear();
						break;
					},
					Err(err) => {
						let p = err.valid_up_to();
						if p > 0 {
							// SAFETY: [..p] is valid UTF-8 per valid_up_to().
							let text = unsafe { str::from_utf8_unchecked(&pending[..p]) };
							emit_chunk(text, Some(cb)).await;
							pending.drain(..p);
						}
						match err.error_len() {
							Some(skip) => {
								emit_chunk(REPLACEMENT, Some(cb)).await;
								pending.drain(..skip);
							},
							None => break,
						}
					},
				}
			}
		}
	}

	// Flush any trailing bytes the streaming decoder held back at EOF.
	if let Some(cb) = on_chunk.as_ref() {
		for chunk in pending.utf8_chunks() {
			let valid = chunk.valid();
			if !valid.is_empty() {
				emit_chunk(valid, Some(cb)).await;
			}
			if !chunk.invalid().is_empty() {
				emit_chunk(REPLACEMENT, Some(cb)).await;
			}
		}
	}

	BufferedOutput { text: String::from_utf8_lossy(&captured).into_owned(), input_bytes, exceeded }
}

#[cfg(unix)]
fn register_nonblocking_pipe(reader: fs::File) -> io::Result<tokio::io::unix::AsyncFd<fs::File>> {
	set_nonblocking(&reader)?;
	tokio::io::unix::AsyncFd::new(reader)
}

#[cfg(unix)]
fn set_nonblocking<T: std::os::fd::AsRawFd>(file: &T) -> io::Result<()> {
	let fd = file.as_raw_fd();
	// SAFETY: `fd` is owned by `file` and remains valid for the duration of
	// these `fcntl` calls.
	let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
	if flags < 0 {
		return Err(io::Error::last_os_error());
	}
	if flags & libc::O_NONBLOCK != 0 {
		return Ok(());
	}

	// SAFETY: `fd` remains valid here and we are only toggling `O_NONBLOCK`.
	let result = unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
	if result < 0 {
		Err(io::Error::last_os_error())
	} else {
		Ok(())
	}
}

#[cfg(unix)]
fn read_nonblocking<T: std::os::fd::AsRawFd>(file: &T, buf: &mut [u8]) -> io::Result<usize> {
	// SAFETY: `buf` is writable for `buf.len()` bytes, and the raw fd obtained
	// from `file` stays valid for the duration of the syscall.
	let read = unsafe { libc::read(file.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
	if read < 0 {
		Err(io::Error::last_os_error())
	} else {
		Ok(read as usize)
	}
}

/// Forward one decoded chunk to the streaming callback, honouring channel
/// backpressure: on a bounded channel (the pi-natives JS bridge) the send
/// parks until the consumer frees a slot — which parks the pipe reader and,
/// transitively, the child on its stdout/stderr pipe — so a fast producer
/// can never buffer unbounded output in memory (#4078). A disconnected
/// receiver (consumer gone) fails immediately, so the pipe keeps draining
/// and the child never wedges on a full pipe.
async fn emit_chunk(text: &str, callback: Option<&Sender<String>>) {
	if let Some(callback) = callback {
		let _ = callback.send_async(text.to_string()).await;
	}
}

fn pipe_to_files(label: &str) -> Result<(fs::File, fs::File)> {
	let (r, w) =
		os_pipe::pipe().map_err(|err| Error::msg(format!("Failed to create {label} pipe: {err}")))?;

	#[cfg(unix)]
	let (r, w): (fs::File, fs::File) = {
		use std::os::unix::io::{FromRawFd, IntoRawFd};
		let r = r.into_raw_fd();
		let w = w.into_raw_fd();
		// SAFETY: We just obtained these fds from os_pipe and own them exclusively.
		unsafe { (FromRawFd::from_raw_fd(r), FromRawFd::from_raw_fd(w)) }
	};

	#[cfg(windows)]
	let (r, w): (fs::File, fs::File) = {
		use std::os::windows::io::{FromRawHandle, IntoRawHandle};
		let r = r.into_raw_handle();
		let w = w.into_raw_handle();
		// SAFETY: We just obtained these handles from os_pipe and own them exclusively.
		unsafe { (FromRawHandle::from_raw_handle(r), FromRawHandle::from_raw_handle(w)) }
	};

	Ok((r, w))
}

/// Whether the `nohup` builtin should stand aside for the system binary.
///
/// The builtin detaches its operand into a new session so a backgrounded server
/// survives this embedded shell's kill-on-drop teardown, which a system `nohup`
/// does not do. It therefore shadows the real one unless
/// `PI_DISABLE_NOHUP_BUILTIN` (session env or process env) asks otherwise.
fn nohup_builtin_disabled(config: &ShellConfig) -> bool {
	uutils_env_disabled(config, "PI_DISABLE_NOHUP_BUILTIN")
}

/// Reads a boolean "disable" flag for the uutils builtins from the session
/// environment (preferred) then the process environment, mirroring the nohup
/// builtin gate. Truthy = present and not "", "0", or "false".
fn uutils_env_disabled(config: &ShellConfig, key: &str) -> bool {
	let raw = config
		.session_env
		.as_ref()
		.and_then(|env| env.get(key).cloned())
		.or_else(|| std::env::var(key).ok());
	matches!(raw.as_deref(), Some(value) if !value.is_empty() && value != "0" && !value.eq_ignore_ascii_case("false"))
}

#[cfg(test)]
mod tests {
	#[cfg(unix)]
	use std::os::unix::process::ExitStatusExt as _;

	#[cfg(unix)]
	use tokio::process::Command;

	use super::*;

	#[cfg(unix)]
	async fn kill_test_context() -> (ShellSessionCore, ExecutionParameters) {
		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let session = create_session(&config).await.expect("create_session");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null stdin"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null stdout"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null stderr"));
		(session, params)
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

	/// Regression for issue #8925: a host env entry whose key or value is not
	/// valid Unicode must be skipped, not fatal. `std::env::vars()` panics on
	/// the first one (e.g. the corrupt `GHOSTTY_BIN_DIR` cmux/Ghostty stages,
	/// bytes `9d d9 50`) before any command runs; `copy_env_into_shell` reads
	/// via `vars_os()` and drops corrupt entries while still copying the rest
	/// and merging duplicate `PATH` values.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn copy_env_skips_non_utf8_entries_and_merges_path() {
		use std::os::unix::ffi::OsStringExt;

		let mut shell = BrushShell::builder()
			.do_not_inherit_env(true)
			.profile(ProfileLoadBehavior::Skip)
			.rc(RcLoadBehavior::Skip)
			.builtins(default_builtins(BuiltinSet::BashMode))
			.build()
			.await
			.expect("build shell");

		// GHOSTTY_BIN_DIR with the corrupt bytes, a normal var, a corrupt key,
		// and a duplicate PATH — in host-env iteration order.
		let entries = vec![
			(std::ffi::OsString::from("PATH"), std::ffi::OsString::from("/usr/bin:/bin")),
			(
				std::ffi::OsString::from("GHOSTTY_BIN_DIR"),
				std::ffi::OsString::from_vec(vec![0x9d, 0xd9, 0x50]),
			),
			(std::ffi::OsString::from("HOME"), std::ffi::OsString::from("/home/tester")),
			(
				std::ffi::OsString::from_vec(vec![0xff, b'B', b'A', b'D']),
				std::ffi::OsString::from("x"),
			),
			(std::ffi::OsString::from("PATH"), std::ffi::OsString::from("/opt/bin")),
		];
		copy_env_into_shell(&mut shell, entries.into_iter()).expect("copy host env");

		let value = |name: &str| {
			shell
				.env()
				.get(name)
				.and_then(|(_, var)| match var.value() {
					ShellValue::String(value) => Some(value.clone()),
					_ => None,
				})
		};
		assert_eq!(value("PATH").as_deref(), Some("/opt/bin"), "PATH is merged/preserved");
		assert_eq!(value("HOME").as_deref(), Some("/home/tester"), "valid entry copied");
		assert!(value("GHOSTTY_BIN_DIR").is_none(), "non-UTF-8 value must be skipped");
		assert!(value("BAD").is_none(), "non-UTF-8 key must be skipped");
	}

	#[cfg(unix)]
	async fn wait_for_process_name(pid: i32, expected: &str) {
		time::timeout(Duration::from_secs(2), async {
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

	#[cfg(unix)]
	struct PidfileProcessCleanup(Vec<std::path::PathBuf>);

	#[cfg(unix)]
	impl Drop for PidfileProcessCleanup {
		fn drop(&mut self) {
			for pidfile in &self.0 {
				if let Some(process) = fs::read_to_string(pidfile)
					.ok()
					.and_then(|pid| pid.trim().parse::<i32>().ok())
					.and_then(process::Process::from_pid)
				{
					let _ = process.kill_tree(Some(libc::SIGKILL));
				}
			}
		}
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn pgrep_matches_name_and_pkills_signal_probe() {
		let (_dir, command, name) = process_test_command("opg");
		let mut child = process_test_child(&command, Duration::from_secs(30))
			.spawn()
			.expect("matching process");
		let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
		wait_for_process_name(pid, &name).await;

		let (pgrep_result, output) = execute_captured(format!("pgrep -x -p {pid} {name}")).await;
		let (pkill_result, pkill_output) =
			execute_captured(format!("pkill -0 -x -p {pid} {name}")).await;

		let still_running = child.try_wait().expect("probe child status").is_none();
		let _ = child.start_kill();
		let _ = child.wait().await;
		assert_eq!(pgrep_result.exit_code, Some(0));
		assert_eq!(output, format!("{pid}\n"));
		assert_eq!(pkill_result.exit_code, Some(0));
		assert_eq!(pkill_output, "");
		assert!(still_running, "signal 0 must not terminate a matching process");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn pkill_accepts_platform_signal_names() {
		#[cfg(target_os = "macos")]
		let signal = "INFO";
		#[cfg(not(target_os = "macos"))]
		let signal = "WINCH";
		let dir = tempfile::tempdir().expect("signal test directory");
		let ready = dir.path().join("ready");
		let script = format!("trap '' {signal}; : > \"$1\"; while :; do sleep 0.05; done");
		let mut command = Command::new("sh");
		command
			.args(["-c", &script, "sh", ready.to_str().expect("utf8 ready path")])
			.kill_on_drop(true);
		let mut child = command.spawn().expect("signal test process");
		let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
		time::timeout(Duration::from_secs(2), async {
			while !ready.exists() {
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await
		.expect("signal trap was not installed");

		let (result, _) = execute_captured(format!("pkill -{signal} -p {pid}")).await;
		let still_running = child.try_wait().expect("signal child status").is_none();
		let _ = child.start_kill();
		let _ = child.wait().await;
		assert_eq!(result.exit_code, Some(0));
		assert!(still_running, "{signal} should be ignored by the test process");
	}

	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn pkill_queue_option_consumes_its_value() {
		let (_dir, command, name) = process_test_command("opq");
		let mut command = process_test_child(&command, Duration::from_secs(30));
		command.kill_on_drop(true);
		let mut child = command.spawn().expect("queue test process");
		let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
		wait_for_process_name(pid, &name).await;

		let (result, output) = execute_captured(format!("pkill -0 -q 37 -x -p {pid} {name}")).await;
		let still_running = child.try_wait().expect("queue child status").is_none();
		let _ = child.start_kill();
		let _ = child.wait().await;
		assert_eq!(result.exit_code, Some(0));
		assert!(output.is_empty());
		assert!(still_running, "queued signal 0 must only probe the process");
	}

	#[cfg(target_os = "macos")]
	#[tokio::test(flavor = "multi_thread")]
	async fn pkill_interactive_prompt_honors_cancellation() {
		let (_dir, command, name) = process_test_command("opi");
		let mut command = process_test_child(&command, Duration::from_secs(30));
		command.kill_on_drop(true);
		let mut child = command.spawn().expect("interactive target");
		let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
		wait_for_process_name(pid, &name).await;

		let mut cancel = CancelToken::default();
		let abort = cancel.emplace_abort_token();
		let execution = tokio::spawn(execute_shell(
			ShellExecuteOptions {
				command: format!("sleep 30 | pkill -I -x -p {pid} {name}"),
				..Default::default()
			},
			None,
			cancel,
		));
		time::sleep(Duration::from_millis(100)).await;
		abort.abort(crate::cancel::AbortReason::User);
		let result = time::timeout(Duration::from_secs(2), execution)
			.await
			.expect("interactive pkill remained blocked after cancellation")
			.expect("interactive execution task")
			.expect("interactive shell execution");
		let still_running = child
			.try_wait()
			.expect("interactive target status")
			.is_none();
		let _ = child.start_kill();
		let _ = child.wait().await;
		assert_ne!(result.exit_code, Some(0));
		assert!(still_running, "cancelled pkill must not signal its pending target");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn pgrep_reads_pidfile_from_standard_input() {
		let (_dir, command, name) = process_test_command("opf");
		let mut child = process_test_child(&command, Duration::from_secs(30))
			.spawn()
			.expect("pidfile process");
		let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
		wait_for_process_name(pid, &name).await;

		let (result, output) =
			execute_captured(format!("printf '%s\\n' {pid} | pgrep -F - -x {name}")).await;
		let _ = child.start_kill();
		let _ = child.wait().await;
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output, format!("{pid}\n"));
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn pgrep_requires_an_externally_locked_pidfile() {
		let python = Command::new("python3").arg("--version").output().await;
		if !python.is_ok_and(|output| output.status.success()) {
			eprintln!("skipping pgrep_requires_an_externally_locked_pidfile: python3 unavailable");
			return;
		}

		let (_dir, command, name) = process_test_command("opl");
		let mut child = process_test_child(&command, Duration::from_secs(30))
			.spawn()
			.expect("locked pidfile process");
		let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
		wait_for_process_name(pid, &name).await;

		let files = tempfile::tempdir().expect("pidfile directory");
		let pidfile = files.path().join("service.pid");
		let ready = files.path().join("locked");
		let pid_arg = pid.to_string();
		let mut locker = Command::new("python3")
			.args([
				"-c",
				"import fcntl,pathlib,sys,time; f=open(sys.argv[1],'w'); f.write(sys.argv[2]+'\\n'); \
				 f.flush(); fcntl.lockf(f,fcntl.LOCK_EX); pathlib.Path(sys.argv[3]).touch(); \
				 time.sleep(30)",
				pidfile.to_str().expect("utf8 pidfile"),
				&pid_arg,
				ready.to_str().expect("utf8 ready path"),
			])
			.spawn()
			.expect("pidfile locker");
		let ready_result = time::timeout(Duration::from_secs(2), async {
			while !ready.exists() {
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await;
		if ready_result.is_err() {
			let _ = locker.start_kill();
			let _ = child.start_kill();
			let _ = locker.wait().await;
			let _ = child.wait().await;
			panic!("pidfile locker did not become ready");
		}

		let command =
			format!("pgrep -L -F {} -x {name}", quote_arg(pidfile.to_str().expect("utf8 pidfile")));
		let (locked_result, locked_output) = execute_captured(command.clone()).await;
		let _ = locker.start_kill();
		let _ = locker.wait().await;
		let (unlocked_result, unlocked_output) = execute_captured(command).await;
		let _ = child.start_kill();
		let _ = child.wait().await;

		assert_eq!(locked_result.exit_code, Some(0));
		assert_eq!(locked_output, format!("{pid}\n"));
		assert_eq!(unlocked_result.exit_code, Some(3));
		assert!(unlocked_output.contains("is not locked"), "{unlocked_output:?}");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn pkill_signals_every_matching_process() {
		let (_dir, command, name) = process_test_command("opk");
		let mut first = process_test_child(&command, Duration::from_secs(30))
			.spawn()
			.expect("first matching process");
		let mut second = process_test_child(&command, Duration::from_secs(30))
			.spawn()
			.expect("second matching process");
		let first_pid = i32::try_from(first.id().expect("first pid")).expect("pid fits i32");
		let second_pid = i32::try_from(second.id().expect("second pid")).expect("pid fits i32");
		wait_for_process_name(first_pid, &name).await;
		wait_for_process_name(second_pid, &name).await;

		let (result, output) = execute_captured(format!("pkill -TERM -x {name}")).await;
		let statuses =
			time::timeout(Duration::from_secs(2), async { tokio::join!(first.wait(), second.wait()) })
				.await;
		if statuses.is_err() {
			let _ = first.start_kill();
			let _ = second.start_kill();
			let _ = first.wait().await;
			let _ = second.wait().await;
		}
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output, "");
		assert!(statuses.is_ok(), "pkill did not signal every matching process");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn pidwait_returns_after_the_matching_process_exits() {
		let (_dir, command, name) = process_test_command("opw");
		let mut child = process_test_child(&command, Duration::from_millis(250))
			.spawn()
			.expect("waited process");
		let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
		wait_for_process_name(pid, &name).await;

		let (result, output) = execute_captured(format!("pidwait -x -p {pid} {name}")).await;
		let status = child.try_wait().expect("waited child status");
		if status.is_none() {
			let _ = child.start_kill();
			let _ = child.wait().await;
		}
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output, "");
		assert!(status.is_some(), "pidwait returned while its matching process was still running");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn ps_builtin_supports_common_bsd_and_posix_forms() {
		let pid = std::process::id();
		let (custom_result, custom) =
			execute_captured(format!("ps -p {pid} -o pid=,ppid=,stat=,comm=")).await;
		let (posix_result, posix) = execute_captured(format!("ps -ef -p {pid}")).await;
		let (bsd_result, bsd) = execute_captured(format!("ps aux -p {pid}")).await;

		assert_eq!(custom_result.exit_code, Some(0));
		assert_eq!(custom.lines().count(), 1);
		let mut fields = custom.split_whitespace();
		assert_eq!(fields.next(), Some(pid.to_string().as_str()));
		assert!(
			fields
				.next()
				.and_then(|value| value.parse::<i32>().ok())
				.is_some()
		);
		assert!(fields.next().is_some_and(|value| !value.is_empty()));
		assert!(fields.next().is_some_and(|value| !value.is_empty()));

		assert_eq!(posix_result.exit_code, Some(0));
		assert!(
			posix
				.lines()
				.next()
				.is_some_and(|line| line.contains("PPID"))
		);
		assert!(posix.lines().skip(1).any(|line| {
			line
				.split_whitespace()
				.any(|value| value == pid.to_string())
		}));

		assert_eq!(bsd_result.exit_code, Some(0));
		assert!(bsd.lines().next().is_some_and(|line| line.contains("%CPU")));
		assert!(bsd.lines().skip(1).any(|line| {
			line
				.split_whitespace()
				.any(|value| value == pid.to_string())
		}));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn ps_builtin_formats_parseable_long_start_without_a_header() {
		let pid = std::process::id();
		let (result, output) = execute_captured(format!("ps -p {pid} -o lstart=")).await;
		assert_eq!(result.exit_code, Some(0));
		assert!(
			jiff::fmt::strtime::parse("%a %b %e %H:%M:%S %Y", output.trim()).is_ok(),
			"{output:?}"
		);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn ps_builtin_supports_extended_format_specifiers() {
		let pid = std::process::id();
		let (result, output) = execute_captured(format!(
			"ps -p {pid} -o \
			 pid=,tpgid=,ruid=,rgid=,egid=,pri=,f=,min_flt=,maj_flt=,times=,sz=,s=,ruser=,rgroup=,\
			 tgid="
		))
		.await;
		assert_eq!(result.exit_code, Some(0), "{output:?}");
		let fields: Vec<&str> = output.split_whitespace().collect();
		assert_eq!(fields.len(), 15, "{output:?}");
		assert_eq!(fields[0], pid.to_string());
		assert_eq!(fields[14], pid.to_string(), "tgid aliases pid");
		#[cfg(unix)]
		{
			// tpgid is an integer; -1 without a controlling terminal.
			assert!(fields[1].parse::<i32>().is_ok(), "tpgid: {:?}", fields[1]);
			for (index, name) in [(2, "ruid"), (3, "rgid"), (4, "egid")] {
				assert!(fields[index].parse::<u32>().is_ok(), "{name}: {:?}", fields[index]);
			}
			assert!(fields[5].parse::<i64>().is_ok(), "pri: {:?}", fields[5]);
			assert!(u64::from_str_radix(fields[6], 16).is_ok(), "flags: {:?}", fields[6]);
			assert!(fields[7].parse::<u64>().is_ok(), "min_flt: {:?}", fields[7]);
			assert!(fields[8].parse::<u64>().is_ok(), "maj_flt: {:?}", fields[8]);
			assert!(fields[9].parse::<u64>().is_ok(), "times: {:?}", fields[9]);
			assert!(fields[10].parse::<u64>().is_ok(), "sz: {:?}", fields[10]);
			assert_eq!(fields[11].chars().count(), 1, "state: {:?}", fields[11]);
			assert_ne!(fields[12], "?", "ruser should resolve to a name");
			assert_ne!(fields[13], "?", "rgroup should resolve to a name");
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn ps_builtin_accepts_tpgid_alongside_job_control_columns() {
		// Exact form from the field report that failed with
		// "unknown output format specifier 'tpgid'".
		let pid = std::process::id();
		let (result, output) =
			execute_captured(format!("ps -o pid,ppid,pgid,tpgid,sess,stat,tty,command -p {pid}"))
				.await;
		assert_eq!(result.exit_code, Some(0), "{output:?}");
		let header = output.lines().next().unwrap_or_default();
		for label in ["PID", "PPID", "PGID", "TPGID", "SID", "STAT", "TTY", "COMMAND"] {
			assert!(header.contains(label), "missing {label} in {header:?}");
		}
		assert!(output.lines().skip(1).any(|line| {
			line
				.split_whitespace()
				.next()
				.is_some_and(|value| value == pid.to_string())
		}));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn top_builtin_emits_one_finite_snapshot() {
		#[cfg(target_os = "macos")]
		let command = "top -l 1 -n 3";
		#[cfg(not(target_os = "macos"))]
		let command = "top -b -n 1 -r 3";
		let (result, output) = execute_captured(command.to_string()).await;
		assert_eq!(result.exit_code, Some(0));
		assert!(output.contains("top - snapshot 1"));
		assert!(output.contains("PID"));
		assert!(output.contains("COMMAND"));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn top_builtin_stops_when_its_output_pipe_closes() {
		#[cfg(target_os = "macos")]
		let command = "top -s 0 | head -n 1";
		#[cfg(not(target_os = "macos"))]
		let command = "top -d 0 | head -n 1";
		let execution = time::timeout(Duration::from_secs(2), execute_captured(command.to_string()))
			.await
			.expect("top kept sampling after its output pipe closed");
		assert_eq!(execution.0.exit_code, Some(0));
		assert!(execution.1.contains("top - snapshot 1"), "{:?}", execution.1);
	}

	/// Regression: builtin tail upstream of an early-exiting consumer printed
	/// "tail: Broken pipe" and failed (`tail -c N big.jsonl | jq …` with jq
	/// aborting on a parse error). Real tail dies silently from SIGPIPE; the
	/// builtin must exit 141 with no diagnostic. `pipefail` exposes tail's own
	/// status, so rc=141 proves the broken pipe actually fired (head closed
	/// the pipe early) and was mapped to the silent SIGPIPE exit, not 1.
	#[tokio::test(flavor = "multi_thread")]
	async fn tail_builtin_is_silent_when_downstream_closes_pipe() {
		let dir = tempfile::tempdir().expect("tempdir");
		let file = dir.path().join("big.txt");
		// ~589 KiB: forces the seekable bounded_tail path, and the 400 KB tail
		// overflows the OS pipe buffer so tail is still writing when head exits.
		let command = format!(
			"seq 1 100000 > '{file}'; set -o pipefail; tail -c 400000 '{file}' | head -c 10 > \
			 /dev/null; echo rc=$?",
			file = file.display()
		);
		let (result, output) = execute_captured(command).await;
		assert_eq!(result.exit_code, Some(0));
		assert!(output.contains("rc=141"), "{output:?}");
		assert!(!output.contains("Broken pipe"), "{output:?}");
	}

	/// The kill builtin accepts a numeric signal and applies it to every process
	/// operand.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn kill_builtin_accepts_numeric_signal_for_multiple_processes() {
		let mut first = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("first sleep");
		let mut second = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("second sleep");
		let first_pid = first.id().expect("first pid");
		let second_pid = second.id().expect("second pid");
		let (mut session, params) = kill_test_context().await;
		let source_info = SourceInfo::from("pi-natives:test");

		let result = session
			.shell
			.run_string(format!("kill -9 {first_pid} {second_pid}"), &source_info, &params)
			.await
			.expect("kill command");
		let code = exit_code(&result);
		if code != 0 {
			let _ = first.kill().await;
			let _ = second.kill().await;
			let _ = first.wait().await;
			let _ = second.wait().await;
			assert_eq!(code, 0, "numeric multi-process kill should succeed");
		}

		let statuses =
			time::timeout(Duration::from_secs(5), async { tokio::join!(first.wait(), second.wait()) })
				.await;
		if statuses.is_err() {
			let _ = first.kill().await;
			let _ = second.kill().await;
			let _ = first.wait().await;
			let _ = second.wait().await;
			panic!("kill must signal every process operand");
		}
		let (first_status, second_status) = statuses.expect("checked timeout");
		assert_eq!(first_status.expect("first wait").signal(), Some(libc::SIGKILL));
		assert_eq!(second_status.expect("second wait").signal(), Some(libc::SIGKILL));
	}

	/// The kill builtin defaults to SIGTERM so processes can shut down
	/// gracefully.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn kill_builtin_defaults_to_sigterm() {
		let dir = tempfile::tempdir().expect("temp dir");
		let ready = dir.path().join("ready");
		let mut child = Command::new("sh")
			.args([
				"-c",
				"trap 'exit 42' TERM; : > \"$1\"; while :; do :; done",
				"sh",
				ready.to_str().expect("utf8 path"),
			])
			.spawn()
			.expect("trapping child");
		let pid = child.id().expect("child pid");
		let ready_result = time::timeout(Duration::from_secs(5), async {
			while !ready.exists() {
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await;
		if ready_result.is_err() {
			let _ = child.kill().await;
			let _ = child.wait().await;
			panic!("child did not install its SIGTERM trap");
		}

		let (mut session, params) = kill_test_context().await;
		let source_info = SourceInfo::from("pi-natives:test");
		let result = session
			.shell
			.run_string(format!("kill {pid}"), &source_info, &params)
			.await
			.expect("kill command");
		let code = exit_code(&result);

		let status = time::timeout(Duration::from_secs(5), child.wait()).await;
		if status.is_err() {
			let _ = child.kill().await;
			let _ = child.wait().await;
			panic!("default kill signal did not terminate the child");
		}
		assert_eq!(code, 0, "default kill should succeed");
		assert_eq!(status.expect("checked timeout").expect("child wait").code(), Some(42));
	}

	/// A negative PID after `--` targets a process group per `kill(2)` instead
	/// of being parsed as a numeric signal, and a plain PID in the same command
	/// is still signaled.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn kill_builtin_preserves_negative_pid_process_group_operands() {
		let dir = tempfile::tempdir().expect("temp dir");
		let group_ready = dir.path().join("group-ready");
		let plain_ready = dir.path().join("plain-ready");
		let spawn_trapping = |ready: &std::path::Path, own_group: bool| {
			let mut cmd = Command::new("sh");
			cmd.args([
				"-c",
				"trap 'exit 42' TERM; : > \"$1\"; while :; do sleep 0.05; done",
				"sh",
				ready.to_str().expect("utf8 path"),
			]);
			if own_group {
				// pgid becomes this child's own pid, so `-pid` addresses the group.
				cmd.process_group(0);
			}
			cmd.spawn().expect("trapping child")
		};

		let mut group_child = spawn_trapping(&group_ready, true);
		let mut plain_child = spawn_trapping(&plain_ready, false);
		let group_pid = group_child.id().expect("group pid");
		let plain_pid = plain_child.id().expect("plain pid");

		let ready_result = time::timeout(Duration::from_secs(5), async {
			while !group_ready.exists() || !plain_ready.exists() {
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await;
		if ready_result.is_err() {
			let _ = group_child.start_kill();
			let _ = plain_child.start_kill();
			let _ = group_child.wait().await;
			let _ = plain_child.wait().await;
			panic!("children did not install their SIGTERM traps");
		}

		let (mut session, params) = kill_test_context().await;
		let source_info = SourceInfo::from("pi-natives:test");
		let result = session
			.shell
			.run_string(format!("kill -TERM -- -{group_pid} {plain_pid}"), &source_info, &params)
			.await
			.expect("kill command");
		let code = exit_code(&result);

		let statuses = time::timeout(Duration::from_secs(5), async {
			tokio::join!(group_child.wait(), plain_child.wait())
		})
		.await;
		if statuses.is_err() {
			let _ = group_child.start_kill();
			let _ = plain_child.start_kill();
			let _ = group_child.wait().await;
			let _ = plain_child.wait().await;
			panic!("negative-PID kill must signal the process group and the plain PID");
		}
		let (group_status, plain_status) = statuses.expect("checked timeout");
		assert_eq!(code, 0, "negative-PID kill should succeed");
		assert_eq!(group_status.expect("group wait").code(), Some(42));
		assert_eq!(plain_status.expect("plain wait").code(), Some(42));
	}

	/// When clap consumes the `--` marker before `execute` (the default-signal
	/// and `-s SIG` forms), a following negative PID is still an operand, not a
	/// signal: `kill -- -<pgid>` defaults to SIGTERM for the group, and
	/// `kill -s TERM -- -<pgid>` sends the named signal to the group.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn kill_builtin_signals_group_when_marker_precedes_negative_pid() {
		let dir = tempfile::tempdir().expect("temp dir");
		let default_ready = dir.path().join("default-ready");
		let named_ready = dir.path().join("named-ready");
		let spawn_group_leader = |ready: &std::path::Path| {
			Command::new("sh")
				.args([
					"-c",
					"trap 'exit 42' TERM; : > \"$1\"; while :; do sleep 0.05; done",
					"sh",
					ready.to_str().expect("utf8 path"),
				])
				.process_group(0)
				.spawn()
				.expect("group leader")
		};

		let mut default_child = spawn_group_leader(&default_ready);
		let mut named_child = spawn_group_leader(&named_ready);
		let default_pid = default_child.id().expect("default pid");
		let named_pid = named_child.id().expect("named pid");

		let ready_result = time::timeout(Duration::from_secs(5), async {
			while !default_ready.exists() || !named_ready.exists() {
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await;
		if ready_result.is_err() {
			let _ = default_child.start_kill();
			let _ = named_child.start_kill();
			let _ = default_child.wait().await;
			let _ = named_child.wait().await;
			panic!("group leaders did not install their SIGTERM traps");
		}

		let (mut session, params) = kill_test_context().await;
		let source_info = SourceInfo::from("pi-natives:test");
		// Default signal (SIGTERM) with the marker consumed by clap.
		let default_result = session
			.shell
			.run_string(format!("kill -- -{default_pid}"), &source_info, &params)
			.await
			.expect("default kill command");
		// Named signal via -s, marker consumed by clap.
		let named_result = session
			.shell
			.run_string(format!("kill -s TERM -- -{named_pid}"), &source_info, &params)
			.await
			.expect("named kill command");

		let statuses = time::timeout(Duration::from_secs(5), async {
			tokio::join!(default_child.wait(), named_child.wait())
		})
		.await;
		if statuses.is_err() {
			let _ = default_child.start_kill();
			let _ = named_child.start_kill();
			let _ = default_child.wait().await;
			let _ = named_child.wait().await;
			panic!("marker-preceded negative PID must signal the process group");
		}
		let (default_status, named_status) = statuses.expect("checked timeout");
		assert_eq!(exit_code(&default_result), 0, "`kill -- -<pgid>` should succeed");
		assert_eq!(exit_code(&named_result), 0, "`kill -s TERM -- -<pgid>` should succeed");
		assert_eq!(default_status.expect("default wait").code(), Some(42));
		assert_eq!(named_status.expect("named wait").code(), Some(42));
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn kill_builtin_signals_every_process_in_a_jobspec_pipeline() {
		const MARKER: &str = "PI_SHELL_TEST_KILL_JOBSPEC_PIPELINE";
		if std::env::var_os(MARKER).is_none() {
			run_isolated_kill_test(
				"shell::tests::kill_builtin_signals_every_process_in_a_jobspec_pipeline",
				MARKER,
				true,
			)
			.await;
			return;
		}

		let dir = tempfile::tempdir().expect("jobspec directory");
		let first_pidfile = dir.path().join("first.pid");
		let second_pidfile = dir.path().join("second.pid");
		let _cleanup = PidfileProcessCleanup(vec![first_pidfile.clone(), second_pidfile.clone()]);
		let first_ready = dir.path().join("first.ready");
		let second_ready = dir.path().join("second.ready");
		let first_script = "trap 'exit 42' TERM; echo $$ > \"$1\"; : > \"$2\"; kill -STOP $$; while \
		                    :; do sleep 0.05; done";
		let second_script = "trap 'exit 43' TERM; echo $$ > \"$1\"; : > \"$2\"; kill -STOP $$; \
		                     while :; do sleep 0.05; done";
		let command = format!(
			"sh -c {} sh {} {} | sh -c {} sh {} {}",
			quote_arg(first_script),
			quote_arg(first_pidfile.to_str().expect("utf8 first pidfile")),
			quote_arg(first_ready.to_str().expect("utf8 first ready path")),
			quote_arg(second_script),
			quote_arg(second_pidfile.to_str().expect("utf8 second pidfile")),
			quote_arg(second_ready.to_str().expect("utf8 second ready path")),
		);
		let (mut session, params) = kill_test_context().await;
		let source_info = SourceInfo::from("pi-natives:test");

		time::timeout(
			Duration::from_secs(5),
			session.shell.run_string(command, &source_info, &params),
		)
		.await
		.expect("pipeline did not stop")
		.expect("stopped pipeline");
		time::timeout(Duration::from_secs(5), async {
			while !first_ready.exists() || !second_ready.exists() {
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await
		.expect("pipeline processes did not become ready");
		assert_eq!(
			session
				.shell
				.jobs()
				.current_job()
				.expect("stopped pipeline job")
				.process_ids()
				.count(),
			2,
			"jobspec must retain every external pipeline process",
		);
		let pids = [&first_pidfile, &second_pidfile].map(|pidfile| {
			fs::read_to_string(pidfile)
				.expect("pipeline pidfile")
				.trim()
				.parse::<i32>()
				.expect("pipeline pid")
		});

		let killed = session
			.shell
			.run_string("kill -CONT %1; kill %1", &source_info, &params)
			.await
			.expect("kill jobspec");
		assert_eq!(exit_code(&killed), 0, "`kill %1` should signal every pipeline process");
		let _ = session
			.shell
			.run_string("wait %1", &source_info, &params)
			.await
			.expect("reap jobspec");
		for pid in pids {
			assert!(process::Process::from_pid(pid).is_none(), "pipeline process {pid} survived");
		}
	}

	/// A failed target makes `kill` return non-zero without preventing later
	/// process operands from receiving the selected signal.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn kill_builtin_continues_after_target_failure() {
		let mut first = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("first sleep");
		let mut second = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("second sleep");
		let mut stale = Command::new("true").spawn().expect("stale process");
		let first_pid = first.id().expect("first pid");
		let second_pid = second.id().expect("second pid");
		let stale_pid = stale.id().expect("stale pid");
		stale.wait().await.expect("stale wait");

		let (mut session, params) = kill_test_context().await;
		let source_info = SourceInfo::from("pi-natives:test");
		let result = session
			.shell
			.run_string(
				format!("kill -KILL {first_pid} {stale_pid} {second_pid}"),
				&source_info,
				&params,
			)
			.await
			.expect("kill command");
		let code = exit_code(&result);

		let statuses =
			time::timeout(Duration::from_secs(5), async { tokio::join!(first.wait(), second.wait()) })
				.await;
		if statuses.is_err() {
			let _ = first.start_kill();
			let _ = second.start_kill();
			let _ = first.wait().await;
			let _ = second.wait().await;
			panic!("kill must continue signaling after an intermediate target fails");
		}
		let (first_status, second_status) = statuses.expect("checked timeout");
		assert_ne!(code, 0, "a failed target should make kill return non-zero");
		assert_eq!(first_status.expect("first wait").signal(), Some(libc::SIGKILL));
		assert_eq!(second_status.expect("second wait").signal(), Some(libc::SIGKILL));
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn kill_builtin_translates_signal_names_and_numbers() {
		let (result, output) = execute_captured("kill -l KILL; kill -l 9".to_string()).await;
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output, "9\nKILL\n");
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

	/// `kill -0` can probe the shell, but a nonzero signal aimed at its PID is
	/// refused without terminating command execution.
	#[tokio::test(flavor = "multi_thread")]
	async fn kill_builtin_refuses_own_pid() {
		const MARKER: &str = "PI_SHELL_TEST_KILL_OWN_PID";
		if std::env::var_os(MARKER).is_none() {
			run_isolated_kill_test("shell::tests::kill_builtin_refuses_own_pid", MARKER, false).await;
			return;
		}

		let pid = std::process::id();
		let (probe, _) = execute_captured(format!("kill -0 {pid}")).await;
		assert_eq!(probe.exit_code, Some(0), "signal 0 should probe the shell process");
		let (result, output) = execute_captured(format!(
			"kill -KILL {pid}; status=$?; printf 'status=%s survived\\n' \"$status\"; test \
			 \"$status\" -ne 0"
		))
		.await;
		assert_eq!(result.exit_code, Some(0), "the shell must survive a direct kill attempt");
		assert!(output.contains("refusing to signal the shell process"), "{output:?}");
		assert!(output.contains("survived"), "{output:?}");
	}

	/// A process-group operand that contains the shell is rejected before the
	/// `kill(2)` group operation can signal any member.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn kill_builtin_refuses_own_process_group() {
		const MARKER: &str = "PI_SHELL_TEST_KILL_OWN_GROUP";
		if std::env::var_os(MARKER).is_none() {
			run_isolated_kill_test(
				"shell::tests::kill_builtin_refuses_own_process_group",
				MARKER,
				true,
			)
			.await;
			return;
		}

		let (result, output) = execute_captured(
			"kill -KILL -- 0; status=$?; printf 'status=%s survived\\n' \"$status\"; test \
			 \"$status\" -ne 0"
				.to_string(),
		)
		.await;
		assert_eq!(result.exit_code, Some(0), "the shell must survive a group kill attempt");
		assert!(output.contains("refusing to signal the shell process"), "{output:?}");
		assert!(output.contains("survived"), "{output:?}");
	}

	/// An agent that runs `kill <terminal pid>` or `pkill <terminal>` must not
	/// be able to take down the terminal the session lives in. Self-kill was
	/// already refused, but an ancestor is a different process in a different
	/// process group and session, so it slipped straight through.
	///
	/// Uses `CONT` rather than a lethal signal: the guard runs for any real
	/// signal (only `-0` is exempt), so `CONT` exercises exactly the same code
	/// path while staying harmless if the guard ever regresses. A lethal signal
	/// here could terminate the test harness. `TERM` appears once, aimed only
	/// at a child this test spawned, to prove the guard has not over-blocked
	/// into uselessness.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn kill_builtin_refuses_ancestors_but_not_unrelated_processes() {
		let sleep = test_executable("sleep");
		let command = format!(
			"parent=$(ps -o ppid= -p $$ | tr -d ' ')\nkill -CONT \"$parent\"; printf \
			 'ancestor=%s\\n' \"$?\"\n{} 30 &\nchild=$!\nkill -TERM \"$child\"; printf 'child=%s\\n' \
			 \"$?\"\nprintf 'survived\\n'",
			quote_arg(sleep.to_str().expect("utf8 sleep path"))
		);
		let (result, output) = execute_captured(command).await;
		assert_eq!(result.exit_code, Some(0), "the shell must survive: {output:?}");
		assert!(output.contains("survived"), "{output:?}");
		assert!(
			output.contains("refusing to signal the shell process"),
			"signalling an ancestor must be refused: {output:?}"
		);
		assert!(output.contains("ancestor=1"), "the ancestor kill must report failure: {output:?}");
		// The same guard must leave a process outside our ancestry alone, or `kill`
		// would be useless.
		assert!(output.contains("child=0"), "an unrelated child must remain signallable: {output:?}");
	}

	/// `pkill` removes the shell PID from the candidate set before sending the
	/// selected signal, even when that PID is requested explicitly.
	#[tokio::test(flavor = "multi_thread")]
	async fn pkill_builtin_excludes_own_pid() {
		const MARKER: &str = "PI_SHELL_TEST_PKILL_OWN_PID";
		if std::env::var_os(MARKER).is_none() {
			run_isolated_kill_test("shell::tests::pkill_builtin_excludes_own_pid", MARKER, false)
				.await;
			return;
		}

		let pid = std::process::id();
		let (result, output) = execute_captured(format!(
			"pkill -KILL -p {pid}; status=$?; printf 'status=%s survived\\n' \"$status\"; test \
			 \"$status\" -eq 1"
		))
		.await;
		assert_eq!(result.exit_code, Some(0), "the shell must survive an explicit pkill");
		assert!(output.contains("survived"), "{output:?}");
	}

	/// `cmp` remains available with no executable search path, proving the shell
	/// dispatches the in-process builtin rather than a platform binary.
	#[tokio::test(flavor = "multi_thread")]
	async fn cmp_is_registered_as_an_in_process_builtin() {
		let dir = tempfile::tempdir().expect("temp dir");
		let root = std::fs::canonicalize(dir.path()).expect("canonical temp dir");
		std::fs::write(root.join("a"), b"same").expect("write a");
		std::fs::write(root.join("b"), b"same").expect("write b");
		std::fs::write(root.join("c"), b"different").expect("write c");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session
			.shell
			.set_working_dir(root.to_str().expect("utf8 temp path"))
			.expect("set cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null stdin"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null stdout"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null stderr"));
		let source_info = SourceInfo::from("pi-natives:test");

		let equal = session
			.shell
			.run_string("PATH=/definitely-missing cmp -s a b", &source_info, &params)
			.await
			.expect("equal cmp");
		assert_eq!(exit_code(&equal), 0);

		let different = session
			.shell
			.run_string("PATH=/definitely-missing cmp -s a c", &source_info, &params)
			.await
			.expect("different cmp");
		assert_eq!(exit_code(&different), 1);
	}

	/// The moreutils-style builtins (`ts`, `sponge`, `isutf8`, `combine`,
	/// `ifne`, `errno`) dispatch in-process: the script runs with no usable
	/// executable search path, and the `ts | sponge` pipeline must land its
	/// output in the shell's working directory.
	#[tokio::test(flavor = "multi_thread")]
	async fn moreutils_builtins_are_registered_in_process() {
		let dir = tempfile::tempdir().expect("temp dir");
		let root = std::fs::canonicalize(dir.path()).expect("canonical temp dir");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session
			.shell
			.set_working_dir(root.to_str().expect("utf8 temp path"))
			.expect("set cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null stdin"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null stdout"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null stderr"));
		let source_info = SourceInfo::from("pi-natives:test");

		let script = "PATH=/definitely-missing\necho x | ts -s '%H:%M:%S' | sponge out || exit \
		              10\nisutf8 out || exit 11\necho x | combine - and out || exit 12\nifne \
		              /definitely-missing/tool || exit 13";
		let result = session
			.shell
			.run_string(script, &source_info, &params)
			.await
			.expect("moreutils script");
		assert_eq!(exit_code(&result), 0);

		// `ts -s` stamps the first line with zero elapsed time: `HH:MM:SS x`.
		let out = std::fs::read_to_string(root.join("out")).expect("sponge output");
		assert!(out.len() == 11 && out.ends_with(" x\n"), "unexpected ts+sponge output: {out:?}");

		#[cfg(unix)]
		{
			let errno = session
				.shell
				.run_string("errno ENOENT", &source_info, &params)
				.await
				.expect("errno lookup");
			assert_eq!(exit_code(&errno), 0);
		}
	}

	/// `sort --compress-program` spawns real children from inside the
	/// external-sort temp-file machinery. Those children must inherit the
	/// *shell's* context, not the host process's: the program is resolved
	/// against the shell's exported `PATH` (here a directory that exists only
	/// there), it runs in the shell working directory, and its stderr is
	/// forwarded to the command's own fd 2 instead of being inherited — an
	/// inherited fd 2 belongs to the TUI and would corrupt the rendered frame.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_sort_compress_program_uses_shell_path_and_stderr() {
		use std::os::unix::fs::PermissionsExt as _;

		let tmp = std::env::temp_dir().join(format!("pi-sort-compress-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		let bin = tmp.join("bin");
		std::fs::create_dir_all(&bin).expect("bin dir");

		// An identity "compressor" that also proves it was started with the
		// shell's working directory and reaches the command's stderr.
		let shim = bin.join("pi-test-compress");
		let shell = test_executable("sh");
		let cat = test_executable("cat");
		let shim_source = format!(
			"#!{}\nprintf 'compressor cwd=%s\\n' \"$PWD\" >&2\nexec {}\n",
			shell.display(),
			quote_arg(cat.to_str().expect("utf8 cat path"))
		);
		std::fs::write(&shim, shim_source).expect("write shim");
		std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).expect("chmod shim");

		// Enough distinct lines that the 1K buffer forces spilling through the
		// compressor rather than sorting entirely in memory.
		let mut input = String::new();
		for n in (0..400).rev() {
			use std::fmt::Write as _;
			let _ = writeln!(input, "line{n:04}");
		}
		std::fs::write(tmp.join("in.txt"), &input).expect("write input");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session
			.shell
			.set_working_dir(tmp.to_str().expect("utf8 temp path"))
			.expect("set cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null stdin"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null stdout"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null stderr"));
		let source_info = SourceInfo::from("pi-natives:test");

		// `PATH` holds only the shim directory, so the compressor is reachable
		// solely through the shell's exported environment.
		let script = format!(
			"export PATH={}\nsort -S 1K --compress-program=pi-test-compress in.txt > out.txt 2> \
			 err.txt",
			bin.to_str().expect("utf8 bin path")
		);
		let exec = session
			.shell
			.run_string(script, &source_info, &params)
			.await
			.expect("run sort");
		assert_eq!(exit_code(&exec), 0, "sort --compress-program failed");

		let out = std::fs::read_to_string(tmp.join("out.txt")).expect("out.txt");
		let mut expected: Vec<&str> = input.lines().collect();
		expected.sort_unstable();
		assert_eq!(out.lines().collect::<Vec<_>>(), expected, "compressed external sort misordered");

		// The compressor really ran (so the spill path was exercised), its
		// stderr reached the command's redirected fd 2, and it started in the
		// shell working directory.
		let err = std::fs::read_to_string(tmp.join("err.txt")).expect("err.txt");
		assert!(
			err.contains("compressor cwd="),
			"compressor stderr never reached the command's fd 2: {err:?}"
		);
		// The shell reports the working directory as it was set; macOS also
		// exposes it under `/private`, so accept either spelling.
		let canonical = std::fs::canonicalize(&tmp).expect("canonical tmp");
		assert!(
			err.contains(&format!("cwd={}\n", tmp.display()))
				|| err.contains(&format!("cwd={}\n", canonical.display())),
			"compressor did not start in the shell working directory ({}): {err:?}",
			tmp.display()
		);

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// The uutils-backed `mkdir` builtin must (1) create directories under the
	/// shell's working directory rather than the host process cwd, (2) route
	/// `-v` output through the command's (here redirected) stdout, and (3)
	/// display the original operand, not the resolved absolute path.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_mkdir_resolves_cwd_and_displays_operand() {
		let tmp = std::env::temp_dir().join(format!("pi-mkdir-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		let tmp_str = tmp.to_str().expect("utf8 temp path");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("set cwd");

		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));

		let source_info = SourceInfo::from("pi-natives:test");
		let exec = session
			.shell
			.run_string("mkdir -v -p a/b/c rel > out.txt", &source_info, &params)
			.await
			.expect("run_string");
		assert!(matches!(exec.exit_code, ExecutionExitCode::Success), "exit {}", exit_code(&exec));

		// (1) created under the shell working dir, and (2) not leaked into the
		// host process cwd.
		assert!(tmp.join("a/b/c").is_dir(), "nested dirs not created under shell cwd");
		assert!(tmp.join("rel").is_dir(), "rel not created under shell cwd");
		assert!(!std::path::Path::new("a/b/c").exists(), "mkdir leaked into process cwd");

		// (2)+(3): -v output reached the redirected file, names the operand, and
		// does not leak the absolute resolved path.
		let out = std::fs::read_to_string(tmp.join("out.txt")).expect("out.txt");
		assert!(out.contains("'rel'"), "verbose output missing operand `rel`: {out:?}");
		assert!(!out.contains(tmp_str), "verbose output leaked absolute path: {out:?}");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// `command -v`/`-V` must iterate over every operand like bash/zsh, printing
	/// one line per name that resolves and skipping the misses, rather than
	/// honoring only the first operand. Regression test for silently dropped
	/// operands in `command -v a b c` (issue #10544).
	#[tokio::test(flavor = "multi_thread")]
	async fn command_v_iterates_all_operands() {
		let tmp = std::env::temp_dir().join(format!("pi-command-v-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		let tmp_str = tmp.to_str().expect("utf8 temp path");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("set cwd");

		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));

		let source_info = SourceInfo::from("pi-natives:test");

		// Three always-registered builtins plus a name that never resolves. bash
		// prints one line per resolved builtin and skips the miss, exiting 0.
		let exec = session
			.shell
			.run_string("command -v true false pwd nope-xyz-10544 > out.txt", &source_info, &params)
			.await
			.expect("run_string");
		assert_eq!(exit_code(&exec), 0, "command -v exit code with a resolvable name");

		let out = std::fs::read_to_string(tmp.join("out.txt")).expect("out.txt");
		let lines: Vec<&str> = out.lines().collect();
		assert_eq!(
			lines,
			vec!["true", "false", "pwd"],
			"command -v must print one line per resolved operand and skip misses: {out:?}"
		);

		// When no operand resolves, the exit status is a general error.
		let exec = session
			.shell
			.run_string("command -v nope-a-10544 nope-b-10544", &source_info, &params)
			.await
			.expect("run_string");
		assert_eq!(exit_code(&exec), 1, "command -v exit code when nothing resolves");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// Every utility `pi-builtins` offers must actually be dispatchable in
	/// process, under the name it is registered as.
	///
	/// The registry (`pi_builtins::utility_builtins`) maps a name to a
	/// `Registration`, and each registration renders its help from its own
	/// `clap` command. Wiring a name to the wrong module — easy to do, since the
	/// mapping is written by hand — still compiles and still runs; the only
	/// visible symptom is that `NAME --help` describes some other utility. With
	/// `PATH` emptied there is no binary to fall back on, so this also proves
	/// the whole set resolves as builtins rather than as system commands.
	#[tokio::test(flavor = "multi_thread")]
	async fn every_utility_builtin_is_registered_under_its_own_name() {
		let tmp = std::env::temp_dir().join(format!("pi-utility-help-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session
			.shell
			.set_working_dir(tmp.to_str().expect("utf8 temp path"))
			.expect("set cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null stdin"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null stdout"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null stderr"));
		let source_info = SourceInfo::from("pi-natives:test");

		// Pin the registry contents rather than iterating whatever it happens to
		// contain: a loop over the registry cannot notice a name missing from it.
		// Adding a utility is expected to update this list.
		let expected = [
			"b2sum",
			"base32",
			"base64",
			"basename",
			"cat",
			"cksum",
			"cmp",
			"combine",
			"comm",
			"cut",
			"date",
			"diff",
			"dirname",
			"errno",
			"fd",
			"find",
			"grep",
			"head",
			"hostname",
			"ifne",
			"isutf8",
			"jq",
			"ln",
			"ls",
			"md5sum",
			"mkdir",
			"mktemp",
			"mv",
			"nproc",
			"paste",
			"printenv",
			"readlink",
			"realpath",
			"rg",
			"rm",
			"sed",
			"seq",
			"sha1sum",
			"sha224sum",
			"sha256sum",
			"sha384sum",
			"sha512sum",
			"sort",
			"sponge",
			"stat",
			"tac",
			"tail",
			"tee",
			"touch",
			"tr",
			"truncate",
			"ts",
			"uname",
			"uniq",
			"wc",
			"which",
			"whoami",
			"xargs",
			"yes",
		];
		let mut names: Vec<&'static str> =
			pi_builtins::utility_builtins::<brush_core::extensions::DefaultShellExtensions>()
				.into_iter()
				.map(|(name, _)| name)
				.collect();
		names.sort_unstable();
		assert_eq!(names, expected, "the utility builtin registry changed");

		for name in names {
			let exec = session
				.shell
				.run_string(format!("PATH= {name} --help > help.txt 2> err.txt"), &source_info, &params)
				.await
				.unwrap_or_else(|err| panic!("{name} --help failed to run: {err}"));
			assert_eq!(exit_code(&exec), 0, "{name} --help exited nonzero");

			let help = std::fs::read_to_string(tmp.join("help.txt")).expect("help.txt");
			let err = std::fs::read_to_string(tmp.join("err.txt")).expect("err.txt");
			assert!(err.is_empty(), "{name} --help wrote to stderr: {err:?}");
			// Two builtins are registered under the familiar command name but keep
			// their implementation's own help text, exactly as the standalone
			// versions did: `rg` is ripgrep, `jq` is jaq.
			let expected = match name {
				"rg" => "ripgrep",
				"jq" => "jaq",
				other => other,
			};
			assert!(
				help.contains(expected),
				"{name} --help does not mention {expected:?}, so it is wired to the wrong utility: \
				 {help:.200?}"
			);
		}

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// Every process builtin `pi-builtins` offers must be installed and
	/// dispatch in process.
	///
	/// `factory.rs` maps each name to a struct by hand, so a mis-wire compiles
	/// and runs — and with `PATH` emptied there is no binary to silently fall
	/// back to, which is the failure this catches. Each command gets an
	/// invocation that is benign but must reach the builtin: exit 127 means the
	/// name never resolved.
	#[tokio::test(flavor = "multi_thread")]
	async fn every_process_builtin_is_installed_and_dispatches() {
		let tmp = std::env::temp_dir().join(format!("pi-process-builtins-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session
			.shell
			.set_working_dir(tmp.to_str().expect("utf8 temp path"))
			.expect("set cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null stdin"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null stdout"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null stderr"));
		let source_info = SourceInfo::from("pi-natives:test");

		// Bounded, side-effect-free invocations. `pgrep`/`pkill`/`pidwait` render
		// their own help; `sleep`/`timeout`/`top` are given the smallest amount of
		// work that still exercises dispatch; `nohup` with no operand is a usage
		// error, which is still the builtin answering.
		let probes = [
			("nohup", "nohup"),
			("pgrep", "pgrep --help"),
			("pidwait", "pidwait --help"),
			("pkill", "pkill --help"),
			("ps", "ps --help"),
			("sleep", "sleep 0"),
			("timeout", "timeout 1 true"),
			("top", "top -n 0"),
		];

		// Pin the registry contents rather than deriving the probe list from it:
		// a test that skips whatever the registry omits cannot notice an omission.
		let mut registered: Vec<&'static str> =
			pi_builtins::process_builtins::<brush_core::extensions::DefaultShellExtensions>()
				.into_iter()
				.map(|(name, _)| name)
				.collect();
		registered.sort_unstable();
		let expected: Vec<&'static str> = probes.iter().map(|(name, _)| *name).collect();
		assert_eq!(registered, expected, "the process builtin registry changed");

		// `kill` comes from the default builtin set, where our implementation
		// replaced brush's, so it is checked alongside but not listed above.
		for (name, command) in probes.iter().copied().chain([("kill", "kill -l")]) {
			let exec = session
				.shell
				.run_string(format!("PATH= {command}"), &source_info, &params)
				.await
				.unwrap_or_else(|err| panic!("{name} failed to run: {err}"));
			assert_ne!(
				exit_code(&exec),
				127,
				"{name} resolved to nothing: it is not registered as a builtin"
			);
		}

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// Regression test for issue #5819: `mkdir -p ~/proj/{a,b}` must create both
	/// `a` and `b` under `$HOME/proj`. Brace expansion runs before tilde
	/// expansion and previously left every element after the first with a
	/// literal `~`, so `b` was created as `./~/proj/b` in the shell cwd instead.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_mkdir_expands_tilde_for_every_brace_element() {
		let base = std::env::temp_dir().join(format!("pi-mkdir-brace-{}", std::process::id()));
		let home = base.join("home");
		let cwd = base.join("cwd");
		let _ = std::fs::remove_dir_all(&base);
		std::fs::create_dir_all(&home).expect("home dir");
		std::fs::create_dir_all(&cwd).expect("cwd dir");
		let cwd_str = cwd.to_str().expect("utf8 cwd path");

		let mut env = HashMap::new();
		env.insert("HOME".to_string(), home.to_string_lossy().to_string());
		let config =
			ShellConfig { session_env: Some(env), snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(cwd_str).expect("set cwd");

		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));

		let source_info = SourceInfo::from("pi-natives:test");
		let exec = session
			.shell
			.run_string("mkdir -p ~/proj/{a,b}", &source_info, &params)
			.await
			.expect("run_string");
		assert!(matches!(exec.exit_code, ExecutionExitCode::Success), "exit {}", exit_code(&exec));

		// Both elements' tildes expanded: dirs land under $HOME/proj.
		assert!(home.join("proj/a").is_dir(), "~/proj/a not created under HOME");
		assert!(home.join("proj/b").is_dir(), "~/proj/b not created under HOME");
		// The buggy path created a literal `~` tree in the shell cwd.
		assert!(!cwd.join("~").exists(), "literal ~ tree leaked into cwd");
		assert!(!cwd.join("a").exists(), "unexpanded element leaked into cwd");

		let _ = std::fs::remove_dir_all(&base);
	}

	/// `mkdir --help` and an invalid flag must be handled in-process: rendered
	/// to the command streams and returned as an exit code. The upstream
	/// `uumain` parser calls `std::process::exit`, which would terminate the
	/// whole host (and this test binary); reaching the asserts proves the
	/// vendored `run` entry point bypasses that path.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_mkdir_help_and_bad_flag_do_not_exit_process() {
		let tmp = std::env::temp_dir().join(format!("pi-mkdir-help-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		let tmp_str = tmp.to_str().expect("utf8 temp path");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("set cwd");

		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let source_info = SourceInfo::from("pi-natives:test");

		let help = session
			.shell
			.run_string("mkdir --help > help.txt", &source_info, &params)
			.await
			.expect("run_string help");
		assert_eq!(exit_code(&help), 0, "mkdir --help should succeed");
		let help_text = std::fs::read_to_string(tmp.join("help.txt")).expect("help.txt");
		assert!(help_text.contains("mkdir"), "help text missing util name: {help_text:?}");

		let bad = session
			.shell
			.run_string("mkdir --no-such-flag 2> err.txt", &source_info, &params)
			.await
			.expect("run_string bad flag");
		assert_ne!(exit_code(&bad), 0, "invalid flag should be a usage error");
		let err_text = std::fs::read_to_string(tmp.join("err.txt")).expect("err.txt");
		assert!(!err_text.is_empty(), "usage error should be reported to stderr");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// The uutils-backed `head` builtin must read piped stdin through the
	/// context, read file operands resolved against the shell working directory,
	/// honor the obsolete `-NUM` syntax, and write to the command's (here
	/// redirected) stdout.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_head_streams_stdin_and_reads_files() {
		let tmp = std::env::temp_dir().join(format!("pi-head-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		std::fs::write(tmp.join("data.txt"), "l1\nl2\nl3\nl4\nl5\n").expect("write data");
		let tmp_str = tmp.to_str().expect("utf8 temp path");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("set cwd");

		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let source_info = SourceInfo::from("pi-natives:test");

		// File operand, resolved against the shell working directory.
		let f = session
			.shell
			.run_string("head -2 data.txt > out_file.txt", &source_info, &params)
			.await
			.expect("run_string file");
		assert_eq!(exit_code(&f), 0, "head file read should succeed");
		assert_eq!(std::fs::read_to_string(tmp.join("out_file.txt")).unwrap(), "l1\nl2\n");

		// Piped stdin (head is the final stage; reads the pipe through the ctx).
		let p = session
			.shell
			.run_string("printf 'a\\nb\\nc\\nd\\n' | head -2 > out_pipe.txt", &source_info, &params)
			.await
			.expect("run_string pipe");
		assert_eq!(exit_code(&p), 0, "head stdin read should succeed");
		assert_eq!(std::fs::read_to_string(tmp.join("out_pipe.txt")).unwrap(), "a\nb\n");

		// Obsolete `-NUM` syntax, normalized by arg_iterate.
		let o = session
			.shell
			.run_string("printf '1\\n2\\n3\\n' | head -1 > out_obs.txt", &source_info, &params)
			.await
			.expect("run_string obsolete");
		assert_eq!(exit_code(&o), 0, "head -1 should succeed");
		assert_eq!(std::fs::read_to_string(tmp.join("out_obs.txt")).unwrap(), "1\n");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// `head --help` / invalid flag must be handled in-process (rendered to the
	/// command streams, returned as an exit code) — head has its own `run`
	/// entry point bypassing uutils' process-exiting parser, and literalized
	/// help strings.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_head_help_and_bad_flag_do_not_exit_process() {
		let tmp = std::env::temp_dir().join(format!("pi-head-help-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		let tmp_str = tmp.to_str().expect("utf8 temp path");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("set cwd");

		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let source_info = SourceInfo::from("pi-natives:test");

		let help = session
			.shell
			.run_string("head --help > help.txt", &source_info, &params)
			.await
			.expect("run_string head help");
		assert_eq!(exit_code(&help), 0, "head --help should succeed");
		let help_text = std::fs::read_to_string(tmp.join("help.txt")).expect("help.txt");
		assert!(help_text.contains("first"), "help text not localized: {help_text:?}");

		let bad = session
			.shell
			.run_string("head --no-such-flag 2> err.txt", &source_info, &params)
			.await
			.expect("run_string head bad flag");
		assert_ne!(exit_code(&bad), 0, "invalid flag should be a usage error");
		assert_ne!(std::fs::read_to_string(tmp.join("err.txt")).expect("err.txt"), "");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// Smoke-test the read-only uutils filter/listing builtins end-to-end
	/// through the shell: piped stdin (sort/wc/tail), file reads + cwd
	/// resolution (grep/ls/find), and redirected stdout capture.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_filters_listing_find_grep() {
		let tmp = std::env::temp_dir().join(format!("pi-utils-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(tmp.join("sub")).expect("temp dirs");
		std::fs::write(tmp.join("data.txt"), "foo\nbar\nbaz\n").expect("data");
		std::fs::write(tmp.join("sub/nested.txt"), "deep\n").expect("nested");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");
		let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

		// sort: reads piped stdin, parallel sort, writes sorted output.
		session
			.shell
			.run_string("printf 'c\\na\\nb\\n' | sort > sort.txt", &si, &params)
			.await
			.expect("sort");
		assert_eq!(read("sort.txt"), "a\nb\nc\n");
		// wc -l: line count from stdin.
		session
			.shell
			.run_string("printf 'x\\ny\\nz\\n' | wc -l > wc.txt", &si, &params)
			.await
			.expect("wc");
		assert_eq!(read("wc.txt").trim(), "3");
		// tail: last N lines from stdin.
		session
			.shell
			.run_string("printf '1\\n2\\n3\\n4\\n' | tail -2 > tail.txt", &si, &params)
			.await
			.expect("tail");
		assert_eq!(read("tail.txt"), "3\n4\n");
		// grep: matching lines from a cwd-resolved file (single file => no prefix).
		session
			.shell
			.run_string("grep ba data.txt > grep.txt", &si, &params)
			.await
			.expect("grep");
		assert_eq!(read("grep.txt"), "bar\nbaz\n");
		// ls: non-tty listing of the cwd.
		session
			.shell
			.run_string("ls > ls.txt", &si, &params)
			.await
			.expect("ls");
		let ls = read("ls.txt");
		assert!(ls.contains("data.txt") && ls.contains("sub"), "ls output: {ls:?}");
		// find: recursive name match. Paths must keep the `.` operand prefix
		// (GNU/BSD contract) instead of leaking the working-dir-resolved absolute
		// root the walk is physically rooted at.
		session
			.shell
			.run_string("find . -name '*.txt' > find.txt", &si, &params)
			.await
			.expect("find");
		let found = read("find.txt");
		assert!(!found.trim().is_empty(), "find produced no output");
		for line in found.lines() {
			assert!(
				line.starts_with("./"),
				"find path is not operand-relative: {line:?} (full: {found:?})"
			);
		}
		assert!(
			found.contains("./data.txt") && found.contains("./sub/nested.txt"),
			"find output: {found:?}"
		);
		// cat: concatenate a cwd-resolved file with -n line numbering.
		session
			.shell
			.run_string("cat -n data.txt > cat.txt", &si, &params)
			.await
			.expect("cat");
		assert_eq!(read("cat.txt"), "     1\tfoo\n     2\tbar\n     3\tbaz\n");
		// uniq: collapse adjacent duplicate lines from piped stdin.
		session
			.shell
			.run_string("printf 'a\\na\\nb\\nb\\nb\\nc\\n' | uniq > uniq.txt", &si, &params)
			.await
			.expect("uniq");
		assert_eq!(read("uniq.txt"), "a\nb\nc\n");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// `rg` is not an alias for `grep`: it recurses by default, respects
	/// ripgrep's ignore/hidden/binary filters, and keeps `-h` as help.
	#[tokio::test(flavor = "multi_thread")]
	async fn rg_builtin_uses_ripgrep_defaults() {
		let tmp = std::env::temp_dir().join(format!("pi-rg-defaults-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(tmp.join("sub")).expect("sub dir");
		std::fs::create_dir_all(tmp.join(".git")).expect("git dir");
		std::fs::write(tmp.join("data.txt"), "alpha\nneedle\n").expect("data");
		std::fs::write(tmp.join("sub/nested.txt"), "needle\n").expect("nested");
		std::fs::write(tmp.join(".hidden.txt"), "needle\n").expect("hidden");
		std::fs::write(tmp.join("ignored.log"), "needle\n").expect("ignored");
		std::fs::write(tmp.join(".gitignore"), "ignored.log\n").expect("gitignore");
		std::fs::write(tmp.join("binary.bin"), b"needle\0hidden\n").expect("binary");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");
		let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

		let exec = session
			.shell
			.run_string("rg needle > rg.txt", &si, &params)
			.await
			.expect("rg");
		assert_eq!(exit_code(&exec), 0, "rg recursive search should match");
		let out = read("rg.txt");
		assert!(out.contains("data.txt:needle"), "rg missed visible file: {out:?}");
		assert!(out.contains("sub/nested.txt:needle"), "rg missed nested file: {out:?}");
		assert!(!out.contains(".hidden.txt"), "rg searched hidden file by default: {out:?}");
		assert!(!out.contains("ignored.log"), "rg ignored .gitignore by default: {out:?}");
		assert!(!out.contains("binary.bin"), "rg printed binary file by default: {out:?}");

		let single = session
			.shell
			.run_string("rg -nH needle data.txt > single.txt", &si, &params)
			.await
			.expect("rg single");
		assert_eq!(exit_code(&single), 0, "rg explicit file should match");
		assert_eq!(read("single.txt"), "data.txt:2:needle\n");

		let explicit_binary = session
			.shell
			.run_string("rg needle binary.bin > explicit-binary.txt", &si, &params)
			.await
			.expect("rg explicit binary");
		assert_eq!(exit_code(&explicit_binary), 0, "explicit binary file should be searched");
		assert_eq!(read("explicit-binary.txt"), "needle\n");

		let help = session
			.shell
			.run_string("rg -h > help.txt", &si, &params)
			.await
			.expect("rg help");
		assert_eq!(exit_code(&help), 0, "rg -h should be help, not no-filename");
		assert!(
			read("help.txt").contains("ripgrep recursively searches"),
			"help text should describe ripgrep"
		);

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// `fd` recurses from the shell working directory, respects hidden and
	/// ignore filters (including `.fdignore`), preserves explicit search-path
	/// prefixes, and renders help to stdout with a success status.
	#[tokio::test(flavor = "multi_thread")]
	async fn fd_builtin_uses_fd_defaults() {
		let tmp = std::env::temp_dir().join(format!("pi-fd-defaults-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(tmp.join("sub")).expect("sub dir");
		std::fs::create_dir_all(tmp.join(".git/info")).expect("git info dir");
		std::fs::write(tmp.join("needle.txt"), "visible\n").expect("visible");
		std::fs::write(tmp.join("sub/needle.rs"), "nested\n").expect("nested");
		std::fs::write(tmp.join(".hidden-needle.txt"), "hidden\n").expect("hidden");
		std::fs::write(tmp.join("ignored-needle.log"), "ignored\n").expect("ignored");
		std::fs::write(tmp.join("excluded-needle.vcs"), "excluded\n").expect("excluded");
		std::fs::write(tmp.join("fdignored-needle.tmp"), "fdignored\n").expect("fdignored");
		std::fs::write(tmp.join(".gitignore"), "ignored-needle.log\n").expect("gitignore");
		std::fs::write(tmp.join(".git/info/exclude"), "excluded-needle.vcs\n").expect("exclude");
		std::fs::write(tmp.join(".fdignore"), "fdignored-needle.tmp\n").expect("fdignore");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");
		let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

		let exec = session
			.shell
			.run_string("fd needle > fd.txt", &si, &params)
			.await
			.expect("fd");
		assert_eq!(exit_code(&exec), 0, "fd should match visible files");
		let out = read("fd.txt");
		assert!(out.contains("needle.txt"), "fd missed visible file: {out:?}");
		assert!(out.contains("sub/needle.rs"), "fd missed nested file: {out:?}");
		assert!(!out.contains(".hidden-needle.txt"), "fd searched hidden file: {out:?}");
		assert!(!out.contains("ignored-needle.log"), "fd ignored .gitignore: {out:?}");
		assert!(!out.contains("fdignored-needle.tmp"), "fd ignored .fdignore: {out:?}");
		assert!(!out.contains("excluded-needle.vcs"), "fd ignored .git/info/exclude: {out:?}");

		session
			.shell
			.run_string("fd -u needle > unrestricted.txt", &si, &params)
			.await
			.expect("fd -u");
		let unrestricted = read("unrestricted.txt");
		assert!(unrestricted.contains(".hidden-needle.txt"), "-u should include hidden files");
		assert!(unrestricted.contains("ignored-needle.log"), "-u should include gitignored files");
		assert!(unrestricted.contains("fdignored-needle.tmp"), "-u should include fdignored files");

		session
			.shell
			.run_string("fd --no-ignore-vcs needle > no-ignore-vcs.txt", &si, &params)
			.await
			.expect("fd --no-ignore-vcs");
		let no_ignore_vcs = read("no-ignore-vcs.txt");
		assert!(
			no_ignore_vcs.contains("ignored-needle.log"),
			"--no-ignore-vcs should include .gitignore matches"
		);
		assert!(
			no_ignore_vcs.contains("excluded-needle.vcs"),
			"--no-ignore-vcs should include .git/info/exclude matches"
		);
		assert!(
			!no_ignore_vcs.contains("fdignored-needle.tmp"),
			"--no-ignore-vcs must still respect .fdignore"
		);

		session
			.shell
			.run_string("fd --glob '*.rs' sub > glob.txt", &si, &params)
			.await
			.expect("fd glob");
		assert_eq!(read("glob.txt"), "sub/needle.rs\n");

		let no_match = session
			.shell
			.run_string("fd definitely-absent > no-match.txt", &si, &params)
			.await
			.expect("fd no match");
		assert_eq!(exit_code(&no_match), 0, "ordinary fd no-match should still succeed");
		assert_eq!(read("no-match.txt"), "");

		let quiet_miss = session
			.shell
			.run_string("fd -q definitely-absent > quiet-miss.txt", &si, &params)
			.await
			.expect("fd quiet miss");
		assert_eq!(exit_code(&quiet_miss), 1, "quiet fd no-match should fail");
		assert_eq!(read("quiet-miss.txt"), "");

		let quiet_hit = session
			.shell
			.run_string("fd -q needle > quiet-hit.txt", &si, &params)
			.await
			.expect("fd quiet hit");
		assert_eq!(exit_code(&quiet_hit), 0, "quiet fd match should succeed");
		assert_eq!(read("quiet-hit.txt"), "");

		let help = session
			.shell
			.run_string("fd --help > help.txt 2> help.err", &si, &params)
			.await
			.expect("fd help");
		assert_eq!(exit_code(&help), 0, "fd help should succeed");
		assert!(read("help.txt").contains("A program to find entries in your filesystem"));
		assert_eq!(read("help.err"), "");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// Plain `rg PATTERN` uses the shell working directory when the host wired
	/// stdin to null, but a real pipeline remains stdin input. Pattern stdin
	/// (`-f -`) must not consume the implicit search path decision.
	#[tokio::test(flavor = "multi_thread")]
	async fn rg_builtin_defaults_to_cwd_unless_stdin_is_pipeline() {
		let tmp = std::env::temp_dir().join(format!("pi-rg-stdin-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		std::fs::write(tmp.join("data.txt"), "from-cwd\nfrom-pattern\n").expect("data");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");
		let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

		session
			.shell
			.run_string("rg from-cwd > cwd.txt", &si, &params)
			.await
			.expect("rg cwd");
		assert_eq!(read("cwd.txt"), "data.txt:from-cwd\n");

		session
			.shell
			.run_string("printf 'from-pipe\\n' | rg from-pipe > pipe.txt", &si, &params)
			.await
			.expect("rg pipe");
		assert_eq!(read("pipe.txt"), "from-pipe\n");

		session
			.shell
			.run_string("printf 'from-pattern\\n' | rg -f - > pattern.txt", &si, &params)
			.await
			.expect("rg pattern stdin");
		assert_eq!(read("pattern.txt"), "data.txt:from-pattern\n");

		session
			.shell
			.run_string("printf 'not-a-path\\n' | rg --files > files.txt", &si, &params)
			.await
			.expect("rg files");
		let files = read("files.txt");
		assert!(files.contains("data.txt"), "--files should list cwd files: {files:?}");
		assert!(!files.contains("not-a-path"), "--files must not read piped stdin: {files:?}");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// `grep -q` must suppress all stdout and drive the exit status (0 on match,
	/// 1 otherwise) so shell conditionals work; `-x` must anchor whole lines.
	/// Mirrors busybox applet probing: `grep -qx "$applet" <(strings bin)`.
	#[tokio::test(flavor = "multi_thread")]
	async fn grep_quiet_and_line_regexp() {
		let tmp = std::env::temp_dir().join(format!("pi-grepq-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		std::fs::write(tmp.join("data.txt"), "foo\nbar\nbaz\n").expect("data");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");
		let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

		// -q: no stdout even on a match.
		session
			.shell
			.run_string("grep -q ba data.txt > qout.txt", &si, &params)
			.await
			.expect("grep -q");
		assert_eq!(read("qout.txt"), "", "-q must not print matches");
		// -q exit code drives `&&` (match) and `||` (no match).
		session
			.shell
			.run_string("grep -q ba data.txt && echo HIT > hit.txt", &si, &params)
			.await
			.expect("grep -q hit");
		assert_eq!(read("hit.txt"), "HIT\n", "-q match must exit 0");
		session
			.shell
			.run_string("grep -q zzz data.txt || echo MISS > miss.txt", &si, &params)
			.await
			.expect("grep -q miss");
		assert_eq!(read("miss.txt"), "MISS\n", "-q no-match must exit 1");
		// -qx: whole-line match succeeds on an exact line ...
		session
			.shell
			.run_string("grep -qx bar data.txt && echo XHIT > xhit.txt", &si, &params)
			.await
			.expect("grep -qx hit");
		assert_eq!(read("xhit.txt"), "XHIT\n", "-x must match a whole line");
		// ... and fails on a substring that is not a whole line.
		session
			.shell
			.run_string("grep -qx ba data.txt || echo XMISS > xmiss.txt", &si, &params)
			.await
			.expect("grep -qx miss");
		assert_eq!(read("xmiss.txt"), "XMISS\n", "-x must reject a partial-line match");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// The destructive uutils builtins (`rm`, `mv`) must operate on paths
	/// resolved against the shell working directory, not the host process cwd.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_rm_and_mv_operate_on_shell_cwd() {
		let tmp = std::env::temp_dir().join(format!("pi-rmmv-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(tmp.join("tree/inner")).expect("tree");
		std::fs::write(tmp.join("a.txt"), "hello").expect("a");
		std::fs::write(tmp.join("tree/inner/leaf.txt"), "x").expect("leaf");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");

		// mv: rename within the shell cwd.
		let mv = session
			.shell
			.run_string("mv a.txt b.txt", &si, &params)
			.await
			.expect("mv");
		assert_eq!(exit_code(&mv), 0, "mv should succeed");
		assert!(!tmp.join("a.txt").exists(), "source should be gone");
		assert_eq!(std::fs::read_to_string(tmp.join("b.txt")).unwrap(), "hello");

		// rm -rf: recursive removal resolved against the shell cwd.
		let rm = session
			.shell
			.run_string("rm -rf tree", &si, &params)
			.await
			.expect("rm");
		assert_eq!(exit_code(&rm), 0, "rm -rf should succeed");
		assert!(!tmp.join("tree").exists(), "tree should be removed");
		// and the host process cwd must be untouched.
		assert!(tmp.join("b.txt").exists());

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// Removing a nonexistent file must print exactly one diagnostic (like GNU
	/// rm) and exit non-zero — not a second, message-less `rm:` line. Regression
	/// guard: the in-process entry point used to re-print the status-only
	/// `Err(1)` returned after `remove()` had already reported each failure.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_rm_missing_file_prints_single_diagnostic() {
		let tmp = std::env::temp_dir().join(format!("pi-rm-missing-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");

		let rm = session
			.shell
			.run_string("rm nonexistent.txt 2> err.txt", &si, &params)
			.await
			.expect("rm");
		assert_ne!(exit_code(&rm), 0, "rm of a missing file must report failure");
		let err = std::fs::read_to_string(tmp.join("err.txt")).expect("err.txt");
		let lines: Vec<&str> = err.lines().collect();
		assert_eq!(lines.len(), 1, "rm should emit exactly one diagnostic line, got: {err:?}");
		assert!(lines[0].contains("nonexistent.txt"), "diagnostic should name the file: {err:?}");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// The find display/match surface must use the operand-relative path while
	/// filesystem actions still target the real (resolved) path: `-path` and
	/// `-printf %p` see `./...`, while `-delete` removes the correct file.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_find_display_and_actions_split_paths() {
		let tmp = std::env::temp_dir().join(format!("pi-find-split-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(tmp.join("sub")).expect("dirs");
		std::fs::write(tmp.join("keep.log"), "k").expect("keep");
		std::fs::write(tmp.join("sub/drop.tmp"), "d").expect("drop");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");
		let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

		// -path matches against the operand-relative path.
		session
			.shell
			.run_string("find . -path './sub/*' > p.txt", &si, &params)
			.await
			.expect("path");
		assert_eq!(read("p.txt"), "./sub/drop.tmp\n", "-path should match the operand-relative path");

		// -printf %p emits the operand-relative path.
		session
			.shell
			.run_string("find . -name keep.log -printf '%p\\n' > pf.txt", &si, &params)
			.await
			.expect("printf");
		assert_eq!(read("pf.txt"), "./keep.log\n", "-printf %p should be operand-relative");

		// -delete operates on the real (resolved) path, removing the right file.
		let del = session
			.shell
			.run_string("find . -name '*.tmp' -delete", &si, &params)
			.await
			.expect("delete");
		assert_eq!(exit_code(&del), 0, "find -delete should succeed");
		assert!(!tmp.join("sub/drop.tmp").exists(), "-delete should remove the matched file");
		assert!(tmp.join("keep.log").exists(), "-delete must not touch unmatched files");

		// -exec substitutes the operand-relative path and runs in the shell cwd,
		// so the relative `{}` resolves and the child's redirect lands in the cwd.
		session
			.shell
			.run_string(
				"find . -name keep.log -exec sh -c 'printf %s \"$1\" > ex.txt' sh {} ';'",
				&si,
				&params,
			)
			.await
			.expect("exec");
		assert_eq!(
			read("ex.txt"),
			"./keep.log",
			"-exec {{}} should be operand-relative and run in the shell cwd"
		);

		// -exec children must write through the scope streams — an inherited
		// process stdout would bypass the shell redirect and spam the host
		// TUI's terminal — and must see the shell's exported environment.
		session
			.shell
			.run_string(
				"export PI_EXEC_ENV=zed; find . -name keep.log -exec sh -c 'echo \"$PI_EXEC_ENV $1\"' \
				 sh {} ';' > cap.txt",
				&si,
				&params,
			)
			.await
			.expect("exec capture");
		assert_eq!(
			read("cap.txt"),
			"zed ./keep.log\n",
			"-exec child stdout must flow through the shell redirect with the shell's exported env"
		);

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// The vendored `sed` builtin must stream pipeline stdin through scripts and
	/// perform `-i` in-place edits (with backup suffix) against the shell
	/// working directory rather than the host process cwd.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_sed_substitutes_streams_and_edits_in_place() {
		let tmp = std::env::temp_dir().join(format!("pi-sed-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		std::fs::write(tmp.join("conf.txt"), "x=1\n").expect("conf");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");
		let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

		// Piped stdin through a quiet substitute-and-print script.
		session
			.shell
			.run_string("printf 'hello\\nworld\\n' | sed -n 's/hello/HI/p' > sed.txt", &si, &params)
			.await
			.expect("sed pipeline");
		assert_eq!(read("sed.txt"), "HI\n");
		// In-place edit of a cwd-relative operand, keeping the requested backup.
		session
			.shell
			.run_string("sed -i.bak 's/1/2/' conf.txt", &si, &params)
			.await
			.expect("sed -i");
		assert_eq!(read("conf.txt"), "x=2\n", "in-place edit must land in the shell cwd");
		assert_eq!(read("conf.txt.bak"), "x=1\n", "backup must keep the original");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// The `xargs` builtin spawns real child processes, but their stdout must
	/// flow back into the shell pipeline (ctx streams, not the host fds), items
	/// must batch per `-n`, and a failing invocation must surface GNU's 123.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_xargs_children_feed_pipeline_and_report_failure() {
		let tmp = std::env::temp_dir().join(format!("pi-xargs-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");
		let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

		// Default echo action: child stdout is captured into the redirect.
		session
			.shell
			.run_string("printf 'a b c\\n' | xargs > xargs.txt", &si, &params)
			.await
			.expect("xargs default");
		assert_eq!(read("xargs.txt"), "a b c\n");
		// -n batching, with child output feeding a downstream builtin stage.
		session
			.shell
			.run_string(
				"printf '1\\n2\\n3\\n4\\n' | xargs -n2 echo | wc -l > batches.txt",
				&si,
				&params,
			)
			.await
			.expect("xargs -n2");
		assert_eq!(read("batches.txt").trim(), "2");
		// A child exiting 1-125 makes xargs exit 123 (GNU contract).
		session
			.shell
			.run_string("printf 'x\\n' | xargs false; printf %s $? > code.txt", &si, &params)
			.await
			.expect("xargs false");
		assert_eq!(read("code.txt"), "123");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// The `jq` builtin must evaluate filters over piped JSON, resolve file
	/// operands against the shell working directory, and propagate `-e`'s
	/// null/false exit status through the shell.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_jq_filters_json_and_propagates_exit_status() {
		let tmp = std::env::temp_dir().join(format!("pi-jq-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		std::fs::write(tmp.join("in.json"), "{\"name\":\"pi\"}\n").expect("in.json");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");
		let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

		// Compact filter over piped stdin.
		session
			.shell
			.run_string("printf '{\"a\":{\"b\":2}}' | jq -c .a > jq.txt", &si, &params)
			.await
			.expect("jq pipeline");
		assert_eq!(read("jq.txt"), "{\"b\":2}\n");
		// Raw output from a cwd-relative file operand.
		session
			.shell
			.run_string("jq -r .name in.json > name.txt", &si, &params)
			.await
			.expect("jq file");
		assert_eq!(read("name.txt"), "pi\n");
		// -e maps a null result to exit status 1.
		session
			.shell
			.run_string("printf 'null' | jq -e . > /dev/null; printf %s $? > code.txt", &si, &params)
			.await
			.expect("jq -e");
		assert_eq!(read("code.txt"), "1");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// A stdin-reading builtin blocked on an open pipe must honor abort/timeout:
	/// the context's cancel flag makes the read return EOF so the utility
	/// unwinds promptly and the command reports interrupted (130) — it must not
	/// hang or leak a detached thread that keeps the fds alive.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_head_stdin_read_is_cancellable() {
		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");

		// Hold the pipe's write end open with no data so `head` blocks reading.
		let (reader, _writer) = pipe_to_files("cancel").expect("pipe");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, OpenFile::from(reader));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let token = CancellationToken::new();
		params.set_cancel_token(token.clone());
		let si = SourceInfo::from("pi-natives:test");

		let canceller = tokio::spawn(async move {
			time::sleep(Duration::from_millis(150)).await;
			token.cancel();
		});
		let result = time::timeout(
			Duration::from_secs(5),
			session.shell.run_string("head -n 1000000", &si, &params),
		)
		.await;
		let _ = canceller.await;

		let exec = result
			.expect("head must return promptly after cancel, not hang on the open pipe")
			.expect("run_string");
		// Core contract: prompt return (the 5s timeout did NOT fire) proves the
		// read unblocked and the blocking task unwound cleanly — no hang, no
		// detached thread. The interrupted command reports a non-zero status;
		// `run_uutil` yields 130 but brush's run_string maps the cancelled
		// program to its own non-zero code, so we assert the stable contract.
		assert_ne!(
			exit_code(&exec),
			0,
			"cancelled stdin read should report a non-zero (interrupted) status"
		);
	}

	/// The disable env vars must actually gate registration: the global switch
	/// drops the whole set, and the per-utility destructive switches drop only
	/// the risky shadows.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_builtins_respect_disable_env() {
		let session_with = |pairs: &[(&str, &str)]| {
			let map: std::collections::HashMap<String, String> = pairs
				.iter()
				.map(|(k, v)| ((*k).to_string(), (*v).to_string()))
				.collect();
			ShellConfig { session_env: Some(map), snapshot_path: None, minimizer: None }
		};

		let mut default = create_session(&ShellConfig {
			session_env:   None,
			snapshot_path: None,
			minimizer:     None,
		})
		.await
		.expect("create_session");
		assert!(default.shell.builtin_mut("head").is_some(), "head registered by default");
		assert!(default.shell.builtin_mut("rg").is_some(), "rg registered by default");
		assert!(default.shell.builtin_mut("rm").is_some(), "rm registered by default");
		assert!(default.shell.builtin_mut("mv").is_some(), "mv registered by default");

		let mut all_off = create_session(&session_with(&[("PI_DISABLE_UUTILS_BUILTINS", "1")]))
			.await
			.expect("create_session");
		assert!(all_off.shell.builtin_mut("head").is_none(), "kill-switch drops head");
		assert!(all_off.shell.builtin_mut("rg").is_none(), "kill-switch drops rg");
		assert!(all_off.shell.builtin_mut("rm").is_none(), "kill-switch drops rm");

		let mut rm_off = create_session(&session_with(&[("PI_DISABLE_RM_BUILTIN", "1")]))
			.await
			.expect("create_session");
		assert!(rm_off.shell.builtin_mut("rm").is_none(), "rm disabled individually");
		assert!(rm_off.shell.builtin_mut("mv").is_some(), "mv stays enabled");
		assert!(rm_off.shell.builtin_mut("head").is_some(), "head stays enabled");
	}

	/// Truth-table coverage for `brush_core::commands::child_session_action`.
	///
	/// Lives in `pi-natives` because the brush-core crate is excluded from the
	/// workspace (vendored upstream) and cannot be tested standalone — its tokio
	/// dependency only resolves the `net` feature via feature-unification with
	/// other workspace members.
	mod child_session_action {
		use brush_core::commands::{ChildSessionAction, child_session_action};

		/// Interactive brush, leading its own pgroup, terminal stdin: foreground.
		#[test]
		fn interactive_with_terminal_stdin_takes_foreground() {
			assert_eq!(child_session_action(true, true, false), ChildSessionAction::TakeForeground,);
			// Terminal foregrounding wins even when this is the first stage of a
			// pipeline; no detach is attempted.
			assert_eq!(child_session_action(true, true, true), ChildSessionAction::TakeForeground,);
		}

		/// Brush leading a new pgroup with non-terminal stdin always detaches —
		/// including the first stage of a pipeline. `setsid()` keeps the child
		/// off the host's controlling tty; the spawn path skips
		/// `process_group(...)` for detached children, so later stages no longer
		/// try to `setpgid`-join a leader that has moved sessions (the historical
		/// EPERM hazard).
		#[test]
		fn non_terminal_stdin_detaches_regardless_of_pipeline() {
			assert_eq!(child_session_action(true, false, false), ChildSessionAction::DetachSession,);
			assert_eq!(child_session_action(true, false, true), ChildSessionAction::DetachSession,);
		}

		/// Non-interactive brush, terminal stdin, no pipeline: nothing to do.
		#[test]
		fn non_interactive_with_terminal_stdin_does_nothing() {
			assert_eq!(child_session_action(false, true, false), ChildSessionAction::None,);
		}

		/// Non-interactive brush, terminal stdin, joining a pipeline pgroup:
		/// nothing to do (parent already wired pgroup membership).
		#[test]
		fn non_interactive_terminal_stdin_in_pipeline_does_nothing() {
			assert_eq!(child_session_action(false, true, true), ChildSessionAction::None,);
		}

		/// **Embedded host bug fix.** Non-interactive brush, non-terminal stdin,
		/// no pipeline pgroup: detach so the child cannot SIGTTIN/SIGTTOU the
		/// host. This is the case that regressed before this fix and is the
		/// motivating bug for PR #895.
		#[test]
		fn embedded_host_with_non_terminal_stdin_detaches() {
			assert_eq!(child_session_action(false, false, false), ChildSessionAction::DetachSession,);
		}

		/// **Pipeline tty-safety.** Non-interactive brush, non-terminal stdin
		/// (pipe), and a multi-command pipeline: detach. An interactive child in
		/// a pipeline (`zsh -i ... | awk`) would otherwise open `/dev/tty`,
		/// `tcsetpgrp` itself to the foreground, and leave the host stopped on
		/// its next tty read (`suspended (tty input)`). Each stage gets its own
		/// session instead; the embedded host cancels via the descendant tree,
		/// not a shared pgroup, and pipes are session-independent.
		#[test]
		fn pipeline_stage_with_non_terminal_stdin_detaches() {
			assert_eq!(child_session_action(false, false, true), ChildSessionAction::DetachSession,);
		}
	}

	#[cfg(unix)]
	fn shell_test_lock() -> &'static TokioMutex<()> {
		static LOCK: std::sync::OnceLock<TokioMutex<()>> = std::sync::OnceLock::new();
		LOCK.get_or_init(|| TokioMutex::new(()))
	}

	#[cfg(unix)]
	async fn run_command_capture(
		command: &str,
		cwd: Option<&std::path::Path>,
		minimizer: Option<minimizer::MinimizerOptions>,
		cancel_token: CancelToken,
	) -> (ShellExecuteResult, String) {
		let _guard = shell_test_lock().lock().await;
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

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_diff_reads_process_substitution_fds() {
		let (result, output) = time::timeout(
			Duration::from_secs(5),
			run_command_capture("diff <(echo a) <(echo b)", None, None, CancelToken::default()),
		)
		.await
		.expect("process substitution should not hang");

		assert_eq!(result.exit_code, Some(1));
		assert!(output.contains("< a\n---\n> b\n"), "diff output missing changed lines: {output:?}");
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

	#[tokio::test(flavor = "multi_thread")]
	async fn one_shot_completion_aborts_internal_background_jobs() {
		let marker = tempfile::NamedTempFile::new().expect("marker file");
		let marker_path = marker.path().to_string_lossy();
		std::fs::remove_file(marker.path()).expect("remove initial marker");
		let command = format!("{{ sleep 1; echo leaked > {}; }} &", quote_arg(&marker_path));

		execute_shell(
			ShellExecuteOptions { command, ..Default::default() },
			None,
			CancelToken::default(),
		)
		.await
		.expect("one-shot shell execution");
		// `execute_shell` returns after its short post-exit idle drain (~250ms),
		// while the background job cannot write the marker until its 1s sleep
		// elapses. Wait well past that delay so a job that outlived the dropped
		// session has demonstrably had its chance to run — the pre-fix leak fires
		// at ~1s and is caught here; the fixed path aborts the task on drop and the
		// marker never appears.
		time::sleep(Duration::from_millis(2000)).await;

		assert!(
			!marker.path().exists(),
			"an internal background job outlived its one-shot shell session"
		);
	}

	/// `live_background_job_count` reports 0 when the session has no live
	/// external background jobs and 1 while one is running. The host relies on
	/// this to retain a per-call shell whose `&`/`nohup` child is still alive
	/// instead of dropping it (which would SIGKILL the child via kill-on-drop).
	/// `sh -c` forces an external process because the bare `sleep` builtin runs
	/// in-process and is intentionally not counted.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn live_background_job_count_tracks_external_background_jobs() {
		let _guard = shell_test_lock().lock().await;
		let shell = Shell::new(None);

		// No session core materialized yet.
		assert_eq!(shell.live_background_job_count().await, 0);

		// A foreground-only command leaves nothing in the background.
		shell
			.run(
				ShellRunOptions { command: "true".into(), ..Default::default() },
				None,
				CancelToken::default(),
			)
			.await
			.expect("run true");
		assert_eq!(shell.live_background_job_count().await, 0);

		// An external background process is tracked while it runs.
		shell
			.run(
				ShellRunOptions { command: "sh -c 'sleep 30' &".into(), ..Default::default() },
				None,
				CancelToken::default(),
			)
			.await
			.expect("run sleep");
		assert_eq!(shell.live_background_job_count().await, 1);

		// Dropping the shell at scope end reaps the child via kill-on-drop.
		shell.abort().await;
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn segmented_false_and_printf_skips_second_and_returns_nonzero() {
		let root = unique_temp_dir("false-and");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
		let (result, output) = run_command_capture(
			"false && printf skipped",
			None,
			Some(minimizer),
			CancelToken::default(),
		)
		.await;
		let _ = std::fs::remove_dir_all(&root);
		assert_eq!(result.exit_code, Some(1));
		assert!(!result.cancelled);
		assert!(!result.timed_out);
		assert_eq!(output, "");
		// `false && printf` short-circuits: nothing is rewritten, so a no-op chain
		// must surface no minimizer telemetry (None).
		assert!(result.minimized.is_none(), "chain noop must not surface telemetry");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn segmented_false_semicolon_printf_continues_and_returns_last_code() {
		let root = unique_temp_dir("false-semi");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
		let expected = "hello\n".repeat(200);
		let command = format!("false ; printf '{}'", "hello\\n".repeat(200));
		let (result, output) =
			run_command_capture(&command, None, Some(minimizer), CancelToken::default()).await;
		let _ = std::fs::remove_dir_all(&root);
		let minimized = result.minimized.expect("long output should be minimized");
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output, expected);
		assert_eq!(minimized.filter, "chain");
		assert_eq!(minimized.original_text, expected);
		assert_eq!(minimized.text, "HI\n".repeat(200));
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn segmented_cd_tmp_and_pwd_persists_state_across_segments() {
		let root = unique_temp_dir("cwd");
		let tmp_dir = root.join("tmp");
		std::fs::create_dir_all(&tmp_dir).expect("create nested tmp dir");
		let settings_path = root.join("minimizer.toml");
		std::fs::write(
			&settings_path,
			r#"
schema_version = 1

[filters.pwd]
match_command = "^pwd$"
replace = [{ pattern = "^.+$", replacement = "PWD" }]
"#,
		)
		.expect("write settings");
		let minimizer = minimizer::MinimizerOptions {
			enabled: Some(true),
			settings_path: Some(settings_path.to_string_lossy().into_owned()),
			..Default::default()
		};

		let expected = format!("{}\n", tmp_dir.display());
		let (result, output) =
			run_command_capture("cd tmp && pwd", Some(&root), Some(minimizer), CancelToken::default())
				.await;
		let _ = std::fs::remove_dir_all(&root);
		assert!(result.minimized.is_none(), "short pwd output must not be minimized");
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output, expected);
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn whole_command_exceeding_capture_cap_streams_raw_without_minimized() {
		let root = unique_temp_dir("whole-cap");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), Some(1024));
		let (result, output) =
			run_command_capture("printf '%1200s' x", None, Some(minimizer), CancelToken::default())
				.await;
		let _ = std::fs::remove_dir_all(&root);
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output.len(), 1200);
		assert!(output.ends_with('x'));
		// Output exceeded the capture cap: streamed raw and never buffered, so
		// nothing was minimized. `minimized` must be absent (not a `too-large`
		// result with empty `text`, which would mislead presence-keyed consumers).
		assert!(result.minimized.is_none());
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn segmented_printf_chain_preserves_raw_original_text() {
		let root = unique_temp_dir("minimizer");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
		let hello = "hello\n".repeat(200);
		let world = "world\n".repeat(200);
		let command =
			format!("printf '{}' ; printf '{}'", "hello\\n".repeat(200), "world\\n".repeat(200));
		let (result, output) =
			run_command_capture(&command, None, Some(minimizer), CancelToken::default()).await;
		let _ = std::fs::remove_dir_all(&root);
		let minimized = result.minimized.expect("long output should be minimized");
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output, format!("{hello}{world}"));
		assert_eq!(minimized.filter, "chain");
		assert_eq!(minimized.original_text, format!("{hello}{world}"));
		assert_eq!(minimized.text, format!("{}{}", "HI\n".repeat(200), world));
		assert_eq!(minimized.input_bytes, (hello.len() + world.len()) as u32);
		assert_eq!(minimized.output_bytes, ("HI\n".repeat(200).len() + world.len()) as u32);
	}

	/// Regression: a quoted here-doc followed by another command must execute
	/// instead of failing with "unterminated here document". The minimizer's
	/// segmented runner used to rebuild each segment via the brush AST Display
	/// impl, which re-emitted the `<<'PY'` close tag as the quoted `'PY'` — an
	/// invalid delimiter that left the body unterminated. Here-doc-bearing
	/// commands now bail out of segmentation and run whole via the single path.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn quoted_heredoc_in_chain_runs_via_single_path() {
		let root = unique_temp_dir("heredoc-chain");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
		let (result, output) = run_command_capture(
			"cat <<'PY'\nhello $USER\nPY\nprintf 'after\\n'",
			None,
			Some(minimizer),
			CancelToken::default(),
		)
		.await;
		let _ = std::fs::remove_dir_all(&root);
		assert_eq!(result.exit_code, Some(0));
		// Quoted delimiter keeps the body literal ($USER unexpanded) and the
		// trailing command still runs in order.
		assert_eq!(output, "hello $USER\nafter\n");
		assert!(!output.contains("unterminated"));
	}

	/// Regression: a `&&` / `;` chain whose later pipeline stage is a compound
	/// command (`while … done`) must execute instead of failing with
	/// "pi-natives:command: syntax error at end of input". The segmented chain
	/// runner rebuilt each segment via the brush AST `Display` impl, but only
	/// validated the *first* pipeline stage — so a compound later stage was
	/// reconstructed without its terminator and re-run as invalid shell. Such a
	/// command now bails out of segmentation and runs whole via the single path.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn compound_stage_in_chain_runs_via_single_path() {
		let root = unique_temp_dir("compound-chain");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
		let (result, output) = run_command_capture(
			"printf 'start\\n' && seq 5 | while read n; do echo \"n=$n\"; done | head -2",
			None,
			Some(minimizer),
			CancelToken::default(),
		)
		.await;
		let _ = std::fs::remove_dir_all(&root);
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output, "start\nn=1\nn=2\n");
		assert!(!output.contains("syntax error"));
		// Ran whole (unsegmented), so nothing was minimized.
		assert!(result.minimized.is_none());
	}

	/// A segment that carries a file redirect is still segmented, and the brush
	/// `Display` reconstruction the runner executes must round-trip through
	/// brush's own parser **without losing the redirect**.
	/// `echo hidden >/dev/null` suppresses its own stdout: if the reconstruction
	/// dropped the redirect, `hidden` would leak into the captured output.
	/// Proves the reconstruction path is semantically sound for the
	/// redirect-bearing shapes the per-stage whitelist accepts (not just
	/// syntactically parseable).
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn segmented_chain_with_redirect_executes_correctly() {
		let root = unique_temp_dir("redirect-chain");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
		let expected = "hello\n".repeat(200);
		let command = format!("echo hidden >/dev/null && printf '{}'", "hello\\n".repeat(200));
		let (result, output) =
			run_command_capture(&command, None, Some(minimizer), CancelToken::default()).await;
		let _ = std::fs::remove_dir_all(&root);
		assert_eq!(result.exit_code, Some(0));
		// The redirect survived reconstruction: segment 1's stdout went to
		// /dev/null, so only segment 2's output is captured.
		assert!(!output.contains("hidden"), "redirect must suppress segment-1 stdout");
		assert_eq!(output, expected);
		let minimized = result.minimized.expect("long output should be minimized");
		assert_eq!(minimized.original_text, expected);
		assert_eq!(minimized.text, "HI\n".repeat(200));
		assert!(!output.contains("syntax error"));
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn segmented_chain_exceeding_aggregate_capture_cap_stays_raw() {
		let root = unique_temp_dir("aggregate-cap");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), Some(1024));
		let (result, output) = run_command_capture(
			"printf '%600s' x ; printf '%600s' y",
			None,
			Some(minimizer),
			CancelToken::default(),
		)
		.await;
		let _ = std::fs::remove_dir_all(&root);
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output.len(), 1200);
		assert!(output.ends_with('y'));
		// Aggregate cap exceeded: the chain streamed its output raw and was not
		// minimized, so `minimized` is absent (not an empty-text `too-large`).
		assert!(result.minimized.is_none());
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn segmented_timeout_in_first_segment_prevents_later_segments() {
		let root = unique_temp_dir("timeout");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
		let (result, output) = run_command_capture(
			"sleep 1 && printf later",
			None,
			Some(minimizer),
			CancelToken::new(Some(10)),
		)
		.await;
		let _ = std::fs::remove_dir_all(&root);
		assert!(result.exit_code.is_none());
		assert!(!result.cancelled);
		assert!(result.timed_out);
		assert!(result.minimized.is_none());
		assert!(!output.contains("later"));
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn segmented_cancel_in_first_segment_prevents_later_segments() {
		let root = unique_temp_dir("cancel");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
		let mut cancel_token = CancelToken::default();
		let abort_token = cancel_token.emplace_abort_token();
		let cancel_task = tokio::spawn(async move {
			time::sleep(Duration::from_millis(10)).await;
			abort_token.abort(AbortReason::Signal);
		});
		let (result, output) =
			run_command_capture("sleep 1 && printf later", None, Some(minimizer), cancel_token).await;
		let _ = cancel_task.await;
		let _ = std::fs::remove_dir_all(&root);
		assert!(result.exit_code.is_none());
		assert!(result.cancelled);
		assert!(!result.timed_out);
		assert!(result.minimized.is_none());
		assert!(!output.contains("later"));
	}
	/// End-to-end verification that brush, when embedded as a non-interactive
	/// library (`interactive: false`, exactly what `create_session` produces),
	/// spawns external commands in a **separate session** from the host.
	///
	/// The truth-table tests in `child_session_action` cover the decision in
	/// isolation. This test covers the wiring: it boots a real `BrushShell`,
	/// runs a child that prints its PID then sleeps, and asks the kernel for
	/// that PID's session via `getsid(2)` while the child is still alive.
	/// Pre-fix (`new_pg=false` skipped `detach_session`), the child inherited
	/// the host's session, so `getsid(child_pid) == getsid(0)`. Post-fix,
	/// `setsid` ran and the child is its own session leader
	/// (`getsid(child_pid) == child_pid`).
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn embedded_external_command_runs_in_its_own_session() {
		use std::io::Read as _;

		// SAFETY: `getsid(0)` only queries the current process session; the return
		// value is checked. Inside a PID namespace (the containerized CI runner)
		// the host's session leader can live outside the namespace, so `getsid(0)`
		// legitimately reports 0 — only -1 is a real failure. The child-session
		// invariants below (own session, distinct from host) stay meaningful.
		let host_sid = unsafe { libc::getsid(0) };
		assert!(host_sid >= 0, "getsid(0) failed: {}", std::io::Error::last_os_error());

		// Build the same kind of session pi-natives uses in production.
		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");

		// Output pipe shared between the brush child and a concurrent reader. The
		// reader runs on a blocking thread because `os_pipe` reads are blocking.
		let (mut reader, writer) = pipe_to_files("e2e").expect("pipe");
		let stdout_file = OpenFile::from(writer.try_clone().expect("clone"));
		let stderr_file = OpenFile::from(writer);

		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null stdin"));
		params.set_fd(OpenFiles::STDOUT_FD, stdout_file);
		params.set_fd(OpenFiles::STDERR_FD, stderr_file);

		// (pid_tx, pid_rx) — reader task signals the test as soon as it has the PID.
		let (pid_tx, pid_rx) = tokio::sync::oneshot::channel::<i32>();
		let reader_handle = tokio::task::spawn_blocking(move || {
			let mut buf = Vec::new();
			// Read just enough to capture the PID line. The child sleeps after
			// printing so the pipe will not back-pressure.
			let mut chunk = [0u8; 64];
			let mut pid_tx = Some(pid_tx);
			while let Ok(n) = reader.read(&mut chunk)
				&& n > 0
			{
				buf.extend_from_slice(&chunk[..n]);
				if pid_tx.is_some()
					&& let Some(line_end) = buf.iter().position(|&byte| byte == b'\n')
					&& let Ok(line) = std::str::from_utf8(&buf[..line_end])
					&& let Ok(pid) = line.trim().parse::<i32>()
				{
					let _ = pid_tx
						.take()
						.expect("pid sender should be present")
						.send(pid);
				}
			}
			buf
		});

		// Run brush in the background so we can call `getsid(child_pid)` while
		// the child is still alive.
		let shell_handle = tokio::spawn(async move {
			let source_info = SourceInfo::from("pi-natives:test");
			// `printf '%d\n' "$$"` then `sleep 0.5`. Long enough for our `getsid`.
			let exec = session
				.shell
				.run_string("sh -c 'printf \"%d\\n\" \"$$\"; sleep 0.5'", &source_info, &params)
				.await
				.expect("run_string");
			drop(params);
			(session, exec)
		});

		let child_pid = time::timeout(Duration::from_secs(5), pid_rx)
			.await
			.expect("timed out waiting for child PID")
			.expect("reader closed pid channel without sending");
		assert!(child_pid > 0, "got non-positive child pid: {child_pid}");

		// Snapshot the child's session ID immediately, while the child is still
		// in `sleep`. POSIX guarantees `getsid` against a live PID returns the
		// session of that process.
		// SAFETY: `child_pid` is a positive PID from the child; errors are reported via
		// the checked return value.
		let child_sid = unsafe { libc::getsid(child_pid) };
		assert!(
			child_sid > 0,
			"getsid({child_pid}) failed: {} (child may have already exited)",
			std::io::Error::last_os_error(),
		);

		// Drain the brush task and the pipe reader.
		let (_session, exec) = time::timeout(Duration::from_secs(5), shell_handle)
			.await
			.expect("shell timed out")
			.expect("shell task panicked");
		assert!(
			matches!(exec.exit_code, ExecutionExitCode::Success),
			"unexpected exit: {}",
			exit_code(&exec),
		);
		let _ = time::timeout(Duration::from_secs(2), reader_handle).await;

		assert_ne!(
			child_sid, host_sid,
			"child PID {child_pid} inherited host session {host_sid}; setsid() did not run — the \
			 embedded-host bug is back",
		);
		assert_eq!(
			child_sid, child_pid,
			"child PID {child_pid} should be its own session leader after setsid",
		);
	}

	/// Cancelling one `Shell::run` must only signal processes spawned by that
	/// run. Run B starts first so its old host-descendant baseline would not
	/// include run A's later-spawned child; pre-fix, cancelling B classified A's
	/// child as "new" and SIGTERM'd it, so run A returned 143 instead of 0.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn cancelling_one_run_spares_a_concurrent_runs_child() {
		let _guard = shell_test_lock().lock().await;

		let shell_b = Shell::new(None);
		let (tx_b, rx_b) = flume::unbounded::<String>();
		let mut ct_b = CancelToken::default();
		let abort_b = ct_b.emplace_abort_token();
		let handle_b = tokio::spawn(async move {
			shell_b
				.run(
					ShellRunOptions {
						command: "sh -c 'printf \"ready\\n\"; sleep 30'".into(),
						..Default::default()
					},
					Some(tx_b),
					ct_b,
				)
				.await
		});

		let mut b_output = String::new();
		let b_ready = time::timeout(Duration::from_secs(5), async {
			loop {
				let chunk = rx_b
					.recv_async()
					.await
					.expect("run B ended before printing readiness");
				b_output.push_str(&chunk);
				if let Some(line_end) = b_output.find('\n') {
					return b_output[..line_end].to_string();
				}
			}
		})
		.await
		.expect("timed out waiting for run B readiness");
		assert_eq!(b_ready.trim(), "ready", "run B should reach its long sleep before run A starts");

		let shell_a = Shell::new(None);
		let (tx_a, rx_a) = flume::unbounded::<String>();
		let handle_a = tokio::spawn(async move {
			shell_a
				.run(
					ShellRunOptions {
						command: "sh -c 'printf \"%d\\n\" \"$$\"; sleep 2'".into(),
						..Default::default()
					},
					Some(tx_a),
					CancelToken::default(),
				)
				.await
		});

		let mut a_output = String::new();
		let a_child_pid = time::timeout(Duration::from_secs(5), async {
			loop {
				let chunk = rx_a
					.recv_async()
					.await
					.expect("run A ended before printing its child pid");
				a_output.push_str(&chunk);
				if let Some(line_end) = a_output.find('\n') {
					return a_output[..line_end]
						.trim()
						.parse::<i32>()
						.expect("run A pid line should be an integer");
				}
			}
		})
		.await
		.expect("timed out waiting for run A child pid");
		assert!(a_child_pid > 0, "got non-positive run A child pid: {a_child_pid}");

		abort_b.abort(AbortReason::Signal);

		let result_a = time::timeout(Duration::from_secs(10), handle_a)
			.await
			.expect("run A timed out")
			.expect("run A task panicked")
			.expect("run A failed");
		let result_b = time::timeout(Duration::from_secs(10), handle_b)
			.await
			.expect("run B timed out")
			.expect("run B task panicked")
			.expect("run B failed");

		assert_eq!(result_a.exit_code, Some(0), "cancelling run B must not SIGTERM run A's child");
		assert!(!result_a.cancelled, "run A was never cancelled");
		assert!(result_b.cancelled, "run B should report cancellation");
	}

	/// Cancelling while `Shell::run` is still sourcing a snapshot must terminate
	/// the foreground process spawned by that snapshot. The snapshot runs before
	/// the user command, so this specifically guards the shared cancel token and
	/// spawn registry wiring passed into `source_snapshot`.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn cancelling_while_sourcing_snapshot_kills_snapshot_foreground_child() {
		let _guard = shell_test_lock().lock().await;
		let root = unique_temp_dir("snapshot-cancel");
		let snapshot_path = root.join("snapshot.sh");
		let pid_path = root.join("snapshot-child.pid");
		let escaped_pid_path = pid_path.to_string_lossy().replace('\'', "'\\''");
		std::fs::write(
			&snapshot_path,
			format!("sh -c 'printf \"%d\\n\" \"$$\" > \"$1\"; sleep 30' sh '{escaped_pid_path}'\n"),
		)
		.expect("write snapshot file");

		let shell = Shell::new(Some(ShellOptions {
			snapshot_path: Some(snapshot_path.to_string_lossy().into_owned()),
			..Default::default()
		}));
		let mut cancel_token = CancelToken::default();
		let abort_token = cancel_token.emplace_abort_token();
		let run_handle = tokio::spawn(async move {
			shell
				.run(
					ShellRunOptions { command: "printf done".into(), ..Default::default() },
					None,
					cancel_token,
				)
				.await
		});

		let child_pid = time::timeout(Duration::from_secs(5), async {
			loop {
				if let Ok(pid_text) = std::fs::read_to_string(&pid_path)
					&& let Ok(pid) = pid_text.trim().parse::<i32>()
					&& pid > 0
				{
					return pid;
				}
				time::sleep(Duration::from_millis(20)).await;
			}
		})
		.await
		.expect("timed out waiting for snapshot foreground child to write its positive PID");

		abort_token.abort(AbortReason::Signal);

		let result = time::timeout(Duration::from_secs(10), run_handle)
			.await
			.expect("timed out waiting for cancellation while sourcing snapshot")
			.expect("snapshot sourcing run task panicked")
			.expect("shell run failed while cancelling snapshot sourcing");
		assert!(result.cancelled, "cancelling while sourcing a snapshot should report cancellation");
		assert_eq!(
			result.exit_code, None,
			"cancelled snapshot sourcing run should not report an exit code"
		);
		assert!(
			!result.timed_out,
			"signal cancellation during snapshot sourcing must not report timeout"
		);

		let child_dead = time::timeout(Duration::from_secs(5), async {
			loop {
				// SAFETY: `child_pid` came from the foreground `sh` spawned by the
				// snapshot; `kill(pid, 0)` only probes whether that process still exists.
				let kill_result = unsafe { libc::kill(child_pid, 0) };
				if kill_result == -1 {
					let err = std::io::Error::last_os_error();
					if err.raw_os_error() == Some(libc::ESRCH) {
						return;
					}
					panic!(
						"kill({child_pid}, 0) failed with unexpected error while checking snapshot \
						 child cleanup: {err}"
					);
				}
				time::sleep(Duration::from_millis(20)).await;
			}
		})
		.await;
		let _ = std::fs::remove_dir_all(&root);
		assert!(
			child_dead.is_ok(),
			"snapshot foreground child PID {child_pid} was still alive after cancelling while \
			 sourcing snapshot; cancel bridge did not terminate the snapshot-spawned process"
		);
	}

	/// Regression for the `suspended (tty input)` bug: an **interactive child
	/// inside a pipeline** (`zsh -i ... | awk`) used to stay in the host
	/// session, open `/dev/tty`, `tcsetpgrp` itself to the foreground, and
	/// leave the embedded host (OMP) stopped on its next tty read. The earlier
	/// embedded-host fix carved pipelines out of `detach_session` because a
	/// later stage that `setpgid`-joined a detached leader failed with EPERM.
	///
	/// This test boots a real embedded `BrushShell` and runs a two-stage
	/// pipeline whose first stage prints its PID then sleeps (forwarded to us
	/// by `cat`). It asserts two contracts at once:
	///   1. the first stage runs in its **own session** (`getsid == own pid`),
	///      so it can never reach the host's controlling tty — guards the
	///      decision; and
	///   2. the pipeline still exits **successfully**, proving the second stage
	///      spawned without the cross-session `setpgid` EPERM — guards the
	///      wiring that skips `process_group(...)` for detached children.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn embedded_pipeline_stage_runs_in_its_own_session() {
		use std::io::Read as _;

		// SAFETY: `getsid(0)` only queries the current process session; checked
		// below. In a PID namespace (containerized CI) the host's session leader
		// can live outside the namespace, so `getsid(0)` reports 0, not an error;
		// only -1 is a real failure.
		let host_sid = unsafe { libc::getsid(0) };
		assert!(host_sid >= 0, "getsid(0) failed: {}", std::io::Error::last_os_error());

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");

		let (mut reader, writer) = pipe_to_files("e2e-pipe").expect("pipe");
		let stdout_file = OpenFile::from(writer.try_clone().expect("clone"));
		let stderr_file = OpenFile::from(writer);

		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null stdin"));
		params.set_fd(OpenFiles::STDOUT_FD, stdout_file);
		params.set_fd(OpenFiles::STDERR_FD, stderr_file);

		let (pid_tx, pid_rx) = tokio::sync::oneshot::channel::<i32>();
		let reader_handle = tokio::task::spawn_blocking(move || {
			let mut buf = Vec::new();
			let mut chunk = [0u8; 64];
			let mut pid_tx = Some(pid_tx);
			while let Ok(n) = reader.read(&mut chunk)
				&& n > 0
			{
				buf.extend_from_slice(&chunk[..n]);
				if pid_tx.is_some()
					&& let Some(line_end) = buf.iter().position(|&byte| byte == b'\n')
					&& let Ok(line) = std::str::from_utf8(&buf[..line_end])
					&& let Ok(pid) = line.trim().parse::<i32>()
				{
					let _ = pid_tx
						.take()
						.expect("pid sender should be present")
						.send(pid);
				}
			}
			buf
		});

		let shell_handle = tokio::spawn(async move {
			let source_info = SourceInfo::from("pi-natives:test");
			// First stage prints its own PID and sleeps; `sh -c cat` forwards
			// the PID line to our reader and exits on EOF. The first stage
			// leads the pipeline's process group, while the second stage is the
			// join-or-detach process that would EPERM without the wiring fix.
			let exec = session
				.shell
				.run_string(
					"sh -c 'printf \"%d\\n\" \"$$\"; sleep 1' | sh -c cat",
					&source_info,
					&params,
				)
				.await
				.expect("run_string");
			drop(params);
			(session, exec)
		});

		let child_pid = time::timeout(Duration::from_secs(5), pid_rx)
			.await
			.expect("timed out waiting for first-stage PID")
			.expect("reader closed pid channel without sending");
		assert!(child_pid > 0, "got non-positive child pid: {child_pid}");

		// SAFETY: `child_pid` is a live positive PID (still in `sleep`); the return
		// value is checked.
		let child_sid = unsafe { libc::getsid(child_pid) };
		assert!(
			child_sid > 0,
			"getsid({child_pid}) failed: {} (child may have already exited)",
			std::io::Error::last_os_error(),
		);

		let (_session, exec) = time::timeout(Duration::from_secs(5), shell_handle)
			.await
			.expect("shell timed out")
			.expect("shell task panicked");
		// Guards the wiring: the second stage spawned without a cross-session
		// `setpgid` EPERM, so the whole pipeline succeeded.
		assert!(
			matches!(exec.exit_code, ExecutionExitCode::Success),
			"pipeline did not succeed (second stage may have hit setpgid EPERM): {}",
			exit_code(&exec),
		);
		let _ = time::timeout(Duration::from_secs(2), reader_handle).await;

		// Guards the decision: a pipeline stage must not share the host session,
		// or it could seize the controlling tty and SIGTTIN the host.
		assert_ne!(
			child_sid, host_sid,
			"pipeline stage PID {child_pid} inherited host session {host_sid}; it could seize the \
			 controlling tty — the pipeline tty-suspend bug is back",
		);
		assert_eq!(
			child_sid, child_pid,
			"pipeline stage PID {child_pid} should be its own session leader after setsid",
		);
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn wait_accepts_last_background_process_id() {
		let options = ShellExecuteOptions {
			command: "sh -c 'exit 7' & mover=$!; wait \"$mover\"".to_string(),
			..Default::default()
		};

		let result = execute_shell(options, None, CancelToken::default())
			.await
			.expect("execute should succeed");

		assert_eq!(result.exit_code, Some(7));
		assert!(!result.cancelled);
		assert!(!result.timed_out);
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn wait_n_p_records_completed_process_id() {
		let options = ShellExecuteOptions {
			command: "sh -c 'sleep 0.2; exit 42' & slow=$!; sh -c 'exit 13' & fast=$!; wait -n -p \
			          hit \"$slow\" \"$fast\"; status=$?; wait \"$slow\"; [ \"$status\" -eq 13 ] && \
			          [ \"$hit\" = \"$fast\" ]"
				.to_string(),
			..Default::default()
		};

		let result = execute_shell(options, None, CancelToken::default())
			.await
			.expect("execute should succeed");

		assert_eq!(result.exit_code, Some(0));
		assert!(!result.cancelled);
		assert!(!result.timed_out);
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn wait_f_accepts_process_id() {
		let options = ShellExecuteOptions {
			command: "sh -c 'exit 5' & child=$!; wait -f \"$child\"".to_string(),
			..Default::default()
		};

		let result = execute_shell(options, None, CancelToken::default())
			.await
			.expect("execute should succeed");

		assert_eq!(result.exit_code, Some(5));
		assert!(!result.cancelled);
		assert!(!result.timed_out);
	}
	#[tokio::test]
	async fn abort_state_signals_cancel_token() {
		let abort_state = ShellAbortState::default();
		let mut cancel_token = CancelToken::default();
		let abort_token = cancel_token.emplace_abort_token();

		abort_state.set(abort_token).await;
		abort_state.abort().await;

		let reason = time::timeout(Duration::from_millis(100), cancel_token.wait())
			.await
			.expect("cancel token should be signalled");
		assert!(matches!(reason, AbortReason::Signal));
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn read_output_stops_when_cancelled_before_pipe_eof() {
		let (reader, _writer) = pipe_to_files("test").expect("test pipe should be created");
		let cancel = CancellationToken::new();
		let (activity_tx, _activity_rx) = flume::bounded(1);
		let handle = tokio::spawn(read_output(reader, None, cancel.clone(), activity_tx));

		time::sleep(Duration::from_millis(10)).await;
		cancel.cancel();

		time::timeout(Duration::from_millis(100), handle)
			.await
			.expect("reader task should stop after cancellation")
			.expect("reader task should not panic");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn execute_shell_streams_separates_stdout_and_stderr() {
		let (stdout_tx, stdout_rx) = flume::unbounded::<Bytes>();
		let (stderr_tx, stderr_rx) = flume::unbounded::<Bytes>();
		let options = ShellExecuteOptions {
			command: "echo out; echo err 1>&2".to_string(),
			..Default::default()
		};
		let streams = StreamSinks { stdout: Some(stdout_tx), stderr: Some(stderr_tx) };
		let result = execute_shell_streams(options, streams, CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(0));
		assert!(!result.cancelled);

		let mut stdout = Vec::new();
		while let Ok(chunk) = stdout_rx.recv_async().await {
			stdout.extend_from_slice(&chunk);
		}
		let mut stderr = Vec::new();
		while let Ok(chunk) = stderr_rx.recv_async().await {
			stderr.extend_from_slice(&chunk);
		}
		assert_eq!(stdout, b"out\n");
		assert_eq!(stderr, b"err\n");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn execute_shell_streams_works_when_sinks_are_none() {
		// Both sinks `None` — pipes must still drain so the child can exit.
		let options = ShellExecuteOptions {
			command: "yes done | head -n 100 1>&2; echo final".to_string(),
			..Default::default()
		};
		let result = execute_shell_streams(options, StreamSinks::default(), CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(0));
	}

	/// Brush expands `$env:NAME` against the `env` shell variable by default,
	/// collapsing PowerShell references like `Write-Host $env:OMPCODE` to
	/// `:OMPCODE`. The session-level fallback below defines `env=$env` so the
	/// expansion is the literal `$env:OMPCODE`, preserving the PowerShell
	/// token when the command is forwarded to a child shell.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn powershell_env_reference_survives_brush_expansion() {
		let (tx, rx) = flume::unbounded::<Bytes>();
		let options = ShellExecuteOptions {
			command: "printf '%s' \"$env:SystemRoot\"".to_string(),
			..Default::default()
		};
		let streams = StreamSinks { stdout: Some(tx), stderr: None };
		let result = execute_shell_streams(options, streams, CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(0));

		let mut stdout = Vec::new();
		while let Ok(chunk) = rx.recv_async().await {
			stdout.extend_from_slice(&chunk);
		}
		assert_eq!(stdout, b"$env:SystemRoot");
	}

	/// A user assignment to `env` in the command itself must shadow the
	/// session-level fallback so callers that genuinely use a POSIX variable
	/// named `env` see their value, not the literal `$env`.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn user_env_assignment_shadows_powershell_fallback() {
		let (tx, rx) = flume::unbounded::<Bytes>();
		let options = ShellExecuteOptions {
			command: "env=prod; printf '%s' \"$env:8080\"".to_string(),
			..Default::default()
		};
		let streams = StreamSinks { stdout: Some(tx), stderr: None };
		let result = execute_shell_streams(options, streams, CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(0));

		let mut stdout = Vec::new();
		while let Ok(chunk) = rx.recv_async().await {
			stdout.extend_from_slice(&chunk);
		}
		assert_eq!(stdout, b"prod:8080");
	}

	/// Quoted heredoc delimiters at EOF must behave like bash. `brush-parser`
	/// currently rejects that shape unless the input stream ends with a newline,
	/// which surfaced as `unterminated here document sequence; tag(s) [...]` for
	/// normal paste-run Python snippets.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn quoted_heredoc_without_trailing_newline_runs() {
		let (result, output) =
			run_command_capture("cat <<'PY'\nhello $USER\nPY", None, None, CancelToken::default())
				.await;

		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output, "hello $USER\n");
	}

	/// Regression for a Windows/macOS deadlock in
	/// `brush_core::interp::setup_open_file_with_contents`. The body is
	/// 256 KiB — well past the default pipe buffer on every platform
	/// (Windows ~4 KiB, macOS 16-64 KiB, Linux 64 KiB), so any inline
	/// `write_all` on the calling thread blocks forever. The `:` builtin
	/// never reads its stdin, so the only way `echo done` runs is if the
	/// heredoc writer is decoupled from the main thread (or, on Linux,
	/// the pipe buffer was grown via `F_SETPIPE_SZ`). The
	/// `tokio::time::timeout` is the safety net that turns a regression
	/// into a 10 s failure instead of hanging CI for the full
	/// hard-timeout window.
	#[tokio::test(flavor = "multi_thread")]
	async fn large_heredoc_does_not_deadlock() {
		let body = "X".repeat(256 * 1024);
		let command = format!(": <<'EOF'\n{body}\nEOF\necho done");
		let options = ShellExecuteOptions { command, ..Default::default() };

		let result = time::timeout(
			Duration::from_secs(10),
			execute_shell(options, None, CancelToken::default()),
		)
		.await
		.expect("execute_shell hung past 10 s — heredoc writer deadlocked")
		.expect("execute_shell errored");

		assert_eq!(result.exit_code, Some(0), "command did not run to completion");
	}

	/// The `nohup` builtin runs its operand command and surfaces that command's
	/// own exit status — not nohup's (`125`/`126`/`127`) error codes.
	#[tokio::test(flavor = "multi_thread")]
	async fn nohup_builtin_propagates_command_exit_code() {
		let command = if cfg!(windows) {
			"nohup cmd /C exit 7"
		} else {
			"nohup sh -c 'exit 7'"
		};
		let options = ShellExecuteOptions { command: command.to_string(), ..Default::default() };
		let result = execute_shell(options, None, CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(7));
		assert!(!result.cancelled);
		assert!(!result.timed_out);
	}

	/// `nohup` is a no-op builtin in this embedded shell, but `nohup cmd &`
	/// must still behave like a process-launching background command for `$!`.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn nohup_background_captures_operand_pid() {
		let (tx, rx) = flume::unbounded::<String>();
		let options = ShellExecuteOptions {
			command: "nohup sh -c 'exit 0' >/dev/null 2>&1 & pid=$!; printf 'pid=%s\n' \"$pid\"; \
			          test -n \"$pid\""
				.to_string(),
			..Default::default()
		};
		let result = execute_shell(options, Some(tx), CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(0));
		assert!(!result.cancelled);
		assert!(!result.timed_out);

		let mut out = String::new();
		while let Ok(chunk) = rx.recv_async().await {
			out.push_str(&chunk);
		}
		let pid = out
			.trim()
			.strip_prefix("pid=")
			.expect("nohup background PID output should include pid= prefix");
		assert!(pid.parse::<i32>().is_ok_and(|pid| pid > 0), "invalid PID output: {out:?}");
	}

	/// `nohup` with no operand mirrors coreutils: a `missing operand` diagnostic
	/// and exit code 125 (a nohup-level error, distinct from any command code).
	#[tokio::test(flavor = "multi_thread")]
	async fn nohup_builtin_without_command_reports_missing_operand() {
		let (tx, rx) = flume::unbounded::<String>();
		let options = ShellExecuteOptions { command: "nohup".to_string(), ..Default::default() };
		let result = execute_shell(options, Some(tx), CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(125));
		let mut out = String::new();
		while let Ok(chunk) = rx.recv_async().await {
			out.push_str(&chunk);
		}
		assert!(
			out.contains("missing operand"),
			"expected a missing-operand diagnostic, got: {out:?}"
		);
	}

	/// The contract that makes this a *builtin* and not the external tool: the
	/// child must **not** inherit `SIGHUP = SIG_IGN`. Real `nohup` masks SIGHUP
	/// (and it survives `exec`), so a process launched through `/usr/bin/nohup`
	/// reports `IGN` here; the builtin runs the command as an ordinary
	/// descendant, so it reports `DFL` and dies with the host on hangup. The
	/// probe needs `getsid`-style signal introspection, so it is gated on
	/// `python3` (skipped, not failed, when absent — matching the embedded
	/// session-detach e2e suite).
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn nohup_builtin_does_not_mask_sighup() {
		let python_ok = std::process::Command::new("python3")
			.arg("-c")
			.arg("pass")
			.stdout(std::process::Stdio::null())
			.stderr(std::process::Stdio::null())
			.status()
			.is_ok_and(|status| status.success());
		if !python_ok {
			eprintln!("skipping nohup_builtin_does_not_mask_sighup: python3 unavailable");
			return;
		}

		let probe = "import signal,sys; sys.stdout.write('IGN' if \
		             signal.getsignal(signal.SIGHUP)==signal.SIG_IGN else 'DFL')";
		let (tx, rx) = flume::unbounded::<String>();
		let options = ShellExecuteOptions {
			command: format!("nohup python3 -c \"{probe}\""),
			..Default::default()
		};
		let result = execute_shell(options, Some(tx), CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(0));
		let mut out = String::new();
		while let Ok(chunk) = rx.recv_async().await {
			out.push_str(&chunk);
		}
		assert!(
			out.contains("DFL") && !out.contains("IGN"),
			"builtin nohup masked SIGHUP like the external tool (output: {out:?})",
		);
	}

	/// Regression for #4078: the JS bridge hands the pipe readers a *bounded*
	/// chunk channel. With a consumer slower than the producer the readers
	/// must park on `send_async` (backpressuring the child through its pipe)
	/// rather than buffer unboundedly — and, unlike a drop-on-full design,
	/// every produced byte must still reach the consumer.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn streaming_output_backpressures_on_bounded_channel_without_loss() {
		const TOTAL_BYTES: usize = 1_048_576;
		let (tx, rx) = flume::bounded::<String>(4);
		let options = ShellExecuteOptions {
			command: format!("yes x | head -c {TOTAL_BYTES}"),
			..Default::default()
		};
		let run = tokio::spawn(execute_shell(options, Some(tx), CancelToken::default()));

		let mut received = 0usize;
		while let Ok(chunk) = rx.recv_async().await {
			received += chunk.len();
			// Slow consumer: forces the bounded queue to fill and the readers
			// to park between chunks.
			time::sleep(Duration::from_micros(50)).await;
		}

		let result = time::timeout(Duration::from_secs(30), run)
			.await
			.expect("command should finish despite backpressure")
			.expect("run task should not panic")
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(0));
		assert!(!result.cancelled);
		assert!(!result.timed_out);
		assert_eq!(received, TOTAL_BYTES, "streamed bytes were dropped under backpressure");
	}
}
