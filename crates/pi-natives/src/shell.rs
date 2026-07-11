//! Brush-based shell execution exported via N-API.

use std::{collections::HashMap, sync::Arc};

use napi::{
	Env, Result,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
	tokio::sync::mpsc,
};
use napi_derive::napi;
use pi_shell::{
	MinimizerResult as CoreMinimizerResult, Shell as CoreShell,
	ShellExecuteOptions as CoreShellExecuteOptions, ShellOptions as CoreShellOptions,
	ShellRunOptions as CoreShellRunOptions, ShellRunResult as CoreShellRunResult,
	execute_shell as core_execute_shell,
	fixup::{BashFixupResult as CoreBashFixupResult, apply_bash_fixups as core_apply_bash_fixups},
	minimizer,
};

use crate::task;

/// N-API opt-in handle for the minimizer.
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct MinimizerOptions {
	/// Master switch. Absent / false = disabled.
	pub enabled:              Option<bool>,
	/// Optional path to a TOML settings file whose values override
	/// field-level defaults. `~` is expanded.
	pub settings_path:        Option<String>,
	/// Optional xxHash64 digest (hex) of the settings file contents. When
	/// supplied, the engine refuses to honor a settings file whose hash does
	/// not match — a lightweight trust gate for agent-controllable paths.
	pub settings_hash:        Option<String>,
	/// Opt-in allowlist of program names (e.g. `"git"`). When empty or
	/// absent, all built-in filters are active.
	pub only:                 Option<Vec<String>>,
	/// Program names explicitly excluded from minimization.
	pub except:               Option<Vec<String>>,
	/// Maximum captured bytes per command before the engine falls back to
	/// the raw, un-minimized output. Default 4 MiB.
	pub max_capture_bytes:    Option<u32>,
	/// Source-outline level for `cat <source-file>` minimization. Accepts
	/// `"default"` (current behavior) or `"aggressive"` (strip function bodies).
	pub source_outline_level: Option<String>,
	/// Kill-switch to fall back to the pre-PR (legacy) filter behavior for
	/// grep / find / pytest. When `Some(true)`, filters that opted into the
	/// always-shrink Tier 1 / Tier 2 behavior skip the new code path. When
	/// `None`, defers to the `OMP_MINIMIZER_LEGACY_FILTERS` env var.
	pub legacy_filters:       Option<bool>,
}

impl From<MinimizerOptions> for minimizer::MinimizerOptions {
	fn from(value: MinimizerOptions) -> Self {
		Self {
			enabled:              value.enabled,
			settings_path:        value.settings_path,
			settings_hash:        value.settings_hash,
			only:                 value.only,
			except:               value.except,
			max_capture_bytes:    value.max_capture_bytes,
			source_outline_level: value.source_outline_level,
			legacy_filters:       value.legacy_filters,
		}
	}
}

/// Options for configuring a persistent shell session.
#[napi(object)]
pub struct ShellOptions {
	/// Environment variables to apply once per session.
	pub session_env:   Option<HashMap<String, String>>,
	/// Optional snapshot file to source on session creation.
	pub snapshot_path: Option<String>,
	/// Optional per-command output minimizer configuration.
	pub minimizer:     Option<MinimizerOptions>,
}

impl From<ShellOptions> for CoreShellOptions {
	fn from(value: ShellOptions) -> Self {
		Self {
			session_env:   value.session_env,
			snapshot_path: value.snapshot_path,
			minimizer:     value.minimizer.map(Into::into),
		}
	}
}

/// Options for running a shell command.
#[napi(object)]
pub struct ShellRunOptions<'env> {
	/// Command string to execute in the shell.
	pub command:    String,
	/// Working directory for the command.
	pub cwd:        Option<String>,
	/// Environment variables to apply for this command only.
	pub env:        Option<HashMap<String, String>>,
	/// Timeout in milliseconds before cancelling the command.
	pub timeout_ms: Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:     Option<Unknown<'env>>,
}

/// Options for executing a shell command via brush-core.
#[napi(object)]
pub struct ShellExecuteOptions<'env> {
	/// Command string to execute in the shell.
	pub command:       String,
	/// Working directory for the command.
	pub cwd:           Option<String>,
	/// Environment variables to apply for this command only.
	pub env:           Option<HashMap<String, String>>,
	/// Environment variables to apply once per session.
	pub session_env:   Option<HashMap<String, String>>,
	/// Timeout in milliseconds before cancelling the command.
	pub timeout_ms:    Option<u32>,
	/// Optional snapshot file to source on session creation.
	pub snapshot_path: Option<String>,
	/// Optional per-command output minimizer configuration.
	pub minimizer:     Option<MinimizerOptions>,
	/// Abort signal for cancelling the operation.
	pub signal:        Option<Unknown<'env>>,
}

