//! The OS process table (Unix): who is in a session or process group, and
//! identity-pinned signalling.
//!
//! Used by the spawner's leak checks and KILL escalation, and by
//! conformance harnesses to clean up after each upstream test driver. A pid can
//! be recycled between a scan and a signal; every signal here first pins the
//! scanned process: on Linux through a pidfd plus a start-time recheck (the
//! signal then cannot reach another process), on macOS through a start-time
//! recheck immediately before `kill` (the remaining window is a pid wrapping
//! around within microseconds).

use std::io;

use bstr::BString;

use crate::bash::{Platform, Signal};

/// One process of the table.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ProcInfo {
	/// Process id.
	pub pid:   i32,
	/// Parent pid.
	pub ppid:  i32,
	/// Process group.
	pub pgid:  i32,
	/// Session; `-1` when the kernel does not say (a macOS zombie).
	pub sid:   i32,
	/// Scheduling state.
	pub state: ProcState,
	/// Command name (`comm`).
	pub name:  BString,
	/// Kernel start time in platform units (Linux clock ticks since boot,
	/// macOS µs since the epoch); with `pid` it identifies the process.
	pub start: u64,
}

/// Coarse scheduling state of a [`ProcInfo`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, strum::IntoStaticStr)]
#[strum(serialize_all = "snake_case")]
pub enum ProcState {
	/// Running or runnable.
	Running,
	/// Sleeping (interruptibly or not).
	Sleeping,
	/// Stopped by a signal or traced.
	Stopped,
	/// Exited, not yet reaped.
	Zombie,
	/// Anything else (idle kernel threads, being created, dead).
	Other,
}

/// Every process visible to the caller.
pub fn list() -> io::Result<Vec<ProcInfo>> {
	sys::list()
}

/// The process `pid`, if it exists.
pub fn info(pid: i32) -> Option<ProcInfo> {
	sys::info(pid)
}

/// The current instant in [`ProcInfo::start`] units: every process that
/// exists has `start <= now()`, and one started after the call has
/// `start >= ` the returned value (a "since" mark for containment checks).
///
/// Linux: `CLOCK_BOOTTIME` floored to clock ticks with integer math, the
/// same floor the kernel applies to `/proc/<pid>/stat` field 22 (parsing
/// `/proc/uptime` as a float can be a tick off). macOS: µs since the epoch,
/// like `pbi_start_tvsec`/`usec` (a wall clock: a step back in time breaks
/// the second guarantee).
pub fn now() -> io::Result<u64> {
	sys::now()
}

/// Processes whose session is `sid`, excluding the caller.
pub fn session_members(sid: i32) -> io::Result<Vec<ProcInfo>> {
	members(|p| p.sid == sid)
}

/// Processes whose process group is `pgid`, excluding the caller.
pub fn group_members(pgid: i32) -> io::Result<Vec<ProcInfo>> {
	members(|p| p.pgid == pgid)
}

fn members(pred: impl Fn(&ProcInfo) -> bool) -> io::Result<Vec<ProcInfo>> {
	let me = std::process::id() as i32;
	let mut all = list()?;
	all.retain(|p| p.pid != me && pred(p));
	Ok(all)
}

/// Signal every member of session `sid` (identity-pinned, zombies skipped);
/// returns the members signalled.
pub fn kill_session(sid: i32, sig: Signal) -> io::Result<Vec<ProcInfo>> {
	signal_all(session_members(sid)?, sig)
}

/// Signal every member of process group `pgid` (identity-pinned, zombies
/// skipped); returns the members signalled.
pub fn kill_group(pgid: i32, sig: Signal) -> io::Result<Vec<ProcInfo>> {
	signal_all(group_members(pgid)?, sig)
}

fn signal_all(mut procs: Vec<ProcInfo>, sig: Signal) -> io::Result<Vec<ProcInfo>> {
	procs.retain(|p| p.state != ProcState::Zombie);
	let mut sent = Vec::with_capacity(procs.len());
	for p in procs {
		if signal_pinned(&p, sig)? {
			sent.push(p);
		}
	}
	Ok(sent)
}

