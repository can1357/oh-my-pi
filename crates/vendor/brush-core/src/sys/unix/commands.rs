//! Command execution utilities.

pub use std::os::unix::process::{CommandExt, ExitStatusExt};

use command_fds::{CommandFdExt, FdMapping};

use crate::{ShellFd, error, openfiles};

/// Extension trait for injecting file descriptors into commands.
pub trait CommandFdInjectionExt {
	/// Injects the given open files as file descriptors into the command.
	///
	/// # Arguments
	///
	/// * `open_files` - A mapping of child file descriptors to open files.
	fn inject_fds(
		&mut self,
		open_files: impl Iterator<Item = (ShellFd, openfiles::OpenFile)>,
	) -> Result<(), error::Error>;
}

impl CommandFdInjectionExt for std::process::Command {
	fn inject_fds(
		&mut self,
		open_files: impl Iterator<Item = (ShellFd, openfiles::OpenFile)>,
	) -> Result<(), error::Error> {
		use std::os::fd::AsRawFd as _;

		// Each file is held here, not duplicated, until the command is dropped:
		// a duplicate per descriptor doubled what this process holds while it
		// starts a child, so a command that this process gives hundreds of
		// descriptors to reached the open-file limit the command itself is
		// given. The child takes each at its number by `dup2` alone.
		let mut held = Vec::new();
		let mut mappings = Vec::new();
		for (child_fd, open_file) in open_files {
			let parent_fd = open_file.try_borrow_as_fd()?.as_raw_fd();
			if mappings.iter().any(|&(_, child)| child == child_fd) {
				return Err(error::ErrorKind::ChildCreationFailure.into());
			}
			mappings.push((parent_fd, child_fd));
			held.push(open_file);
		}

		// `pre_exec` forces std onto its fork+exec path instead of
		// `posix_spawn`, so none is registered for an empty list.
		if mappings.is_empty() {
			return Ok(());
		}

		let mut done = vec![false; mappings.len()];
		// SAFETY: the closure only makes system calls on the descriptors it
		// was given and on numbers they name, and allocates nothing.
		unsafe {
			self.pre_exec(move || {
				let _ = &held;
				place_fds(&mut mappings, &mut done)
			});
		}

		Ok(())
	}
}

/// Puts each `(parent, child)` descriptor at its child number, in the child
/// before it executes, with no descriptor beyond the ones it is given except
/// one at a time where the numbers form a ring. A mapping is made once no
/// other mapping still to be made reads the number it writes; when every one
/// left does, one source is moved to the lowest free number, which no
/// mapping writes (every number one writes is open as a source), and the
/// ring opens.
fn place_fds(mappings: &mut [(i32, ShellFd)], done: &mut [bool]) -> std::io::Result<()> {
	let mut left = mappings.len();
	for index in 0..mappings.len() {
		let (parent, child) = mappings[index];
		if parent == child {
			// SAFETY: plain descriptor call; the child keeps it across exec.
			if unsafe { libc::fcntl(parent, libc::F_SETFD, 0) } < 0 {
				return Err(std::io::Error::last_os_error());
			}
			done[index] = true;
			left -= 1;
		}
	}
	while left > 0 {
		let mut progressed = false;
		for index in 0..mappings.len() {
			if done[index] {
				continue;
			}
			let (parent, child) = mappings[index];
			let read_later = (0..mappings.len()).any(|other| !done[other] && other != index && mappings[other].0 == child);
			if read_later {
				continue;
			}
			// SAFETY: plain descriptor call; `dup2` clears close-on-exec.
			if unsafe { libc::dup2(parent, child) } < 0 {
				return Err(std::io::Error::last_os_error());
			}
			done[index] = true;
			left -= 1;
			progressed = true;
		}
		if !progressed && let Some(index) = (0..mappings.len()).find(|&index| !done[index]) {
			// SAFETY: plain descriptor call on an open source descriptor.
			let moved = unsafe { libc::fcntl(mappings[index].0, libc::F_DUPFD_CLOEXEC, 0) };
			if moved < 0 {
				return Err(std::io::Error::last_os_error());
			}
			let source = mappings[index].0;
			for (other, mapping) in mappings.iter_mut().enumerate() {
				if !done[other] && mapping.0 == source {
					mapping.0 = moved;
				}
			}
		}
	}
	Ok(())
}

/// Extension trait for arranging for commands to take the foreground.
pub trait CommandFgControlExt {
	/// Arranges for the command to take the foreground when it is executed.
	fn take_foreground(&mut self);
	/// Arranges for the command to become a session leader when it is executed.
	fn lead_session(&mut self);
}

