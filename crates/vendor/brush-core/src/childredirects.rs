//! Redirections a background external command's forked child makes itself,
//! before it executes the command (see [`DeferredRedirect`]), as the child
//! Bash forks makes them: in the order written, with `open`, `dup2` and
//! `close`, under the command's own resource limits. They cost no descriptor
//! the command does not get, and need no other program.
//!
//! `std::process::Command::spawn` returns only once the child has executed its
//! program: it reads a pipe that closes when the child calls `exec`. A child
//! that opened a FIFO first would hold this shell until the FIFO's other end
//! appears, and that can be the shell's own next command
//! (`/bin/cat <f & echo hi >f`). So the child first closes every descriptor
//! `exec` would close, that pipe among them, which lets the shell go on with
//! the child's pid. Then it makes the redirections, and executes the command
//! itself, reporting a failure to start it as this shell would. From then on
//! it must end in `exec` or `_exit`: std's own failure path writes to the pipe
//! it closed.
//!
//! Every byte the child may write is formatted here, before the fork: the
//! forked child of a threaded process may make only async-signal-safe calls,
//! so it allocates nothing.

// Only Unix defers redirections, so only Unix reads what is prepared here.
#![cfg_attr(not(unix), allow(dead_code))]

use std::ffi::{CString, c_char};

use crate::interp::{ChildOpenMode, DeferredRedirect};
use crate::{Shell, ShellFd, error, extensions, results::ExecutionExitCode, rlimits::ResourceLimits};

/// The deferred redirections of a background external command, ready for its
/// forked child, and how the child ends once it has made them.
///
/// The child makes them under the shell's `ulimit` settings, as the child
/// Bash forks does, whichever way it ends. A redirection that cannot be made
/// is reported on the standard error in effect at that point, in this shell's
/// words, and ends the child with status 1.
pub(crate) struct ChildRedirects {
	steps:            Vec<Step>,
	limits:           ResourceLimits,
	end:              End,
	errno_texts:      &'static [Box<[u8]>],
	/// Every descriptor below this is checked when the child cannot list its
	/// open descriptors.
	descriptor_bound: i32,
}

enum Step {
	/// Open `path` on `fd`. A failure is reported as `failure.0`, the text of
	/// the `errno`, then `failure.1`; a target descriptor the process may not
	/// have as `bad_target`.
	Open {
		fd:         ShellFd,
		mode:       ChildOpenMode,
		path:       CString,
		failure:    (Box<[u8]>, Box<[u8]>),
		bad_target: Box<[u8]>,
	},
	/// Duplicate `from` onto `fd`; `failure` reports a bad descriptor.
	Duplicate { fd: ShellFd, from: ShellFd, failure: Box<[u8]> },
	Close { fd: ShellFd },
	/// Truncate the file at `fd` as `O_TRUNC` would; a failure other than
	/// `EINVAL` (not a regular file) is reported as `failure` is for `Open`.
	Truncate { fd: ShellFd, failure: (Box<[u8]>, Box<[u8]>) },
}

enum End {
	/// Write `text` on the standard error the redirections leave and exit with
	/// `status`, executing nothing (see `interp::ErrorReport`).
	Report { text: Box<[u8]>, status: i32 },
	/// Execute the command.
	Exec(Exec),
}

/// The command, as `execve` takes it.
struct Exec {
	program:     CString,
	/// `argv` and `envp` own what the pointer arrays point into.
	_argv:       Vec<CString>,
	_envp:       Vec<CString>,
	argv:        Vec<*const c_char>,
	envp:        Vec<*const c_char>,
	/// `/bin/sh program args…`, which runs a program that has no `#!` line, as
	/// `execvp` does when `execve` fails with `ENOEXEC`.
	script_argv: Vec<*const c_char>,
	/// Reports a program that does not exist (status 127).
	not_found:   Box<[u8]>,
	/// Reports any other failure to start it, around the text of the `errno`.
	failure:     (Box<[u8]>, Box<[u8]>),
	/// The status of such a failure.
	status:      i32,
}

