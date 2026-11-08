//! The embedded shell: pi's commands run on a [`crate::bash`] engine session
//! ([`crate::session::Session`]) over pi's filesystem, with pi's
//! utilities, process builtins and `git` layers as engine commands.

#[cfg(windows)]
use std::collections::HashSet;
use std::{
	collections::HashMap,
	fs,
	io::{self},
	path::Path,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::Duration,
};

use anyhow::{Error, Result};
use bstr::{BString, ByteSlice};
use bytes::Bytes;
use flume::Sender;
use pi_vfs::Fs;
#[cfg(not(unix))]
use tokio::io::AsyncReadExt as _;
use tokio::{sync::Mutex as TokioMutex, time};
use tokio_util::sync::CancellationToken;

pub use crate::git::GIT_REPO_LOCATION_ENV_VARS;
use crate::{
	bash::trace::{RunTrace, SegmentSource},
	cancel::{AbortReason, AbortToken, CancelToken},
	git::is_git_repo_location_var,
	minimizer,
	output_decode::CaptureDecoder,
	session::{Children, RunOptions, RunOutcome, RunStdio, Session, SessionConfig, SessionError},
	taps::PipeTaps,
	vfs::VfsFs,
};

/// A live engine session and the filesystem it runs on.
struct ShellSessionCore {
	session:    Session,
	/// The engine's filesystem slot (shared with the session's host). Each run
	/// installs a cancellation-scoped view of the session filesystem, or of
	/// the run's own override, and restores the session filesystem after it.
	slot:       VfsFs,
	/// Session filesystem.
	filesystem: Fs,
	/// The shell's working directory after the last command.
	cwd:        BString,
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

/// `path` as the engine spells it.
fn path_bytes(path: &Path) -> BString {
	BString::from(path.as_os_str().as_encoded_bytes())
}

/// Whether the shell, now in `current`, is already in `requested`.
fn working_dir_matches(current: &[u8], requested: &str) -> bool {
	let path = Path::new(requested);
	if pi_vfs::is_virtual_path(path) {
		return current == requested.as_bytes();
	}
	if !path.is_absolute() {
		return false;
	}
	// The stored dir is long-form on Windows (every `cd` stores what the
	// request expanded to), so only the requested spelling needs expansion
	// for a short-spelled host cwd to match its long spelling.
	#[cfg(windows)]
	{
		current == path_bytes(&crate::windows::expand_to_long_path(path)).as_slice()
	}
	#[cfg(not(windows))]
	{
		current == requested.as_bytes()
	}
}

/// The directory to move the shell to before a command: `None` when it is
/// there already. Like `cd`, the target must be a directory the run's
/// filesystem knows; a short-spelled Windows path is stored long-form, a URL
/// path verbatim.
async fn requested_cwd(core: &ShellSessionCore, cwd: Option<&str>) -> Result<Option<BString>> {
	let Some(cwd) = cwd else {
		return Ok(None);
	};
	if working_dir_matches(&core.cwd, cwd) {
		return Ok(None);
	}
	let path = Path::new(cwd);
	let target = if pi_vfs::is_virtual_path(path) {
		path.to_path_buf()
	} else if path.is_absolute() {
		#[cfg(windows)]
		{
			crate::windows::expand_to_long_path(path)
		}
		#[cfg(not(windows))]
		{
			path.to_path_buf()
		}
	} else {
		return Err(Error::msg(format!("Failed to set cwd: {cwd} is not an absolute path")));
	};
	match core.slot.filesystem().metadata(&target).await {
		Ok(metadata) if metadata.file_type().is_dir() => Ok(Some(path_bytes(&target))),
		Ok(_) => Err(Error::msg(format!("Failed to set cwd: {cwd}: Not a directory"))),
		Err(err) => Err(Error::msg(format!("Failed to set cwd: {cwd}: {err}"))),
	}
}

#[derive(Clone)]
struct ShellConfig {
	session_env:   Option<HashMap<String, String>>,
	snapshot_path: Option<String>,
	minimizer:     Option<minimizer::MinimizerConfig>,
	filesystem:    Fs,
}

#[derive(Debug, Clone, Default)]
pub struct ShellOptions {
	pub session_env:   Option<HashMap<String, String>>,
	pub snapshot_path: Option<String>,
	pub minimizer:     Option<minimizer::MinimizerOptions>,
	/// Filesystem backing every run of the session (native by default).
	pub filesystem:    Fs,
}

struct ShellRunConfig {
	command:    String,
	cwd:        Option<String>,
	env:        Option<HashMap<String, String>>,
	minimizer:  Option<minimizer::MinimizerConfig>,
	/// Replaces the session filesystem for this run only.
	filesystem: Option<Fs>,
	/// Mirrors the run's pipeline pipes.
	pipe_taps:  Option<Arc<PipeTaps>>,
	/// Folds the run's engine events.
	trace:      Option<Arc<RunTrace>>,
}

#[derive(Debug, Clone, Default)]
pub struct ShellRunOptions {
	pub command:    String,
	pub cwd:        Option<String>,
	pub env:        Option<HashMap<String, String>>,
	pub timeout_ms: Option<u32>,
	/// Filesystem for this run only; the session filesystem when `None`.
	pub filesystem: Option<Fs>,
	/// Receives a copy of every byte crossing the run's pipeline pipes.
	pub pipe_taps:  Option<Arc<PipeTaps>>,
	/// Folds the run's engine events into a live model of `command`
	/// (built over the same command text).
	pub trace:      Option<Arc<RunTrace>>,
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
	/// Filesystem backing the command (native by default).
	pub filesystem:    Fs,
}

pub type ShellExecuteResult = ShellRunResult;

/// The live externals of the session's run in flight, readable apart from the
/// session mutex (held for the whole command) so [`Shell::pids`] never waits
/// for it. Replaced when a new session is created.
type ActiveChildren = Arc<parking_lot::Mutex<Option<Children>>>;

pub struct Shell {
	session:     Arc<TokioMutex<Option<ShellSessionCore>>>,
	abort_state: ShellAbortState,
	config:      ShellConfig,
	children:    ActiveChildren,
}

impl Shell {
	#[must_use]
	pub fn new(options: Option<ShellOptions>) -> Self {
		let config = match options {
			None => ShellConfig {
				session_env:   None,
				snapshot_path: None,
				minimizer:     None,
				filesystem:    Fs::native(),
			},
			Some(opt) => {
				let minimizer = opt
					.minimizer
					.as_ref()
					.map(minimizer::MinimizerConfig::from_options);
				ShellConfig {
					session_env: opt.session_env,
					snapshot_path: opt.snapshot_path,
					minimizer,
					filesystem: opt.filesystem,
				}
			},
		};
		Self {
			session: Arc::new(TokioMutex::new(None)),
			abort_state: ShellAbortState::default(),
			config,
			children: ActiveChildren::default(),
		}
	}