/// Telemetry for a single minimization.
///
/// Surfaced when the minimizer actually rewrote the command's output. The
/// session layer is expected to persist `original_text` via its
/// `ArtifactManager`, splice the resulting `artifact://<id>` reference
/// into `text`, and replace any previously streamed raw output with the
/// minimized text.
#[napi(object)]
pub struct MinimizerResult {
	/// Dispatch label produced by the minimizer (e.g. `"git"`,
	/// `"pipeline:gradle"`, `"pipeline+builtin"`).
	pub filter:        String,
	/// The minimized replacement text. Callers that streamed raw chunks
	/// during execution should clear and replace their accumulated output
	/// with this text.
	pub text:          String,
	/// The full original capture, before minimization.
	pub original_text: String,
	/// Captured byte length before minimization.
	pub input_bytes:   u32,
	/// Byte length of the minimized text the consumer received.
	pub output_bytes:  u32,
}

impl From<CoreMinimizerResult> for MinimizerResult {
	fn from(value: CoreMinimizerResult) -> Self {
		Self {
			filter:        value.filter,
			text:          value.text,
			original_text: value.original_text,
			input_bytes:   value.input_bytes,
			output_bytes:  value.output_bytes,
		}
	}
}

/// Result of running a shell command.
#[napi(object)]
pub struct ShellRunResult {
	/// Exit code when the command completes normally.
	pub exit_code: Option<i32>,
	/// Whether the command was cancelled via abort.
	pub cancelled: bool,
	/// Whether the command timed out before completion.
	pub timed_out: bool,
	/// When the minimizer rewrote the captured output, this carries the
	/// original buffer + telemetry so the session layer can persist it as
	/// an artifact and splice an `artifact://<id>` reference into the
	/// minimized text shown to the agent. `None` when nothing was rewritten.
	pub minimized: Option<MinimizerResult>,
}

impl From<CoreShellRunResult> for ShellRunResult {
	fn from(value: CoreShellRunResult) -> Self {
		Self {
			exit_code: value.exit_code,
			cancelled: value.cancelled,
			timed_out: value.timed_out,
			minimized: value.minimized.map(Into::into),
		}
	}
}

/// Persistent brush-core shell session.
#[napi]
pub struct Shell {
	inner: Arc<CoreShell>,
}

#[napi]
impl Shell {
	/// Create a new shell session from optional configuration.
	///
	/// The options set session-scoped environment variables and a snapshot path.
	#[napi(constructor)]
	pub fn new(options: Option<ShellOptions>) -> Self {
		Self { inner: Arc::new(CoreShell::new(options.map(Into::into))) }
	}

	/// Run a shell command using the provided options.
	///
	/// The `on_chunk` callback receives streamed stdout/stderr output. Returns
	/// the exit code when the command completes, or flags when cancelled or
	/// timed out.
	#[napi]
	pub fn run<'env>(
		&self,
		env: &'env Env,
		options: ShellRunOptions<'env>,
		#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
		on_chunk: Option<ThreadsafeFunction<String>>,
	) -> Result<PromiseRaw<'env, ShellRunResult>> {
		let cancel_token = task::CancelToken::new(options.timeout_ms, options.signal);
		let inner = Arc::clone(&self.inner);
		let run_options = CoreShellRunOptions {
			command:    options.command,
			cwd:        options.cwd,
			env:        options.env,
			timeout_ms: options.timeout_ms,
		};
		task::future(env, "shell.run", async move {
			let (chunk_tx, drain_handle) = bridge_chunks(on_chunk);
			let result = inner
				.run(run_options, chunk_tx, cancel_token.into_core())
				.await
				.map(Into::into)
				.map_err(|err| Error::from_reason(err.to_string()));
			if let Some(handle) = drain_handle {
				let _ = handle.await;
			}
			result
		})
	}

	/// Abort all running commands for this shell session.
	///
	/// Returns `Ok(())` even when no commands are running.
	#[napi]
	pub async fn abort(&self) -> Result<()> {
		self.inner.abort().await;
		Ok(())
	}

	/// Count live background jobs (`&`/`nohup` children still running) on this
	/// session. Completed jobs are reaped first. The host uses this to retain a
	/// per-call shell whose background processes are still running instead of
	/// dropping it (which would SIGKILL them via kill-on-drop).
	#[napi]
	pub async fn live_background_job_count(&self) -> u32 {
		self.inner.live_background_job_count().await
	}
}

