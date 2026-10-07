//! Process-table snapshots for the process builtins (`ps`, `top`, `pgrep`,
//! `pkill`, `pidwait`, `kill`), and the OS process layer beneath them.
//!
//! One `ProcInfo` per platform, each exposing the same accessors so the
//! builtins above stay platform-agnostic. The platform queries themselves —
//! procfs parsing, pidfds, libproc, Toolhelp, process handles — live in
//! [`sys`], which `pi-shell`'s identity-pinned process references
//! (`pi_shell::process`) are built on too, so each query has one
//! implementation and a platform fix lands once.

// Consumers (`ps`, `top`, `pgrep`, `pkill`, `pidwait`, `kill`) are each
// feature-gated, so a build with only some of them enabled legitimately uses
// only part of this API.
#![allow(dead_code, reason = "consumed by the feature-gated process builtins")]

/// Whether a process reference is still live.
///
/// Shared by the process-table snapshots here and by `pi-shell`'s own
/// session/teardown process management, which re-exports this type.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessStatus {
	/// The referenced process is still running.
	Running,
	/// The referenced process has exited or is no longer observable.
	Exited,
}

/// One thread of a process, as `ps -M` lists it.
///
/// Fields the platform cannot report stay `None`. Produced in bulk by
/// [`threads_by_pid`], because Windows can only enumerate threads system-wide.
#[derive(Clone, Debug)]
pub struct ThreadInfo {
	/// Scheduler state letter: the kernel's own on Linux (`R`, `S`, `D`, …),
	/// Apple `ps` letters on macOS (`R`, `U`, `S`, `I`, `T`, `H`), `?` when
	/// unknown.
	pub state:       char,
	/// Scheduling priority on the platform's native scale.
	pub priority:    Option<i32>,
	/// Policy letter Apple `ps -M` appends to the priority: `T` timesharing,
	/// `R` round-robin, `F` FIFO.
	pub policy:      Option<char>,
	pub user_time:   Option<std::time::Duration>,
	pub system_time: Option<std::time::Duration>,
	/// Kernel-decayed recent CPU share on macOS; lifetime average elsewhere.
	pub cpu_percent: Option<f64>,
}

/// Collapses a process command line into a single display line.
///
/// Command lines reach the terminal verbatim from `ps` and `top`, so control
/// characters and embedded newlines would corrupt the rendered table.
pub(crate) fn sanitize_process_command(command: String) -> String {
	command
		.chars()
		.map(|character| {
			if character.is_control() {
				' '
			} else {
				character
			}
		})
		.collect()
}

/// Translates libproc's pid count into a padded allocation and its C byte size.
///
/// macOS silently truncates the listing to the supplied buffer even when the
/// sizing query reported more pids, so the buffer leaves room for processes
/// spawned between the two calls.
#[cfg(any(target_os = "macos", test))]
fn macos_pid_buffer_size(reported: i32) -> Option<(usize, i32)> {
	let count = usize::try_from(reported).ok().filter(|count| *count > 0)?;
	let capacity = count.saturating_mul(4).max(2048);
	let bytes = i32::try_from(capacity.checked_mul(size_of::<i32>())?).ok()?;
	Some((capacity, bytes))
}

/// The argument vector in a `KERN_PROCARGS2` buffer:
/// `argc: i32 | exec_path | NUL padding | argv[..argc] | env[..]`.
///
/// argc counts only argv, so stopping after argc entries keeps the environment
/// (NUL-terminated `NAME=value` strings that look exactly like arguments) out
/// of the list.
#[cfg(any(target_os = "macos", test))]
fn parse_procargs2(buffer: &[u8]) -> Vec<String> {
	let Some((argc, rest)) = buffer.split_first_chunk::<4>() else {
		return Vec::new();
	};
	let argc = usize::try_from(i32::from_ne_bytes(*argc)).unwrap_or(0);
	let exec_path_end = rest.iter().position(|byte| *byte == 0).unwrap_or(rest.len());
	let rest = &rest[exec_path_end..];
	let argv_start = rest.iter().position(|byte| *byte != 0).unwrap_or(rest.len());
	rest[argv_start..]
		.split(|byte| *byte == 0)
		.take(argc)
		.take_while(|arg| !arg.is_empty())
		.map(|arg| String::from_utf8_lossy(arg).into_owned())
		.collect()
}

/// Linux process primitives: procfs and pidfds.
#[cfg(any(target_os = "android", target_os = "linux"))]
pub mod sys {
	use std::{
		fs,
		os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd},
		str::{FromStr, SplitWhitespace},
	};

	/// Every pid `/proc` lists.
	pub fn pids() -> impl Iterator<Item = i32> {
		fs::read_dir("/proc")
			.into_iter()
			.flatten()
			.flatten()
			.filter_map(|entry| entry.file_name().to_str()?.parse().ok())
	}

	/// Opens a pidfd on whichever process holds `pid` now; callers pin identity
	/// by re-checking [`start_time`] after the open.
	pub fn open_pidfd(pid: i32) -> Option<OwnedFd> {
		// SAFETY: pidfd_open takes scalar arguments and returns a new owned fd.
		let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
		(fd >= 0).then(|| {
			// SAFETY: a successful pidfd_open returned a uniquely owned descriptor.
			unsafe { OwnedFd::from_raw_fd(fd as i32) }
		})
	}

	/// Sends `signal` through `pidfd`, which can never reach a recycled pid.
	pub fn pidfd_send_signal(pidfd: BorrowedFd<'_>, signal: i32) -> bool {
		// SAFETY: pidfd is open for the call. A null siginfo makes the kernel
		// fill in what kill(2) would, and zero flags is the default behavior.
		unsafe {
			libc::syscall(
				libc::SYS_pidfd_send_signal,
				pidfd.as_raw_fd(),
				signal,
				std::ptr::null::<libc::siginfo_t>(),
				0,
			) == 0
		}
	}

	/// The fields of a `/proc/<pid>/stat` line from `state` (field 3) on. The
	/// command name before them may itself contain spaces and parentheses, so
	/// the split starts after the *last* `)`.
	pub(crate) fn stat_fields(stat: &str) -> Option<SplitWhitespace<'_>> {
		Some(stat[stat.rfind(')')? + 1..].split_whitespace())
	}

	fn stat_field<T: FromStr>(pid: i32, index: usize) -> Option<T> {
		stat_fields(&fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)?
			.nth(index)?
			.parse()
			.ok()
	}

	/// Start time in clock ticks since boot (`starttime`, field 22). Together
	/// with the pid it identifies a process across pid reuse.
	pub fn start_time(pid: i32) -> Option<u64> {
		stat_field(pid, 19)
	}

	/// The recorded parent pid (`ppid`, field 4).
	pub fn parent_pid(pid: i32) -> Option<i32> {
		stat_field(pid, 1)
	}

	/// The argument vector from `/proc/<pid>/cmdline`; `None` when unreadable.
	pub fn cmdline(pid: i32) -> Option<Vec<String>> {
		let bytes = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
		Some(
			bytes
				.split(|byte| *byte == 0)
				.filter(|part| !part.is_empty())
				.map(|part| String::from_utf8_lossy(part).into_owned())
				.collect(),
		)
	}
}

#[cfg(any(target_os = "android", target_os = "linux"))]
mod proc_snapshot {
	use std::{collections::HashMap, fs, os::fd::AsFd, time::Duration};

	use super::{ProcessStatus, ThreadInfo, sys};

	#[derive(Clone)]
	pub struct ProcInfo {
		pid:  i32,
		stat: Stat,
		args: Vec<String>,
		uid:  Option<(u32, u32)>,
		gid:  Option<(u32, u32)>,
	}

	#[derive(Clone)]
	struct Stat {
		comm:       String,
		state:      char,
		policy:     Option<u32>,
		ppid:       i32,
		pgrp:       i32,
		session:    i32,
		tty:        i64,
		tpgid:      i32,
		flags:      u64,
		minflt:     u64,
		majflt:     u64,
		utime:      u64,
		stime:      u64,
		priority:   i32,
		nice:       i32,
		threads:    u32,
		start_time: u64,
		virtual_:   u64,
		rss_pages:  i64,
	}

