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
		// given. The child takes each at its number by `dup2` alone. A file at
		// 0, 1 or 2 is the one exception: the child's standard streams are put
		// there before the descriptors are, so it is duplicated here once per
		// standard number, and every descriptor naming that number reads the
		// one copy, at most three of them however many name them.
		let mut held = Vec::new();
		let mut standard: [Option<std::os::fd::OwnedFd>; 3] = [None, None, None];
		let mut mappings = Vec::new();
		for (child_fd, open_file) in open_files {
			let borrowed = open_file.try_borrow_as_fd()?;
			let raw = borrowed.as_raw_fd();
			let parent_fd = if let Some(copy) = usize::try_from(raw).ok().and_then(|n| standard.get_mut(n)) {
				match copy {
					Some(owned) => owned.as_raw_fd(),
					None => copy.insert(borrowed.try_clone_to_owned()?).as_raw_fd(),
				}
			} else {
				raw
			};
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
		let mut scratch = vec![false; mappings.len()];
		// SAFETY: the closure only makes system calls on the descriptors it
		// was given and on numbers they name, and allocates nothing.
		unsafe {
			self.pre_exec(move || {
				let _ = (&held, &standard);
				place_fds(&mut mappings, &mut done, &mut scratch)
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
/// ring opens; that number is closed once the last mapping reading it is
/// made. `scratch` marks the mappings that read a moved source.
fn place_fds(mappings: &mut [(i32, ShellFd)], done: &mut [bool], scratch: &mut [bool]) -> std::io::Result<()> {
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
			if scratch[index] && !(0..mappings.len()).any(|other| !done[other] && mappings[other].0 == parent) {
				// SAFETY: `parent` is the moved copy this function made, which
				// nothing reads any more.
				unsafe { libc::close(parent) };
			}
		}
		if !progressed && let Some(index) = (0..mappings.len()).find(|&index| !done[index]) {
			// SAFETY: plain descriptor call on an open source descriptor.
			let moved = unsafe { libc::fcntl(mappings[index].0, libc::F_DUPFD_CLOEXEC, 0) };
			if moved < 0 {
				return Err(std::io::Error::last_os_error());
			}
			let source = mappings[index].0;
			let was_scratch = scratch[index];
			for (other, mapping) in mappings.iter_mut().enumerate() {
				if !done[other] && mapping.0 == source {
					mapping.0 = moved;
					scratch[other] = true;
				}
			}
			if was_scratch {
				// SAFETY: `source` is a moved copy this function made, and
				// every mapping that read it reads `moved` now.
				unsafe { libc::close(source) };
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

#[cfg(all(test, target_os = "linux"))]
mod tests {
	use std::os::{fd::AsRawFd as _, unix::fs::MetadataExt as _};

	use super::*;

	fn open_count() -> usize {
		std::fs::read_dir("/proc/self/fd").expect("descriptor list").count()
	}

	fn inode(fd: i32) -> u64 {
		std::fs::metadata(format!("/proc/self/fd/{fd}")).expect("descriptor").ino()
	}

	/// Three rings of two, each closed with a moved copy of one source: every
	/// target ends with the other's file, and no copy is left open, so a
	/// command given many rings needs one spare descriptor, not one per ring.
	#[test]
	fn rings_are_placed_and_leave_no_copy_open() {
		let dir = tempfile::tempdir().expect("scratch directory");
		let mut fds = Vec::new();
		for name in 0..6 {
			let file = std::fs::File::create(dir.path().join(name.to_string())).expect("file");
			// SAFETY: plain descriptor call on a file this test owns.
			let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 900 + name) };
			assert!(fd >= 900, "a high descriptor");
			fds.push(fd);
		}
		let inodes: Vec<u64> = fds.iter().map(|&fd| inode(fd)).collect();
		let mut mappings: Vec<(i32, ShellFd)> = (0..6).map(|i| (fds[i], fds[i ^ 1])).collect();
		let mut done = vec![false; 6];
		let mut scratch = vec![false; 6];
		let before = open_count();
		place_fds(&mut mappings, &mut done, &mut scratch).expect("placed");
		assert_eq!(open_count(), before, "a moved copy was left open");
		for i in 0..6 {
			assert_eq!(inode(fds[i ^ 1]), inodes[i], "descriptor {} holds file {i}", fds[i ^ 1]);
		}
		for fd in fds {
			// SAFETY: the test's own descriptors.
			unsafe { libc::close(fd) };
		}
	}

	/// A file this process holds at 1 is given to the child as it was, not
	/// as the child's redirected standard output put there before it.
	#[test]
	fn a_standard_stream_is_given_as_it_was() {
		let dir = tempfile::tempdir().expect("scratch directory");
		let redirected = dir.path().join("redirected");
		let mut command = std::process::Command::new("/bin/sh");
		command.args(["-c", "printf SAVED >&3"]);
		command.stdout(std::fs::File::create(&redirected).expect("file"));
		command
			.inject_fds(std::iter::once((3, openfiles::OpenFile::from(std::io::stdout()))))
			.expect("injected");
		assert!(command.status().expect("ran").success());
		assert_eq!(std::fs::read_to_string(&redirected).expect("read"), "");
	}

	/// 56 descriptors naming one standard stream are given to a child through
	/// one copy of it, not one each: with 40 descriptors open here, a copy per
	/// descriptor reached the open-file limit of 64 before the child started.
	#[test]
	fn aliases_of_a_standard_stream_share_one_copy() {
		// nextest runs each test in a process of its own, whose limit this is.
		let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
		// SAFETY: plain calls on a structure this function owns.
		unsafe {
			assert_eq!(libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut limit), 0);
			limit.rlim_cur = limit.rlim_max.min(64);
			assert_eq!(libc::setrlimit(libc::RLIMIT_NOFILE, &raw const limit), 0);
		}
		let mut fillers = Vec::new();
		while open_count() < 40 {
			fillers.push(std::fs::File::open("/dev/null").expect("filler"));
		}
		let streams: [(&str, fn() -> openfiles::OpenFile); 3] = [
			("stdin", || std::io::stdin().into()),
			("stdout", || std::io::stdout().into()),
			("stderr", || std::io::stderr().into()),
		];
		for (name, stream) in streams {
			let mut command = std::process::Command::new("/bin/true");
			command.inject_fds((3..59).map(|fd| (fd, stream()))).expect("injected");
			let status = command.status().unwrap_or_else(|e| panic!("{name}: {e}"));
			assert!(status.success(), "{name}: {status}");
		}
	}
}
