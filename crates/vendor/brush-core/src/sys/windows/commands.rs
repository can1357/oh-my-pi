//! Command execution utilities.
//!
//! On Windows, process creation flags are applied uniformly in
//! `sys::process::spawn` (`CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`); the
//! per-command extension methods below intentionally do not touch creation
//! flags, because `CommandExt::creation_flags` replaces rather than ORs and
//! two writers would silently clobber each other.

use std::ffi::OsStr;

use crate::{ShellFd, error, openfiles};

/// Extension trait for Windows command extensions.
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
		// NOTE: Windows does not support overriding argv[0] directly.
		self
	}

	fn process_group(&mut self, _pgroup: i32) -> &mut Self {
		// NOTE: Windows cannot join an existing process group, and new-group
		// creation is handled uniformly by `sys::process::spawn`.
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
			return Err(
				error::ErrorKind::NotSupportedOnThisPlatform(
					"fd redirections beyond stdin/stdout/stderr on Windows",
				)
				.into(),
			);
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
		// NOTE: no terminal foregrounding on Windows; group/console flags are
		// applied uniformly by `sys::process::spawn`.
	}

	fn lead_session(&mut self) {
		// NOTE: no sessions on Windows; group/console flags are applied
		// uniformly by `sys::process::spawn`.
	}
}

/// Extension trait for detaching a command from the parent's controlling terminal.
pub trait CommandSessionExt {
	/// Arranges for the command to run in a new POSIX session with no controlling
	/// terminal. On Windows this is a no-op; process-group and console behavior
	/// are handled uniformly by `sys::process::spawn`.
	fn detach_session(&mut self);
}

impl CommandSessionExt for std::process::Command {
	fn detach_session(&mut self) {
		// NOTE: Windows has no setsid; intentionally a no-op.
	}
}