/// Send `sig` to `p` if the pid still names the process that was scanned.
/// `Ok(false)` when it has exited or the pid now names another process.
pub fn signal_pinned(p: &ProcInfo, sig: Signal) -> io::Result<bool> {
	sys::signal_pinned(p, i32::from(sig.number(Platform::current())))
}

/// Split a Linux `/proc/<pid>/stat` line into `(comm, fields after comm)`.
/// The command name may itself contain spaces and parentheses, so it ends at
/// the *last* `)`.
#[cfg_attr(
	not(target_os = "linux"),
	allow(dead_code, reason = "Linux-only outside tests; the parser is tested everywhere")
)]
fn split_stat(line: &[u8]) -> Option<(&[u8], impl Iterator<Item = &[u8]>)> {
	let open = line.iter().position(|&b| b == b'(')?;
	let close = line.iter().rposition(|&b| b == b')')?;
	let comm = line.get(open + 1..close)?;
	let rest = line.get(close + 1..)?;
	Some((
		comm,
		rest
			.split(u8::is_ascii_whitespace)
			.filter(|f| !f.is_empty()),
	))
}

/// Parse a Linux `/proc/<pid>/stat` line.
#[cfg_attr(
	not(target_os = "linux"),
	allow(dead_code, reason = "Linux-only outside tests; the parser is tested everywhere")
)]
fn parse_stat(pid: i32, line: &[u8]) -> Option<ProcInfo> {
	fn num<T: std::str::FromStr>(f: &[u8]) -> Option<T> {
		std::str::from_utf8(f).ok()?.parse().ok()
	}
	let (comm, fields) = split_stat(line)?;
	let fields: Vec<&[u8]> = fields.take(20).collect();
	let state = match fields.first()?.first()? {
		b'R' => ProcState::Running,
		b'S' | b'D' => ProcState::Sleeping,
		b'T' | b't' => ProcState::Stopped,
		b'Z' => ProcState::Zombie,
		_ => ProcState::Other,
	};
	Some(ProcInfo {
		pid,
		ppid: num(fields.get(1)?)?,
		pgid: num(fields.get(2)?)?,
		sid: num(fields.get(3)?)?,
		state,
		name: BString::from(comm),
		start: num(fields.get(19)?)?,
	})
}

#[cfg(target_os = "linux")]
mod sys {
	use std::{
		fs, io,
		os::fd::{AsRawFd, FromRawFd, OwnedFd},
	};

	use super::{ProcInfo, parse_stat};

	pub fn list() -> io::Result<Vec<ProcInfo>> {
		let mut out = Vec::new();
		for entry in fs::read_dir("/proc")? {
			let Ok(entry) = entry else { continue };
			let Some(pid) = entry
				.file_name()
				.to_str()
				.and_then(|n| n.parse::<i32>().ok())
			else {
				continue;
			};
			// The process may exit between readdir and the read.
			if let Some(p) = info(pid) {
				out.push(p);
			}
		}
		Ok(out)
	}

	pub fn info(pid: i32) -> Option<ProcInfo> {
		let line = fs::read(format!("/proc/{pid}/stat")).ok()?;
		parse_stat(pid, &line)
	}