	pub async fn run(
		&self,
		options: ShellRunOptions,
		on_chunk: Option<Sender<String>>,
		mut cancel_token: CancelToken,
	) -> Result<ShellRunResult> {
		let run_config = ShellRunConfig {
			command:    options.command,
			cwd:        options.cwd,
			env:        options.env,
			minimizer:  self.config.minimizer.clone(),
			filesystem: options.filesystem,
			pipe_taps:  options.pipe_taps,
			trace:      options.trace,
		};
		run_shell_session(
			self.session.clone(),
			self.abort_state.clone(),
			self.children.clone(),
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

	/// Pids of the processes spawned by the in-flight [`Shell::run`] that are
	/// still alive, in spawn order. Covers every external child the session
	/// started — foreground commands, pipeline stages, and `&` background
	/// jobs — but not builtins, which run in-process. Empty when no run is
	/// executing (including one still waiting for a previous run to release
	/// the session). Never blocks on the session lock held by a running
	/// command.
	#[must_use]
	pub fn pids(&self) -> Vec<i32> {
		self
			.children
			.lock()
			.as_ref()
			.map_or_else(Vec::new, Children::pids)
	}

	/// Number of live external background jobs tracked by the persistent
	/// session. The host retains a per-call shell while this is nonzero, since
	/// dropping it would kill its children. Exited children are reaped
	/// without discarding their status, so a later `wait` still sees the exit
	/// code. 0 when the session is gone.
	pub async fn live_background_job_count(&self) -> u32 {
		let guard = self.session.lock().await;
		let Some(core) = guard.as_ref() else {
			return 0;
		};
		core
			.session
			.live_external_jobs()
			.await
			.map_or(0, |count| u32::try_from(count).unwrap_or(u32::MAX))
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
		filesystem:    options.filesystem,
	};
	let run_config = ShellRunConfig {
		command: options.command,
		cwd: options.cwd,
		env: options.env,
		minimizer,
		filesystem: None,
		pipe_taps: None,
		trace: None,
	};
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
		filesystem:    options.filesystem,
	};
	let run_config = ShellRunConfig {
		command:    options.command,
		cwd:        options.cwd,
		env:        options.env,
		minimizer:  None,
		filesystem: None,
		pipe_taps:  None,
		trace:      None,
	};
	run_shell_oneshot_streams(config, run_config, streams, cancel_token).await
}

/// How long a cancelled run waits for its task to wind down before aborting
/// it (discarding any output still queued in the pipe readers, and stopping
/// the command with `KILL`).
///
/// The session's own cancel sends `TERM`, then `KILL` after its 1 s grace;
/// a run that ends within these two seconds reports normally. Windows needs a
/// wider budget: in-process pipeline producers stop on a poll between
/// writes, so producer exit, pipe EOF, the consumer's final flush and the
/// reader's last read each need a separate thread wakeup; under heavy load
/// that chain exceeded 2s (`yes x | tail -5` lost its 5 lines).
#[cfg(windows)]
const CANCEL_RUN_GRACE: Duration = Duration::from_secs(5);
#[cfg(not(windows))]
const CANCEL_RUN_GRACE: Duration = Duration::from_secs(2);

/// Delay between cancellation and cancelling the output readers. Readers stay
/// open so pipeline consumers can flush after their producers die, and so a
/// TERM trap that writes output during the session's TERM grace does not hit
/// EPIPE and die before finishing its cleanup. Windows needs a wider budget
/// for the same reason as `CANCEL_RUN_GRACE`. The delayed fallback still
/// releases readers whose writers never close.
#[cfg(windows)]
const CANCEL_READER_GRACE: Duration = Duration::from_millis(2000);
#[cfg(not(windows))]
const CANCEL_READER_GRACE: Duration = Duration::from_millis(1250);

/// What a run reports when it ends normally.
struct CommandResult {
	status:      i32,
	minimized:   Option<MinimizerResult>,
	working_dir: String,
}

impl CommandResult {
	fn into_run_result(self) -> ShellRunResult {
		ShellRunResult {
			exit_code:   Some(self.status),
			cancelled:   false,
			timed_out:   false,
			minimized:   self.minimized,
			working_dir: Some(self.working_dir),
		}
	}
}

/// The result of a run cancelled by `reason`.
const fn cancelled_result(reason: AbortReason) -> ShellRunResult {
	ShellRunResult {
		exit_code:   None,
		cancelled:   matches!(reason, AbortReason::Signal),
		timed_out:   matches!(reason, AbortReason::Timeout),
		minimized:   None,
		working_dir: None,
	}
}

async fn run_shell_session(
	session: Arc<TokioMutex<Option<ShellSessionCore>>>,
	abort_state: ShellAbortState,
	children: ActiveChildren,
	config: ShellConfig,
	run_config: ShellRunConfig,
	on_chunk: Option<Sender<String>>,
	ct: &mut CancelToken,
) -> Result<ShellRunResult> {
	let tokio_cancel = CancellationToken::new();
	let mut run_task = tokio::spawn({
		let session = session.clone();
		let abort_state = abort_state.clone();
		let tokio_cancel = tokio_cancel.clone();
		let at = ct.emplace_abort_token();
		async move {
			let mut session_guard = session.lock().await;
			let core = if let Some(core) = &mut *session_guard {
				core
			} else {
				let core = create_session_for_run(&config, Some(&tokio_cancel)).await?;
				*children.lock() = Some(core.session.children());
				session_guard.insert(core)
			};
			abort_state.set(at).await;
			run_shell_command(core, &run_config, on_chunk, tokio_cancel).await
		}
	});

	let res = tokio::select! {
		res = &mut run_task => res,
		reason = ct.wait() => {
			tokio_cancel.cancel();
			let graceful = time::timeout(CANCEL_RUN_GRACE, &mut run_task).await;
			if graceful.is_err() {
				// Dropping the run stops the command with `KILL`.
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
			return Ok(cancelled_result(reason));
		}
	};
	let res =
		res.unwrap_or_else(|err| Err(Error::msg(format!("Shell execution task failed: {err}"))));
	abort_state.clear().await;

	// `exit`, errexit, or a stray top-level `return`/`break` ends this command,
	// not the session: the next run keeps the variables, functions, and options
	// built so far. Only a failed run leaves the shell in an unknown state.
	if res.is_err() {
		*session.lock().await = None;
	}
	Ok(res?.into_run_result())
}

async fn run_shell_oneshot(
	config: ShellConfig,
	run_config: ShellRunConfig,
	on_chunk: Option<Sender<String>>,
	ct: CancelToken,
) -> Result<ShellExecuteResult> {
	let tokio_cancel = CancellationToken::new();
	let mut task = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		async move {
			// The session ends with this task: its background jobs end with it.
			let mut session = create_session_for_run(&config, Some(&tokio_cancel)).await?;
			run_shell_command(&mut session, &run_config, on_chunk, tokio_cancel).await
		}
	});