// SAFETY: the pointers point into the `CString`s the same `Exec` owns, which
// nothing changes or drops before the `Exec` itself.
unsafe impl Send for Exec {}
// SAFETY: as above; nothing writes through the pointers.
unsafe impl Sync for Exec {}

/// Stands for the text of an `errno` while a failure is formatted, so the
/// forked child can put the text of the one it got there.
const ERRNO_TEXT_MARK: &str = "\u{0}errno\u{0}";

/// The text each `errno` below 256 is shown with, as `std::io::Error` shows
/// it. [`ChildRedirects`] forces it before any fork, so the forked child only
/// reads it.
static ERRNO_TEXTS: std::sync::LazyLock<Vec<Box<[u8]>>> = std::sync::LazyLock::new(|| {
	(0..256)
		.map(|errno| std::io::Error::from_raw_os_error(errno).to_string().into_bytes().into())
		.collect()
});

impl ChildRedirects {
	/// Prepares `redirects` for the child of `cmd`, the command composed by
	/// `commands::compose_std_command` with `argv0`, which the child then
	/// executes.
	pub(crate) fn to_exec(
		shell: &Shell<impl extensions::ShellExtensions>,
		redirects: &[DeferredRedirect],
		cmd: &std::process::Command,
		argv0: &str,
		command_name: &str,
	) -> Result<Self, error::Error> {
		let exec = Exec::new(shell, cmd, argv0, command_name)?;
		Self::new(shell, redirects, End::Exec(exec))
	}

	/// Prepares `redirects` for a child that then writes `diagnostic` on the
	/// standard error they leave and exits with `status`.
	pub(crate) fn to_report(
		shell: &Shell<impl extensions::ShellExtensions>,
		redirects: &[DeferredRedirect],
		diagnostic: &str,
		status: u8,
	) -> Result<Self, error::Error> {
		Self::new(shell, redirects, End::Report {
			text:   diagnostic.as_bytes().into(),
			status: i32::from(status),
		})
	}

	fn new(
		shell: &Shell<impl extensions::ShellExtensions>,
		redirects: &[DeferredRedirect],
		end: End,
	) -> Result<Self, error::Error> {
		let steps = redirects
			.iter()
			.map(|redirect| {
				Ok(match redirect {
					DeferredRedirect::Open { fd, mode, path, .. } => Step::Open {
						fd:         *fd,
						mode:       *mode,
						path:       CString::new(path.as_os_str().as_encoded_bytes())
							.map_err(|_| error::ErrorKind::InvalidRedirection)?,
						failure:    split_at_errno(error_text(
							shell,
							error::ErrorKind::RedirectionFailure(
								path.to_string_lossy().into_owned(),
								std::io::Error::other(ERRNO_TEXT_MARK),
							),
						)),
						bad_target: error_text(shell, error::ErrorKind::BadFileDescriptor(*fd)),
					},
					DeferredRedirect::Duplicate { fd, from } => Step::Duplicate {
						fd:      *fd,
						from:    *from,
						failure: error_text(shell, error::ErrorKind::BadFileDescriptor(*from)),
					},
					DeferredRedirect::Close { fd } => Step::Close { fd: *fd },
					DeferredRedirect::Truncate { fd, path } => Step::Truncate {
						fd:      *fd,
						failure: split_at_errno(error_text(
							shell,
							error::ErrorKind::RedirectionFailure(
								path.to_string_lossy().into_owned(),
								std::io::Error::other(ERRNO_TEXT_MARK),
							),
						)),
					},
				})
			})
			.collect::<Result<_, error::Error>>()?;
		Ok(Self {
			steps,
			limits: shell.resource_limits().clone(),
			end,
			errno_texts: &ERRNO_TEXTS,
			descriptor_bound: descriptor_bound(),
		})
	}

