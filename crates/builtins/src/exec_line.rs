//! Command lines sized to what one `exec` takes, for `xargs`,
//! `find -exec … +` and `fd -X`: the system's `ARG_MAX` less the
//! environment and POSIX's 2048 bytes of headroom (Windows: `CreateProcess`'s
//! 32767-character command line).

use std::{
	ffi::{OsStr, OsString},
	io,
};

/// What an argument takes besides its string: its `argv` pointer on Unix;
/// nothing on Windows, where the command line is one string.
pub const ARG_OVERHEAD: usize = if cfg!(unix) { size_of::<*const u8>() } else { 0 };

/// What `arg`'s string takes of the room: its bytes and NUL (Unix), or its
/// UTF-16 units and the separating space (Windows).
pub fn string_size(arg: &OsStr) -> usize {
	#[cfg(unix)]
	let units = std::os::unix::ffi::OsStrExt::as_bytes(arg).len();
	#[cfg(windows)]
	let units = std::os::windows::ffi::OsStrExt::encode_wide(arg).count();
	units + 1
}

/// The room one `exec` leaves its arguments (strings and [`ARG_OVERHEAD`])
/// when it passes `env`; at least 1.
#[cfg(unix)]
pub fn system_room<K: AsRef<OsStr>, V: AsRef<OsStr>>(env: impl IntoIterator<Item = (K, V)>) -> usize {
	// POSIX leaves 2048 bytes for the child to set its own variables.
	const HEADROOM: usize = 2048;
	// SAFETY: sysconf only reads a configuration value.
	let arg_max = unsafe { libc::sysconf(libc::_SC_ARG_MAX) };
	// Indeterminate (-1): Linux's historical 128 KiB.
	let arg_max = usize::try_from(arg_max)
		.ok()
		.filter(|&max| max > 0)
		.unwrap_or(128 * 1024);
	// Each `NAME=value` string (the two sizes count '=' and NUL) and its
	// `envp` pointer.
	let env_size: usize = env
		.into_iter()
		.map(|(name, value)| string_size(name.as_ref()) + string_size(value.as_ref()) + ARG_OVERHEAD)
		.sum();
	arg_max.saturating_sub(HEADROOM).saturating_sub(env_size).max(1)
}

/// The room one `exec` leaves its arguments: `CreateProcess` takes a
/// command line of up to 32767 characters, whatever the environment.
#[cfg(windows)]
pub fn system_room<K: AsRef<OsStr>, V: AsRef<OsStr>>(_env: impl IntoIterator<Item = (K, V)>) -> usize {
	32_767
}

/// A command line filled argument by argument; it refuses any argument that
/// would not fit in one `exec` under this process's environment.
pub struct ExecLine {
	argv: Vec<OsString>,
	/// What is left of the room.
	room: usize,
}

impl ExecLine {
	/// `program` alone.
	pub fn new(program: impl Into<OsString>) -> Self {
		let program = program.into();
		let room = system_room(std::env::vars_os()).saturating_sub(cost(&program));
		Self { argv: vec![program], room }
	}

	/// Whether `args` would all fit.
	pub fn fits<'a>(&self, args: impl IntoIterator<Item = &'a OsStr>) -> bool {
		args.into_iter().map(cost).sum::<usize>() <= self.room
	}

	/// Adds `arg` if it fits.
	///
	/// # Errors
	/// `E2BIG` when it does not; nothing is added.
	pub fn try_arg(&mut self, arg: &OsStr) -> io::Result<()> {
		self.try_args(std::slice::from_ref(&arg))
	}

	/// Adds `args` if they all fit.
	///
	/// # Errors
	/// `E2BIG` when they do not; nothing is added.
	pub fn try_args(&mut self, args: &[impl AsRef<OsStr>]) -> io::Result<()> {
		let size: usize = args.iter().map(|arg| cost(arg.as_ref())).sum();
		if size > self.room {
			return Err(too_long());
		}
		self.room -= size;
		self.argv.extend(args.iter().map(|arg| arg.as_ref().to_os_string()));
		Ok(())
	}

	/// The program and its arguments.
	pub fn into_argv(self) -> Vec<OsString> {
		self.argv
	}
}

/// What `arg` takes of the room.
fn cost(arg: &OsStr) -> usize {
	string_size(arg) + ARG_OVERHEAD
}

fn too_long() -> io::Error {
	#[cfg(unix)]
	return io::Error::from_raw_os_error(libc::E2BIG);
	#[cfg(windows)]
	return io::ErrorKind::ArgumentListTooLong.into();
}