	let run_result = tokio::select! {
		result = &mut task => result,
		reason = ct.wait() => {
			tokio_cancel.cancel();
			let graceful = time::timeout(CANCEL_RUN_GRACE, &mut task).await;
			if graceful.is_err() {
				task.abort();
				let _ = task.await;
			}
			return Ok(cancelled_result(reason));
		},
	};

	let res = run_result
		.unwrap_or_else(|err| Err(Error::msg(format!("Shell execution task failed: {err}"))));
	Ok(res?.into_run_result())
}

async fn run_shell_oneshot_streams(
	config: ShellConfig,
	run_config: ShellRunConfig,
	streams: StreamSinks,
	ct: CancelToken,
) -> Result<ShellExecuteResult> {
	let tokio_cancel = CancellationToken::new();
	let mut task = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		async move {
			let mut session = create_session_for_run(&config, Some(&tokio_cancel)).await?;
			run_shell_command_streams(&mut session, &run_config, streams, tokio_cancel).await
		}
	});

	let run_result = tokio::select! {
		result = &mut task => result,
		reason = ct.wait() => {
			tokio_cancel.cancel();
			let graceful = time::timeout(CANCEL_RUN_GRACE, &mut task).await;
			if graceful.is_err() {
				task.abort();
				let _ = task.await;
			}
			return Ok(cancelled_result(reason));
		},
	};

	let res = run_result
		.unwrap_or_else(|err| Err(Error::msg(format!("Shell execution task failed: {err}"))));
	Ok(res?.into_run_result())
}

/// The null device, for a stream a command must not see.
fn null_file() -> Result<fs::File> {
	let path = if cfg!(windows) { "NUL" } else { "/dev/null" };
	fs::OpenOptions::new()
		.read(true)
		.write(true)
		.open(path)
		.map_err(|err| Error::msg(format!("Failed to create null file: {err}")))
}

/// Standard streams for a command that reads nothing and writes nowhere.
fn null_stdio() -> Result<RunStdio> {
	Ok(RunStdio {
		stdin:  Some(null_file()?),
		stdout: Some(null_file()?),
		stderr: Some(null_file()?),
	})
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

/// Canonical spelling for a key inherited from the host environment (the
/// process env or the caller-forwarded session env). Windows env names are
/// case-insensitive, so a host `Temp` must still surface as `$TEMP` in the
/// case-sensitive shell. Per-command env keeps the narrower
/// [`normalize_env_key`]: a lowercase `tmp` there is an ordinary variable.
#[cfg(windows)]
const fn normalize_inherited_env_key(key: &str) -> &str {
	if key.eq_ignore_ascii_case("TEMP") {
		"TEMP"
	} else if key.eq_ignore_ascii_case("TMP") {
		"TMP"
	} else if key.eq_ignore_ascii_case("TMPDIR") {
		"TMPDIR"
	} else {
		normalize_env_key(key)
	}
}

#[cfg(not(windows))]
const fn normalize_inherited_env_key(key: &str) -> &str {
	key
}

/// Value exported for an inherited (already normalized) env key.
///
/// A host `TEMP`/`TMP`/`TMPDIR` may carry an 8.3 profile alias
/// (`C:\Users\ADMINI~1\...`) while `cd` stores the long form in `PWD`, so
/// `cd "$TEMP"` would leave the two spellings disagreeing. Absolute temp paths
/// are expanded with the same `GetLongPathNameW` routine `cd` uses (symlinks
/// and junctions kept); anything else, or a failed expansion, passes through.
#[cfg(windows)]
fn inherited_env_value<'a>(key: &str, value: &'a str) -> std::borrow::Cow<'a, str> {
	let path = Path::new(value);
	if !matches!(key, "TEMP" | "TMP" | "TMPDIR") || !path.is_absolute() {
		return std::borrow::Cow::Borrowed(value);
	}
	match crate::windows::expand_to_long_path(path)
		.into_os_string()
		.into_string()
	{
		Ok(expanded) => std::borrow::Cow::Owned(expanded),
		Err(_) => std::borrow::Cow::Borrowed(value),
	}
}