	#[allow(
		clippy::unnecessary_wraps,
		reason = "Option returns match the cross-platform ProcInfo contract"
	)]
	impl ProcInfo {
		pub fn all() -> Vec<Self> {
			sys::pids().filter_map(Self::from_pid).collect()
		}

		fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let stat = read_stat(pid)?;
			let args = sys::cmdline(pid).unwrap_or_default();
			let uid = status_ids(pid, "Uid:").map(|ids| (ids.0, ids.1));
			let gid = status_ids(pid, "Gid:");
			(sys::start_time(pid)? == stat.start_time).then_some(Self {
				pid,
				stat,
				args,
				uid,
				gid,
			})
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub const fn ppid(&self) -> Option<i32> {
			Some(self.stat.ppid)
		}

		pub fn args(&self) -> Vec<String> {
			self.args.clone()
		}

		pub const fn group_id(&self) -> Option<i32> {
			Some(self.stat.pgrp)
		}

		pub const fn session_id(&self) -> Option<i32> {
			Some(self.stat.session)
		}

		pub fn real_user_id(&self) -> Option<u32> {
			self.uid.map(|ids| ids.0)
		}

		pub fn effective_user_id(&self) -> Option<u32> {
			self.uid.map(|ids| ids.1)
		}

		pub fn real_group_id(&self) -> Option<u32> {
			self.gid.map(|ids| ids.0)
		}

		pub fn effective_group_id(&self) -> Option<u32> {
			self.gid.map(|ids| ids.1)
		}

		pub fn terminal_id(&self) -> Option<u64> {
			(self.stat.tty != 0).then_some(self.stat.tty as u32 as u64)
		}

		pub fn terminal_group_id(&self) -> Option<i32> {
			(self.stat.tpgid > 0).then_some(self.stat.tpgid)
		}

		pub const fn priority(&self) -> Option<i32> {
			Some(self.stat.priority)
		}

		pub const fn flags(&self) -> Option<u64> {
			Some(self.stat.flags)
		}

		pub const fn minor_faults(&self) -> Option<u64> {
			Some(self.stat.minflt)
		}

		pub const fn major_faults(&self) -> Option<u64> {
			Some(self.stat.majflt)
		}

		pub fn wchan(&self) -> Option<String> {
			let value = fs::read_to_string(format!("/proc/{}/wchan", self.pid)).ok()?;
			let value = value.trim();
			(!value.is_empty() && value != "0" && value != "-").then(|| value.to_string())
		}

		pub const fn state(&self) -> char {
			self.stat.state
		}

		pub const fn start_time(&self) -> u64 {
			self.stat.start_time
		}

		pub fn age(&self) -> Option<Duration> {
			let uptime = uptime_seconds()?;
			let ticks = clock_ticks()? as f64;
			Some(Duration::from_secs_f64((uptime - self.stat.start_time as f64 / ticks).max(0.0)))
		}

		pub fn match_name(&self) -> String {
			self.stat.comm.clone()
		}

		pub fn command_name(&self) -> String {
			self.stat.comm.clone()
		}

		pub fn status(&self) -> ProcessStatus {
			match read_stat(self.pid) {
				Some(stat) if stat.start_time == self.stat.start_time && stat.state != 'Z' => {
					ProcessStatus::Running
				},
				_ => ProcessStatus::Exited,
			}
		}

		pub fn signal(&self, signal: i32, queue: Option<i32>) -> bool {
			let alive = || sys::start_time(self.pid) == Some(self.stat.start_time);
			if signal == 0 {
				return alive();
			}
			let Some(pidfd) = sys::open_pidfd(self.pid) else {
				#[cfg(target_os = "android")]
				{
					if queue.is_some() {
						return false;
					}
					let Some(stat) = read_stat(self.pid) else {
						return false;
					};
					if stat.start_time != self.stat.start_time || stat.state == 'Z' {
						return false;
					}
					// SAFETY: kill takes scalar arguments and no pointers.
					return unsafe { libc::kill(self.pid, signal) == 0 };
				}
				#[cfg(target_os = "linux")]
				return false;
			};
			if !alive() {
				return false;
			}
			if let Some(value) = queue {
				let mut value_arg = libc::sigval { sival_ptr: std::ptr::null_mut() };
				// SAFETY: sigval is a C union; writing its integer member initializes
				// the bytes consumed by sigqueue while the remaining bytes stay zero.
				unsafe {
					(&raw mut value_arg).cast::<i32>().write(value);
					return libc::sigqueue(self.pid, signal, value_arg) == 0;
				}
			}
			sys::pidfd_send_signal(pidfd.as_fd(), signal)
		}

		pub fn cpu_time(&self) -> Option<Duration> {
			let ticks = clock_ticks()?;
			Some(Duration::from_secs_f64((self.stat.utime + self.stat.stime) as f64 / ticks as f64))
		}

		pub fn resident_bytes(&self) -> Option<u64> {
			let pages = u64::try_from(self.stat.rss_pages).ok()?;
			Some(pages.saturating_mul(page_size()?))
		}

		pub const fn virtual_bytes(&self) -> Option<u64> {
			Some(self.stat.virtual_)
		}

		pub const fn thread_count(&self) -> Option<u32> {
			Some(self.stat.threads)
		}

		pub const fn nice(&self) -> Option<i32> {
			Some(self.stat.nice)
		}
	}

	/// Lists every thread of each process, main thread first.
	pub fn threads_by_pid(processes: &[ProcInfo]) -> HashMap<i32, Vec<ThreadInfo>> {
		let uptime = uptime_seconds();
		let ticks = clock_ticks().map(|ticks| ticks as f64);
		processes
			.iter()
			.map(|process| (process.pid, process_threads(process.pid, uptime, ticks)))
			.collect()
	}

	/// Reads `/proc/<pid>/task`, which the kernel lists in thread-id order.
	fn process_threads(pid: i32, uptime: Option<f64>, ticks: Option<f64>) -> Vec<ThreadInfo> {
		let Ok(entries) = fs::read_dir(format!("/proc/{pid}/task")) else {
			return Vec::new();
		};
		entries
			.flatten()
			.filter_map(|entry| parse_stat(&fs::read_to_string(entry.path().join("stat")).ok()?))
			.map(|stat| {
				let seconds = |value: u64| ticks.map(|ticks| Duration::from_secs_f64(value as f64 / ticks));
				// A thread started within the current clock tick has no elapsed time
				// yet; procps reports 0% rather than an unknown share.
				let cpu_percent = uptime.zip(ticks).map(|(uptime, ticks)| {
					let age = uptime - stat.start_time as f64 / ticks;
					if age > 0.0 { 100.0 * (stat.utime + stat.stime) as f64 / ticks / age } else { 0.0 }
				});
				ThreadInfo {
					state: stat.state,
					priority: Some(stat.priority),
					// SCHED_OTHER, SCHED_BATCH and SCHED_IDLE are all timesharing.
					policy: match stat.policy {
						Some(0 | 3 | 5) => Some('T'),
						Some(1) => Some('F'),
						Some(2) => Some('R'),
						_ => None,
					},
					user_time: seconds(stat.utime),
					system_time: seconds(stat.stime),
					cpu_percent,
				}
			})
			.collect()
	}

	fn read_stat(pid: i32) -> Option<Stat> {
		parse_stat(&fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
	}

	fn parse_stat(content: &str) -> Option<Stat> {
		let comm = content[content.find('(')? + 1..content.rfind(')')?].to_string();
		let fields: Vec<&str> = sys::stat_fields(content)?.collect();
		Some(Stat {
			comm,
			state: fields.first()?.chars().next()?,
			policy: fields.get(38).and_then(|value| value.parse().ok()),
			ppid: fields.get(1)?.parse().ok()?,
			pgrp: fields.get(2)?.parse().ok()?,
			session: fields.get(3)?.parse().ok()?,
			tty: fields.get(4)?.parse().ok()?,
			tpgid: fields.get(5)?.parse().ok()?,
			flags: fields.get(6)?.parse().ok()?,
			minflt: fields.get(7)?.parse().ok()?,
			majflt: fields.get(9)?.parse().ok()?,
			utime: fields.get(11)?.parse().ok()?,
			stime: fields.get(12)?.parse().ok()?,
			priority: fields.get(15)?.parse().ok()?,
			nice: fields.get(16)?.parse().ok()?,
			threads: fields.get(17)?.parse().ok()?,
			start_time: fields.get(19)?.parse().ok()?,
			virtual_: fields.get(20)?.parse().ok()?,
			rss_pages: fields.get(21)?.parse().ok()?,
		})
	}

	fn status_ids(pid: i32, prefix: &str) -> Option<(u32, u32)> {
		let content = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
		let mut ids = content
			.lines()
			.find(|line| line.starts_with(prefix))?
			.split_whitespace()
			.skip(1)
			.filter_map(|value| value.parse().ok());
		Some((ids.next()?, ids.next()?))
	}

	#[cfg(target_os = "linux")]
	fn uptime_seconds() -> Option<f64> {
		fs::read_to_string("/proc/uptime")
			.ok()?
			.split_whitespace()
			.next()?
			.parse()
			.ok()
	}

	#[cfg(target_os = "android")]
	fn uptime_seconds() -> Option<f64> {
		let mut uptime = libc::timespec {
			tv_sec:  0,
			tv_nsec: 0,
		};
		// SAFETY: clock_gettime writes one initialized timespec to a valid pointer.
		if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &raw mut uptime) } != 0 {
			return None;
		}
		Some(uptime.tv_sec as f64 + uptime.tv_nsec as f64 / 1_000_000_000.0)
	}

	fn clock_ticks() -> Option<u64> {
		// SAFETY: sysconf reads a process-global constant.
		u64::try_from(unsafe { libc::sysconf(libc::_SC_CLK_TCK) })
			.ok()
			.filter(|v| *v > 0)
	}
	fn page_size() -> Option<u64> {
		// SAFETY: sysconf reads a process-global constant.
		u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) })
			.ok()
			.filter(|v| *v > 0)
	}
}

/// macOS process primitives: libproc and `KERN_PROCARGS2`.
#[cfg(target_os = "macos")]
pub mod sys {
	use std::{mem::size_of, ptr};

	const KERN_PROCARGS2: libc::c_int = 49;

	/// Capacity `proc_pidpath` needs (`PROC_PIDPATHINFO_MAXSIZE`).
	pub const PATH_CAPACITY: usize = 4096;

