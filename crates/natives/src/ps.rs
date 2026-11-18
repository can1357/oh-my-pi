//! N-API bindings for cross-platform process tree management.
//!
//! The platform-specific implementation lives in [`omp_shell::proctree`]; this
//! module is a thin shim that exposes that crate's `Process` surface to
//! JavaScript and re-exports the termination primitives used by other native
//! modules (e.g. [`crate::pty`]).

use std::time::Duration;

use napi::{
	Env, JsString, Result,
	bindgen_prelude::{PromiseRaw, Unknown},
};
use napi_derive::napi;
use omp_shell::proctree::{self as core_process, ProcessStatus as CoreProcessStatus};
pub use omp_shell::proctree::{KILL_SIGNAL, TERM_SIGNAL, TerminationTargets, kill_process_group};

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
	///
	/// Returns a conservative count of successful signal deliveries: one per
	/// successful group call or pinned-process send, not an exact count of
	/// distinct recipients.
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

	/// Process start time in milliseconds since the Unix epoch, when the
	/// platform reports it; a pid-reuse guard for re-adopting processes.
	#[napi]
	pub fn start_time(&self) -> Option<f64> {
		start_time_ms(self.inner.pid())
	}
}

impl Process {
	const fn from_inner(inner: core_process::Process) -> Self {
		Self { inner }
	}
}

/// Start time of `pid` in milliseconds since the Unix epoch.
#[cfg(target_os = "linux")]
fn start_time_ms(pid: i32) -> Option<f64> {
	let ticks = omp_builtins::proc_sys::start_time(pid)? as f64;
	// SAFETY: sysconf reads a process-global constant.
	let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
	if hz <= 0 {
		return None;
	}
	let stat = std::fs::read_to_string("/proc/stat").ok()?;
	let boot_secs: f64 = stat
		.lines()
		.find_map(|line| line.strip_prefix("btime "))?
		.trim()
		.parse()
		.ok()?;
	Some((boot_secs + ticks / hz as f64) * 1000.0)
}

/// Start time of `pid` in milliseconds since the Unix epoch.
#[cfg(target_os = "macos")]
fn start_time_ms(pid: i32) -> Option<f64> {
	let info = omp_builtins::proc_sys::bsdinfo(pid)?;
	Some((info.pbi_start_tvsec as f64).mul_add(1000.0, info.pbi_start_tvusec as f64 / 1000.0))
}

/// Start time of `pid` in milliseconds since the Unix epoch.
#[cfg(windows)]
fn start_time_ms(pid: i32) -> Option<f64> {
	use omp_builtins::proc_sys as sys;
	/// FILETIME ticks (100 ns) between 1601-01-01 and 1970-01-01.
	const EPOCH_DELTA_TICKS: u64 = 116_444_736_000_000_000;
	let handle =
		sys::open_process(u32::try_from(pid).ok()?, sys::PROCESS_QUERY_LIMITED_INFORMATION)?;
	let creation = sys::process_times(&handle)?.0;
	Some(creation.checked_sub(EPOCH_DELTA_TICKS)? as f64 / 10_000.0)
}

/// Start time of `pid` in milliseconds since the Unix epoch.
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn start_time_ms(_pid: i32) -> Option<f64> {
	None
}
