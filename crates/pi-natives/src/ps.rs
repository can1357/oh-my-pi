//! N-API bindings for cross-platform process tree management.
//!
//! The platform-specific implementation lives in [`pi_shell::process`]; this
//! module is a thin shim that exposes that crate's `Process` surface to
//! JavaScript and re-exports the termination primitives used by other native
//! modules (e.g. [`crate::pty`]).

use std::time::Duration;

use napi::{
	Env, JsString, Result,
	bindgen_prelude::{PromiseRaw, Unknown},
};
use napi_derive::napi;
use pi_shell::process::{self as core_process, ProcessStatus as CoreProcessStatus};
pub use pi_shell::process::{KILL_SIGNAL, TERM_SIGNAL, TerminationTargets, kill_process_group};

use crate::{js::into_string, task};

#[derive(Default)]
#[napi(object)]
pub struct ProcessTerminateOptions<'env> {
	/// Also signal the process group when supported by the platform.
	pub group:       Option<bool>,
	/// Milliseconds to wait after polite termination before hard-killing.
	/// Omit to use the default grace period. Pass a negative value to skip the
	/// graceful phase and hard-kill immediately.
	pub graceful_ms: Option<i32>,
	/// Milliseconds to wait after hard-kill for the process tree to exit.
	pub timeout_ms:  Option<u32>,
	/// Abort signal for cancelling termination while waiting.
	pub signal:      Option<Unknown<'env>>,
}

/// Options for waiting on a process exit.
#[derive(Default)]
#[napi(object)]
pub struct ProcessWaitOptions<'env> {
	/// Milliseconds to wait before returning false. Omit to wait indefinitely.
	pub timeout_ms: Option<u32>,
	/// Abort signal for cancelling the wait.
	pub signal:     Option<Unknown<'env>>,
}

/// Current state of a process reference.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum ProcessStatus {
	/// The referenced process is still running.
	#[napi(value = "running")]
	Running,
	/// The referenced process has exited or is no longer observable.
	#[napi(value = "exited")]
	Exited,
}

impl From<CoreProcessStatus> for ProcessStatus {
	fn from(value: CoreProcessStatus) -> Self {
		match value {
			CoreProcessStatus::Running => Self::Running,
			CoreProcessStatus::Exited => Self::Exited,
		}
	}
}

/// Stable process reference.
#[napi]
#[derive(Clone)]
pub struct Process {
	inner: core_process::Process,
}

#[napi]
#[allow(clippy::use_self, reason = "napi return types must name the exported class")]
impl Process {
	/// Open a stable process reference from a PID.
	#[napi]
	pub fn from_pid(pid: i32) -> Option<Process> {
		core_process::Process::from_pid(pid).map(Self::from_inner)
	}

	/// Open stable process references whose executable path matches exactly.
	#[napi]
	pub fn from_path(path: JsString) -> Result<Vec<Process>> {
		Ok(core_process::Process::from_path(into_string(path)?)
			.into_iter()
			.map(Self::from_inner)
			.collect())
	}

	/// Operating-system process identifier for this process reference.
	#[napi(getter)]
	pub const fn pid(&self) -> i32 {
		self.inner.pid()
	}

	/// Parent process id for this process, when available.
	#[napi(getter)]
	pub fn ppid(&self) -> Option<i32> {
		self.inner.ppid()
	}

	/// Launch arguments for this process.
	#[napi]
	pub fn args(&self) -> Vec<String> {
		self.inner.args()
	}

	/// Send `signal` to this process and its descendants, children first.
	///
	/// On Linux and macOS the signal is forwarded as-is. On Windows there is no
	/// signal abstraction, so the `signal` argument is ignored and the entire
	/// tree is hard-killed via `TerminateProcess`. Defaults to the POSIX
	/// hard-kill signal.
	#[napi]
	pub fn kill_tree(&self, signal: Option<i32>) -> u32 {
		self.inner.kill_tree(signal)
	}

