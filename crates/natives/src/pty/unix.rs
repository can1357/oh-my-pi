//! Starting a program on a pseudoterminal's slave (Unix): the child leads a
//! session of its own with the pseudoterminal as its controlling terminal
//! and standard streams, with the default signal dispositions and nothing
//! blocked; no other descriptor of this process survives its `exec`.

use std::{
	io,
	os::{fd::OwnedFd, unix::process::CommandExt as _},
	path::Path,
	process::{Child, Command},
};

use super::{Spawn, env::Env};

/// Starts `spawn`'s program on the pseudoterminal whose slave is `slave`.
/// The program is found on its own environment's `PATH`.
///
/// # Errors
/// When the program cannot start (one not found included) or the child
/// cannot take the pseudoterminal as its controlling terminal.
pub(super) fn spawn(slave: OwnedFd, spawn: &Spawn<'_>) -> io::Result<Child> {
	let mut command = Command::new(spawn.program);
	command
		.args(spawn.args)
		.env_clear()
		.envs(
			spawn
				.env
				.entries()
				.iter()
				.map(|(name, value)| (name, value)),
		)
		.stdin(slave.try_clone()?)
		.stdout(slave.try_clone()?)
		.stderr(slave);
	if let Some(dir) = directory(spawn.cwd, spawn.env) {
		command.current_dir(dir);
	}
	let mut seal = Seal::new();
	// SAFETY: the hook runs in the forked child after std attached the slave
	// as fds 0-2, and makes only async-signal-safe system calls on memory
	// reserved before the fork.
	unsafe {
		command.pre_exec(move || {
			for signal in 1..SIGNALS {
				libc::signal(signal, libc::SIG_DFL);
			}
			let mut none = std::mem::zeroed::<libc::sigset_t>();
			libc::sigemptyset(&raw mut none);
			libc::sigprocmask(libc::SIG_SETMASK, &raw const none, std::ptr::null_mut());
			if libc::setsid() == -1 {
				return Err(io::Error::last_os_error());
			}
			#[cfg(target_os = "linux")]
			let controlling = libc::ioctl(0, libc::TIOCSCTTY, 0);
			#[cfg(not(target_os = "linux"))]
			let controlling = libc::ioctl(0, libc::c_ulong::from(libc::TIOCSCTTY), 0);
			if controlling == -1 {
				return Err(io::Error::last_os_error());
			}
			seal.apply();
			Ok(())
		});
	}
	// `command` drops this process's copies of the slave on return.
	command.spawn()
}

/// `cwd` when it is a directory, else `env`'s `HOME`; `None` keeps this
/// process's.
fn directory<'a>(cwd: Option<&'a Path>, env: &'a Env) -> Option<&'a Path> {
	cwd.filter(|dir| dir.is_dir())
		.or_else(|| env.get("HOME").map(Path::new))
}

/// Signals there are (numbered from 1).
#[cfg(target_os = "linux")]
const SIGNALS: libc::c_int = 65;
/// Signals there are (numbered from 1).
#[cfg(not(target_os = "linux"))]
const SIGNALS: libc::c_int = 32;

/// Marks every descriptor above the standard three close-on-exec in the
/// forked child, so `exec` leaves the program none of this process's
/// (closing them instead would also close the pipe std reports a failed
/// `exec` on). Everything it needs is reserved before the fork.
struct Seal {
	/// Room for the child's list of its descriptors.
	#[cfg(target_os = "macos")]
	listed:  Vec<libc::proc_fdinfo>,
	/// Past the highest descriptor the child may hold, for marking them one
	/// by one when it cannot list them.
	#[cfg(not(target_os = "linux"))]
	ceiling: libc::c_int,
}

