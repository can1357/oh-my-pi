//! Liveness checks for the integration tests. A process counts as dead only
//! when that is proven: `kill(pid, 0)` fails with ESRCH or, on Linux, /proc
//! shows the process and each of its threads dead (state Z, X or x), or its
//! entry gone. An entry that cannot be read proves nothing, so it counts as
//! alive.
#![cfg(unix)]
#![allow(dead_code)] // each test crate uses part of this module

/// Whether `pid` may still be alive.
pub fn process_alive(pid: libc::pid_t) -> bool {
	if probe_finds_none(pid) {
		return false;
	}
	#[cfg(target_os = "linux")]
	return !linux::process_dead(&pid.to_string());
	#[cfg(not(target_os = "linux"))]
	true
}

/// Whether some member of process group `pgid` may still be alive.
pub fn group_alive(pgid: libc::pid_t) -> bool {
	if probe_finds_none(-pgid) {
		return false;
	}
	#[cfg(target_os = "linux")]
	return !linux::group_dead(pgid);
	#[cfg(not(target_os = "linux"))]
	true
}

/// `kill(target, 0)` fails with ESRCH: no such process (or group member),
/// live or dead.
fn probe_finds_none(target: libc::pid_t) -> bool {
	// SAFETY: `kill` has no memory-safety preconditions; signal 0 only probes.
	let failed = unsafe { libc::kill(target, 0) } == -1;
	failed && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(target_os = "linux")]
mod linux {
	use std::io;

	/// State and process group of `/proc/<name>`: `Ok(None)` when it is gone,
	/// `Err` when it cannot be read or parsed.
	fn stat(name: &str) -> Result<Option<(u8, libc::pid_t)>, ()> {
		let stat = match std::fs::read(format!("/proc/{name}/stat")) {
			Ok(stat) => stat,
			Err(error) if vanished(&error) => return Ok(None),
			Err(_) => return Err(()),
		};
		let rparen = stat.iter().rposition(|&byte| byte == b')').ok_or(())?;
		let mut fields = stat[rparen + 1..]
			.split(u8::is_ascii_whitespace)
			.filter(|field| !field.is_empty());
		let &[state] = fields.next().ok_or(())? else {
			return Err(());
		};
		let _ppid = fields.next();
		let pgrp = fields
			.next()
			.and_then(|field| std::str::from_utf8(field).ok())
			.and_then(|field| field.parse().ok())
			.ok_or(())?;
		Ok(Some((state, pgrp)))
	}

	fn vanished(error: &io::Error) -> bool {
		error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(libc::ESRCH)
	}

	fn dead(state: u8) -> bool {
		matches!(state, b'Z' | b'X' | b'x')
	}

	/// Whether /proc proves process `pid` dead.
	pub fn process_dead(pid: &str) -> bool {
		match stat(pid) {
			Ok(None) => true,
			Ok(Some((state, _))) => dead(state) && threads_dead(pid),
			Err(()) => false,
		}
	}

	/// Whether /proc proves every thread of `pid` dead or gone.
	fn threads_dead(pid: &str) -> bool {
		let entries = match std::fs::read_dir(format!("/proc/{pid}/task")) {
			Ok(entries) => entries,
			Err(error) => return vanished(&error),
		};
		entries.into_iter().all(|entry| {
			let Ok(entry) = entry else { return false };
			let Some(tid) = entry.file_name().to_str().map(str::to_owned) else {
				return false;
			};
			match stat(&format!("{pid}/task/{tid}")) {
				Ok(None) => true,
				Ok(Some((state, _))) => dead(state),
				Err(()) => false,
			}
		})
	}

	/// Whether /proc proves every member of group `pgid` dead.
	pub fn group_dead(pgid: libc::pid_t) -> bool {
		let Ok(entries) = std::fs::read_dir("/proc") else {
			return false;
		};
		for entry in entries {
			let Ok(entry) = entry else { return false };
			let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
				continue;
			};
			if name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_digit()) {
				continue;
			}
			match stat(&name) {
				Ok(None) => {},
				Ok(Some((_, member_pgid))) if member_pgid != pgid => {},
				Ok(Some(_)) if process_dead(&name) => {},
				_ => return false,
			}
		}
		true
	}
}