	/// Runs in the forked child as its last step before `exec`: makes the
	/// redirections, then ends the child as [`End`] says. It never returns:
	/// once it has closed the pipe `spawn` waits on, std's own failure path,
	/// which writes to that pipe, must not run.
	#[cfg(unix)]
	pub(crate) fn run_in_child(&self) -> ! {
		reset_signal_handlers();
		close_descriptors_exec_closes(self.descriptor_bound);
		// The limits apply before the redirections, as in the child Bash forks,
		// where the shell itself holds them. Failing to set them fails a command
		// that was to run; a command that has failed already still reports why,
		// with its own status.
		if let Err(error) = self.limits.apply_in_child()
			&& let End::Exec(exec) = &self.end
		{
			self.fail(&exec.failure, error.raw_os_error().unwrap_or(0), exec.status);
		}
		for step in &self.steps {
			match step {
				Step::Open { fd, mode, path, failure, bad_target } => {
					let opened = open(path, *mode).unwrap_or_else(|errno| self.fail(failure, errno, 1));
					if opened != *fd {
						// SAFETY: plain descriptor calls on descriptors this process owns.
						let moved = unsafe { libc::dup2(opened, *fd) };
						// SAFETY: as above.
						unsafe { libc::close(opened) };
						if moved < 0 {
							write_all(libc::STDERR_FILENO, bad_target);
							exit(1);
						}
					}
				},
				Step::Duplicate { fd, from, failure } => {
					// SAFETY: plain descriptor call.
					if unsafe { libc::dup2(*from, *fd) } < 0 {
						write_all(libc::STDERR_FILENO, failure);
						exit(1);
					}
				},
				Step::Close { fd } => {
					// SAFETY: plain descriptor call; closing a closed descriptor is harmless.
					unsafe { libc::close(*fd) };
				},
				Step::Truncate { fd, failure } => {
					// SAFETY: plain descriptor call.
					if unsafe { libc::ftruncate(*fd, 0) } != 0 {
						let errno = last_errno();
						if errno != libc::EINVAL {
							self.fail(failure, errno, 1);
						}
					}
				},
			}
		}
		match &self.end {
			End::Report { text, status } => {
				write_all(libc::STDERR_FILENO, text);
				exit(*status);
			},
			End::Exec(exec) => exec.run(self),
		}
	}

	/// Writes `failure` around the text of `errno` and exits with `status`.
	#[cfg(unix)]
	fn fail(&self, failure: &(Box<[u8]>, Box<[u8]>), errno: i32, status: i32) -> ! {
		let errno_text = usize::try_from(errno)
			.ok()
			.and_then(|errno| self.errno_texts.get(errno))
			.map_or(&[][..], |text| &text[..]);
		write_all(libc::STDERR_FILENO, &failure.0);
		write_all(libc::STDERR_FILENO, errno_text);
		write_all(libc::STDERR_FILENO, &failure.1);
		exit(status)
	}
}