#[cfg(not(windows))]
const fn inherited_env_value<'a>(_key: &str, value: &'a str) -> std::borrow::Cow<'a, str> {
	std::borrow::Cow::Borrowed(value)
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
	for component in Path::new(trimmed).components() {
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
	create_session_for_run(config, None).await
}

/// Copies the host environment into `vars` (the shell's starting
/// environment, every entry exported), merging duplicate `PATH` values and
/// setting the merged `PATH` last.
///
/// Entries whose key or value is not valid Unicode are skipped: a corrupt
/// entry carries no usable meaning, and `std::env::vars()` — the naive way to
/// read the host environment — panics on the first one before any command can
/// run. `vars_os()` yields the raw entries without panicking, leaving the
/// skip decision here. Shell-owned variables ([`should_skip_env_var`]) and
/// git repository-location overrides are not inherited.
fn copy_env_into(
	vars: &mut HashMap<String, String>,
	env: impl Iterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) {
	let mut merged_path: Option<String> = None;
	for (key, value) in env {
		// A key or value that cannot be decoded as Unicode is unusable; drop
		// it rather than panicking startup for a corrupt host environment.
		let (Some(key), Some(value)) = (key.to_str(), value.to_str()) else {
			continue;
		};
		let normalized_key = normalize_inherited_env_key(key);
		if should_skip_env_var(normalized_key) || is_git_repo_location_var(normalized_key) {
			continue;
		}
		if normalized_key == "PATH" {
			merged_path = Some(match merged_path {
				Some(existing) => merge_path_values(&existing, value),
				None => value.to_string(),
			});
			continue;
		}
		let value = inherited_env_value(normalized_key, value);
		vars.insert(normalized_key.to_owned(), value.into_owned());
	}

	#[cfg(windows)]
	if merged_path.is_none()
		&& let Some(value) = std::env::var_os("Path").or_else(|| std::env::var_os("PATH"))
	{
		merged_path = Some(value.to_string_lossy().into_owned());
	}

	if let Some(path_value) = merged_path {
		vars.insert("PATH".to_owned(), path_value);
	}
}

/// Apply the caller's session env over the inherited one, with the same skips
/// and temp-path expansion.
fn apply_session_env(vars: &mut HashMap<String, String>, session_env: &HashMap<String, String>) {
	for (key, value) in session_env {
		let normalized_key = normalize_inherited_env_key(key);
		if should_skip_env_var(normalized_key) || is_git_repo_location_var(normalized_key) {
			continue;
		}
		// The agent forwards its whole host env here, so temp paths need the
		// same long-form expansion as the direct host copy.
		let value = inherited_env_value(normalized_key, value);
		vars.insert(normalized_key.to_owned(), value.into_owned());
	}
}

/// The shell's starting environment: the host's, then the session env.
fn session_vars(config: &ShellConfig) -> HashMap<String, String> {
	let mut vars = HashMap::new();
	copy_env_into(&mut vars, std::env::vars_os());
	if let Some(env) = config.session_env.as_ref() {
		apply_session_env(&mut vars, env);
	}
	#[cfg(windows)]
	crate::windows::configure_windows_path(&mut vars);
	vars
}

/// The directory a new shell starts in: the process's, or `HOME` (then `/`)
/// when a long-running host's working directory was deleted.
fn initial_cwd() -> BString {
	if let Ok(cwd) = std::env::current_dir()
		&& cwd.is_dir()
	{
		#[cfg(windows)]
		let cwd = crate::windows::expand_to_long_path(&cwd);
		return path_bytes(&cwd);
	}
	let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
		.map(std::path::PathBuf::from)
		.filter(|home| home.is_dir());
	home.map_or_else(|| BString::from("/"), |home| path_bytes(&home))
}