	#[link(name = "proc", kind = "dylib")]
	unsafe extern "C" {
		fn proc_listallpids(buffer: *mut i32, buffersize: i32) -> i32;
		fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, buffersize: u32) -> i32;
	}

	/// Every pid libproc lists.
	pub fn pids() -> Vec<i32> {
		// SAFETY: a null buffer with size 0 is libproc's documented sizing query;
		// it does not dereference the pointer.
		let reported = unsafe { proc_listallpids(ptr::null_mut(), 0) };
		let Some((capacity, bytes)) = super::macos_pid_buffer_size(reported) else {
			return Vec::new();
		};
		let mut pids = vec![0i32; capacity];
		// SAFETY: pids is aligned and writable for `bytes` bytes; libproc writes
		// at most that.
		let actual = unsafe { proc_listallpids(pids.as_mut_ptr(), bytes) };
		if actual <= 0 {
			return Vec::new();
		}
		pids.truncate((actual as usize).min(capacity));
		pids
	}

	/// The kernel's BSD record for `pid`. Its start time identifies the process
	/// across pid reuse.
	pub fn bsdinfo(pid: i32) -> Option<libc::proc_bsdinfo> {
		if pid <= 0 {
			return None;
		}
		// SAFETY: proc_bsdinfo is a C integer record valid when zeroed.
		let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdinfo>() };
		// SAFETY: info is writable for the exact supplied size.
		let actual = unsafe {
			libc::proc_pidinfo(
				pid,
				libc::PROC_PIDTBSDINFO,
				0,
				(&raw mut info).cast(),
				size_of::<libc::proc_bsdinfo>() as i32,
			)
		};
		(actual >= size_of::<libc::proc_bsdinfo>() as i32).then_some(info)
	}

	/// The executable path libproc reports for `pid`, read into `buffer`.
	pub fn executable_path(pid: i32, buffer: &mut [u8; PATH_CAPACITY]) -> Option<&[u8]> {
		// SAFETY: buffer is writable for its length; libproc writes a path no
		// longer than that and returns the byte count.
		let len = unsafe { proc_pidpath(pid, buffer.as_mut_ptr().cast(), PATH_CAPACITY as u32) };
		let path = buffer.get(..usize::try_from(len).ok().filter(|len| *len > 0)?)?;
		path.split(|byte| *byte == 0).next()
	}

	/// The argument vector of `pid` from `KERN_PROCARGS2`; empty when unreadable.
	pub fn args(pid: i32) -> Vec<String> {
		let mut mib = [libc::CTL_KERN, KERN_PROCARGS2, pid];
		let mut size = 0usize;
		// SAFETY: a null old-value buffer is the sysctl sizing form.
		if unsafe {
			libc::sysctl(mib.as_mut_ptr(), 3, ptr::null_mut(), &raw mut size, ptr::null_mut(), 0)
		} != 0 || size <= size_of::<libc::c_int>()
		{
			return Vec::new();
		}
		let mut buffer = vec![0u8; size];
		// SAFETY: buffer is writable for size bytes.
		if unsafe {
			libc::sysctl(
				mib.as_mut_ptr(),
				3,
				buffer.as_mut_ptr().cast(),
				&raw mut size,
				ptr::null_mut(),
				0,
			)
		} != 0
		{
			return Vec::new();
		}
		buffer.truncate(size);
		super::parse_procargs2(&buffer)
	}
}

#[cfg(target_os = "macos")]
mod proc_snapshot {
	use std::{
		collections::HashMap,
		ffi::CStr,
		mem::size_of,
		path::Path,
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	use super::{ProcessStatus, ThreadInfo, sys};

	/// `proc_pidinfo` flavor listing a task's thread handles; absent from `libc`.
	const PROC_PIDLISTTHREADS: libc::c_int = 6;

	#[derive(Clone)]
	pub struct ProcInfo {
		pid:  i32,
		info: libc::proc_bsdinfo,
		task: Option<libc::proc_taskinfo>,
		args: Vec<String>,
	}

	#[allow(
		clippy::unnecessary_wraps,
		reason = "Option returns match the cross-platform ProcInfo contract"
	)]
	impl ProcInfo {
		pub fn all() -> Vec<Self> {
			sys::pids().into_iter().filter_map(Self::from_pid).collect()
		}

		fn from_pid(pid: i32) -> Option<Self> {
			let info = sys::bsdinfo(pid)?;
			Some(Self { pid, info, task: read_taskinfo(pid), args: sys::args(pid) })
		}

		fn live_info(&self) -> Option<libc::proc_bsdinfo> {
			let info = sys::bsdinfo(self.pid())?;
			(info.pbi_start_tvsec == self.info.pbi_start_tvsec
				&& info.pbi_start_tvusec == self.info.pbi_start_tvusec)
				.then_some(info)
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn ppid(&self) -> Option<i32> {
			i32::try_from(self.info.pbi_ppid).ok()
		}

		pub fn args(&self) -> Vec<String> {
			self.args.clone()
		}

		pub fn group_id(&self) -> Option<i32> {
			i32::try_from(self.info.pbi_pgid).ok()
		}

		pub fn session_id(&self) -> Option<i32> {
			// SAFETY: getsid takes only a scalar process id.
			let sid = unsafe { libc::getsid(self.pid()) };
			(sid >= 0).then_some(sid)
		}

		pub const fn real_user_id(&self) -> Option<u32> {
			Some(self.info.pbi_ruid)
		}

		pub const fn effective_user_id(&self) -> Option<u32> {
			Some(self.info.pbi_uid)
		}

		pub const fn real_group_id(&self) -> Option<u32> {
			Some(self.info.pbi_rgid)
		}

		pub fn terminal_id(&self) -> Option<u64> {
			(!matches!(self.info.e_tdev, 0 | u32::MAX)).then_some(self.info.e_tdev as u64)
		}

		pub fn terminal_group_id(&self) -> Option<i32> {
			i32::try_from(self.info.e_tpgid)
				.ok()
				.filter(|tpgid| *tpgid > 0)
		}

		pub const fn effective_group_id(&self) -> Option<u32> {
			Some(self.info.pbi_gid)
		}

		pub fn priority(&self) -> Option<i32> {
			Some(self.task.as_ref()?.pti_priority)
		}

		pub const fn flags(&self) -> Option<u64> {
			Some(self.info.pbi_flags as u64)
		}

		pub fn minor_faults(&self) -> Option<u64> {
			u64::try_from(self.task.as_ref()?.pti_faults).ok()
		}

		pub fn major_faults(&self) -> Option<u64> {
			u64::try_from(self.task.as_ref()?.pti_pageins).ok()
		}

		#[allow(clippy::unused_self, reason = "matches the cross-platform ProcInfo contract")]
		pub const fn wchan(&self) -> Option<String> {
			None
		}

		/// Apple `ps` state letter.
		///
		/// XNU leaves almost every live process in `SRUN`, so such a process
		/// takes the letter of its most active thread, as Apple `ps` does; `?`
		/// when its threads are unreadable (another user's process, without
		/// root).
		pub fn state(&self) -> char {
			match self.info.pbi_status {
				1 => 'I',
				2 => process_threads(self)
					.iter()
					.map(|thread| thread.state)
					.min_by_key(|&state| MACH_STATE_ORDER.find(state).unwrap_or(usize::MAX))
					.unwrap_or('?'),
				3 => 'S',
				4 => 'T',
				5 => 'Z',
				_ => '?',
			}
		}

		pub const fn start_time(&self) -> u64 {
			self
				.info
				.pbi_start_tvsec
				.saturating_mul(1_000_000)
				.saturating_add(self.info.pbi_start_tvusec)
		}

		pub fn age(&self) -> Option<Duration> {
			let start = UNIX_EPOCH
				+ Duration::from_secs(self.info.pbi_start_tvsec)
				+ Duration::from_micros(self.info.pbi_start_tvusec);
			SystemTime::now().duration_since(start).ok()
		}

		pub fn match_name(&self) -> String {
			self
				.args
				.first()
				.and_then(|arg| Path::new(arg).file_name())
				.map(|name| name.to_string_lossy().into_owned())
				.filter(|name| !name.is_empty())
				.unwrap_or_else(|| self.command_name())
		}

		pub fn command_name(&self) -> String {
			// SAFETY: pbi_comm is a kernel-filled fixed buffer with NUL termination.
			unsafe { CStr::from_ptr(self.info.pbi_comm.as_ptr()) }
				.to_string_lossy()
				.into_owned()
		}

		pub fn status(&self) -> ProcessStatus {
			match self.live_info() {
				Some(info) if info.pbi_status != 5 => ProcessStatus::Running,
				_ => ProcessStatus::Exited,
			}
		}

		pub fn signal(&self, signal: i32, _queue: Option<i32>) -> bool {
			if self.live_info().is_none() {
				return false;
			}
			// SAFETY: identity was rechecked immediately before the scalar kill call.
			unsafe { libc::kill(self.pid(), signal) == 0 }
		}

		pub fn cpu_time(&self) -> Option<Duration> {
			let task = self.task.as_ref()?;
			Some(Duration::from_nanos(task.pti_total_user.saturating_add(task.pti_total_system)))
		}

		pub fn resident_bytes(&self) -> Option<u64> {
			Some(self.task.as_ref()?.pti_resident_size)
		}

		pub fn virtual_bytes(&self) -> Option<u64> {
			Some(self.task.as_ref()?.pti_virtual_size)
		}

		pub fn thread_count(&self) -> Option<u32> {
			u32::try_from(self.task.as_ref()?.pti_threadnum).ok()
		}

		pub const fn nice(&self) -> Option<i32> {
			Some(self.info.pbi_nice)
		}
	}

	/// Lists every thread of each process in the kernel's creation order.
	///
	/// Processes whose threads are unreadable (another user's, without root)
	/// map to an empty list.
	pub fn threads_by_pid(processes: &[ProcInfo]) -> HashMap<i32, Vec<ThreadInfo>> {
		processes
			.iter()
			.map(|process| (process.pid, process_threads(process)))
			.collect()
	}

	fn process_threads(process: &ProcInfo) -> Vec<ThreadInfo> {
		let mut capacity = process
			.thread_count()
			.map_or(64, |count| count as usize + 8);
		loop {
			let mut handles = vec![0u64; capacity];
			// SAFETY: handles is writable for the supplied byte size.
			let bytes = unsafe {
				libc::proc_pidinfo(
					process.pid,
					PROC_PIDLISTTHREADS,
					0,
					handles.as_mut_ptr().cast(),
					(capacity * size_of::<u64>()) as i32,
				)
			};
			if bytes <= 0 {
				return Vec::new();
			}
			let listed = bytes as usize / size_of::<u64>();
			// A full buffer may have cut the list short; threads were spawned since
			// the task snapshot.
			if listed == capacity {
				capacity *= 2;
				continue;
			}
			handles.truncate(listed);
			return handles
				.into_iter()
				.filter_map(|handle| read_threadinfo(process.pid, handle))
				.map(|info| thread_info(&info))
				.collect();
		}
	}

	fn read_threadinfo(pid: i32, handle: u64) -> Option<libc::proc_threadinfo> {
		// SAFETY: proc_threadinfo is a C record of integers and a char array,
		// valid when zeroed.
		let mut info = unsafe { std::mem::zeroed::<libc::proc_threadinfo>() };
		// SAFETY: info is writable for the exact supplied size.
		let actual = unsafe {
			libc::proc_pidinfo(
				pid,
				libc::PROC_PIDTHREADINFO,
				handle,
				(&raw mut info).cast(),
				size_of::<libc::proc_threadinfo>() as i32,
			)
		};
		(actual >= size_of::<libc::proc_threadinfo>() as i32).then_some(info)
	}

	/// Thread state letters from most to least active: Apple `ps`'s
	/// `mach_state_order`, which picks a process's letter from its threads.
	const MACH_STATE_ORDER: &str = "RUSITH";

	/// Mirrors Apple `ps`: `mach_state_order` for the state letter, and the
	/// current priority for timesharing threads but the base priority for
	/// fixed-priority ones.
	fn thread_info(info: &libc::proc_threadinfo) -> ThreadInfo {
		const TH_USAGE_SCALE: f64 = 1000.0;
		// <mach/policy.h>; absent from `libc`.
		const POLICY_TIMESHARE: i32 = 1;
		const POLICY_RR: i32 = 2;
		const POLICY_FIFO: i32 = 4;
		let state = match info.pth_run_state {
			1 => 'R',
			2 => 'T',
			3 if info.pth_sleep_time > 20 => 'I',
			3 => 'S',
			4 => 'U',
			5 => 'H',
			_ => '?',
		};
		let (priority, policy) = match info.pth_policy {
			POLICY_TIMESHARE => (info.pth_curpri, Some('T')),
			POLICY_RR => (info.pth_priority, Some('R')),
			POLICY_FIFO => (info.pth_priority, Some('F')),
			_ => (info.pth_curpri, None),
		};
		ThreadInfo {
			state,
			priority: Some(priority),
			policy,
			user_time: Some(Duration::from_nanos(info.pth_user_time)),
			system_time: Some(Duration::from_nanos(info.pth_system_time)),
			cpu_percent: Some(f64::from(info.pth_cpu_usage) * 100.0 / TH_USAGE_SCALE),
		}
	}

	fn read_taskinfo(pid: i32) -> Option<libc::proc_taskinfo> {
		// SAFETY: proc_taskinfo is a C integer record valid when zeroed.
		let mut info = unsafe { std::mem::zeroed::<libc::proc_taskinfo>() };
		// SAFETY: info is writable for the exact supplied size.
		let actual = unsafe {
			libc::proc_pidinfo(
				pid,
				libc::PROC_PIDTASKINFO,
				0,
				(&raw mut info).cast(),
				size_of::<libc::proc_taskinfo>() as i32,
			)
		};
		(actual >= size_of::<libc::proc_taskinfo>() as i32).then_some(info)
	}
}