impl Exec {
	/// The command `cmd` runs. `commands::compose_std_command` clears its
	/// environment, so the variables it sets are all of it, and passes the
	/// program as a path (`execute_via_external` resolves it), so it needs no
	/// `PATH` search.
	fn new(
		shell: &Shell<impl extensions::ShellExtensions>,
		cmd: &std::process::Command,
		argv0: &str,
		command_name: &str,
	) -> Result<Self, error::Error> {
		let c_string = |bytes: &[u8]| {
			CString::new(bytes).map_err(|_| {
				error::Error::from(error::ErrorKind::FailedToExecuteCommand(
					command_name.to_owned(),
					std::io::Error::from(std::io::ErrorKind::InvalidInput),
				))
			})
		};
		let program = c_string(cmd.get_program().as_encoded_bytes())?;
		let argv = std::iter::once(Ok(c_string(argv0.as_bytes())?))
			.chain(cmd.get_args().map(|arg| c_string(arg.as_encoded_bytes())))
			.collect::<Result<Vec<_>, _>>()?;
		let envp = cmd
			.get_envs()
			.filter_map(|(name, value)| {
				let value = value?;
				let mut entry = name.as_encoded_bytes().to_vec();
				entry.push(b'=');
				entry.extend_from_slice(value.as_encoded_bytes());
				Some(c_string(&entry))
			})
			.collect::<Result<Vec<_>, _>>()?;
		let failure = error::ErrorKind::FailedToExecuteCommand(
			command_name.to_owned(),
			std::io::Error::other(ERRNO_TEXT_MARK),
		);
		let status = i32::from(u8::from(ExecutionExitCode::from(&failure)));
		Ok(Self {
			argv: null_terminated(argv.iter().map(|arg| arg.as_ptr())),
			envp: null_terminated(envp.iter().map(|entry| entry.as_ptr())),
			script_argv: null_terminated(
				[c"/bin/sh".as_ptr(), program.as_ptr()]
					.into_iter()
					.chain(argv[1..].iter().map(|arg| arg.as_ptr())),
			),
			not_found: error_text(shell, error::ErrorKind::CommandNotFound(command_name.to_owned())),
			failure: split_at_errno(error_text(shell, failure)),
			status,
			program,
			_argv: argv,
			_envp: envp,
		})
	}

	/// Executes the command, as std's `execvp` would, or reports why it
	/// cannot and exits.
	#[cfg(unix)]
	fn run(&self, redirects: &ChildRedirects) -> ! {
		// SAFETY: every pointer array is NULL-terminated and points into
		// strings this value owns.
		unsafe { libc::execve(self.program.as_ptr(), self.argv.as_ptr(), self.envp.as_ptr()) };
		let mut errno = last_errno();
		if errno == libc::ENOEXEC {
			// SAFETY: as above.
			unsafe { libc::execve(c"/bin/sh".as_ptr(), self.script_argv.as_ptr(), self.envp.as_ptr()) };
			errno = last_errno();
		}
		if errno == libc::ENOENT {
			write_all(libc::STDERR_FILENO, &self.not_found);
			exit(i32::from(u8::from(ExecutionExitCode::NotFound)));
		}
		redirects.fail(&self.failure, errno, self.status)
	}
}

/// What `shell` shows for `error`, as bytes.
fn error_text(shell: &Shell<impl extensions::ShellExtensions>, error: error::ErrorKind) -> Box<[u8]> {
	shell.error_text(&error.into()).unwrap_or_default().into_bytes().into()
}

/// Splits `text` where the text of an `errno` goes.
fn split_at_errno(text: Box<[u8]>) -> (Box<[u8]>, Box<[u8]>) {
	let mark = ERRNO_TEXT_MARK.as_bytes();
	match text.windows(mark.len()).position(|window| window == mark) {
		Some(at) => (text[..at].into(), text[at + mark.len()..].into()),
		None => (text, Box::default()),
	}
}

/// `pointers`, ended by the null pointer `execve` looks for.
fn null_terminated(pointers: impl Iterator<Item = *const c_char>) -> Vec<*const c_char> {
	pointers.chain(std::iter::once(std::ptr::null())).collect()
}

/// The highest descriptor number, plus one, this process may have open: its
/// open-file limit, up to 1,048,576 descriptors.
#[cfg(unix)]
fn descriptor_bound() -> i32 {
	const MOST: u64 = 1 << 20;
	let limit = rlimit::Resource::NOFILE.get().map_or(MOST, |(soft, _)| soft.min(MOST));
	i32::try_from(limit).unwrap_or(i32::MAX)
}

#[cfg(not(unix))]
const fn descriptor_bound() -> i32 {
	0
}

