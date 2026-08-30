//! Stable operating-system process identities for detached-process re-adoption.

use std::{io, mem, path::PathBuf, process, time::SystemTime};

use omp_proto::env::v1;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// PID plus an operating-system start generation, preventing PID-reuse
/// adoption.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProcessIdentity {
	/// Operating-system process identifier.
	pub pid:              u32,
	/// Informational wall-clock process start time in Unix milliseconds.
	pub started_at_ms:    u64,
	/// Platform start generation (microseconds, clock ticks, or FILETIME ticks).
	pub start_generation: u64,
	/// Executable path observed from the operating system.
	pub executable:       PathBuf,
}

impl ProcessIdentity {
	/// Captures a verifiable identity for `pid` from the operating system.
	pub fn capture(pid: u32) -> Result<Self, IdentityError> {
		platform::capture(pid)
	}

	/// Captures the current daemon identity.
	pub fn current() -> Result<Self, IdentityError> {
		Self::capture(process::id())
	}

	/// Re-reads the PID and verifies its start generation and executable.
	pub fn verify(&self) -> Result<bool, IdentityError> {
		match Self::capture(self.pid) {
			Ok(current) => Ok(current.start_generation == self.start_generation
				&& current.executable == self.executable),
			Err(IdentityError::NotFound { .. }) => Ok(false),
			Err(error) => Err(error),
		}
	}

	/// Projects this verified identity into the additive env v1 supervision
	/// schema.
	pub fn to_wire(&self) -> v1::ProcessIdentity {
		v1::ProcessIdentity {
			pid:              u64::from(self.pid),
			started_at_ms:    self.started_at_ms,
			start_generation: self.start_generation.to_le_bytes().to_vec().into(),
			executable:       self.executable.to_string_lossy().into_owned(),
		}
	}

	/// Verifies a wire identity against the currently running operating-system
	/// process.
	pub fn verify_wire(wire: &v1::ProcessIdentity) -> bool {
		let Ok(pid) = u32::try_from(wire.pid) else {
			return false;
		};
		let Ok(generation) = <[u8; 8]>::try_from(wire.start_generation.as_ref()) else {
			return false;
		};
		let Ok(current) = Self::capture(pid) else {
			return false;
		};
		current.start_generation == u64::from_le_bytes(generation)
			&& current.executable.to_string_lossy() == wire.executable
	}
}

/// Process identity inspection failure.
#[derive(Debug, Error)]
pub enum IdentityError {
	/// PID was invalid or no longer exists.
	#[error("process {pid} does not exist")]
	NotFound {
		/// Missing PID.
		pid: u32,
	},
	/// Operating-system identity query failed.
	#[error("failed to inspect process {pid}")]
	Inspect {
		/// Queried PID.
		pid:    u32,
		/// Platform I/O failure.
		#[source]
		source: io::Error,
	},
	/// The operating system returned an incomplete identity record.
	#[error("process {pid} returned incomplete identity metadata")]
	Incomplete {
		/// Queried PID.
		pid: u32,
	},
}

fn unix_millis(time: SystemTime) -> u64 {
	time
		.duration_since(SystemTime::UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX)
}

#[cfg(target_os = "macos")]
mod platform {
	use std::{ffi::OsString, mem::size_of, os::unix::ffi::OsStringExt as _, time::Duration};

	use super::*;

	pub fn capture(pid: u32) -> Result<ProcessIdentity, IdentityError> {
		let pid_i32 = i32::try_from(pid).map_err(|_| IdentityError::NotFound { pid })?;
		// SAFETY: proc_bsdinfo is an integer C record valid when zeroed.
		let mut info = unsafe { mem::zeroed::<libc::proc_bsdinfo>() };
		// SAFETY: `info` is writable for the exact size supplied.
		let actual = unsafe {
			libc::proc_pidinfo(
				pid_i32,
				libc::PROC_PIDTBSDINFO,
				0,
				(&raw mut info).cast(),
				size_of::<libc::proc_bsdinfo>() as i32,
			)
		};
		if actual == 0 {
			let source = io::Error::last_os_error();
			return if source.raw_os_error() == Some(libc::ESRCH) {
				Err(IdentityError::NotFound { pid })
			} else {
				Err(IdentityError::Inspect { pid, source })
			};
		}
		if actual < size_of::<libc::proc_bsdinfo>() as i32 {
			return Err(IdentityError::Incomplete { pid });
		}

		let mut path = [0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
		// SAFETY: `path` is writable for its supplied capacity.
		let path_len = unsafe {
			libc::proc_pidpath(pid_i32, path.as_mut_ptr().cast(), u32::try_from(path.len()).unwrap())
		};
		if path_len <= 0 {
			return Err(IdentityError::Inspect { pid, source: io::Error::last_os_error() });
		}
		let start_generation = info
			.pbi_start_tvsec
			.saturating_mul(1_000_000)
			.saturating_add(info.pbi_start_tvusec);
		let started = SystemTime::UNIX_EPOCH
			+ Duration::from_secs(info.pbi_start_tvsec)
			+ Duration::from_micros(info.pbi_start_tvusec);
		Ok(ProcessIdentity {
			pid,
			started_at_ms: unix_millis(started),
			start_generation,
			executable: PathBuf::from(OsString::from_vec(path[..path_len as usize].to_vec())),
		})
	}
}

#[cfg(target_os = "linux")]
mod platform {
	use std::{fs, os::unix::fs::MetadataExt as _, time::Duration};

	use super::*;