/// Execute a brush shell command.
///
/// Creates a fresh session for each call. The `on_chunk` callback receives
/// streamed stdout/stderr output. Returns the exit code when the command
/// completes, or flags when cancelled or timed out.
#[napi]
pub fn execute_shell<'env>(
	env: &'env Env,
	options: ShellExecuteOptions<'env>,
	#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
	on_chunk: Option<ThreadsafeFunction<String>>,
) -> Result<PromiseRaw<'env, ShellRunResult>> {
	let cancel_token = task::CancelToken::new(options.timeout_ms, options.signal);
	let exec_options = CoreShellExecuteOptions {
		command:       options.command,
		cwd:           options.cwd,
		env:           options.env,
		session_env:   options.session_env,
		timeout_ms:    options.timeout_ms,
		snapshot_path: options.snapshot_path,
		minimizer:     options.minimizer.map(Into::into),
	};
	task::future(env, "shell.execute", async move {
		let (chunk_tx, drain_handle) = bridge_chunks(on_chunk);
		let result = core_execute_shell(exec_options, chunk_tx, cancel_token.into_core())
			.await
			.map(Into::into)
			.map_err(|err| Error::from_reason(err.to_string()));
		if let Some(handle) = drain_handle {
			let _ = handle.await;
		}
		result
	})
}

fn bridge_chunks(
	on_chunk: Option<ThreadsafeFunction<String>>,
) -> (Option<mpsc::UnboundedSender<String>>, Option<napi::tokio::task::JoinHandle<()>>) {
	let Some(on_chunk) = on_chunk else {
		return (None, None);
	};
	let (tx, mut rx) = mpsc::unbounded_channel::<String>();
	let handle = napi::tokio::spawn(async move {
		// Hard cap on one coalesced batch so the JS main thread never sees a
		// multi-MB napi callback (a giant single string would stall sanitize +
		// tail-buffer maintenance for the whole copy).
		const MAX_BATCH_BYTES: usize = 64 * 1024;
		// Initial capacity sized for typical bursty pipe output. Re-allocated
		// each batch because `String` ownership is moved into the napi call.
		const INITIAL_BATCH_CAP: usize = 8 * 1024;
		let mut batch = String::with_capacity(INITIAL_BATCH_CAP);
		while let Some(first) = rx.recv().await {
			batch.push_str(&first);
			// Greedily drain everything already queued. Child processes that
			// write byte-at-a-time (printf-style progress, llama-cli token
			// streams) otherwise produce one napi callback per `write(2)`,
			// saturating the JS main thread (~200% CPU observed) and leaving
			// the queue draining long after the child exits.
			while batch.len() < MAX_BATCH_BYTES {
				match rx.try_recv() {
					Ok(more) => batch.push_str(&more),
					Err(_) => break,
				}
			}
			let payload = std::mem::replace(&mut batch, String::with_capacity(INITIAL_BATCH_CAP));
			on_chunk.call(Ok(payload), ThreadsafeFunctionCallMode::NonBlocking);
		}
	});
	(Some(tx), Some(handle))
}

/// Result of [`apply_bash_fixups`]: a possibly-rewritten command plus the
/// substrings that were removed (in source order).
#[napi(object)]
pub struct BashFixupResult {
	/// Possibly-rewritten command. Equal to the input when no fixup fired.
	pub command:  String,
	/// Substrings removed, in source order — suitable for a user-facing notice.
	pub stripped: Vec<String>,
}

impl From<CoreBashFixupResult> for BashFixupResult {
	fn from(value: CoreBashFixupResult) -> Self {
		Self { command: value.command, stripped: value.stripped }
	}
}