/// Windows process primitives: Toolhelp snapshots and process handles.
#[cfg(target_os = "windows")]
pub mod sys {
	use std::{
		ffi::c_void,
		mem::size_of,
		os::windows::io::{AsRawHandle, HandleOrInvalid, HandleOrNull, OwnedHandle, RawHandle},
		sync::Arc,
	};

	/// Process access right needed by [`terminate`].
	pub const PROCESS_TERMINATE: u32 = 0x0001;
	/// Process access right for [`process_times`], [`image_path`],
	/// [`parent_pid`] and [`command_line`].
	pub const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
	/// Access right to wait on a process handle ([`has_exited`], [`exited`]).
	pub const SYNCHRONIZE: u32 = 0x0010_0000;
	const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
	const WAIT_OBJECT_0: u32 = 0;
	const INFINITE: u32 = u32::MAX;
	const WT_EXECUTEONLYONCE: u32 = 0x0000_0008;
	const PROCESS_BASIC_INFORMATION: u32 = 0;
	const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;

	/// One `PROCESSENTRY32W` of a Toolhelp process snapshot.
	#[repr(C)]
	#[derive(Clone, Copy)]
	pub struct ProcessEntry {
		size:              u32,
		usage:             u32,
		/// The process id.
		pub pid:           u32,
		default_heap:      usize,
		module_id:         u32,
		/// Number of threads in the process when the snapshot was taken.
		pub threads:       u32,
		/// The parent pid recorded at creation. Windows never rewrites it, so
		/// once the parent exits it can name an unrelated process that reused
		/// the pid.
		pub ppid:          u32,
		/// Base scheduling priority of the process's threads.
		pub base_priority: i32,
		flags:             u32,
		exe:               [u16; 260],
	}

	impl ProcessEntry {
		/// The executable's file name.
		pub fn exe_name(&self) -> String {
			let end = self
				.exe
				.iter()
				.position(|unit| *unit == 0)
				.unwrap_or(self.exe.len());
			String::from_utf16_lossy(&self.exe[..end])
		}
	}

	#[repr(C)]
	#[derive(Clone, Copy, Default)]
	pub(crate) struct FileTime {
		low:  u32,
		high: u32,
	}

	impl FileTime {
		/// 100 ns ticks since 1601.
		pub(crate) fn ticks(self) -> u64 {
			(u64::from(self.high) << 32) | u64::from(self.low)
		}
	}

	#[repr(C)]
	struct UnicodeString {
		length:         u16,
		maximum_length: u16,
		buffer:         *const u16,
	}

	#[repr(C)]
	struct ProcessBasicInformation {
		exit_status: i32,
		peb_base_address: usize,
		affinity_mask: usize,
		base_priority: i32,
		unique_process_id: usize,
		inherited_from_unique_process_id: usize,
	}

	#[link(name = "kernel32")]
	unsafe extern "system" {
		fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> RawHandle;
		fn Process32FirstW(snapshot: RawHandle, entry: *mut ProcessEntry) -> i32;
		fn Process32NextW(snapshot: RawHandle, entry: *mut ProcessEntry) -> i32;
		fn OpenProcess(access: u32, inherit: i32, pid: u32) -> RawHandle;
		fn TerminateProcess(handle: RawHandle, exit_code: u32) -> i32;
		fn WaitForSingleObject(handle: RawHandle, milliseconds: u32) -> u32;
		fn RegisterWaitForSingleObject(
			wait: *mut RawHandle,
			object: RawHandle,
			callback: unsafe extern "system" fn(context: *mut c_void, timed_out: u8),
			context: *const c_void,
			milliseconds: u32,
			flags: u32,
		) -> i32;
		fn UnregisterWaitEx(wait: RawHandle, completion_event: RawHandle) -> i32;
		fn GetProcessTimes(
			handle: RawHandle,
			creation: *mut FileTime,
			exit: *mut FileTime,
			kernel: *mut FileTime,
			user: *mut FileTime,
		) -> i32;
		fn QueryFullProcessImageNameW(
			handle: RawHandle,
			flags: u32,
			name: *mut u16,
			size: *mut u32,
		) -> i32;
		fn LocalFree(memory: *mut c_void) -> *mut c_void;
	}

	#[link(name = "ntdll")]
	unsafe extern "system" {
		fn NtQueryInformationProcess(
			handle: RawHandle,
			class: u32,
			information: *mut c_void,
			information_length: u32,
			return_length: *mut u32,
		) -> i32;
	}