	pub fn capture(pid: u32) -> Result<ProcessIdentity, IdentityError> {
		let proc = PathBuf::from(format!("/proc/{pid}"));
		let stat = fs::read_to_string(proc.join("stat")).map_err(|source| map_io(pid, source))?;
		let (_, fields) = stat
			.rsplit_once(") ")
			.ok_or(IdentityError::Incomplete { pid })?;
		let start_generation = fields
			.split_ascii_whitespace()
			.nth(19)
			.ok_or(IdentityError::Incomplete { pid })?
			.parse::<u64>()
			.map_err(|_| IdentityError::Incomplete { pid })?;
		let executable = fs::read_link(proc.join("exe")).map_err(|source| map_io(pid, source))?;
		let boot_seconds = boot_seconds().ok_or(IdentityError::Incomplete { pid })?;
		// SAFETY: `_SC_CLK_TCK` is a read-only process configuration query.
		let ticks_per_second = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
		let ticks_per_second =
			u64::try_from(ticks_per_second).map_err(|_| IdentityError::Incomplete { pid })?;
		if ticks_per_second == 0 {
			return Err(IdentityError::Incomplete { pid });
		}
		let started = SystemTime::UNIX_EPOCH
			+ Duration::from_secs(boot_seconds.saturating_add(start_generation / ticks_per_second))
			+ Duration::from_nanos(
				start_generation % ticks_per_second * 1_000_000_000 / ticks_per_second,
			);
		Ok(ProcessIdentity { pid, started_at_ms: unix_millis(started), start_generation, executable })
	}

	/// Reads the kernel boot epoch used to turn `/proc/<pid>/stat` jiffies into
	/// the informational wall-clock start time.
	///
	/// `btime` is the procfs-native source. Uptime and `/proc/1` metadata are
	/// fallbacks for kernels that omit it.
	fn boot_seconds() -> Option<u64> {
		if let Ok(stat) = fs::read_to_string("/proc/stat")
			&& let Some(seconds) = parse_boot_seconds(&stat)
		{
			return Some(seconds);
		}
		if let Ok(uptime) = fs::read_to_string("/proc/uptime")
			&& let Some(uptime) = uptime
				.split_ascii_whitespace()
				.next()
				.and_then(|value| value.parse::<f64>().ok())
			&& let Ok(now) = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)
		{
			return Some(now.as_secs().saturating_sub(uptime as u64));
		}
		fs::metadata("/proc/1")
			.ok()
			.map(|metadata| metadata.ctime().max(0) as u64)
	}

	fn parse_boot_seconds(stat: &str) -> Option<u64> {
		stat
			.lines()
			.find_map(|line| line.strip_prefix("btime "))
			.and_then(|value| value.trim().parse().ok())
	}

	fn map_io(pid: u32, source: io::Error) -> IdentityError {
		if source.kind() == io::ErrorKind::NotFound {
			IdentityError::NotFound { pid }
		} else {
			IdentityError::Inspect { pid, source }
		}
	}
}

#[cfg(windows)]
mod platform {
	use std::{ffi::OsString, os::windows::ffi::OsStringExt as _, ptr};

	use windows_sys::Win32::{
		Foundation::{CloseHandle, FILETIME, HANDLE},
		System::Threading::{
			GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
			QueryFullProcessImageNameW,
		},
	};

	use super::*;

	pub fn capture(pid: u32) -> Result<ProcessIdentity, IdentityError> {
		// SAFETY: opens a query-only handle for the supplied numeric PID.
		let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
		if handle.is_null() {
			let source = io::Error::last_os_error();
			return if source.kind() == io::ErrorKind::NotFound {
				Err(IdentityError::NotFound { pid })
			} else {
				Err(IdentityError::Inspect { pid, source })
			};
		}
		let result = capture_handle(pid, handle);
		// SAFETY: `handle` was returned by OpenProcess and is closed exactly once.
		unsafe { CloseHandle(handle) };
		result
	}

	fn capture_handle(pid: u32, handle: HANDLE) -> Result<ProcessIdentity, IdentityError> {
		let mut creation = FILETIME::default();
		let mut exit = FILETIME::default();
		let mut kernel = FILETIME::default();
		let mut user = FILETIME::default();
		// SAFETY: all output pointers are valid writable FILETIME records.
		if unsafe {
			GetProcessTimes(handle, &raw mut creation, &raw mut exit, &raw mut kernel, &raw mut user)
		} == 0
		{
			return Err(IdentityError::Inspect { pid, source: io::Error::last_os_error() });
		}
		let start_generation =
			u64::from(creation.dwLowDateTime) | (u64::from(creation.dwHighDateTime) << 32);
		let mut path = vec![0_u16; 32_768];
		let mut length = path.len() as u32;
		// SAFETY: buffer and in/out length describe the allocated UTF-16 storage.
		if unsafe { QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &raw mut length) } == 0 {
			return Err(IdentityError::Inspect { pid, source: io::Error::last_os_error() });
		}
		path.truncate(length as usize);
		const WINDOWS_TO_UNIX_100NS: u64 = 116_444_736_000_000_000;
		let started_at_ms = start_generation.saturating_sub(WINDOWS_TO_UNIX_100NS) / 10_000;
		Ok(ProcessIdentity {
			pid,
			started_at_ms,
			start_generation,
			executable: PathBuf::from(OsString::from_wide(&path)),
		})
	}
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
compile_error!("durable process identity is not implemented for this target");

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn current_identity_round_trips_to_os() {
		let identity = ProcessIdentity::current().unwrap();
		assert_eq!(identity.pid, std::process::id());
		assert!(identity.start_generation > 0);
		assert!(!identity.executable.as_os_str().is_empty());
		assert!(identity.verify().unwrap());
		let wire = identity.to_wire();
		assert_eq!(wire.pid, u64::from(std::process::id()));
		assert_eq!(wire.start_generation.as_ref(), identity.start_generation.to_le_bytes());

		let mut stale = identity;
		stale.start_generation ^= 1;
		assert!(!stale.verify().unwrap());
	}
}