	/// Gracefully terminate this process and its descendants.
	///
	/// By default this waits 1000ms after polite termination before
	/// hard-killing. Pass `graceful_ms < 0` to skip the graceful phase.
	#[napi]
	pub fn terminate<'env>(
		&self,
		env: &'env Env,
		options: Option<ProcessTerminateOptions<'env>>,
	) -> Result<PromiseRaw<'env, bool>> {
		let options = options.unwrap_or_default();
		let group = options.group.unwrap_or(false);
		let graceful_ms = options.graceful_ms.unwrap_or(1000);
		let timeout_ms = options.timeout_ms.unwrap_or(5000);
		let ct = task::CancelToken::new(None, options.signal);
		let process = self.inner.clone();
		task::future(env, "process.terminate", async move {
			process
				.terminate_tree(group, graceful_ms, timeout_ms, ct.into_core())
				.await
				.map_err(|err| napi::Error::from_reason(err.to_string()))
		})
	}

	/// Wait until this process exits.
	///
	/// When `options.timeout_ms` is omitted, waits until the process exits.
	#[napi]
	pub fn wait_for_exit<'env>(
		&self,
		env: &'env Env,
		options: Option<ProcessWaitOptions<'env>>,
	) -> Result<PromiseRaw<'env, bool>> {
		let options = options.unwrap_or_default();
		let ct = task::CancelToken::new(None, options.signal);
		let timeout = options
			.timeout_ms
			.map(|ms| Duration::from_millis(u64::from(ms)));
		let process = self.inner.clone();
		task::future(env, "process.wait_for_exit", async move {
			process
				.wait_for_exit(timeout, ct.into_core())
				.await
				.map_err(|err| napi::Error::from_reason(err.to_string()))
		})
	}

	/// Process group id for this process, when supported by the platform.
	#[napi]
	#[allow(clippy::missing_const_for_fn, reason = "#[napi] generates a non-const wrapper")]
	pub fn group_id(&self) -> Option<i32> {
		self.inner.group_id()
	}

	/// Direct children of this process as stable process references.
	#[napi]
	pub fn children(&self) -> Vec<Process> {
		self
			.inner
			.children()
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	/// Current status of this process reference.
	#[napi]
	pub fn status(&self) -> ProcessStatus {
		self.inner.status().into()
	}
}

impl Process {
	const fn from_inner(inner: core_process::Process) -> Self {
		Self { inner }
	}
}

/// Replace the current process image via `execvp(3)`.
///
/// On success this never returns: the kernel tears down every other thread and
/// the new program takes over this PID, controlling terminal, and inherited
/// (non-`CLOEXEC`) file descriptors. Callers must flush logs and restore the
/// terminal first — no JS or native cleanup runs after a successful call.
///
/// # Errors
/// Returns an error, leaving the process untouched, when `argv` is empty, an
/// argument contains an interior NUL byte, or the exec itself fails (e.g.
/// executable not found). Windows has no exec-replace semantics, so this
/// always errors there; callers fall back to spawn-and-wait.
#[napi]
pub fn exec_replace(argv: Vec<String>) -> Result<()> {
	#[cfg(unix)]
	{
		use std::ffi::CString;

		if argv.is_empty() {
			return Err(napi::Error::from_reason("exec_replace: argv must not be empty"));
		}
		let args = argv
			.into_iter()
			.map(CString::new)
			.collect::<std::result::Result<Vec<_>, _>>()
			.map_err(|err| napi::Error::from_reason(format!("exec_replace: {err}")))?;
		let mut ptrs: Vec<*const libc::c_char> = args.iter().map(|arg| arg.as_ptr()).collect();
		ptrs.push(std::ptr::null());
		// SAFETY: `ptrs` is a NUL-terminated array of pointers into `args`, which
		// outlives the call; execvp only returns on failure.
		unsafe { libc::execvp(ptrs[0], ptrs.as_ptr()) };
		Err(napi::Error::from_reason(format!("execvp failed: {}", std::io::Error::last_os_error())))
	}
	#[cfg(not(unix))]
	{
		let _ = argv;
		Err(napi::Error::from_reason("exec_replace is unsupported on this platform"))
	}
}