	#[link(name = "shell32")]
	unsafe extern "system" {
		fn CommandLineToArgvW(command_line: *const u16, argc: *mut i32) -> *mut *mut u16;
	}

	/// A system-wide Toolhelp snapshot of the kinds in `flags`.
	pub(crate) fn toolhelp_snapshot(flags: u32) -> Option<OwnedHandle> {
		// SAFETY: CreateToolhelp32Snapshot takes scalars and returns a new owned
		// handle or INVALID_HANDLE_VALUE.
		let snapshot = unsafe { CreateToolhelp32Snapshot(flags, 0) };
		// SAFETY: a valid result is a fresh handle nothing else owns.
		OwnedHandle::try_from(unsafe { HandleOrInvalid::from_raw_handle(snapshot) }).ok()
	}

	/// Iterates one Toolhelp process snapshot.
	pub struct ProcessEntries {
		snapshot: Option<OwnedHandle>,
		entry:    ProcessEntry,
		started:  bool,
	}

	/// Every process, from one Toolhelp snapshot taken now.
	pub fn processes() -> ProcessEntries {
		// SAFETY: the all-zero record is valid; its ABI size is set below.
		let mut entry = unsafe { std::mem::zeroed::<ProcessEntry>() };
		entry.size = size_of::<ProcessEntry>() as u32;
		ProcessEntries { snapshot: toolhelp_snapshot(TH32CS_SNAPPROCESS), entry, started: false }
	}

	impl Iterator for ProcessEntries {
		type Item = ProcessEntry;

		fn next(&mut self) -> Option<ProcessEntry> {
			let snapshot = self.snapshot.as_ref()?.as_raw_handle();
			let entry = &raw mut self.entry;
			let step = if std::mem::replace(&mut self.started, true) {
				Process32NextW
			} else {
				Process32FirstW
			};
			// SAFETY: the snapshot is open and the entry carries its ABI size.
			let found = unsafe { step(snapshot, entry) };
			if found == 0 {
				self.snapshot = None;
				return None;
			}
			Some(self.entry)
		}
	}

	/// Opens `pid` with `access`. Windows does not reuse a pid while a handle
	/// to its process is open, so the handle pins whichever process held `pid`
	/// at the open; callers confirm which one through [`process_times`].
	pub fn open_process(pid: u32, access: u32) -> Option<OwnedHandle> {
		// SAFETY: OpenProcess takes scalars and returns a new owned handle or null.
		let handle = unsafe { OpenProcess(access, 0, pid) };
		// SAFETY: a non-null result is a fresh handle nothing else owns.
		OwnedHandle::try_from(unsafe { HandleOrNull::from_raw_handle(handle) }).ok()
	}

	/// `(creation, kernel, user)` FILETIME ticks. The creation time identifies
	/// the process across pid reuse.
	pub fn process_times(process: &OwnedHandle) -> Option<(u64, u64, u64)> {
		let mut creation = FileTime::default();
		let mut exit = FileTime::default();
		let mut kernel = FileTime::default();
		let mut user = FileTime::default();
		// SAFETY: all FILETIME output pointers are valid and writable.
		let ok = unsafe {
			GetProcessTimes(
				process.as_raw_handle(),
				&raw mut creation,
				&raw mut exit,
				&raw mut kernel,
				&raw mut user,
			)
		};
		(ok != 0).then(|| (creation.ticks(), kernel.ticks(), user.ticks()))
	}

	/// Whether the process has exited; needs `SYNCHRONIZE` access.
	///
	/// The handle is signalled exactly when the process exits. Exit codes
	/// cannot tell: a process that returned 259 (`STILL_ACTIVE`) looks alive.
	pub fn has_exited(process: &OwnedHandle) -> bool {
		// SAFETY: the handle is open; a zero timeout makes this a probe.
		unsafe { WaitForSingleObject(process.as_raw_handle(), 0) == WAIT_OBJECT_0 }
	}

	/// Terminates the process with exit code 1; needs `PROCESS_TERMINATE`.
	pub fn terminate(process: &OwnedHandle) -> bool {
		// SAFETY: the handle is open; the exit code is passed by value.
		unsafe { TerminateProcess(process.as_raw_handle(), 1) != 0 }
	}

	/// Resolves once `process` exits; needs `SYNCHRONIZE` access.
	///
	/// A registered thread-pool wait wakes the task, so no thread is parked
	/// per waiter: a blocking wait would hold one of the runtime's few
	/// blocking-pool threads for as long as the process lives. Dropping the
	/// future unregisters the wait.
	pub async fn exited(process: Arc<OwnedHandle>) -> std::io::Result<()> {
		let wait = ExitWait::register(process)?;
		wait.notify.notified().await;
		Ok(())
	}

	/// A registered thread-pool wait that wakes `notify` when `process` is
	/// signalled. Dropping it unregisters the wait before releasing the
	/// reference the callback holds; `process` stays open until then.
	struct ExitWait {
		/// The wait handle as an integer, so the awaiting future stays `Send`.
		wait:    isize,
		notify:  Arc<tokio::sync::Notify>,
		process: Arc<OwnedHandle>,
	}

	impl ExitWait {
		fn register(process: Arc<OwnedHandle>) -> std::io::Result<Self> {
			let notify = Arc::new(tokio::sync::Notify::new());
			let context = Arc::into_raw(Arc::clone(&notify));
			let mut wait: RawHandle = std::ptr::null_mut();
			// SAFETY: `process` is a live handle the returned `ExitWait` keeps
			// open for as long as the wait is registered; `context` is a counted
			// `Notify` reference the callback borrows until `Drop` unregisters it.
			let registered = unsafe {
				RegisterWaitForSingleObject(
					&raw mut wait,
					process.as_raw_handle(),
					Self::signalled,
					context.cast(),
					INFINITE,
					WT_EXECUTEONLYONCE,
				)
			};
			if registered == 0 {
				let err = std::io::Error::last_os_error();
				// SAFETY: registration failed, so the callback never receives
				// `context`; this releases the reference made for it.
				drop(unsafe { Arc::from_raw(context) });
				return Err(err);
			}
			Ok(Self { wait: wait as isize, notify, process })
		}

		unsafe extern "system" fn signalled(context: *mut c_void, _timed_out: u8) {
			// SAFETY: `context` is the `Notify` reference `register` handed over;
			// it stays alive until `Drop` has unregistered this callback.
			unsafe { &*context.cast::<tokio::sync::Notify>() }.notify_one();
		}
	}

	impl Drop for ExitWait {
		fn drop(&mut self) {
			// `INVALID_HANDLE_VALUE`: block until a running callback returns.
			let wait_for_callbacks = -1isize as RawHandle;
			// SAFETY: `self.wait` is the registered wait. Blocking on a running
			// callback is brief (it only stores a permit), after which no
			// callback can start.
			let _ = unsafe { UnregisterWaitEx(self.wait as RawHandle, wait_for_callbacks) };
			// SAFETY: the callback can no longer run, so the reference created
			// for it in `register` is released exactly once.
			drop(unsafe { Arc::from_raw(Arc::as_ptr(&self.notify)) });
		}
	}

	/// The parent pid recorded at creation (see [`ProcessEntry::ppid`]).
	pub fn parent_pid(process: &OwnedHandle) -> Option<i32> {
		// SAFETY: the C record of integers is valid when zeroed.
		let mut info = unsafe { std::mem::zeroed::<ProcessBasicInformation>() };
		let mut returned = 0u32;
		// SAFETY: info is writable for exactly the supplied size.
		let status = unsafe {
			NtQueryInformationProcess(
				process.as_raw_handle(),
				PROCESS_BASIC_INFORMATION,
				(&raw mut info).cast(),
				size_of::<ProcessBasicInformation>() as u32,
				&raw mut returned,
			)
		};
		if status != 0 {
			return None;
		}
		i32::try_from(info.inherited_from_unique_process_id)
			.ok()
			.filter(|pid| *pid > 0)
	}

	/// The process's command line, one kernel query on any handle with
	/// `PROCESS_QUERY_LIMITED_INFORMATION`; `None` when unreadable or empty.
	pub fn command_line(process: &OwnedHandle) -> Option<String> {
		let handle = process.as_raw_handle();
		let mut bytes = 0u32;
		// SAFETY: a null sizing query writes only the required byte count.
		unsafe {
			NtQueryInformationProcess(
				handle,
				PROCESS_COMMAND_LINE_INFORMATION,
				std::ptr::null_mut(),
				0,
				&raw mut bytes,
			);
		}
		if bytes < size_of::<UnicodeString>() as u32 {
			return None;
		}
		let words = (bytes as usize).div_ceil(size_of::<usize>());
		let mut storage = vec![0usize; words];
		// SAFETY: storage is aligned and writable for at least `bytes` bytes.
		let status = unsafe {
			NtQueryInformationProcess(
				handle,
				PROCESS_COMMAND_LINE_INFORMATION,
				storage.as_mut_ptr().cast(),
				bytes,
				&raw mut bytes,
			)
		};
		if status < 0 {
			return None;
		}
		// SAFETY: a successful query initializes a UnicodeString at the buffer head.
		let command = unsafe { &*storage.as_ptr().cast::<UnicodeString>() };
		let length = usize::from(command.length);
		if length == 0 || length % size_of::<u16>() != 0 {
			return None;
		}
		let base = storage.as_ptr() as usize;
		let end = base.checked_add(storage.len().checked_mul(size_of::<usize>())?)?;
		let command_start = command.buffer as usize;
		let command_end = command_start.checked_add(length)?;
		if command_start < base || command_end > end {
			return None;
		}
		// SAFETY: the validated range is aligned for UTF-16 within the query buffer.
		let units = unsafe { std::slice::from_raw_parts(command.buffer, length / size_of::<u16>()) };
		Some(String::from_utf16_lossy(units)).filter(|command| !command.is_empty())
	}

