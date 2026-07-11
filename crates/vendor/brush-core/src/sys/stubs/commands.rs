//! Command execution utilities.

use std::ffi::OsStr;

use crate::{ShellFd, error, openfiles};

/// Extension trait for Unix-like command extensions.
pub trait CommandExt {
	/// Sets the zeroth argument (argv[0]) of the command.
	///
	/// # Arguments
	///
	/// * `arg` - The argument to set as argv[0].
	fn arg0<S>(&mut self, arg: S) -> &mut Self
	where
		S: AsRef<OsStr>;

	/// Sets the process group ID of the command.
	///
	/// # Arguments
	///
	/// * `pgroup` - The process group ID to set.
	fn process_group(&mut self, pgroup: i32) -> &mut Self;
}

impl CommandExt for std::process::Command {
	fn arg0<S>(&mut self, _arg: S) -> &mut Self
	where
		S: AsRef<OsStr>,
	{
		// NOTE: no-op.
		self
	}

	fn process_group(&mut self, _pgroup: i32) -> &mut Self {
		// NOTE: no-op.
		self
	}
}

/// Extension trait for Unix-like exit status extensions.
pub trait ExitStatusExt {
	/// Returns the signal that terminated the process, if any.
	fn signal(&self) -> Option<i32>;
}

impl ExitStatusExt for std::process::ExitStatus {
	fn signal(&self) -> Option<i32> {
		None
	}
}

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
		mut open_files: impl Iterator<Item = (ShellFd, openfiles::OpenFile)>,
	) -> Result<(), error::Error> {
		if open_files.next().is_some() {
			return Err(error::ErrorKind::NotSupportedOnThisPlatform("fd redirections").into());
		}

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
		// NOTE: This is a no-op.
	}

	fn lead_session(&mut self) {
		// NOTE: This is a no-op.
	}
}

/// Extension trait for detaching commands from the parent's controlling terminal.
pub trait CommandSessionExt {
	/// Arranges for the command to run in a new session with no controlling terminal.
	fn detach_session(&mut self);
	/// Like [`CommandSessionExt::detach_session`]. No-op on platforms without
	/// `setsid`/`fork` reparenting.
	fn detach_session_reparent(&mut self);
}

impl CommandSessionExt for std::process::Command {
	fn detach_session(&mut self) {
		// NOTE: This is a no-op on platforms without setsid support.
	}

	fn detach_session_reparent(&mut self) {
		// NOTE: This is a no-op on platforms without setsid/fork support.
	}
}