impl Seal {
	#[cfg_attr(
		target_os = "linux",
		allow(clippy::missing_const_for_fn, reason = "Linux reserves nothing")
	)]
	fn new() -> Self {
		#[cfg(target_os = "macos")]
		let listed = {
			// SAFETY: with no buffer, `proc_pidinfo` returns the size the list
			// of this process's descriptors needs.
			let needed = unsafe {
				libc::proc_pidinfo(libc::getpid(), libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0)
			};
			let entries = usize::try_from(needed).unwrap_or(0) / size_of::<libc::proc_fdinfo>();
			// Room for twice as many as are open now.
			Vec::with_capacity(entries * 2 + 64)
		};
		#[cfg(not(target_os = "linux"))]
		let ceiling = {
			let mut current = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
			// SAFETY: getrlimit fills the struct the pointer names.
			if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut current) } == 0 {
				libc::c_int::try_from(current.rlim_cur.min(1 << 20)).unwrap_or(1 << 20)
			} else {
				1 << 16
			}
		};
		Self {
			#[cfg(target_os = "macos")]
			listed,
			#[cfg(not(target_os = "linux"))]
			ceiling,
		}
	}

	/// Marks the descriptors.
	///
	/// # Safety
	/// Only in the forked child before `exec`.
	#[cfg(target_os = "linux")]
	#[allow(clippy::unused_self, reason = "Linux lists the descriptors itself; nothing is reserved")]
	unsafe fn apply(&mut self) {
		let first: libc::c_uint = 3;
		// SAFETY: system calls on the child's own descriptors.
		unsafe {
			// Linux 5.11.
			if libc::syscall(
				libc::SYS_close_range,
				first,
				libc::c_uint::MAX,
				libc::CLOSE_RANGE_CLOEXEC,
			) == 0
			{
				return;
			}
			mark_listed();
		}
	}

	/// Marks the descriptors.
	///
	/// # Safety
	/// Only in the forked child before `exec`.
	#[cfg(not(target_os = "linux"))]
	unsafe fn apply(&mut self) {
		// SAFETY: `proc_pidinfo` fills the room `new` reserved at most to its
		// size; `fcntl` on descriptor numbers (a closed one fails harmlessly).
		unsafe {
			#[cfg(target_os = "macos")]
			{
				let entry = size_of::<libc::proc_fdinfo>();
				let room = self.listed.capacity() * entry;
				if let Ok(size) = libc::c_int::try_from(room) {
					let filled = libc::proc_pidinfo(
						libc::getpid(),
						libc::PROC_PIDLISTFDS,
						0,
						self.listed.as_mut_ptr().cast(),
						size,
					);
					// A full buffer may have left some out.
					if let Ok(filled) = usize::try_from(filled)
						&& filled > 0
						&& filled < room
					{
						let listed = std::slice::from_raw_parts(self.listed.as_ptr(), filled / entry);
						for info in listed {
							if info.proc_fd > 2 {
								libc::fcntl(info.proc_fd, libc::F_SETFD, libc::FD_CLOEXEC);
							}
						}
						return;
					}
				}
			}
			for fd in 3..self.ceiling {
				libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
			}
		}
	}
}

/// Marks every descriptor above the standard three that `/proc/self/fd`
/// lists; nothing when it cannot be read.
///
/// # Safety
/// Only in the forked child before `exec`.
#[cfg(target_os = "linux")]
unsafe fn mark_listed() {
	// SAFETY: `open`, `getdents64` into a local buffer it fills at most to
	// its length, `fcntl` and `close`.
	unsafe {
		let dir = libc::open(c"/proc/self/fd".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY);
		if dir == -1 {
			return;
		}
		// 8-byte aligned, as `linux_dirent64` records are.
		let mut buf = [0u64; 512];
		loop {
			let read = libc::syscall(
				libc::SYS_getdents64,
				dir,
				buf.as_mut_ptr().cast::<std::ffi::c_void>(),
				size_of_val(&buf),
			);
			let Ok(read) = usize::try_from(read) else {
				if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
					continue;
				}
				break;
			};
			if read == 0 {
				break;
			}
			let bytes = std::slice::from_raw_parts(buf.as_ptr().cast::<u8>(), read);
			let mut at = 0;
			// A record: inode (8), offset (8), length (2), type (1), name.
			while at + 19 < read {
				let length = usize::from(u16::from_ne_bytes([bytes[at + 16], bytes[at + 17]]));
				if length == 0 {
					break;
				}
				let mut fd: libc::c_int = 0;
				let mut digits = 0;
				for &byte in &bytes[at + 19..(at + length).min(read)] {
					if !byte.is_ascii_digit() {
						break;
					}
					fd = fd
						.saturating_mul(10)
						.saturating_add(libc::c_int::from(byte - b'0'));
					digits += 1;
				}
				if digits > 0 && fd > 2 && fd != dir {
					libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
				}
				at += length;
			}
		}
		libc::close(dir);
	}
}