impl CommandFgControlExt for std::process::Command {
	fn take_foreground(&mut self) {
		// SAFETY:
		// This arranges for a provided function to run in the context of
		// the forked process before it exec's the target command. In general,
		// rust can't guarantee safety of code running in such a context.
		unsafe {
			self.pre_exec(pre_exec_take_foreground);
		}
	}

	fn lead_session(&mut self) {
		// SAFETY:
		// This arranges for a provided function to run in the context of
		// the forked process before it exec's the target command. In general,
		// rust can't guarantee safety of code running in such a context.
		unsafe {
			self.pre_exec(pre_exec_lead_session);
		}
	}
}

/// Extension trait for detaching commands from the parent's controlling terminal.
pub trait CommandSessionExt {
	/// Arranges for the command to run in a new POSIX session with no controlling terminal.
	fn detach_session(&mut self);
	/// Like [`CommandSessionExt::detach_session`], but additionally double-forks
	/// so the spawned process reparents to init (PID 1) and leaves the caller's
	/// descendant tree.
	fn detach_session_reparent(&mut self);
}

impl CommandSessionExt for std::process::Command {
	fn detach_session(&mut self) {
		// Unlike a `pre_exec` closure, this keeps std's `posix_spawn` path
		// (`POSIX_SPAWN_SETSID`, vfork-style) available on linux-gnu, so spawn cost
		// does not scale with the host's address space. Elsewhere std calls
		// `setsid()` in its fork+exec fallback. Callers never combine this with
		// `process_group`, so the fresh child cannot already lead a process group
		// and `setsid()` cannot fail with EPERM.
		//
		// glibc rejects `POSIX_SPAWN_SETSID` with EINVAL before 2.26, but std only
		// reaches it here on glibc 2.29+: `compose_std_command` always sets a
		// working directory, and std takes `posix_spawn` with one only when
		// `posix_spawn_file_actions_addchdir_np` (glibc 2.29) exists.
		self.setsid(true);
	}

	fn detach_session_reparent(&mut self) {
		// SAFETY:
		// This arranges for a provided function to run in the forked child before
		// exec. Only async-signal-safe calls (`setsid`, `fork`, `_exit`) are used.
		unsafe {
			self.pre_exec(pre_exec_detach_session_reparent);
		}
	}
}

fn pre_exec_take_foreground() -> Result<(), std::io::Error> {
	use crate::sys;

	sys::terminal::move_self_to_foreground()?;
	Ok(())
}

fn pre_exec_lead_session() -> Result<(), std::io::Error> {
	if let Err(e) = nix::unistd::setsid() {
		return Err(std::io::Error::other(format!("failed to become session leader: {e}")));
	}

	#[cfg(not(target_os = "macos"))]
	let control = libc::TIOCSCTTY;
	#[cfg(target_os = "macos")]
	let control: u64 = libc::TIOCSCTTY.into();

	// SAFETY:
	// This is calling a libc function to set the controlling terminal.
	let result = unsafe { libc::ioctl(0, control, 0) };
	if result != 0 {
		return Err(std::io::Error::other("failed to set controlling terminal"));
	}

	Ok(())
}

fn pre_exec_detach_session_reparent() -> Result<(), std::io::Error> {
	// New session first: drop any controlling terminal. Ignore EPERM, which means
	// the child is already a session leader from an outer policy.
	match nix::unistd::setsid() {
		Ok(_) | Err(nix::errno::Errno::EPERM) => {},
		Err(errno) => return Err(std::io::Error::from_raw_os_error(errno as i32)),
	}

	// Double-fork: the intermediate child — the pid the parent's spawn machinery
	// tracks — exits immediately, so the grandchild that goes on to `exec` the
	// operand reparents to init (PID 1) and is no longer a descendant of the
	// shell. This is what lets `nohup cmd &` survive the host's descendant-walk
	// teardown without relying on an external `setsid(1)` binary.
	//
	// SAFETY: the post-`fork` child here is single-threaded, and only
	// async-signal-safe primitives (`fork`, `_exit`) run before `exec`.
	let pid = unsafe { libc::fork() };
	if pid < 0 {
		return Err(std::io::Error::last_os_error());
	}
	if pid > 0 {
		// Intermediate parent: exit now to orphan the grandchild. `_exit` avoids
		// running atexit handlers or flushing inherited buffers in the fork.
		// SAFETY: this post-fork intermediate child must terminate without
		// running destructors or touching inherited buffered state.
		unsafe { libc::_exit(0) };
	}
	Ok(())
}