	/// Splits a command line into arguments the way the C runtime does.
	pub fn split_command_line(command_line: &str) -> Vec<String> {
		let wide: Vec<u16> = command_line.encode_utf16().chain([0]).collect();
		let mut argc = 0i32;
		// SAFETY: wide is NUL-terminated and alive for the call; argc is a valid
		// out-parameter. The returned block is released with LocalFree below.
		let argv = unsafe { CommandLineToArgvW(wide.as_ptr(), &raw mut argc) };
		if argv.is_null() {
			return Vec::new();
		}
		// SAFETY: CommandLineToArgvW returned `argc` argument pointers, valid
		// until LocalFree.
		let pointers = unsafe { std::slice::from_raw_parts(argv, usize::try_from(argc).unwrap_or(0)) };
		let args = pointers
			.iter()
			.filter(|arg| !arg.is_null())
			.map(|&arg| {
				let mut len = 0usize;
				// SAFETY: each argument is NUL-terminated inside the argv block.
				while unsafe { *arg.add(len) } != 0 {
					len += 1;
				}
				// SAFETY: the `len` units before the terminator are readable.
				String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(arg, len) })
			})
			.collect();
		// SAFETY: argv is the unfreed CommandLineToArgvW block; nothing points
		// into it any more.
		unsafe { LocalFree(argv.cast()) };
		args
	}

	/// The full Win32 path of the process's executable, read into `buffer`;
	/// needs `PROCESS_QUERY_LIMITED_INFORMATION`.
	pub fn image_path<'a>(process: &OwnedHandle, buffer: &'a mut [u16]) -> Option<&'a [u16]> {
		let mut size = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
		// SAFETY: buffer is writable for `size` UTF-16 units; size is in/out.
		let ok = unsafe {
			QueryFullProcessImageNameW(process.as_raw_handle(), 0, buffer.as_mut_ptr(), &raw mut size)
		};
		(ok != 0).then(|| &buffer[..size as usize])
	}
}

#[cfg(target_os = "windows")]
mod proc_snapshot {
	use std::{
		collections::HashMap,
		mem::size_of,
		os::windows::io::{AsRawHandle, HandleOrNull, OwnedHandle, RawHandle},
		sync::Arc,
		time::Duration,
	};

	use super::{
		ProcessStatus, ThreadInfo,
		sys::{self, FileTime, ProcessEntry},
	};

	const TH32CS_SNAPTHREAD: u32 = 0x0000_0004;
	const THREAD_QUERY_LIMITED_INFORMATION: u32 = 0x0800;

	#[repr(C)]
	struct ThreadEntry32 {
		size:           u32,
		usage:          u32,
		tid:            u32,
		owner_pid:      u32,
		base_priority:  i32,
		delta_priority: i32,
		flags:          u32,
	}

	#[repr(C)]
	struct ProcessMemoryCounters {
		cb: u32,
		page_fault_count: u32,
		peak_working_set_size: usize,
		working_set_size: usize,
		quota_peak_paged_pool_usage: usize,
		quota_paged_pool_usage: usize,
		quota_peak_non_paged_pool_usage: usize,
		quota_non_paged_pool_usage: usize,
		pagefile_usage: usize,
		peak_pagefile_usage: usize,
	}

	#[link(name = "kernel32")]
	unsafe extern "system" {
		fn Thread32First(snapshot: RawHandle, entry: *mut ThreadEntry32) -> i32;
		fn Thread32Next(snapshot: RawHandle, entry: *mut ThreadEntry32) -> i32;
		fn OpenThread(access: u32, inherit: i32, tid: u32) -> RawHandle;
		fn GetThreadTimes(
			handle: RawHandle,
			creation: *mut FileTime,
			exit: *mut FileTime,
			kernel: *mut FileTime,
			user: *mut FileTime,
		) -> i32;
		fn GetSystemTimeAsFileTime(time: *mut FileTime);
		fn K32GetProcessMemoryInfo(
			handle: RawHandle,
			counters: *mut ProcessMemoryCounters,
			size: u32,
		) -> i32;
	}

	#[derive(Clone)]
	pub struct ProcInfo {
		pid:           i32,
		handle:        Arc<OwnedHandle>,
		ppid:          i32,
		threads:       u32,
		base_priority: i32,
		name:          String,
		command_line:  String,
		creation:      u64,
	}

