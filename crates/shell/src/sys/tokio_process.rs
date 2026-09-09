//! Process management utilities

use std::{ffi, io, path::Path, process::Command};

use tokio::process;

pub(crate) type ProcessId = i32;
pub(crate) use process::Child;
/// Validates the Windows ConPTY executable contract.
///
/// `CreateProcessW` cannot launch batch files directly under ConPTY. Callers
/// must use `cmd.exe /c <batch>` so quoting and command lookup remain owned by
/// the Windows command processor.
pub(crate) fn validate_pty_application(application: &Path) -> io::Result<()> {
	#[cfg(windows)]
	if application
		.extension()
		.and_then(ffi::OsStr::to_str)
		.is_some_and(|extension| {
			extension.eq_ignore_ascii_case("bat") || extension.eq_ignore_ascii_case("cmd")
		}) {
		return Err(io::Error::new(
			io::ErrorKind::InvalidInput,
			"Windows PTY batch files require cmd.exe with the batch path after /c",
		));
	}
	#[cfg(not(windows))]
	let _ = application;
	Ok(())
}

/// Returns the ConPTY input sequence that emulates SIGINT on Windows.
///
/// ConPTY does not expose Unix process-group signals. Writing ETX follows the
/// terminal path and gives the foreground console process the same Ctrl+C
/// event it receives from an interactive keyboard.
pub(crate) fn pty_sigint_input(signal: &str) -> Option<&'static [u8]> {
	#[cfg(windows)]
	if signal.eq_ignore_ascii_case("SIGINT") {
		return Some(b"\x03");
	}
	#[cfg(not(windows))]
	let _ = signal;
	None
}

pub(crate) fn spawn(command: Command) -> io::Result<Child> {
	let mut command = process::Command::from(command);
	// `ChildProcess` owns termination policy so disowned children can detach.
	command.kill_on_drop(false);
	// Isolate every external child from the host's console:
	//
	// - `CREATE_NO_WINDOW` gives the child its own *invisible* console instead of
	//   attaching it to ours. Console-sharing children can mutate shared console
	//   state behind the host's back — most notably the output codepage (PHP >=7.1
	//   CLI issues the equivalent of `chcp` and skips the restore when killed;
	//   php.net request #73716), which degraded every non-ASCII glyph a hosting TUI
	//   painted into CP437 mojibake (`Γöé`). Inherited stdio handles are unaffected
	//   (handle-routed, not console-routed); interactive commands belong to the PTY
	//   path, which provisions a dedicated ConPTY anyway.
	// - `CREATE_NEW_PROCESS_GROUP` makes the child a ctrl-event group root. Windows
	//   cannot join an existing group, so this is applied uniformly here rather
	//   than per-command (`creation_flags` replaces rather than ORs; the
	//   `sys::windows::commands` ext traits intentionally leave creation flags
	//   alone).
	#[cfg(windows)]
	{
		use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};
		command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
	}
	let child = command.spawn()?;
	shield_pipes_from_sigpipe(&child);
	Ok(child)
}

/// Marks the child's parent-held pipe endpoints `F_SETNOSIGPIPE` so a write
/// after child exit surfaces as `EPIPE` instead of raising `SIGPIPE`.
///
/// Embedded job control (signal-mask and disposition juggling around waits)
/// can leave the host process with a default `SIGPIPE` disposition on the
/// writing thread; the host must never die because one child closed early.
#[cfg(target_os = "macos")]
fn shield_pipes_from_sigpipe(child: &Child) {
	use std::os::fd::AsRawFd as _;
	/// `fcntl` selector absent from the `libc` crate; from
	/// `<sys/fcntl.h>`: `#define F_SETNOSIGPIPE 73`.
	const F_SETNOSIGPIPE: libc::c_int = 73;
	for fd in [
		child.stdin.as_ref().map(|pipe| pipe.as_raw_fd()),
		child.stdout.as_ref().map(|pipe| pipe.as_raw_fd()),
		child.stderr.as_ref().map(|pipe| pipe.as_raw_fd()),
	]
	.into_iter()
	.flatten()
	{
		// SAFETY: fcntl on an owned, open descriptor with no memory arguments.
		unsafe {
			libc::fcntl(fd, F_SETNOSIGPIPE, 1);
		}
	}
}

#[cfg(not(target_os = "macos"))]
fn shield_pipes_from_sigpipe(_child: &Child) {}
