use std::{io, time::Duration};

use nix::{
	sys::signal::{Signal, killpg},
	unistd::Pid,
};
use tokio::{
	sync::watch,
	time::{self, Instant, MissedTickBehavior},
};

use crate::{Backend, ResourceKind, SandboxError, SandboxSpec};

const SAMPLE_INTERVAL: Duration = Duration::from_millis(100);
const MAX_CPU_PAUSE: Duration = Duration::from_millis(250);

/// Best-effort Seatbelt ceilings. PID limits are intentionally absent because
/// macOS Seatbelt has no corresponding runtime primitive.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WatchdogLimits {
	pub(crate) cpu_cores:    Option<f64>,
	pub(crate) memory_bytes: Option<u64>,
}

impl WatchdogLimits {
	pub(crate) fn from_spec(spec: &SandboxSpec) -> Option<Self> {
		let limits = Self {
			cpu_cores:    spec.resources.cpu_cores(),
			memory_bytes: spec.resources.memory_bytes(),
		};
		(limits.cpu_cores.is_some() || limits.memory_bytes.is_some()).then_some(limits)
	}
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct ProcessGroupUsage {
	cpu_nanoseconds: u64,
	rss_bytes:       u64,
}

/// Samples and controls one already-created process group until `done` becomes
/// true or its sender is dropped. A sampled memory breach kills the entire
/// process group before returning the typed limit error.
pub async fn watch_process_group(
	pgid: i32,
	limits: WatchdogLimits,
	mut done: watch::Receiver<bool>,
) -> Result<(), SandboxError> {
	let mut watchdog = Watchdog::new(pgid);
	let mut ticker = time::interval(SAMPLE_INTERVAL);
	ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
	// Tokio intervals tick immediately; the authority samples after 100 ms.
	ticker.tick().await;

	loop {
		tokio::select! {
			changed = done.changed() => {
				if changed.is_err() || *done.borrow() {
					return Ok(());
				}
			},
			_ = ticker.tick() => {},
		}

		let Some(usage) = process_group_usage(pgid)
			.map_err(|source| SandboxError::ResourceWatchdog { backend: Backend::Seatbelt, source })?
		else {
			return Ok(());
		};
		if let Some(limit) = limits.memory_bytes
			&& usage.rss_bytes > limit
		{
			watchdog.kill();
			return Err(SandboxError::ResourceLimitExceeded {
				backend: Backend::Seatbelt,
				resource: ResourceKind::Memory,
				observed: usage.rss_bytes,
				limit,
			});
		}
		if let Some(cpus) = limits.cpu_cores
			&& let Some(pause) = cpu_pause(usage.cpu_nanoseconds, watchdog.started.elapsed(), cpus)
		{
			watchdog.stop();
			tokio::select! {
				changed = done.changed() => {
					if changed.is_err() || *done.borrow() {
						return Ok(());
					}
				},
				() = time::sleep(pause) => {},
			}
			watchdog.resume();
		}
	}
}

fn cpu_pause(cpu_nanoseconds: u64, elapsed: Duration, cpu_cores: f64) -> Option<Duration> {
	let used = Duration::from_nanos(cpu_nanoseconds).as_secs_f64();
	let overshoot = elapsed.as_secs_f64().mul_add(-cpu_cores, used);
	(overshoot > 0.0)
		.then(|| Duration::from_secs_f64(overshoot / cpu_cores).min(MAX_CPU_PAUSE))
		.filter(|pause| !pause.is_zero())
}

struct Watchdog {
	pgid:    i32,
	started: Instant,
	stopped: bool,
}

impl Watchdog {
	fn new(pgid: i32) -> Self {
		Self { pgid, started: Instant::now(), stopped: false }
	}

	fn stop(&mut self) {
		let _ = killpg(Pid::from_raw(self.pgid), Signal::SIGSTOP);
		self.stopped = true;
	}

	fn resume(&mut self) {
		let _ = killpg(Pid::from_raw(self.pgid), Signal::SIGCONT);
		self.stopped = false;
	}