	pub fn now() -> io::Result<u64> {
		// SAFETY: plain call without pointer arguments.
		let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
		let hz = u128::try_from(hz).map_err(|_| io::Error::last_os_error())?;
		let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
		// SAFETY: `ts` is writable for the call.
		if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &raw mut ts) } != 0 {
			return Err(io::Error::last_os_error());
		}
		let ns = ts.tv_sec as u128 * 1_000_000_000 + ts.tv_nsec as u128;
		Ok((ns * hz / 1_000_000_000) as u64)
	}

	fn pidfd_open(pid: i32) -> io::Result<OwnedFd> {
		// SAFETY: pidfd_open takes scalar arguments and returns a new fd.
		let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
		if fd < 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: a successful pidfd_open returned a descriptor we now own.
		Ok(unsafe { OwnedFd::from_raw_fd(fd as i32) })
	}

	pub fn signal_pinned(p: &ProcInfo, sig: i32) -> io::Result<bool> {
		let pidfd = match pidfd_open(p.pid) {
			Ok(fd) => Some(fd),
			Err(e) if e.raw_os_error() == Some(libc::ESRCH) => return Ok(false),
			// Kernels before 5.3: fall back to a start-time recheck.
			Err(e) if e.raw_os_error() == Some(libc::ENOSYS) => None,
			Err(e) => return Err(e),
		};
		// With the pidfd open the pid cannot be reused for another process
		// while we check that it still names the scanned one.
		if info(p.pid).is_none_or(|now| now.start != p.start) {
			return Ok(false);
		}
		let rc = match &pidfd {
			// SAFETY: the pidfd is open for the call; a null siginfo makes the
			// kernel fill in what kill(2) would.
			Some(fd) => unsafe {
				libc::syscall(
					libc::SYS_pidfd_send_signal,
					fd.as_raw_fd(),
					sig,
					std::ptr::null::<libc::siginfo_t>(),
					0,
				) as i32
			},
			// SAFETY: plain syscall without pointer arguments.
			None => unsafe { libc::kill(p.pid, sig) },
		};
		if rc == 0 {
			return Ok(true);
		}
		let e = io::Error::last_os_error();
		if e.raw_os_error() == Some(libc::ESRCH) {
			Ok(false)
		} else {
			Err(e)
		}
	}
}

#[cfg(target_os = "macos")]
mod sys {
	use std::{ffi::CStr, io, mem, ptr};

	use bstr::BString;

	use super::{ProcInfo, ProcState};

	pub fn list() -> io::Result<Vec<ProcInfo>> {
		// SAFETY: a null buffer with size 0 is libproc's sizing query.
		let reported = unsafe { libc::proc_listallpids(ptr::null_mut(), 0) };
		if reported <= 0 {
			return Err(io::Error::last_os_error());
		}
		// Leave room for processes started since the sizing query.
		let capacity = (reported as usize).saturating_mul(2).max(1024);
		let mut pids = vec![0i32; capacity];
		let bytes = i32::try_from(capacity * mem::size_of::<i32>())
			.map_err(|e| io::Error::new(io::ErrorKind::OutOfMemory, e))?;
		// SAFETY: `pids` is writable for `bytes` bytes; libproc writes at most
		// that and returns the number of pids.
		let n = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
		if n < 0 {
			return Err(io::Error::last_os_error());
		}
		pids.truncate((n as usize).min(capacity));
		Ok(pids
			.into_iter()
			.filter(|&pid| pid > 0)
			.filter_map(info)
			.collect())
	}