/// Start a session for `config`. Setup (the `env` fallback, snapshot
/// sourcing) belongs to the creating run, so its processes and provider
/// calls stop with `cancel_token`.
async fn create_session_for_run(
	config: &ShellConfig,
	cancel_token: Option<&CancellationToken>,
) -> Result<ShellSessionCore> {
	let cancel = cancel_token.cloned().unwrap_or_default();
	let runtime = tokio::runtime::Handle::current();
	let slot = VfsFs::new(config.filesystem.with_cancellation(cancel.clone()), runtime.clone());
	let vars = session_vars(config);
	let has_env_var = vars.contains_key("env");
	let env = vars
		.into_iter()
		.map(|(key, value)| (BString::from(key), BString::from(value)))
		.collect();
	let cwd = initial_cwd();
	// The pi utilities (and their `PI_DISABLE_*` gates), the process
	// builtins, `nohup`, `timeout` and the `git` layers are the session's
	// commands (`crate::tools`), configured from this environment; `exec`
	// and `suspend` never act on this process.
	let session = Session::new(SessionConfig {
		env,
		cwd: cwd.clone(),
		fs: Box::new(slot.clone()),
		vfs: Some(slot.clone()),
		runtime,
		output_decoding: None,
	})
	.map_err(|err| Error::msg(format!("Failed to initialize shell: {err}")))?;
	let mut core = ShellSessionCore { session, slot, filesystem: config.filesystem.clone(), cwd };

	if !has_env_var {
		apply_env_fallback(&mut core, &cancel)
			.await
			.map_err(|err| Error::msg(format!("Failed to set env fallback: {err}")))?;
	}
	if let Some(snapshot_path) = config.snapshot_path.as_ref() {
		let escaped = snapshot_path.replace('\'', "'\\''");
		run_setup(&mut core, format!("source '{escaped}'"), &cancel)
			.await
			.map_err(|err| Error::msg(format!("Failed to source snapshot: {err}")))?;
	}
	restore_session_filesystem(&core);
	if cancel.is_cancelled() {
		return Err(Error::msg("Shell setup was cancelled"));
	}
	Ok(core)
}

/// Run a setup command of a new session with null stdio.
async fn run_setup(
	core: &mut ShellSessionCore,
	command: String,
	cancel: &CancellationToken,
) -> Result<()> {
	let outcome = core
		.session
		.run_with(RunOptions::new(command), null_stdio()?, cancel.clone())
		.await?;
	core.cwd = outcome.cwd;
	Ok(())
}

/// Define `env` as a shell variable expanding to the literal `$env` so that
/// POSIX parameter expansion preserves PowerShell-style `$env:NAME`
/// references when commands are dispatched to a PowerShell (or any)
/// subprocess. The variable is not exported, so it only influences the
/// shell's own expansion; the child process environment is unaffected.
///
/// User-driven assignments (`env=prod; echo "$env:8080"`) replace this
/// default, preserving the bash POSIX contract for callers that genuinely use
/// a variable named `env`.
async fn apply_env_fallback(core: &mut ShellSessionCore, cancel: &CancellationToken) -> Result<()> {
	run_setup(core, "env='$env'".to_owned(), cancel).await
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
			| "READLINE_LINE"
			| "READLINE_POINT"
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

/// The per-command environment: exported to this command only, each name
/// back to its previous value afterwards.
fn command_env(env: Option<&HashMap<String, String>>) -> Vec<(BString, BString)> {
	env.into_iter()
		.flatten()
		.filter_map(|(key, value)| {
			let key = normalize_env_key(key);
			(!should_skip_env_var(key)).then(|| (BString::from(key), BString::from(value.as_str())))
		})
		.collect()
}

#[derive(Clone, Copy)]
enum CommandCaptureMode {
	Streaming,
	Buffered { max_capture_bytes: usize },
}

/// How one session run of a command ended.
struct CommandRunOutput {
	outcome:        RunOutcome,
	buffered:       Option<BufferedOutput>,
	/// A command reported an error yet went on, so the exit status hides it.
	reported_error: bool,
}

/// What every session run of one command shares.
struct CommandScope<'a> {
	options: &'a ShellRunConfig,
	env:     Vec<(BString, BString)>,
	cancel:  CancellationToken,
}

impl CommandScope<'_> {
	/// The session run of `command`; `cwd` moves the shell first.
	fn run_options(
		&self,
		command: String,
		cwd: Option<BString>,
		reported_error: Option<Arc<AtomicBool>>,
	) -> RunOptions {
		RunOptions {
			command,
			env: self.env.clone(),
			cwd,
			pipe_tap: self
				.options
				.pipe_taps
				.as_ref()
				.map(|taps| Arc::clone(taps) as Arc<dyn crate::bash::PipeTap>),
			reported_error,
			text_capture: false,
			events: self
				.options
				.trace
				.as_ref()
				.map(|trace| Arc::clone(trace) as Arc<dyn crate::bash::EventSink>),
		}
	}
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

/// Install the run's filesystem — its override, else the session's — scoped
/// to the run's cancellation, so an aborted run stops waiting on provider
/// calls.
fn install_run_filesystem(
	session: &ShellSessionCore,
	options: &ShellRunConfig,
	cancel_token: &CancellationToken,
) {
	let filesystem = options
		.filesystem
		.as_ref()
		.unwrap_or(&session.filesystem)
		.with_cancellation(cancel_token.clone());
	session.slot.set_filesystem(filesystem);
}

/// Put the session filesystem back so a run's override never leaks into
/// later runs (or into the background jobs it left running).
fn restore_session_filesystem(session: &ShellSessionCore) {
	session.slot.set_filesystem(session.filesystem.clone());
}

/// Wait for the closes of virtual files the command dropped, so its writes
/// have settled before the run reports. Cancellation ends the wait, never the
/// closes themselves.
async fn drain_dropped_files(slot: &VfsFs, cancel_token: &CancellationToken) -> io::Result<()> {
	let filesystem = slot.filesystem();
	tokio::select! {
		drained = filesystem.drain_closes() => drained,
		() = cancel_token.cancelled() => Ok(()),
	}
}

/// A failed close lost data the command believed written: say so on the
/// command's stderr and fail a command that otherwise succeeded.
fn report_close_failure(
	stderr: &mut fs::File,
	err: &io::Error,
	result: &mut std::result::Result<RunOutcome, SessionError>,
) {
	use std::io::Write as _;
	let _ = writeln!(stderr, "pi-shell: closing a file failed: {err}");
	if let Ok(outcome) = result
		&& outcome.status == 0
	{
		outcome.status = 1;
	}
}