/// The `errno` of the last failed call, without allocating.
#[cfg(unix)]
fn last_errno() -> i32 {
	std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

/// Writes `bytes` to `fd`, retrying interrupted and partial writes and giving
/// up on any other failure (a closed descriptor).
#[cfg(unix)]
fn write_all(fd: libc::c_int, mut bytes: &[u8]) {
	while !bytes.is_empty() {
		// SAFETY: `bytes` is valid for `bytes.len()` bytes.
		let written = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
		match usize::try_from(written) {
			Ok(written) if written > 0 => bytes = &bytes[written..],
			_ if written < 0 && last_errno() == libc::EINTR => {},
			_ => return,
		}
	}
}

/// Ends the forked child with `status`, running nothing of this process.
#[cfg(unix)]
fn exit(status: i32) -> ! {
	// SAFETY: `_exit` is async-signal-safe and does not return.
	unsafe { libc::_exit(status) }
}

/// Opens `path` as `mode` says, as the shell opens a redirection's file,
/// retrying an interrupted call; the `errno` of a failure.
///
/// `noclobber` (`WriteNoClobber`) refuses to replace an existing regular
/// file and opens anything else as it is, without truncating it, as Bash
/// does: an exclusive create first, and on `EEXIST` a look at what is there.
#[cfg(unix)]
fn open(path: &CString, mode: ChildOpenMode) -> Result<libc::c_int, i32> {
	let call = |flags: libc::c_int| loop {
		// SAFETY: `path` is a NUL-terminated string that outlives the call.
		let opened = unsafe { libc::open(path.as_ptr(), flags, 0o666 as libc::c_uint) };
		if opened >= 0 {
			return Ok(opened);
		}
		let errno = last_errno();
		if errno != libc::EINTR {
			return Err(errno);
		}
	};
	match mode {
		ChildOpenMode::Read => call(libc::O_RDONLY),
		ChildOpenMode::Write => call(libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC),
		ChildOpenMode::Append => call(libc::O_WRONLY | libc::O_CREAT | libc::O_APPEND),
		ChildOpenMode::ReadWrite => call(libc::O_RDWR | libc::O_CREAT),
		ChildOpenMode::WriteNoClobber => match call(libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL) {
			Err(libc::EEXIST) => {
				// SAFETY: `stat` fills the zeroed buffer, which outlives the call.
				let regular = unsafe {
					let mut status: libc::stat = std::mem::zeroed();
					libc::stat(path.as_ptr(), &raw mut status) == 0
						&& status.st_mode & libc::S_IFMT == libc::S_IFREG
				};
				if regular { Err(libc::EEXIST) } else { call(libc::O_WRONLY) }
			},
			opened => opened,
		},
	}
}

/// Resets every signal this process handles to its default action, as the
/// child Bash forks resets them, so a signal ends a child that waits in
/// `open` for a FIFO's other end instead of running a handler of this
/// process. Ignored signals stay ignored, as `exec` keeps them.
#[cfg(unix)]
fn reset_signal_handlers() {
	for signal in 1..65 {
		if signal == libc::SIGKILL || signal == libc::SIGSTOP {
			continue;
		}
		// SAFETY: `sigaction` with a zeroed, then queried, action is
		// async-signal-safe; an invalid signal number fails with `EINVAL`.
		unsafe {
			let mut action: libc::sigaction = std::mem::zeroed();
			if libc::sigaction(signal, std::ptr::null(), &raw mut action) != 0 {
				continue;
			}
			if action.sa_sigaction != libc::SIG_DFL && action.sa_sigaction != libc::SIG_IGN {
				let mut default: libc::sigaction = std::mem::zeroed();
				default.sa_sigaction = libc::SIG_DFL;
				libc::sigaction(signal, &raw const default, std::ptr::null_mut());
			}
		}
	}
}

/// Closes every descriptor marked close-on-exec, which `exec` would close:
/// std's pipe that holds the parent until then, and every descriptor of this
/// process the command must not see, so a duplication of a descriptor the
/// command does not have fails as it does in Bash. It lists the open
/// descriptors in `/proc/self/fd` where it can, and otherwise checks each one
/// below `bound`.
#[cfg(unix)]
fn close_descriptors_exec_closes(bound: i32) {
	#[cfg(target_os = "linux")]
	if close_listed_descriptors_exec_closes() {
		return;
	}
	for fd in 0..bound {
		close_if_closed_on_exec(fd, -1);
	}
}

/// Closes `fd` if it is marked close-on-exec and is not `keep`.
#[cfg(unix)]
fn close_if_closed_on_exec(fd: i32, keep: i32) {
	if fd == keep {
		return;
	}
	// SAFETY: plain descriptor calls; `fcntl` on a closed descriptor fails with `EBADF`.
	unsafe {
		let flags = libc::fcntl(fd, libc::F_GETFD);
		if flags >= 0 && flags & libc::FD_CLOEXEC != 0 {
			libc::close(fd);
		}
	}
}

/// [`close_descriptors_exec_closes`] for the descriptors `/proc/self/fd`
/// lists. Returns whether it listed them all.
#[cfg(target_os = "linux")]
fn close_listed_descriptors_exec_closes() -> bool {
	// SAFETY: the path is NUL-terminated.
	let dir = unsafe {
		libc::open(c"/proc/self/fd".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC)
	};
	if dir < 0 {
		return false;
	}
	let listed = close_descriptors_listed_in(dir);
	// SAFETY: `dir` is open and owned here.
	unsafe { libc::close(dir) };
	listed
}

/// Reads the directory open at `dir`, a listing of descriptors such as
/// `/proc/self/fd`, with `getdents64` into a buffer on the stack, and closes
/// each descriptor it names that is marked close-on-exec, except `dir`.
/// Returns whether it read the listing to its end: an error other than
/// `EINTR`, or a record it cannot parse, leaves descriptors unchecked, and the
/// caller must check them some other way.
#[cfg(target_os = "linux")]
fn close_descriptors_listed_in(dir: i32) -> bool {
	let mut buffer = [0u8; 4096];
	loop {
		// SAFETY: `buffer` is valid for its length; the kernel writes whole
		// `linux_dirent64` records into it.
		let read = unsafe { libc::syscall(libc::SYS_getdents64, dir, buffer.as_mut_ptr(), buffer.len()) };
		let Ok(read) = usize::try_from(read) else {
			if last_errno() == libc::EINTR {
				continue;
			}
			return false;
		};
		if read == 0 {
			return true;
		}
		// Each record: inode (8 bytes), offset (8), length (2), type (1), name.
		let mut at = 0;
		while at < read {
			if at + 19 > read {
				return false;
			}
			let length = usize::from(u16::from_ne_bytes([buffer[at + 16], buffer[at + 17]]));
			if length < 19 || at + length > read {
				return false;
			}
			let name = &buffer[at + 19..at + length];
			let digits = name.iter().take_while(|byte| byte.is_ascii_digit());
			let fd = digits.fold(Some(0i32), |fd, digit| {
				fd?.checked_mul(10)?.checked_add(i32::from(digit - b'0'))
			});
			if name.first().is_some_and(u8::is_ascii_digit)
				&& let Some(fd) = fd
			{
				close_if_closed_on_exec(fd, dir);
			}
			at += length;
		}
	}
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
	use std::os::fd::AsRawFd as _;

	use super::close_descriptors_listed_in;

	/// A listing `getdents64` cannot read is not taken for a complete one, so
	/// the child checks every descriptor instead: a child that took a failed
	/// read (an `EINTR`, an `EIO`) for the end of the listing kept the pipe
	/// `spawn` waits on open, and opening a FIFO then held the shell for ever.
	/// A regular file stands for the listing here: `getdents64` fails on it
	/// with `ENOTDIR`, and nothing it names is closed.
	#[test]
	fn a_listing_that_cannot_be_read_is_not_complete() {
		let file = tempfile::tempfile().expect("scratch file");
		assert!(!close_descriptors_listed_in(file.as_raw_fd()));
	}
}
