//! Terminal utilities.

use std::{io, io::IsTerminal, os::fd::AsFd, path::PathBuf};

use nix::{
	sys::termios::{self, OutputFlags, SetArg, Termios},
	unistd::Pid,
};

use crate::{builtins::terminal, error, openfiles::OpenFile, sys};

/// Terminal configuration.
#[derive(Clone, Debug)]
pub(crate) struct Config {
	termios: Termios,
}

impl Config {
	/// Creates a new `Config` from the actual terminal attributes of the
	/// terminal associated with the given file descriptor.
	///
	/// # Arguments
	///
	/// * `file` - A reference to the open terminal.
	pub(crate) fn from_term(file: &OpenFile) -> Result<Self, error::Error> {
		let fd = file.try_borrow_as_fd()?;
		let termios = termios::tcgetattr(fd)?;
		Ok(Self { termios })
	}

	/// Applies the terminal settings to the terminal associated with the given
	/// file descriptor.
	///
	/// # Arguments
	///
	/// * `file` - A reference to the open terminal.
	pub(crate) fn apply_to_term(&self, file: &OpenFile) -> Result<(), error::Error> {
		let fd = file.try_borrow_as_fd()?;
		termios::tcsetattr(fd, SetArg::TCSANOW, &self.termios)?;
		Ok(())
	}

	/// Applies the given high-level terminal settings to this configuration.
	/// Does not modify any terminal itself.
	///
	/// # Arguments
	///
	/// * `settings` - The high-level terminal settings to apply to this
	///   configuration.
	pub(crate) fn update(&mut self, settings: &terminal::Settings) {
		if let Some(echo_input) = &settings.echo_input {
			if *echo_input {
				self.termios.local_flags |= termios::LocalFlags::ECHO;
			} else {
				self.termios.local_flags -= termios::LocalFlags::ECHO;
			}
		}

		if let Some(line_input) = &settings.line_input {
			if *line_input {
				self.termios.local_flags |= termios::LocalFlags::ICANON;
			} else {
				self.termios.local_flags -= termios::LocalFlags::ICANON;
			}
		}

		if let Some(interrupt_signals) = &settings.interrupt_signals {
			if *interrupt_signals {
				self.termios.local_flags |= termios::LocalFlags::ISIG;
			} else {
				self.termios.local_flags -= termios::LocalFlags::ISIG;
			}
		}

		if let Some(output_nl_as_nlcr) = &settings.output_nl_as_nlcr {
			if *output_nl_as_nlcr {
				self.termios.output_flags |= OutputFlags::OPOST | OutputFlags::ONLCR;
			} else {
				self.termios.output_flags -= OutputFlags::ONLCR;
			}
		}
	}
}

/// Get the process ID of this process's parent.
pub fn get_parent_process_id() -> Option<sys::process::ProcessId> {
	Some(nix::unistd::getppid().as_raw())
}

/// Get the process group ID for this process's process group.
pub fn get_process_group_id() -> Option<sys::process::ProcessId> {
	Some(nix::unistd::getpgrp().as_raw())
}

/// Get the foreground process ID of the attached terminal.
pub fn get_foreground_pid() -> Option<sys::process::ProcessId> {
	nix::unistd::tcgetpgrp(io::stdin())
		.ok()
		.map(|pgid| pgid.as_raw())
}

/// Move the specified process to the foreground of the attached terminal.
pub fn move_to_foreground(pid: sys::process::ProcessId) -> Result<(), error::Error> {
	nix::unistd::tcsetpgrp(io::stdin(), Pid::from_raw(pid))?;
	Ok(())
}

/// Moves the current process to the foreground of the attached terminal.
// This function needs to return `std::io::Error` so that the OS error code can
// be recovered.
pub fn move_self_to_foreground() -> Result<(), io::Error> {
	if io::stdin().is_terminal() {
		let pgid = nix::unistd::getpgid(None)?;

		// TODO(jobs): This sometimes fails with ENOTTY even though we checked that
		// stdin is a terminal. We should investigate why this is happening.
		let _ = nix::unistd::tcsetpgrp(io::stdin(), pgid);
	}

	Ok(())
}

/// Tries to get the path of the terminal device associated with the attached
/// terminal. Returns `None` if there is no terminal attached or the lookup
/// failed.
pub fn try_get_terminal_device_path() -> Option<PathBuf> {
	nix::unistd::ttyname(io::stdin()).ok()
}
