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
		let fd_mappings: Vec<FdMapping> = open_files
			.map(|(child_fd, open_file)| -> Result<FdMapping, error::Error> {
				let parent_fd = open_file.try_clone_to_owned()?;
				Ok(FdMapping { child_fd, parent_fd })
			})
			.collect::<Result<Vec<_>, _>>()?;

		self
			.fd_mappings(fd_mappings)
			.map_err(|_e| error::ErrorKind::ChildCreationFailure)?;

		Ok(())
	}
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

/// Extension trait for detaching commands from the parent's controlling
/// terminal.
pub trait CommandSessionExt {
	/// Arranges for the command to run in a new POSIX session with no
	/// controlling terminal.
	fn detach_session(&mut self);
}

impl CommandSessionExt for std::process::Command {
	fn detach_session(&mut self) {
		// SAFETY:
		// This arranges for a provided function to run in the forked child
		// before exec. `setsid(2)` is async-signal-safe.
		unsafe {
			self.pre_exec(pre_exec_detach_session);
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

fn pre_exec_detach_session() -> Result<(), std::io::Error> {
	match nix::unistd::setsid() {
		Ok(_) | Err(nix::errno::Errno::EPERM) => Ok(()),
		Err(errno) => Err(std::io::Error::from_raw_os_error(errno as i32)),
	}
}