async fn run_shell_command(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
) -> Result<CommandResult> {
	install_run_filesystem(session, options, &cancel_token);
	let result = run_shell_command_in_filesystem(session, options, on_chunk, cancel_token).await;
	restore_session_filesystem(session);
	result
}

async fn run_shell_command_in_filesystem(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
) -> Result<CommandResult> {
	let cwd = requested_cwd(session, options.cwd.as_deref()).await?;
	let scope =
		CommandScope { options, env: command_env(options.env.as_ref()), cancel: cancel_token };

	let minimizer_mode = if let Some(config) = options.minimizer.as_ref() {
		minimizer::engine::mode_for(&options.command, config)
	} else {
		minimizer::engine::MinimizerMode::None
	};

	let (status, minimized) = match minimizer_mode {
		minimizer::engine::MinimizerMode::SegmentedChain => {
			run_shell_command_segmented_chain(session, &scope, cwd, on_chunk).await?
		},
		minimizer::engine::MinimizerMode::WholeCommand | minimizer::engine::MinimizerMode::None => {
			run_shell_command_single(session, &scope, cwd, on_chunk, minimizer_mode).await?
		},
	};

	Ok(CommandResult { status, minimized, working_dir: session.cwd.to_str_lossy().into_owned() })
}

async fn run_shell_command_single(
	session: &mut ShellSessionCore,
	scope: &CommandScope<'_>,
	cwd: Option<BString>,
	on_chunk: Option<Sender<String>>,
	minimizer_mode: minimizer::engine::MinimizerMode,
) -> Result<(i32, Option<MinimizerResult>)> {
	debug_assert!(!matches!(minimizer_mode, minimizer::engine::MinimizerMode::SegmentedChain));
	let options = scope.options;

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
		scope,
		options.command.clone(),
		cwd,
		on_chunk,
		capture_mode,
		None,
	)
	.await?;
	let status = command_run.outcome.status;

	let mut minimized_out = None;
	if let Some(buffered) = command_run.buffered
		&& let Some(config) = options.minimizer.as_ref()
	{
		// When the capture cap is exceeded the output was streamed raw and never
		// buffered, so nothing was minimized — leave `minimized` absent, matching
		// every other passthrough path and `apply_shell_minimizer`.
		// A command that reported an error yet exited 0 (jq after an input that
		// fails) is left whole: a filter may cut the error, and its exit-code
		// gate cannot see it.
		if !buffered.exceeded && !command_run.reported_error {
			let minimized = match minimizer_mode {
				minimizer::engine::MinimizerMode::WholeCommand => {
					minimizer::apply(&options.command, &buffered.text, status, config)
				},
				minimizer::engine::MinimizerMode::None => {
					minimizer::MinimizerOutput::passthrough(&buffered.text)
				},
				minimizer::engine::MinimizerMode::SegmentedChain => {
					minimizer::MinimizerOutput::passthrough(&buffered.text)
				},
			};
			// Surface telemetry only when the filter actually rewrote the output
			// and kept the original buffer — same contract as
			// `apply_shell_minimizer` in `pi-natives`. A supported filter that
			// runs but leaves the output unchanged reports `changed: false` with
			// no `original_text` and must NOT set `minimized`.
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

	Ok((status, minimized_out))
}

/// The source of a chain segment whose failure must not trip `set -e`: the
/// left side of `&&`, where bash ignores errexit. `&& :` puts the segment in
/// that position without changing its status, and the braces keep a trailing
/// comment from swallowing it.
fn errexit_suppressed(command: &str) -> String {
	format!("{{ {command}\n}} && :")
}

async fn run_shell_command_segmented_chain(
	session: &mut ShellSessionCore,
	scope: &CommandScope<'_>,
	cwd: Option<BString>,
	on_chunk: Option<Sender<String>>,
) -> Result<(i32, Option<MinimizerResult>)> {
	let options = scope.options;
	let unsegmented = minimizer::engine::MinimizerMode::None;
	let Some(config) = options.minimizer.as_ref() else {
		return run_shell_command_single(session, scope, cwd, on_chunk, unsegmented).await;
	};

	// When minimizer is disabled, don't segment — stream the original single
	// path.
	if !config.enabled {
		return run_shell_command_single(session, scope, cwd, on_chunk, unsegmented).await;
	}

	let minimizer::plan::CommandPlan::Chain { segments } =
		minimizer::plan::analyze(&options.command)
	else {
		return run_shell_command_single(session, scope, cwd, on_chunk, unsegmented).await;
	};

	let mut cwd = cwd;
	let mut aggregate = Some(ChainCapture::new());
	let mut previous_succeeded = true;
	let mut last_status = None;
	let max_capture_bytes = config.max_capture_bytes as usize;
	for segment in segments {
		if segment.run_if_previous_succeeded && !previous_succeeded {
			continue;
		}

		let capture_mode = if aggregate.is_some() {
			CommandCaptureMode::Buffered { max_capture_bytes }
		} else {
			CommandCaptureMode::Streaming
		};
		let source = if segment.suppress_errexit {
			errexit_suppressed(&segment.command)
		} else {
			segment.command.clone()
		};

		// Only the first segment moves the shell; later ones start wherever
		// the earlier ones left it.
		let events = options.trace.as_ref().map(|trace| {
			trace.segment(SegmentSource {
				at:     segment.source_at,
				len:    segment.source_len,
				prefix: if segment.suppress_errexit { 2 } else { 0 },
			})
		});
		let command_run = run_shell_command_once(
			session,
			scope,
			source,
			cwd.take(),
			on_chunk.clone(),
			capture_mode,
			events,
		)
		.await?;

		let exit = command_run.outcome.status;
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
					let minimized = if command_run.reported_error {
						minimizer::MinimizerOutput::passthrough(&buffered.text)
					} else {
						minimizer::apply(&segment.command, &buffered.text, exit, config)
					};
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

		// `exit` and errexit end the command (the session itself stays usable).
		let keep_running = !command_run.outcome.exited && !scope.cancel.is_cancelled();
		last_status = Some(exit);
		if !keep_running {
			break;
		}
	}

	let Some(status) = last_status else {
		return Err(Error::msg("Segmented chain executed no segments"));
	};

	if let Some(trace) = options.trace.as_ref() {
		trace.finish_segments(status);
	}

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
	// path and `apply_shell_minimizer`.

	Ok((status, minimized_out))
}

/// Run `command` once on the session, its stdout and stderr merged into one
/// pipe that is decoded into `on_chunk`.
async fn run_shell_command_once(
	session: &mut ShellSessionCore,
	scope: &CommandScope<'_>,
	mut command: String,
	cwd: Option<BString>,
	on_chunk: Option<Sender<String>>,
	capture_mode: CommandCaptureMode,
	events: Option<Arc<dyn crate::bash::EventSink>>,
) -> Result<CommandRunOutput> {
	let cancel_token = scope.cancel.clone();
	let (reader_file, writer_file) = pipe_to_files("output")?;

	let stdout_file = writer_file
		.try_clone()
		.map_err(|err| Error::msg(format!("Failed to clone pipe: {err}")))?;
	let mut diagnostics = writer_file
		.try_clone()
		.map_err(|err| Error::msg(format!("Failed to clone pipe: {err}")))?;
	let stdio =
		RunStdio { stdin: Some(null_file()?), stdout: Some(stdout_file), stderr: Some(writer_file) };
	// Only a buffered capture can be minimized, so only it asks for the report.
	let reported_error = matches!(capture_mode, CommandCaptureMode::Buffered { .. })
		.then(|| Arc::new(AtomicBool::new(false)));
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
	let mut run = scope.run_options(command, cwd, reported_error.clone());
	if let Some(events) = events {
		run.events = Some(events);
	}
	// Stdout and stderr are one pipe read as text: externals' output is
	// decoded per program before it joins what the builtins wrote.
	run.text_capture = true;
	let mut result = session
		.session
		.run_with(run, stdio, cancel_token.clone())
		.await;
	if let Ok(outcome) = &result {
		session.cwd.clone_from(&outcome.cwd);
	}

	if let Err(err) = drain_dropped_files(&session.slot, &cancel_token).await {
		report_close_failure(&mut diagnostics, &err, &mut result);
	}
	// Release the extra writer so the reader can reach EOF.
	drop(diagnostics);

	// The foreground command can complete while background jobs keep the
	// stdout/stderr pipe open. Don't hang forever waiting for EOF; drain output
	// for a short period, then cancel. A cancelled run is the exception: the
	// processes its cancel signalled may still be running their TERM traps, so
	// the reader stays open until they close the pipe or the cancel bridge
	// releases it (`CANCEL_READER_GRACE`).
	const POST_EXIT_IDLE: Duration = Duration::from_millis(250);
	const POST_EXIT_MAX: Duration = Duration::from_secs(2);
	const READER_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(250);

	let cancelled = cancel_token.is_cancelled();
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
			() = &mut idle_timer, if !cancelled => break,
			() = &mut max_timer, if !cancelled => break,
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

	let outcome = result.map_err(|err| Error::msg(format!("Shell execution failed: {err}")))?;
	let buffered = match reader_output {
		Some(OutputRead::Buffered(output)) => Some(output),
		Some(OutputRead::Streaming) | None => None,
	};
	let reported_error = reported_error.is_some_and(|flag| flag.load(Ordering::Relaxed));
	Ok(CommandRunOutput { outcome, buffered, reported_error })
}

async fn run_shell_command_streams(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	streams: StreamSinks,
	cancel_token: CancellationToken,
) -> Result<CommandResult> {
	install_run_filesystem(session, options, &cancel_token);
	let result =
		run_shell_command_streams_in_filesystem(session, options, streams, cancel_token).await;
	restore_session_filesystem(session);
	result
}

async fn run_shell_command_streams_in_filesystem(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	streams: StreamSinks,
	cancel_token: CancellationToken,
) -> Result<CommandResult> {
	let cwd = requested_cwd(session, options.cwd.as_deref()).await?;
	let scope = CommandScope {
		options,
		env: command_env(options.env.as_ref()),
		cancel: cancel_token.clone(),
	};

	let (stdout_reader, stdout_writer) = pipe_to_files("stdout")?;
	let (stderr_reader, stderr_writer) = pipe_to_files("stderr")?;

	let mut diagnostics = stderr_writer
		.try_clone()
		.map_err(|err| Error::msg(format!("Failed to clone pipe: {err}")))?;
	let stdio = RunStdio {
		stdin:  Some(null_file()?),
		stdout: Some(stdout_writer),
		stderr: Some(stderr_writer),
	};
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
			time::sleep(CANCEL_READER_GRACE).await;
			reader_cancel.cancel();
		}
	});
	let mut command = options.command.clone();
	ensure_trailing_newline_for_heredoc(&mut command);
	let run = scope.run_options(command, cwd, None);
	let mut result = session
		.session
		.run_with(run, stdio, cancel_token.clone())
		.await;
	if let Ok(outcome) = &result {
		session.cwd.clone_from(&outcome.cwd);
	}

	if let Err(err) = drain_dropped_files(&session.slot, &cancel_token).await {
		report_close_failure(&mut diagnostics, &err, &mut result);
	}
	// Release the extra writer so the stderr reader can reach EOF.
	drop(diagnostics);

	// As in `run_shell_command_once`: a short drain after the run, except
	// that a cancelled run's readers stay open for its TERM traps until the
	// cancel bridge releases them.
	const POST_EXIT_IDLE: Duration = Duration::from_millis(250);
	const POST_EXIT_MAX: Duration = Duration::from_secs(2);
	const READER_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(250);

	let cancelled = cancel_token.is_cancelled();
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
			() = &mut idle_timer, if !cancelled => break,
			() = &mut max_timer, if !cancelled => break,
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

	let outcome = result.map_err(|err| Error::msg(format!("Shell execution failed: {err}")))?;
	Ok(CommandResult {
		status:      outcome.status,
		minimized:   None,
		working_dir: session.cwd.to_str_lossy().into_owned(),
	})
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