	#[allow(
		clippy::unnecessary_wraps,
		reason = "Option returns match the cross-platform ProcInfo contract"
	)]
	impl ProcInfo {
		pub fn all() -> Vec<Self> {
			let mut handles = HashMap::new();
			for entry in sys::processes() {
				if let Some(identity) = open_process_identity(entry.pid) {
					handles.insert(entry.pid, identity);
				}
			}

			sys::processes()
				.filter_map(|entry| {
					let (handle, creation) = handles.remove(&entry.pid)?;
					Self::from_entry(&entry, handle, creation)
				})
				.collect()
		}

		fn from_entry(entry: &ProcessEntry, handle: Arc<OwnedHandle>, creation: u64) -> Option<Self> {
			let pid = i32::try_from(entry.pid).ok().filter(|pid| *pid > 0)?;
			// A PID reused after the handle was opened appears in the refreshed
			// snapshot, but the pinned predecessor is already signalled as exited.
			if sys::has_exited(&handle) {
				return None;
			}
			let name = entry.exe_name();
			let command_line = sys::command_line(&handle).unwrap_or_else(|| name.clone());
			Some(Self {
				pid,
				handle,
				ppid: i32::try_from(entry.ppid).unwrap_or(0),
				threads: entry.threads,
				base_priority: entry.base_priority,
				name,
				command_line,
				creation,
			})
		}

		pub fn pid(&self) -> i32 {
			self.pid
		}

		pub fn ppid(&self) -> Option<i32> {
			Some(self.ppid)
		}

		pub fn args(&self) -> Vec<String> {
			vec![self.command_line.clone()]
		}

		pub fn group_id(&self) -> Option<i32> {
			None
		}

		pub fn session_id(&self) -> Option<i32> {
			None
		}

		pub fn real_user_id(&self) -> Option<u32> {
			None
		}

		pub fn effective_user_id(&self) -> Option<u32> {
			None
		}

		pub fn real_group_id(&self) -> Option<u32> {
			None
		}

		pub fn terminal_id(&self) -> Option<u64> {
			None
		}

		pub fn terminal_group_id(&self) -> Option<i32> {
			None
		}

		pub fn effective_group_id(&self) -> Option<u32> {
			None
		}

		pub fn priority(&self) -> Option<i32> {
			None
		}

		pub fn flags(&self) -> Option<u64> {
			None
		}

		pub fn minor_faults(&self) -> Option<u64> {
			None
		}

		pub fn major_faults(&self) -> Option<u64> {
			None
		}

		pub fn wchan(&self) -> Option<String> {
			None
		}

		pub fn state(&self) -> char {
			if self.status() == ProcessStatus::Running {
				'R'
			} else {
				'?'
			}
		}

		pub fn start_time(&self) -> u64 {
			self.creation
		}

		pub fn age(&self) -> Option<Duration> {
			Some(ticks_duration(now_ticks().saturating_sub(self.creation)))
		}

		pub fn match_name(&self) -> String {
			self.name.clone()
		}

		pub fn command_name(&self) -> String {
			self.name.clone()
		}

		pub fn status(&self) -> ProcessStatus {
			if sys::has_exited(&self.handle) {
				ProcessStatus::Exited
			} else {
				ProcessStatus::Running
			}
		}

		/// Resolves once this process exits. Waits on the handle the snapshot
		/// opened, so a process that later reuses the pid cannot stand in for it.
		pub async fn exited(&self) -> std::io::Result<()> {
			sys::exited(Arc::clone(&self.handle)).await
		}

		pub fn signal(&self, signal: i32, _queue: Option<i32>) -> bool {
			if signal == 0 {
				return self.status() == ProcessStatus::Running;
			}
			let Some(handle) = sys::open_process(
				self.pid as u32,
				sys::PROCESS_TERMINATE | sys::PROCESS_QUERY_LIMITED_INFORMATION,
			) else {
				return false;
			};
			sys::process_times(&handle).map(|times| times.0) == Some(self.creation)
				&& sys::terminate(&handle)
		}

		pub fn cpu_time(&self) -> Option<Duration> {
			let (_, kernel, user) = sys::process_times(&self.handle)?;
			Some(ticks_duration(kernel.saturating_add(user)))
		}

		pub fn resident_bytes(&self) -> Option<u64> {
			Some(process_memory(&self.handle)?.working_set_size as u64)
		}

		pub fn virtual_bytes(&self) -> Option<u64> {
			None
		}

		pub fn thread_count(&self) -> Option<u32> {
			Some(self.threads)
		}

		pub fn nice(&self) -> Option<i32> {
			Some(self.base_priority)
		}
	}

	/// Lists every thread of each process from one system-wide Toolhelp
	/// snapshot. Windows exposes no run state or scheduling policy here, and
	/// times stay `None` for threads of protected processes.
	pub fn threads_by_pid(processes: &[ProcInfo]) -> HashMap<i32, Vec<ThreadInfo>> {
		let mut threads: HashMap<i32, Vec<ThreadInfo>> = processes
			.iter()
			.map(|process| (process.pid, Vec::new()))
			.collect();
		let Some(snapshot) = sys::toolhelp_snapshot(TH32CS_SNAPTHREAD) else {
			return threads;
		};
		let now = now_ticks();
		// SAFETY: the all-zero entry is initialized with its ABI size below.
		let mut entry = unsafe { std::mem::zeroed::<ThreadEntry32>() };
		entry.size = size_of::<ThreadEntry32>() as u32;
		// SAFETY: snapshot and entry are valid.
		let mut ok = unsafe { Thread32First(snapshot.as_raw_handle(), &raw mut entry) };
		while ok != 0 {
			if let Ok(pid) = i32::try_from(entry.owner_pid)
				&& let Some(list) = threads.get_mut(&pid)
			{
				let times = thread_times(entry.tid);
				list.push(ThreadInfo {
					state:       '?',
					priority:    Some(entry.base_priority),
					policy:      None,
					user_time:   times.map(|(_, _, user)| ticks_duration(user)),
					system_time: times.map(|(_, kernel, _)| ticks_duration(kernel)),
					cpu_percent: times.map(|(creation, kernel, user)| {
						let age = now.saturating_sub(creation);
						if age > 0 { 100.0 * kernel.saturating_add(user) as f64 / age as f64 } else { 0.0 }
					}),
				});
			}
			// SAFETY: snapshot and entry remain valid.
			ok = unsafe { Thread32Next(snapshot.as_raw_handle(), &raw mut entry) };
		}
		threads
	}

	/// `(creation, kernel, user)` FILETIME ticks of one thread.
	fn thread_times(tid: u32) -> Option<(u64, u64, u64)> {
		// SAFETY: OpenThread returns a new owned query handle or null.
		let handle = unsafe { OpenThread(THREAD_QUERY_LIMITED_INFORMATION, 0, tid) };
		// SAFETY: a non-null result is a fresh handle nothing else owns.
		let handle = OwnedHandle::try_from(unsafe { HandleOrNull::from_raw_handle(handle) }).ok()?;
		let mut creation = FileTime::default();
		let mut exit = FileTime::default();
		let mut kernel = FileTime::default();
		let mut user = FileTime::default();
		// SAFETY: all FILETIME output pointers are valid and writable.
		let ok = unsafe {
			GetThreadTimes(
				handle.as_raw_handle(),
				&raw mut creation,
				&raw mut exit,
				&raw mut kernel,
				&raw mut user,
			)
		};
		(ok != 0).then(|| (creation.ticks(), kernel.ticks(), user.ticks()))
	}

	fn open_process_identity(pid: u32) -> Option<(Arc<OwnedHandle>, u64)> {
		i32::try_from(pid).ok().filter(|pid| *pid > 0)?;
		let handle =
			sys::open_process(pid, sys::PROCESS_QUERY_LIMITED_INFORMATION | sys::SYNCHRONIZE)?;
		let creation = sys::process_times(&handle)?.0;
		Some((Arc::new(handle), creation))
	}

	/// Converts 100 ns FILETIME ticks.
	fn ticks_duration(ticks: u64) -> Duration {
		Duration::from_nanos(ticks.saturating_mul(100))
	}

	fn now_ticks() -> u64 {
		let mut now = FileTime::default();
		// SAFETY: now is writable for one FILETIME.
		unsafe { GetSystemTimeAsFileTime(&raw mut now) };
		now.ticks()
	}

	fn process_memory(process: &OwnedHandle) -> Option<ProcessMemoryCounters> {
		// SAFETY: the C record is valid when zeroed and cb is set before the call.
		let mut counters = unsafe { std::mem::zeroed::<ProcessMemoryCounters>() };
		counters.cb = size_of::<ProcessMemoryCounters>() as u32;
		// SAFETY: counters is writable for the supplied exact size.
		let ok = unsafe {
			K32GetProcessMemoryInfo(
				process.as_raw_handle(),
				&raw mut counters,
				size_of::<ProcessMemoryCounters>() as u32,
			)
		};
		(ok != 0).then_some(counters)
	}
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos", target_os = "windows"))]
pub use proc_snapshot::{ProcInfo, threads_by_pid};

/// The processes a signal must never reach: this one and its ancestors.
///
/// Resolve once per command, then read the fields. Self-kill was always refused,
/// but an ancestor is a different process — and usually a different process group
/// and session — so nothing stopped `kill <terminal pid>` or `pkill <terminal>`
/// from taking down the terminal the whole session lives in, harness included.
/// Everything above us in the tree is load-bearing for our own existence.
///
/// Two properties are deliberate:
///
/// * **Resolved, not cached.** A parent that detaches us and then exits frees its
///   pid for the OS to recycle; a remembered chain would go on refusing that pid
///   and quietly protect whatever unrelated process inherited it. Each resolve
///   reflects the tree as it is now.
/// * **Inline, not hashed.** A parent chain is four or five numbers, so it lives
///   in stack-inline storage that callers scan directly. There is no per-target
///   query entry point here, because one invites re-resolving per target — which
///   is a full process-table walk each time.
///
/// Listing is unaffected: `pgrep` still reports ancestors and `ps` still shows
/// them. Only signalling consults this.
#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos", target_os = "windows"))]
pub(crate) struct HostProcesses {
	/// This process and its ancestors, nearest first.
	pub pids:  smallvec::SmallVec<[i32; 16]>,
	/// The process groups those processes belong to.
	pub pgids: smallvec::SmallVec<[i32; 16]>,
}

/// One process as the chain walk sees it.
///
/// Keeping the walk over this rather than over [`ProcInfo`] lets the recycling
/// cases — which are otherwise only reachable by winning a race against the OS —
/// be tested with a synthetic tree.
#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos", target_os = "windows"))]
#[derive(Clone, Copy)]
struct ChainNode {
	ppid:  Option<i32>,
	pgid:  Option<i32>,
	/// Platform start time. Monotonic on every supported platform, so a larger
	/// value means the process started later.
	start: u64,
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos", target_os = "windows"))]
impl HostProcesses {
	/// Walks the parent chain from the current process, taking one process-table
	/// snapshot.
	pub fn resolve() -> Self {
		Self::resolve_in(&ProcInfo::all())
	}

	/// [`Self::resolve`] against a snapshot the caller already holds.
	///
	/// `pkill` snapshots the table to select its targets; this spares it a second.
	pub fn resolve_in(all: &[ProcInfo]) -> Self {
		let Ok(self_pid) = i32::try_from(std::process::id()) else {
			return Self { pids: smallvec::SmallVec::new(), pgids: smallvec::SmallVec::new() };
		};
		Self::walk(self_pid, |pid| {
			all
				.iter()
				.find(|process| process.pid() == pid)
				.map(|process| ChainNode {
					ppid:  process.ppid(),
					pgid:  process.group_id(),
					start: process.start_time(),
				})
		})
	}

	/// Walks from `self_pid` up through `lookup`, collecting the chain.
	///
	/// A recorded parent pid is followed only when the process holding it is both
	/// **present** and **no younger than its child**. Presence alone is not enough:
	/// an entry can name a parent that already exited, and once that number is
	/// recycled the replacement *is* present — protecting it would hand our
	/// immunity to an unrelated process. A real parent cannot have started after
	/// its child, so a later start time identifies the impostor. Equal start times
	/// are accepted, since a `fork` within one clock tick is indistinguishable at
	/// this resolution.
	fn walk(self_pid: i32, lookup: impl Fn(i32) -> Option<ChainNode>) -> Self {
		let mut pids = smallvec::SmallVec::new();
		let mut pgids = smallvec::SmallVec::new();

		// We always protect ourselves, whether or not the snapshot lists us.
		pids.push(self_pid);
		let mut node = lookup(self_pid);
		while let Some(current) = node {
			if let Some(pgid) = current.pgid
				&& !pgids.contains(&pgid)
			{
				pgids.push(pgid);
			}
			let Some(parent) = current.ppid else {
				break;
			};
			// pid 0 is not a signallable process on any supported platform, and a
			// repeat means the parent chain looped back on itself.
			if parent == 0 || pids.contains(&parent) {
				break;
			}
			let Some(found) = lookup(parent) else {
				break;
			};
			if found.start > current.start {
				break;
			}
			pids.push(parent);
			node = Some(found);
		}
		Self { pids, pgids }
	}
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod tests {
	use super::{HostProcesses, ProcInfo};

	use super::{ChainNode, macos_pid_buffer_size, parse_procargs2};

	#[test]
	fn macos_pid_buffer_size_preserves_count_and_checks_byte_capacity() {
		let count = 4097;
		let (capacity, bytes) = macos_pid_buffer_size(count).expect("valid PID count");
		assert!(capacity > usize::try_from(count).unwrap(), "leave room for new processes");
		assert_eq!(usize::try_from(bytes).unwrap(), capacity * size_of::<i32>());
		assert_eq!(macos_pid_buffer_size(i32::MAX), None, "byte size must fit the C ABI");
		assert_eq!(macos_pid_buffer_size(0), None);
		assert_eq!(macos_pid_buffer_size(-1), None);
	}

	/// `ps`, `pgrep -f` and `Process.args` on macOS must list argv only: the
	/// environment follows argv in the same buffer, in the same NUL-separated
	/// form, and only argc tells them apart.
	#[test]
	fn procargs2_yields_argv_without_exec_path_or_environment() {
		let buffer = [&2i32.to_ne_bytes()[..], b"/bin/sleep\0\0\0\0sleep\x0030\0HOME=/root\0"].concat();
		assert_eq!(parse_procargs2(&buffer), ["sleep", "30"]);
		let negative = [&(-1i32).to_ne_bytes()[..], b"/bin/sleep\0sleep\0"].concat();
		assert!(parse_procargs2(&negative).is_empty());
		assert!(parse_procargs2(&[1, 0]).is_empty(), "a truncated header has no arguments");
	}

	/// Builds a lookup over a synthetic `(pid, ppid, pgid, start)` tree.
	fn tree(nodes: &[(i32, Option<i32>, Option<i32>, u64)]) -> impl Fn(i32) -> Option<ChainNode> + '_ {
		|pid| {
			nodes
				.iter()
				.find(|(candidate, ..)| *candidate == pid)
				.map(|(_, ppid, pgid, start)| ChainNode { ppid: *ppid, pgid: *pgid, start: *start })
		}
	}