	fn kill(&mut self) {
		let _ = killpg(Pid::from_raw(self.pgid), Signal::SIGKILL);
	}
}

impl Drop for Watchdog {
	fn drop(&mut self) {
		if self.stopped {
			let _ = killpg(Pid::from_raw(self.pgid), Signal::SIGCONT);
		}
	}
}

#[cfg(target_os = "macos")]
fn process_group_usage(pgid: i32) -> io::Result<Option<ProcessGroupUsage>> {
	let count = unsafe { proc_listallpids(std::ptr::null_mut(), 0) };
	if count < 0 {
		return Err(io::Error::last_os_error());
	}
	let mut pids = vec![0_i32; usize::try_from(count).unwrap_or(0).saturating_add(32)];
	let buffer_bytes =
		i32::try_from(pids.len().saturating_mul(std::mem::size_of::<i32>())).unwrap_or(i32::MAX);
	let returned = unsafe { proc_listallpids(pids.as_mut_ptr().cast(), buffer_bytes) };
	if returned < 0 {
		return Err(io::Error::last_os_error());
	}
	pids.truncate(usize::try_from(returned).unwrap_or(0).min(pids.len()));

	let mut total = ProcessGroupUsage::default();
	let mut seen = false;
	for pid in pids {
		if pid <= 0 {
			continue;
		}
		let Some(bsd) = pid_info::<ProcBsdInfo>(pid, PROC_PIDTBSDINFO) else {
			continue;
		};
		if bsd.pbi_pgid != pgid as u32 {
			continue;
		}
		let Some(task) = pid_info::<ProcTaskInfo>(pid, PROC_PIDTASKINFO) else {
			continue;
		};
		seen = true;
		total.cpu_nanoseconds = total
			.cpu_nanoseconds
			.saturating_add(task.pti_total_user)
			.saturating_add(task.pti_total_system);
		total.rss_bytes = total.rss_bytes.saturating_add(task.pti_resident_size);
	}
	Ok(seen.then_some(total))
}

#[cfg(target_os = "macos")]
fn pid_info<T: Default>(pid: i32, flavor: i32) -> Option<T> {
	let mut info = T::default();
	let size = i32::try_from(std::mem::size_of::<T>()).ok()?;
	let returned = unsafe { proc_pidinfo(pid, flavor, 0, (&raw mut info).cast(), size) };
	(returned == size).then_some(info)
}

#[cfg(not(target_os = "macos"))]
fn process_group_usage(_pgid: i32) -> io::Result<Option<ProcessGroupUsage>> {
	Err(io::Error::new(
		io::ErrorKind::Unsupported,
		"Darwin process accounting is unavailable on this host",
	))
}

#[cfg(target_os = "macos")]
const PROC_PIDTBSDINFO: i32 = 3;
#[cfg(target_os = "macos")]
const PROC_PIDTASKINFO: i32 = 4;

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct ProcBsdInfo {
	pbi_flags:        u32,
	pbi_status:       u32,
	pbi_xstatus:      u32,
	pbi_pid:          u32,
	pbi_ppid:         u32,
	pbi_uid:          libc::uid_t,
	pbi_gid:          libc::gid_t,
	pbi_ruid:         libc::uid_t,
	pbi_rgid:         libc::gid_t,
	pbi_svuid:        libc::uid_t,
	pbi_svgid:        libc::gid_t,
	rfu_1:            u32,
	pbi_comm:         [libc::c_char; 16],
	pbi_name:         [libc::c_char; 32],
	pbi_nfiles:       u32,
	pbi_pgid:         u32,
	pbi_pjobc:        u32,
	e_tdev:           u32,
	e_tpgid:          u32,
	pbi_nice:         i32,
	pbi_start_tvsec:  u64,
	pbi_start_tvusec: u64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct ProcTaskInfo {
	pti_virtual_size:      u64,
	pti_resident_size:     u64,
	pti_total_user:        u64,
	pti_total_system:      u64,
	pti_threads_user:      u64,
	pti_threads_system:    u64,
	pti_policy:            i32,
	pti_faults:            i32,
	pti_pageins:           i32,
	pti_cow_faults:        i32,
	pti_messages_sent:     i32,
	pti_messages_received: i32,
	pti_syscalls_mach:     i32,
	pti_syscalls_unix:     i32,
	pti_csw:               i32,
	pti_threadnum:         i32,
	pti_numrunning:        i32,
	pti_priority:          i32,
}

#[cfg(target_os = "macos")]
#[link(name = "proc")]
unsafe extern "C" {
	fn proc_listallpids(buffer: *mut libc::c_void, buffersize: i32) -> i32;
	fn proc_pidinfo(
		pid: i32,
		flavor: i32,
		arg: u64,
		buffer: *mut libc::c_void,
		buffersize: i32,
	) -> i32;
}
#[cfg(test)]
mod tests {
	use std::time::Duration;

	use super::{MAX_CPU_PAUSE, cpu_pause};

	#[test]
	fn cpu_throttling_starts_only_after_budget_is_exhausted() {
		assert_eq!(cpu_pause(500_000_000, Duration::from_secs(1), 0.5), None);
		assert_eq!(
			cpu_pause(562_500_000, Duration::from_secs(1), 0.5),
			Some(Duration::from_millis(125)),
		);
	}

	#[test]
	fn cpu_throttling_caps_each_stop_interval() {
		assert_eq!(cpu_pause(2_000_000_000, Duration::from_secs(1), 1.0), Some(MAX_CPU_PAUSE),);
	}
}