fn ensure_trailing_newline_for_heredoc(command: &mut String) {
	if command.ends_with('\n')
		|| !command
			.as_bytes()
			.array_windows()
			.any(|window| window == b"<<")
	{
		return;
	}
	command.push('\n');
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

/// How long the capture reader waits for the rest of a held line before
/// judging what it has (a prompt or progress text without a newline).
#[cfg(not(unix))]
const CAPTURE_LINE_IDLE: Duration = Duration::from_millis(50);

/// Completes after [`CAPTURE_LINE_IDLE`] when `holds_line`, never otherwise.
#[cfg(not(unix))]
async fn capture_line_idle(holds_line: bool) {
	if holds_line {
		time::sleep(CAPTURE_LINE_IDLE).await;
	} else {
		std::future::pending::<()>().await;
	}
}

async fn read_output(
	reader: fs::File,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	activity: Sender<()>,
) {
	const BUF: usize = 65536;
	let mut buf = vec![0u8; BUF];
	let mut decoder = CaptureDecoder::new();

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
			let res = loop {
				tokio::select! {
					res = &mut read_future => break Some(res),
					() = cancel_token.cancelled() => break None,
					() = capture_line_idle(decoder.holds_line()) => {
						emit_chunk(decoder.flush_line(), on_chunk.as_ref()).await;
					}
				}
			};
			let Some(res) = res else {
				break;
			};
			match res {
				Ok(0) => break, // EOF
				Ok(n) => n,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(_) => break,
			}
		};
		if n > 0 {
			let _ = activity.try_send(());
			let text = decoder.push(&buf[..n]);
			if !text.is_empty() {
				emit_chunk(text, on_chunk.as_ref()).await;
			}
		}
	}

	let rest = decoder.finish();
	if !rest.is_empty() {
		emit_chunk(rest, on_chunk.as_ref()).await;
	}
}