/// Apply conservative pre-execution rewrites to a bash command.
///
/// Strips trailing `| head|tail [safe-args]` and redundant trailing `2>&1`
/// from each top-level pipeline. The full rules and bail conditions live in
/// `pi_shell::fixup`. Synchronous and cheap (one parse pass over the input).
#[napi]
pub fn apply_bash_fixups(command: String) -> BashFixupResult {
	core_apply_bash_fixups(&command).into()
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use pi_shell::{
		ShellRunOptions as CoreShellRunOptions,
		cancel::{AbortReason, CancelToken},
	};
	#[cfg(unix)]
	use tokio::sync::mpsc;
	use tokio::time;

	use super::CoreShell;

	mod child_session_action_tests {
		use pi_shell::{ChildSessionAction, child_session_action};

		#[test]
		fn interactive_with_terminal_stdin_takes_foreground() {
			assert_eq!(child_session_action(true, true, false), ChildSessionAction::TakeForeground);
			assert_eq!(child_session_action(true, true, true), ChildSessionAction::TakeForeground);
		}

		#[test]
		fn non_terminal_stdin_detaches_regardless_of_pipeline() {
			assert_eq!(child_session_action(true, false, false), ChildSessionAction::DetachSession);
			// A leading-new-pgroup stage of a pipeline still detaches: setsid keeps
			// it off the host's controlling tty.
			assert_eq!(child_session_action(true, false, true), ChildSessionAction::DetachSession);
		}

		#[test]
		fn non_interactive_with_terminal_stdin_does_nothing() {
			assert_eq!(child_session_action(false, true, false), ChildSessionAction::None);
		}

		#[test]
		fn non_interactive_terminal_stdin_in_pipeline_does_nothing() {
			assert_eq!(child_session_action(false, true, true), ChildSessionAction::None);
		}

		#[test]
		fn embedded_host_with_non_terminal_stdin_detaches() {
			assert_eq!(child_session_action(false, false, false), ChildSessionAction::DetachSession);
		}

		#[test]
		fn pipeline_stage_with_non_terminal_stdin_detaches() {
			// Regression: an interactive child inside a pipeline (`zsh -i | awk`)
			// must not stay in the host session and seize its tty. Pre-fix this
			// returned `None`, leaving the stage attached and able to SIGTTIN the host.
			assert_eq!(child_session_action(false, false, true), ChildSessionAction::DetachSession);
		}
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn embedded_external_command_runs_in_its_own_session() {
		let shell = CoreShell::new(None);
		let (tx, mut rx) = mpsc::unbounded_channel::<String>();
		let handle = tokio::spawn(async move {
			shell
				.run(
					CoreShellRunOptions {
						command:    "/bin/sh -c 'printf \"%d\\n\" \"$$\"; sleep 0.5'".to_string(),
						cwd:        None,
						env:        None,
						timeout_ms: None,
					},
					Some(tx),
					CancelToken::default(),
				)
				.await
		});
		let child_pid = time::timeout(Duration::from_secs(5), rx.recv())
			.await
			.expect("timed out waiting for child pid")
			.expect("missing child pid chunk")
			.trim()
			.parse::<i32>()
			.expect("child pid parses");
		// SAFETY: `getsid(0)` only queries the current process session; the
		// return value is checked below. Inside a PID namespace (e.g. the
		// containerized CI runner) the host's session leader can live outside
		// the namespace, so `getsid(0)` legitimately reports 0 — only -1 is a
		// real failure. The meaningful invariant is that the child detached
		// into its own session (`child_sid == child_pid`, distinct from host).
		let host_sid = unsafe { libc::getsid(0) };
		assert!(host_sid >= 0, "getsid(0) failed: {}", std::io::Error::last_os_error());
		// SAFETY: `child_pid` is a live positive PID reported by the child; the
		// return value is checked below.
		let child_sid = unsafe { libc::getsid(child_pid) };
		assert!(child_sid > 0, "getsid({child_pid}) failed: {}", std::io::Error::last_os_error());
		let result = handle
			.await
			.expect("shell task panicked")
			.expect("shell run");
		assert_eq!(result.exit_code, Some(0));
		assert_ne!(child_sid, host_sid);
		assert_eq!(child_sid, child_pid);
	}

	#[tokio::test]
	async fn read_output_stops_when_cancelled_before_pipe_eof() {
		let shell = CoreShell::new(None);
		let mut cancel = CancelToken::default();
		let abort = cancel.emplace_abort_token();
		let handle = tokio::spawn(async move {
			shell
				.run(
					CoreShellRunOptions {
						command:    "sh -c 'sleep 30 & wait'".to_string(),
						cwd:        None,
						env:        None,
						timeout_ms: None,
					},
					None,
					cancel,
				)
				.await
		});

		time::sleep(Duration::from_millis(10)).await;
		abort.abort(AbortReason::Signal);
		let result = time::timeout(Duration::from_secs(3), handle)
			.await
			.expect("shell run should stop after cancellation")
			.expect("shell task should not panic")
			.expect("shell run should return");
		assert!(result.cancelled);
	}
}