	fn bsdinfo(pid: i32) -> Option<libc::proc_bsdinfo> {
		// SAFETY: proc_bsdinfo is plain C integers and arrays, valid zeroed.
		let mut bi: libc::proc_bsdinfo = unsafe { mem::zeroed() };
		let size = mem::size_of::<libc::proc_bsdinfo>() as i32;
		// SAFETY: `bi` is writable for `size` bytes; arg 1 includes zombies.
		let got =
			unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 1, (&raw mut bi).cast(), size) };
		(got >= size).then_some(bi)
	}

	fn c_name(raw: &[libc::c_char]) -> &[u8] {
		// SAFETY: `c_char` and `u8` have the same size and alignment.
		let bytes: &[u8] = unsafe { std::slice::from_raw_parts(raw.as_ptr().cast(), raw.len()) };
		CStr::from_bytes_until_nul(bytes).map_or(bytes, CStr::to_bytes)
	}

	pub fn info(pid: i32) -> Option<ProcInfo> {
		let bi = bsdinfo(pid)?;
		// SAFETY: plain syscall without pointer arguments.
		let sid = unsafe { libc::getsid(pid) };
		let name = c_name(&bi.pbi_name);
		let name = if name.is_empty() {
			c_name(&bi.pbi_comm)
		} else {
			name
		};
		let state = match bi.pbi_status {
			2 => ProcState::Running,  // SRUN
			3 => ProcState::Sleeping, // SSLEEP
			4 => ProcState::Stopped,  // SSTOP
			5 => ProcState::Zombie,   // SZOMB
			_ => ProcState::Other,
		};
		Some(ProcInfo {
			pid,
			ppid: bi.pbi_ppid as i32,
			pgid: bi.pbi_pgid as i32,
			sid,
			state,
			name: BString::from(name),
			start: bi
				.pbi_start_tvsec
				.saturating_mul(1_000_000)
				.saturating_add(bi.pbi_start_tvusec),
		})
	}

	pub fn now() -> io::Result<u64> {
		let since = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map_err(io::Error::other)?;
		Ok(since.as_micros() as u64)
	}

	pub fn signal_pinned(p: &ProcInfo, sig: i32) -> io::Result<bool> {
		if info(p.pid).is_none_or(|now| now.start != p.start) {
			return Ok(false);
		}
		// SAFETY: plain syscall without pointer arguments.
		if unsafe { libc::kill(p.pid, sig) } == 0 {
			return Ok(true);
		}
		let e = io::Error::last_os_error();
		if e.raw_os_error() == Some(libc::ESRCH) {
			Ok(false)
		} else {
			Err(e)
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn stat_lines_with_hostile_command_names_parse() {
		let line = b"4242 (a) b (c) R 1 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 987654 0 0\n";
		let p = parse_stat(4242, line).unwrap();
		assert_eq!(p.name, "a) b (c");
		assert_eq!((p.ppid, p.pgid, p.sid), (1, 4242, 4242));
		assert_eq!(p.state, ProcState::Running);
		assert_eq!(p.start, 987654);
		assert!(parse_stat(1, b"1 (init) Z 0").is_none(), "truncated line");
	}

	#[test]
	fn the_scan_sees_this_process_and_its_session() {
		let me = std::process::id() as i32;
		let p = info(me).expect("own process");
		// SAFETY: plain syscalls without pointer arguments.
		let (pgid, sid) = unsafe { (libc::getpgid(0), libc::getsid(0)) };
		assert_eq!((p.pgid, p.sid), (pgid, sid));
		assert!(list().unwrap().iter().any(|q| q.pid == me));
		assert!(
			!session_members(sid).unwrap().iter().any(|q| q.pid == me),
			"members exclude the caller"
		);
	}

	#[test]
	fn now_brackets_process_start_times() {
		let me = info(std::process::id() as i32).unwrap();
		let since = now().unwrap();
		assert!(me.start <= since, "an existing process started before now()");
		// Linux start times have clock-tick (10 ms) resolution.
		std::thread::sleep(std::time::Duration::from_millis(30));
		let mut child = std::process::Command::new("/bin/sleep")
			.arg("5")
			.spawn()
			.unwrap();
		let start = info(child.id() as i32).unwrap().start;
		child.kill().unwrap();
		child.wait().unwrap();
		assert!(start >= since, "a later child started at or after the mark: {start} < {since}");
		assert!(start <= now().unwrap());
	}

	#[test]
	fn pinned_signal_skips_a_process_whose_start_time_changed() {
		let mut child = std::process::Command::new("/bin/sleep")
			.arg("5")
			.spawn()
			.unwrap();
		let pid = child.id() as i32;
		let mut p = info(pid).unwrap();
		p.start = p.start.wrapping_add(1);
		assert!(!signal_pinned(&p, Signal::Kill).unwrap(), "impostor identity is not signalled");
		assert!(child.try_wait().unwrap().is_none());
		p.start = p.start.wrapping_sub(1);
		assert!(signal_pinned(&p, Signal::Kill).unwrap());
		let status = child.wait().unwrap();
		assert!(!status.success());
	}
}