async fn read_output_buffered(
	reader: fs::File,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	activity: Sender<()>,
	max_capture_bytes: usize,
) -> BufferedOutput {
	const BUF: usize = 65536;
	let mut buf = vec![0u8; BUF];
	let mut input_bytes = 0usize;
	// The decoded capture, built from the same decoder output that streams,
	// so the bytes are decoded once rather than again at the end.
	let mut captured = String::new();
	let mut captured_bytes = 0usize;
	let mut exceeded = false;
	let mut decoder = CaptureDecoder::new();

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
			let res = loop {
				tokio::select! {
					res = &mut read_future => break Some(res),
					() = cancel_token.cancelled() => break None,
					() = capture_line_idle(decoder.holds_line()) => {
						let text = decoder.flush_line();
						if !exceeded {
							captured.push_str(&text);
						}
						emit_chunk(text, on_chunk.as_ref()).await;
					}
				}
			};
			let Some(res) = res else {
				break;
			};
			match res {
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
		// `!output.exceeded` gate at the call site), so the capture serves no
		// purpose. Drop it to bound peak memory on commands that produce very
		// large output.
		if !exceeded && captured_bytes.saturating_add(n) > max_capture_bytes {
			exceeded = true;
			captured.clear();
			captured.shrink_to_fit();
		}
		captured_bytes = captured_bytes.saturating_add(n);

		let text = decoder.push(&buf[..n]);
		if !text.is_empty() {
			if !exceeded {
				captured.push_str(&text);
			}
			emit_chunk(text, on_chunk.as_ref()).await;
		}
	}

	let rest = decoder.finish();
	if !rest.is_empty() {
		if !exceeded {
			captured.push_str(&rest);
		}
		emit_chunk(rest, on_chunk.as_ref()).await;
	}

	BufferedOutput { text: captured, input_bytes, exceeded }
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
	(result >= 0).ok_or_else(io::Error::last_os_error)
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
async fn emit_chunk(text: String, callback: Option<&Sender<String>>) {
	if let Some(callback) = callback {
		let _ = callback.send_async(text).await;
	}
}

fn pipe_to_files(label: &str) -> Result<(fs::File, fs::File)> {
	let (r, w) =
		std::io::pipe().map_err(|err| Error::msg(format!("Failed to create {label} pipe: {err}")))?;

	#[cfg(unix)]
	use std::os::fd::OwnedFd as Owned;
	#[cfg(windows)]
	use std::os::windows::io::OwnedHandle as Owned;

	Ok((fs::File::from(Owned::from(r)), fs::File::from(Owned::from(w))))
}

#[cfg(test)]
mod tests;
