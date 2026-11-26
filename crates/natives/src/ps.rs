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
	Some(start_to_epoch_ms()?(omp_builtins::proc_sys::start_time(pid)?))
}

/// Converts a kernel start time (`/proc/<pid>/stat` clock ticks since boot,
/// the unit of `omp_shell::sys::proc::ProcInfo::start`) to milliseconds since
/// the Unix epoch.
#[cfg(target_os = "linux")]
fn start_to_epoch_ms() -> Option<impl Fn(u64) -> f64> {
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
	let hz = hz as f64;
	Some(move |ticks: u64| (boot_secs + ticks as f64 / hz) * 1000.0)
}

/// Converts a kernel start time (µs since the epoch on macOS, the unit of
/// `omp_shell::sys::proc::ProcInfo::start`) to milliseconds since the epoch.
#[cfg(target_os = "macos")]
#[allow(clippy::unnecessary_wraps, reason = "matches the Linux conversion, which can fail")]
fn start_to_epoch_ms() -> Option<impl Fn(u64) -> f64> {
	Some(|micros: u64| micros as f64 / 1000.0)
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

/// A live process whose environment carries a given `NAME=value` entry.
#[napi(object)]
pub struct TaggedProcess {
	pub pid:            i32,
	pub ppid:           i32,
	/// ms since the epoch
	pub started_at:     f64,
	/// full command line, args joined by spaces
	pub command:        String,
	/// SIGHUP is ignored (nohup)
	pub ignores_hangup: bool,
	pub stopped:        bool,
}

/// Regular files a process's stdout/stderr point at.
#[napi(object)]
pub struct ProcessOutputFiles {
	pub stdout: Option<String>,
	pub stderr: Option<String>,
}

/// Options for [`kill_process_family`].
#[derive(Default)]
#[napi(object)]
pub struct KillProcessFamilyOptions {
	/// Leave members ignoring SIGHUP (`nohup`) and everything descended from
	/// them alive.
	pub spare_hangup_ignoring: Option<bool>,
}

/// Live processes (never the caller) whose environment contains exactly
/// `name=value`.
///
/// Reads the environment each process was exec'd with: only
/// the caller's user's processes are readable, others are skipped. macOS
/// also withholds the environment of Apple platform binaries (`/bin/sh`,
/// `/bin/sleep`, …) even from the same user, so those never match there.
/// Empty on platforms without a readable process environment (Windows).
#[napi]
pub fn list_processes_with_env(name: String, value: String) -> Result<Vec<TaggedProcess>> {
	scan::with_env(&name, &value).map_err(|err| napi::Error::from_reason(err.to_string()))
}

/// The record of each of `pids` that is alive (zombies and unknown pids
/// skipped), from one process-table scan. Empty on Windows.
#[napi]
pub fn process_info(pids: Vec<i32>) -> Result<Vec<TaggedProcess>> {
	scan::info(&pids).map_err(|err| napi::Error::from_reason(err.to_string()))
}

/// Regular files a process's stdout/stderr (fd 1/2) point at; a field is
/// undefined when that descriptor is not a regular file (pipe, terminal,
/// socket, deleted file) or unreadable.
#[napi]
pub fn process_output_files(pid: i32) -> ProcessOutputFiles {
	ProcessOutputFiles { stdout: scan::output_file(pid, 1), stderr: scan::output_file(pid, 2) }
}

/// SIGKILL every process of the family of `pids`; returns the number
/// signalled.
///
/// One process-table snapshot, the ppid walk plus every group/session a
/// member leads, then SIGCONT the stopped ones. With `spareHangupIgnoring`,
/// members ignoring SIGHUP and everything descended (ppid chain) from them
/// are left alone. Windows kills each pid's tree.
#[napi]
pub fn kill_process_family(
	pids: Vec<i32>,
	options: Option<KillProcessFamilyOptions>,
) -> Result<u32> {
	let spare = options
		.unwrap_or_default()
		.spare_hangup_ignoring
		.unwrap_or(false);
	scan::kill_family(&pids, spare).map_err(|err| napi::Error::from_reason(err.to_string()))
}

/// Environment-tagged process scans and family kills over the shell's
/// process table.
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod scan {
	use std::{
		collections::{HashMap, HashSet},
		io,
	};

	use omp_builtins::proc_sys;
	use omp_shell::sys::proc::{self, ProcInfo, ProcState};

	use super::TaggedProcess;

	pub fn with_env(name: &str, value: &str) -> io::Result<Vec<TaggedProcess>> {
		let entry = format!("{name}={value}");
		let me = std::process::id() as i32;
		live(|p| p.pid != me && proc_sys::has_env_entry(p.pid, entry.as_bytes()))
	}

	pub fn info(pids: &[i32]) -> io::Result<Vec<TaggedProcess>> {
		live(|p| pids.contains(&p.pid))
	}

	/// The records of the live (not zombie) processes `select` picks, from
	/// one process-table scan.
	fn live(select: impl Fn(&ProcInfo) -> bool) -> io::Result<Vec<TaggedProcess>> {
		let epoch_ms = super::start_to_epoch_ms()
			.ok_or_else(|| io::Error::other("the kernel boot time is unavailable"))?;
		Ok(proc::list()?
			.into_iter()
			.filter(|p| p.state != ProcState::Zombie && select(p))
			.map(|p| TaggedProcess {
				pid:            p.pid,
				ppid:           p.ppid,
				started_at:     epoch_ms(p.start),
				command:        command_line(&p),
				ignores_hangup: proc_sys::ignores_hangup(p.pid).unwrap_or(false),
				stopped:        p.state == ProcState::Stopped,
			})
			.collect())
	}

	/// argv joined by spaces; the command name when argv is unreadable.
	fn command_line(p: &ProcInfo) -> String {
		#[cfg(target_os = "linux")]
		let args = proc_sys::cmdline(p.pid).unwrap_or_default();
		#[cfg(target_os = "macos")]
		let args = proc_sys::args(p.pid);
		if args.is_empty() {
			p.name.to_string()
		} else {
			args.join(" ")
		}
	}

	pub fn output_file(pid: i32, fd: i32) -> Option<String> {
		proc_sys::output_file(pid, fd)?
			.into_os_string()
			.into_string()
			.ok()
	}

	pub fn kill_family(pids: &[i32], spare_hangup_ignoring: bool) -> io::Result<u32> {
		let table = proc::list()?;
		let roots: Vec<ProcInfo> = table
			.iter()
			.filter(|p| pids.contains(&p.pid))
			.cloned()
			.collect();
		let mut members = proc::family(&table, &roots);
		if spare_hangup_ignoring {
			let spared = hangup_spared(&members);
			members.retain(|p| !spared.contains(&p.pid));
		}
		Ok(u32::try_from(proc::signal_each(&members, libc::SIGKILL)).unwrap_or(u32::MAX))
	}

	/// Pids of `members` that ignore SIGHUP or descend from a member that
	/// does, following parent links through `members`.
	fn hangup_spared(members: &[ProcInfo]) -> HashSet<i32> {
		let parent: HashMap<i32, i32> = members.iter().map(|p| (p.pid, p.ppid)).collect();
		let ignoring: HashSet<i32> = members
			.iter()
			.filter(|p| proc_sys::ignores_hangup(p.pid) == Some(true))
			.map(|p| p.pid)
			.collect();
		members
			.iter()
			.map(|p| p.pid)
			.filter(|&pid| {
				let mut current = pid;
				// Bounded: a ppid cycle (pid reuse mid-snapshot) cannot spin.
				for _ in 0..=members.len() {
					if ignoring.contains(&current) {
						return true;
					}
					let Some(&ppid) = parent.get(&current) else {
						return false;
					};
					current = ppid;
				}
				false
			})
			.collect()
	}
}

/// No readable process environment: scans find nothing, family kills take
/// each pid's tree.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod scan {
	use std::io;

	use super::{TaggedProcess, core_process};

	#[allow(clippy::unnecessary_wraps, reason = "matches the Unix scan, which can fail")]
	pub const fn with_env(_name: &str, _value: &str) -> io::Result<Vec<TaggedProcess>> {
		Ok(Vec::new())
	}

	#[allow(clippy::unnecessary_wraps, reason = "matches the Unix scan, which can fail")]
	pub const fn info(_pids: &[i32]) -> io::Result<Vec<TaggedProcess>> {
		Ok(Vec::new())
	}

	pub const fn output_file(_pid: i32, _fd: i32) -> Option<String> {
		None
	}

	#[allow(clippy::unnecessary_wraps, reason = "matches the Unix kill, which can fail")]
	pub fn kill_family(pids: &[i32], _spare_hangup_ignoring: bool) -> io::Result<u32> {
		Ok(pids
			.iter()
			.filter_map(|&pid| core_process::Process::from_pid(pid))
			.map(|process| process.kill_tree(None))
			.sum())
	}
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests {
	use std::{
		os::unix::process::CommandExt,
		process::{Child, Command, Stdio},
		sync::atomic::{AtomicU32, Ordering},
		time::{Duration, Instant},
	};

	use omp_shell::sys::proc::{self, ProcState};

	use super::{
		KillProcessFamilyOptions, TaggedProcess, kill_process_family, list_processes_with_env,
		process_info, process_output_files,
	};

	const TAG: &str = "OMP_PS_TEST_TAG";
	/// Set in [`sleeper`]'s environment when a test spawns it.
	const SLEEPER: &str = "OMP_PS_TEST_SLEEPER";
	/// [`sleeper`]'s libtest name.
	const SLEEPER_TEST: &str = "ps::tests::sleeper";

	/// The child process of these tests: this test binary re-run for this
	/// test alone. macOS withholds the environment of Apple platform binaries
	/// (`/bin/sleep`, `/bin/sh`) from `KERN_PROCARGS2`; the test binary is not
	/// one, so its tag is readable on both platforms.
	#[test]
	#[ignore = "a child process of the tests above; idles only when they spawn it"]
	fn sleeper() {
		if std::env::var_os(SLEEPER).is_some() {
			std::thread::sleep(Duration::from_secs(60));
		}
	}

	fn test_binary() -> String {
		std::env::current_exe()
			.expect("test binary path")
			.into_os_string()
			.into_string()
			.expect("UTF-8 test binary path")
	}

	/// The command line of a [`sleeper`] spawned for `role`: an extra libtest
	/// filter that matches no test and tells the sleepers apart.
	fn sleeper_command_line(role: &str) -> String {
		format!("{} {SLEEPER_TEST} {role} --exact --ignored", test_binary())
	}

	/// A tag value no other test (or test run) shares.
	fn unique_value() -> String {
		static NEXT: AtomicU32 = AtomicU32::new(0);
		format!("{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed))
	}

	/// Processes spawned with one tag; on drop SIGKILLs every process still
	/// carrying it and reaps the direct children.
	struct Tagged {
		value:    String,
		children: Vec<Child>,
	}

	impl Tagged {
		fn new() -> Self {
			Self { value: unique_value(), children: Vec::new() }
		}

		/// Spawns `command` tagged, with SIGHUP at `hangup` whatever the test
		/// runner inherited; returns its pid.
		fn spawn(&mut self, mut command: Command, hangup: libc::sighandler_t, stdout: Stdio) -> i32 {
			command
				.env(TAG, &self.value)
				.env(SLEEPER, "1")
				.stdin(Stdio::null())
				.stdout(stdout)
				.stderr(Stdio::null());
			// SAFETY: signal(2) is async-signal-safe.
			unsafe {
				command.pre_exec(move || {
					libc::signal(libc::SIGHUP, hangup);
					Ok(())
				});
			}
			let child = command.spawn().expect("spawn tagged child");
			let pid = child.id() as i32;
			self.children.push(child);
			pid
		}

		fn sleeper(&mut self, role: &str, hangup: libc::sighandler_t, stdout: Stdio) -> i32 {
			let mut command = Command::new(test_binary());
			command.args([SLEEPER_TEST, role, "--exact", "--ignored"]);
			self.spawn(command, hangup, stdout)
		}

		/// `/bin/sh -c script` with `$BIN` the test binary and `$TEST` the
		/// sleeper's name.
		fn shell(&mut self, script: &str) -> i32 {
			let mut command = Command::new("/bin/sh");
			command
				.args(["-c", script])
				.env("BIN", test_binary())
				.env("TEST", SLEEPER_TEST);
			self.spawn(command, libc::SIG_DFL, Stdio::null())
		}

		fn list(&self) -> Vec<TaggedProcess> {
			list_processes_with_env(TAG.to_owned(), self.value.clone()).expect("scan")
		}

		/// The tagged processes once the sleepers of every one of `roles` run.
		fn wait_for(&self, roles: &[&str]) -> Vec<TaggedProcess> {
			let deadline = Instant::now() + Duration::from_secs(10);
			loop {
				let found = self.list();
				if roles.iter().all(|role| by_role(&found, role).is_some()) {
					return found;
				}
				assert!(
					Instant::now() < deadline,
					"sleepers {roles:?} never all ran: {:?}",
					found.iter().map(|p| &p.command).collect::<Vec<_>>()
				);
				std::thread::sleep(Duration::from_millis(20));
			}
		}
	}

	impl Drop for Tagged {
		fn drop(&mut self) {
			for p in list_processes_with_env(TAG.to_owned(), self.value.clone()).unwrap_or_default() {
				// SAFETY: plain syscall; the pids carry this test's tag.
				unsafe { libc::kill(p.pid, libc::SIGKILL) };
			}
			for child in &mut self.children {
				let _ = child.kill();
				let _ = child.wait();
			}
		}
	}

	/// The sleeper spawned for `role` (a shell whose script names the role
	/// does not count).
	fn by_role<'a>(found: &'a [TaggedProcess], role: &str) -> Option<&'a TaggedProcess> {
		let command = sleeper_command_line(role);
		found.iter().find(|p| p.command == command)
	}

	fn gone_now(pid: i32) -> bool {
		proc::info(pid).is_none_or(|p| p.state == ProcState::Zombie)
	}

	fn gone(pid: i32) -> bool {
		let deadline = Instant::now() + Duration::from_secs(10);
		while !gone_now(pid) {
			if Instant::now() >= deadline {
				return false;
			}
			std::thread::sleep(Duration::from_millis(20));
		}
		true
	}

	fn now_ms() -> f64 {
		std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap()
			.as_millis() as f64
	}

	#[test]
	fn env_scan_reports_tagged_processes_with_kind_and_command() {
		let mut tagged = Tagged::new();
		let ignoring = tagged.sleeper("ignoring", libc::SIG_IGN, Stdio::null());
		let default = tagged.sleeper("default", libc::SIG_DFL, Stdio::null());
		let found = tagged.wait_for(&["ignoring", "default"]);
		assert_eq!(found.len(), 2, "only the tagged pair");
		let me = std::process::id() as i32;
		let nohup = by_role(&found, "ignoring").unwrap();
		let plain = by_role(&found, "default").unwrap();
		assert_eq!((nohup.pid, plain.pid), (ignoring, default));
		assert_eq!((nohup.ppid, plain.ppid), (me, me));
		assert!(nohup.ignores_hangup && !plain.ignores_hangup);
		assert!(!nohup.stopped && !plain.stopped);
		let now = now_ms();
		assert!(
			(now - 60_000.0..=now + 60_000.0).contains(&plain.started_at),
			"start time {} is about now ({now})",
			plain.started_at
		);
		assert!(
			list_processes_with_env(TAG.to_owned(), "absent".to_owned())
				.unwrap()
				.is_empty()
		);
	}

	#[test]
	fn process_info_reports_live_pids_only() {
		let mut tagged = Tagged::new();
		let live = tagged.sleeper("live", libc::SIG_IGN, Stdio::null());
		// An exited, unreaped child (a filter matching no test exits at once):
		// a zombie until the guard reaps it.
		let mut exits = Command::new(test_binary());
		exits.args(["no-such-test", "--exact"]);
		let zombie = tagged.spawn(exits, libc::SIG_DFL, Stdio::null());
		let deadline = Instant::now() + Duration::from_secs(10);
		while proc::info(zombie).is_some_and(|p| p.state != ProcState::Zombie) {
			assert!(Instant::now() < deadline, "the child never exited");
			std::thread::sleep(Duration::from_millis(20));
		}
		let found = process_info(vec![live, zombie, i32::MAX]).unwrap();
		assert_eq!(found.len(), 1, "only the live pid");
		let p = &found[0];
		assert_eq!((p.pid, p.ppid), (live, std::process::id() as i32));
		assert_eq!(p.command, sleeper_command_line("live"));
		assert!(p.ignores_hangup && !p.stopped);
		let now = now_ms();
		assert!((now - 60_000.0..=now + 60_000.0).contains(&p.started_at));
		assert!(process_info(Vec::new()).unwrap().is_empty());
	}

	#[test]
	fn family_kill_spares_hangup_ignoring_members_and_their_descendants() {
		// `child` restores SIGHUP's default: spared only as a descendant of
		// the nohup'd `parent`.
		let mut tagged = Tagged::new();
		let root = tagged.shell(
			r#""$BIN" "$TEST" plain --exact --ignored &
(trap '' HUP; (trap - HUP; exec "$BIN" "$TEST" child --exact --ignored) & exec "$BIN" "$TEST" parent --exact --ignored) &
wait"#,
		);
		let found = tagged.wait_for(&["child", "parent", "plain"]);
		let (spared_child, spared_parent, plain) = (
			by_role(&found, "child").unwrap(),
			by_role(&found, "parent").unwrap(),
			by_role(&found, "plain").unwrap(),
		);
		assert!(
			spared_parent.ignores_hangup && !spared_child.ignores_hangup && !plain.ignores_hangup
		);
		assert_eq!(spared_child.ppid, spared_parent.pid);
		assert_eq!((spared_parent.ppid, plain.ppid), (root, root));
		let (spared_child, spared_parent, plain) = (spared_child.pid, spared_parent.pid, plain.pid);
		let options = KillProcessFamilyOptions { spare_hangup_ignoring: Some(true) };
		assert_eq!(
			kill_process_family(vec![root], Some(options)).unwrap(),
			2,
			"the shell and `plain`"
		);
		assert!(gone(plain), "plain background child killed");
		assert!(!gone_now(spared_parent) && !gone_now(spared_child), "nohup'd subtree spared");
		assert_eq!(kill_process_family(vec![spared_parent], None).unwrap(), 2);
		assert!(gone(spared_parent) && gone(spared_child));
	}

	#[test]
	fn output_files_name_a_regular_stdout_only() {
		let dir = tempfile::tempdir().expect("temp dir");
		let log = dir.path().join("nohup.out");
		let file = std::fs::File::create(&log).expect("create log");
		let mut tagged = Tagged::new();
		let pid = tagged.sleeper("output", libc::SIG_DFL, Stdio::from(file));
		let files = process_output_files(pid);
		assert_eq!(
			files
				.stdout
				.map(|path| std::fs::canonicalize(path).unwrap()),
			Some(std::fs::canonicalize(&log).unwrap())
		);
		assert_eq!(files.stderr, None, "/dev/null is no regular file");
	}
}
