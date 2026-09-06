//! Process-table snapshots for the process builtins (`ps`, `top`, `pgrep`,
//! `pkill`, `pidwait`, `kill`).
//!
//! One `ProcInfo` per platform, each exposing the same accessors so the
//! builtins above stay platform-agnostic. Lifted out of `pi-shell` when the
//! process builtins moved into this crate; `pi-shell` keeps its own
//! session/teardown process management (`pi_shell::process`), which is a
//! different concern and a different type.

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

#[cfg(any(target_os = "android", target_os = "linux"))]
mod proc_snapshot {
	use std::{
		fs,
		os::fd::{AsRawFd, FromRawFd, OwnedFd},
		time::Duration,
	};

	use super::ProcessStatus;

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
			let Ok(entries) = fs::read_dir("/proc") else {
				return Vec::new();
			};
			let mut result = Vec::new();
			for entry in entries.flatten() {
				let Some(pid) = entry
					.file_name()
					.to_str()
					.and_then(|name| name.parse::<i32>().ok())
				else {
					continue;
				};
				if let Some(process) = Self::from_pid(pid) {
					result.push(process);
				}
			}
			result
		}

		fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let stat = read_stat(pid)?;
			let args = fs::read(format!("/proc/{pid}/cmdline"))
				.ok()
				.map(|bytes| {
					bytes
						.split(|byte| *byte == 0)
						.filter(|part| !part.is_empty())
						.map(|part| String::from_utf8_lossy(part).into_owned())
						.collect()
				})
				.unwrap_or_default();
			let uid = status_ids(pid, "Uid:").map(|ids| (ids.0, ids.1));
			let gid = status_ids(pid, "Gid:");
			(read_stat(pid)?.start_time == stat.start_time).then_some(Self {
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
			if signal == 0 {
				return read_stat(self.pid).is_some_and(|stat| stat.start_time == self.stat.start_time);
			}
			let Some(pidfd) = open_pidfd(self.pid) else {
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
			if read_stat(self.pid).is_none_or(|stat| stat.start_time != self.stat.start_time) {
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
			// SAFETY: pidfd is valid and pidfd_send_signal reads no optional pointers.
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

	fn open_pidfd(pid: i32) -> Option<OwnedFd> {
		// SAFETY: pidfd_open takes scalar arguments and returns a new owned fd.
		let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as i32;
		(fd >= 0).then(|| {
			// SAFETY: successful pidfd_open returned a uniquely owned descriptor.
			unsafe { OwnedFd::from_raw_fd(fd) }
		})
	}

	fn read_stat(pid: i32) -> Option<Stat> {
		let content = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
		let open = content.find('(')?;
		let close = content.rfind(')')?;
		let comm = content[open + 1..close].to_string();
		let fields: Vec<&str> = content[close + 1..].split_whitespace().collect();
		Some(Stat {
			comm,
			state: fields.first()?.chars().next()?,
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
#[cfg(target_os = "macos")]
mod proc_snapshot {
	use std::{
		ffi::CStr,
		mem::size_of,
		path::Path,
		ptr,
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	use super::ProcessStatus;

	const KERN_PROCARGS2: libc::c_int = 49;

	#[link(name = "proc", kind = "dylib")]
	unsafe extern "C" {
		fn proc_listallpids(buffer: *mut i32, buffersize: i32) -> i32;
	}

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
			// SAFETY: null/zero is libproc's documented sizing query.
			let reported = unsafe { proc_listallpids(ptr::null_mut(), 0) };
			if reported <= 0 {
				return Vec::new();
			}
			let count = (reported as usize).saturating_mul(2).max(2048);
			let mut pids = vec![0i32; count];
			// SAFETY: pids is writable for the supplied byte size.
			let actual =
				unsafe { proc_listallpids(pids.as_mut_ptr(), (pids.len() * size_of::<i32>()) as i32) };
			if actual <= 0 {
				return Vec::new();
			}
			pids.truncate((actual as usize).min(pids.len()));
			pids.into_iter().filter_map(Self::from_pid).collect()
		}

		fn from_pid(pid: i32) -> Option<Self> {
			let info = read_bsdinfo(pid)?;
			Some(Self { pid, info, task: read_taskinfo(pid), args: process_args(pid) })
		}

		fn live_info(&self) -> Option<libc::proc_bsdinfo> {
			let info = read_bsdinfo(self.pid())?;
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

		pub const fn state(&self) -> char {
			match self.info.pbi_status {
				1 => 'I',
				2 => 'R',
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

	fn read_bsdinfo(pid: i32) -> Option<libc::proc_bsdinfo> {
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

	fn process_args(pid: i32) -> Vec<String> {
		let mut mib = [libc::CTL_KERN, KERN_PROCARGS2, pid];
		let mut size = 0usize;
		// SAFETY: null old-value is the sysctl sizing form.
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
		let argc_size = size_of::<libc::c_int>();
		let Some(argc_bytes) = buffer.get(..argc_size) else {
			return Vec::new();
		};
		let Ok(argc_bytes) = <[u8; 4]>::try_from(argc_bytes) else {
			return Vec::new();
		};
		let argc = i32::from_ne_bytes(argc_bytes);
		let mut offset = argc_size;
		while offset < buffer.len() && buffer[offset] != 0 {
			offset += 1;
		}
		while offset < buffer.len() && buffer[offset] == 0 {
			offset += 1;
		}
		let mut args = Vec::new();
		while offset < buffer.len() && args.len() < argc.max(0) as usize {
			let end = buffer[offset..]
				.iter()
				.position(|byte| *byte == 0)
				.map_or(buffer.len(), |position| offset + position);
			if end == offset {
				break;
			}
			args.push(String::from_utf8_lossy(&buffer[offset..end]).into_owned());
			offset = end + 1;
		}
		args
	}
}
#[cfg(target_os = "windows")]
mod proc_snapshot {
	use std::{collections::HashMap, ffi::c_void, mem::size_of, sync::Arc, time::Duration};

	use super::ProcessStatus;

	type Handle = *mut c_void;
	const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
	const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
	const PROCESS_TERMINATE: u32 = 0x0001;
	const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
	const SYNCHRONIZE: u32 = 0x0010_0000;
	const WAIT_TIMEOUT: u32 = 0x0000_0102;

	#[repr(C)]
	#[derive(Clone, Copy)]
	struct ProcessEntry32W {
		size:          u32,
		usage:         u32,
		pid:           u32,
		default_heap:  usize,
		module_id:     u32,
		threads:       u32,
		ppid:          u32,
		base_priority: i32,
		flags:         u32,
		exe:           [u16; 260],
	}

	#[repr(C)]
	#[derive(Clone, Copy, Default)]
	struct FileTime {
		low:  u32,
		high: u32,
	}

	#[repr(C)]
	struct UnicodeString {
		length:         u16,
		maximum_length: u16,
		buffer:         *const u16,
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
		fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
		fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
		fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
		fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
		fn CloseHandle(handle: Handle) -> i32;
		fn TerminateProcess(handle: Handle, exit_code: u32) -> i32;
		fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
		fn GetProcessTimes(
			handle: Handle,
			creation: *mut FileTime,
			exit: *mut FileTime,
			kernel: *mut FileTime,
			user: *mut FileTime,
		) -> i32;
		fn GetSystemTimeAsFileTime(time: *mut FileTime);
		fn K32GetProcessMemoryInfo(
			handle: Handle,
			counters: *mut ProcessMemoryCounters,
			size: u32,
		) -> i32;
	}

	#[link(name = "ntdll")]
	unsafe extern "system" {
		fn NtQueryInformationProcess(
			handle: Handle,
			class: u32,
			information: *mut c_void,
			information_length: u32,
			return_length: *mut u32,
		) -> i32;
	}

	struct OwnedHandle(Handle);
	// SAFETY: kernel process handles are safe to wait/query from any thread.
	unsafe impl Send for OwnedHandle {}
	unsafe impl Sync for OwnedHandle {}
	impl Drop for OwnedHandle {
		fn drop(&mut self) {
			// SAFETY: this wrapper uniquely owns the valid handle.
			unsafe {
				CloseHandle(self.0);
			}
		}
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
			for entry in snapshot_entries() {
				if let Some(identity) = open_process_identity(entry.pid) {
					handles.insert(entry.pid, identity);
				}
			}

			snapshot_entries()
				.into_iter()
				.filter_map(|entry| {
					let (handle, creation) = handles.remove(&entry.pid)?;
					Self::from_entry(&entry, handle, creation)
				})
				.collect()
		}

		fn from_entry(
			entry: &ProcessEntry32W,
			handle: Arc<OwnedHandle>,
			creation: u64,
		) -> Option<Self> {
			let pid = i32::try_from(entry.pid).ok().filter(|pid| *pid > 0)?;
			// A PID reused after the handle was opened appears in the refreshed
			// snapshot, but the pinned predecessor is already signalled as exited.
			if unsafe { WaitForSingleObject(handle.0, 0) } != WAIT_TIMEOUT {
				return None;
			}
			let end = entry
				.exe
				.iter()
				.position(|unit| *unit == 0)
				.unwrap_or(entry.exe.len());
			let name = String::from_utf16_lossy(&entry.exe[..end]);
			let command_line = process_command_line(handle.0).unwrap_or_else(|| name.clone());
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
			let mut now = FileTime::default();
			// SAFETY: now is writable for one FILETIME.
			unsafe { GetSystemTimeAsFileTime(&raw mut now) };
			Some(Duration::from_nanos(
				filetime_ticks(now)
					.saturating_sub(self.creation)
					.saturating_mul(100),
			))
		}

		pub fn match_name(&self) -> String {
			self.name.clone()
		}

		pub fn command_name(&self) -> String {
			self.name.clone()
		}

		pub fn status(&self) -> ProcessStatus {
			// SAFETY: the retained process handle remains valid until drop.
			if unsafe { WaitForSingleObject(self.handle.0, 0) } == WAIT_TIMEOUT {
				ProcessStatus::Running
			} else {
				ProcessStatus::Exited
			}
		}

		pub fn signal(&self, signal: i32, _queue: Option<i32>) -> bool {
			if signal == 0 {
				return self.status() == ProcessStatus::Running;
			}
			// SAFETY: OpenProcess returns a fresh owned termination/query handle or null.
			let handle = unsafe {
				OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, self.pid as u32)
			};
			if handle.is_null() {
				return false;
			}
			let handle = OwnedHandle(handle);
			if process_times(handle.0).map(|times| times.0) != Some(self.creation) {
				return false;
			}
			// SAFETY: identity was verified on a handle with PROCESS_TERMINATE access.
			unsafe { TerminateProcess(handle.0, 1) != 0 }
		}

		pub fn cpu_time(&self) -> Option<Duration> {
			let (_, kernel, user) = process_times(self.handle.0)?;
			Some(Duration::from_nanos(kernel.saturating_add(user).saturating_mul(100)))
		}

		pub fn resident_bytes(&self) -> Option<u64> {
			Some(process_memory(self.handle.0)?.working_set_size as u64)
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

	fn snapshot_entries() -> Vec<ProcessEntry32W> {
		// SAFETY: documented scalar Toolhelp snapshot call.
		let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
		if snapshot == INVALID_HANDLE_VALUE {
			return Vec::new();
		}
		let snapshot = OwnedHandle(snapshot);
		// SAFETY: the all-zero entry is initialized with its ABI size below.
		let mut entry = unsafe { std::mem::zeroed::<ProcessEntry32W>() };
		entry.size = size_of::<ProcessEntry32W>() as u32;
		let mut result = Vec::new();
		// SAFETY: snapshot and entry are valid.
		let mut ok = unsafe { Process32FirstW(snapshot.0, &raw mut entry) };
		while ok != 0 {
			result.push(entry);
			// SAFETY: snapshot and entry remain valid.
			ok = unsafe { Process32NextW(snapshot.0, &raw mut entry) };
		}
		result
	}

	fn open_process_identity(pid: u32) -> Option<(Arc<OwnedHandle>, u64)> {
		i32::try_from(pid).ok().filter(|pid| *pid > 0)?;
		// SAFETY: OpenProcess returns a new owned query/synchronize handle or null.
		let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) };
		if handle.is_null() {
			return None;
		}
		let handle = Arc::new(OwnedHandle(handle));
		let creation = process_times(handle.0)?.0;
		Some((handle, creation))
	}

	fn process_command_line(handle: Handle) -> Option<String> {
		const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;
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

	fn filetime_ticks(time: FileTime) -> u64 {
		(u64::from(time.high) << 32) | u64::from(time.low)
	}

	fn process_times(handle: Handle) -> Option<(u64, u64, u64)> {
		let mut creation = FileTime::default();
		let mut exit = FileTime::default();
		let mut kernel = FileTime::default();
		let mut user = FileTime::default();
		// SAFETY: all FILETIME output pointers are valid and writable.
		let ok = unsafe {
			GetProcessTimes(handle, &raw mut creation, &raw mut exit, &raw mut kernel, &raw mut user)
		};
		(ok != 0).then(|| (filetime_ticks(creation), filetime_ticks(kernel), filetime_ticks(user)))
	}

	fn process_memory(handle: Handle) -> Option<ProcessMemoryCounters> {
		// SAFETY: the C record is valid when zeroed and cb is set before the call.
		let mut counters = unsafe { std::mem::zeroed::<ProcessMemoryCounters>() };
		counters.cb = size_of::<ProcessMemoryCounters>() as u32;
		// SAFETY: counters is writable for the supplied exact size.
		let ok = unsafe {
			K32GetProcessMemoryInfo(
				handle,
				&raw mut counters,
				size_of::<ProcessMemoryCounters>() as u32,
			)
		};
		(ok != 0).then_some(counters)
	}
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos", target_os = "windows"))]
pub use proc_snapshot::ProcInfo;

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

	use super::ChainNode;

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