	/// The case presence alone cannot catch: our recorded parent exited and its pid
	/// was reused, so the number *is* in the table — held by a process that started
	/// after us. Following it would hand our immunity to an unrelated process, and
	/// on a long-lived shell that is a silent `kill` failure against a real target.
	#[test]
	fn a_recycled_parent_pid_is_not_followed() {
		// 100 is us, started at t=50; our recorded parent 42 is now a process that
		// started at t=90, i.e. after us, so it cannot be our parent.
		let host = HostProcesses::walk(
			100,
			tree(&[(100, Some(42), Some(7), 50), (42, Some(1), Some(9), 90)]),
		);
		assert_eq!(host.pids.as_slice(), [100], "a younger impostor must not join the chain");
		assert!(!host.pgids.contains(&9), "the impostor's group must not be protected either");
	}

	/// The mirror of the above: a genuine parent started before its child and must
	/// be followed, or the guard protects nothing but ourselves.
	#[test]
	fn an_older_parent_is_followed() {
		let host = HostProcesses::walk(
			100,
			tree(&[(100, Some(42), Some(7), 50), (42, Some(1), Some(9), 10), (1, None, Some(1), 0)]),
		);
		assert_eq!(host.pids.as_slice(), [100, 42, 1], "the real chain must be walked to the root");
		assert!(host.pgids.contains(&9), "an ancestor's group must be protected");
	}

	/// A `fork` inside one clock tick gives parent and child the same start time, so
	/// equality must be accepted — rejecting it would drop real parents on Linux,
	/// where start time is measured in jiffies.
	#[test]
	fn a_same_tick_parent_is_followed() {
		let host = HostProcesses::walk(
			100,
			tree(&[(100, Some(42), Some(7), 50), (42, None, Some(7), 50)]),
		);
		assert_eq!(host.pids.as_slice(), [100, 42], "same-tick parent must still be an ancestor");
	}

	/// A parent absent from the table has exited and its number may already be
	/// reused; the walk stops rather than protecting it.
	#[test]
	fn a_departed_parent_stops_the_walk() {
		let host = HostProcesses::walk(100, tree(&[(100, Some(42), Some(7), 50)]));
		assert_eq!(host.pids.as_slice(), [100], "an unobserved parent must not join the chain");
	}

	/// A cycle in the recorded parent links must not spin forever.
	#[test]
	fn a_cyclic_parent_chain_terminates() {
		let host = HostProcesses::walk(
			100,
			tree(&[(100, Some(42), Some(7), 50), (42, Some(100), Some(7), 10)]),
		);
		assert_eq!(host.pids.as_slice(), [100, 42], "the cycle must close the walk");
	}

	/// The resolved chain must be a real, contiguous parent walk over the snapshot:
	/// it starts at us, every later entry is the recorded parent of the one before
	/// it, and every entry after the first was actually observed.
	///
	/// Asserted as an invariant rather than against a second hand-rolled walk,
	/// because the naive walk is what gets this wrong: a recorded parent pid can
	/// name a process that has already exited (observed in practice on macOS, where
	/// a detached `zsh` kept reporting a departed parent), and following it blindly
	/// is the pid-recycling hazard this type exists to avoid.
	#[test]
	fn chain_is_a_contiguous_parent_walk_over_observed_processes() {
		let all = ProcInfo::all();
		let host = HostProcesses::resolve_in(&all);
		let self_pid = i32::try_from(std::process::id()).expect("pid fits in i32");

		assert_eq!(host.pids.first(), Some(&self_pid), "the chain must start at us");
		for pair in host.pids.windows(2) {
			let [child, parent] = [pair[0], pair[1]];
			let entry = all
				.iter()
				.find(|process| process.pid() == child)
				.unwrap_or_else(|| panic!("chain entry {child} was never observed"));
			assert_eq!(
				entry.ppid(),
				Some(parent),
				"{parent} is in the chain but is not the recorded parent of {child}"
			);
			assert!(
				all.iter().any(|process| process.pid() == parent),
				"ancestor {parent} is in the chain but was never observed"
			);
		}
	}

	/// The walk must not stop early: it continues while the next parent is a
	/// distinct, observed process that is no younger than its child. Stopping one
	/// link short is what would leave the terminal signallable, since a terminal
	/// sits two or more levels up (terminal -> shell -> harness).
	///
	/// The three legitimate stop reasons are enumerated so a real machine with a
	/// stale or recycled parent link does not make this flaky.
	#[test]
	fn chain_extends_until_a_stop_condition_is_reached() {
		let all = ProcInfo::all();
		let host = HostProcesses::resolve_in(&all);
		let last = *host.pids.last().expect("chain is never empty");
		let last_entry = all.iter().find(|process| process.pid() == last);
		let Some(next) = last_entry.and_then(ProcInfo::ppid) else {
			return; // No recorded parent: nothing left to walk.
		};
		let candidate = all.iter().find(|process| process.pid() == next);
		let younger = match (last_entry, candidate) {
			(Some(child), Some(parent)) => parent.start_time() > child.start_time(),
			_ => false,
		};
		assert!(
			next == 0 || host.pids.contains(&next) || candidate.is_none() || younger,
			"the walk stopped at {last} while {next} was still a valid, unseen parent"
		);
	}

	/// A pid outside our ancestry must stay signallable, or `kill` becomes useless.
	/// Guards against over-broad protection (a whole session, say).
	#[test]
	fn leaves_unrelated_processes_out_of_the_chain() {
		let host = HostProcesses::resolve();
		assert!(
			ProcInfo::all()
				.iter()
				.map(ProcInfo::pid)
				.any(|pid| !host.pids.contains(&pid)),
			"every visible process is in the chain, which cannot be right"
		);
	}

	/// Regression guard for the pid-recycling hazard: the chain comes from the
	/// snapshot handed in, so a parent absent from it — exited, and its number free
	/// for reuse — is never carried forward.
	#[test]
	fn a_departed_parent_leaves_no_stale_pid() {
		let self_pid = i32::try_from(std::process::id()).expect("pid fits in i32");
		let all = ProcInfo::all();
		let recorded_parent = all
			.iter()
			.find(|process| process.pid() == self_pid)
			.and_then(ProcInfo::ppid);
		let without_parent: Vec<ProcInfo> = all
			.into_iter()
			.filter(|process| process.pid() == self_pid)
			.collect();

		let host = HostProcesses::resolve_in(&without_parent);
		assert_eq!(host.pids.as_slice(), [self_pid], "only observed processes belong in the chain");
		if let Some(parent) = recorded_parent {
			assert!(
				!host.pids.contains(&parent),
				"pid {parent} was carried forward despite being absent from the snapshot"
			);
		}
	}

	/// Our own process group is recorded without being special-cased, which is what
	/// lets `kill -<pgid>` be refused by a plain membership test.
	#[cfg(unix)]
	#[test]
	fn records_our_own_process_group() {
		let host = HostProcesses::resolve();
		// SAFETY: getpgrp takes no arguments and touches no memory.
		let pgid = unsafe { libc::getpgrp() };
		assert!(host.pgids.contains(&pgid), "own process group {pgid} missing");
	}

	/// The chain is a handful of numbers; keeping it in inline storage is the whole
	/// reason this is not a hashed set.
	#[test]
	fn chain_stays_in_inline_storage() {
		let host = HostProcesses::resolve();
		assert!(
			!host.pids.spilled() && !host.pgids.spilled(),
			"chain spilled to the heap: {} pids, {} pgids",
			host.pids.len(),
			host.pgids.len()
		);
	}
}
