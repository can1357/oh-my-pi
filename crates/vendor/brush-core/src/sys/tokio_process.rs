//! Process management utilities

pub(crate) type ProcessId = i32;
pub(crate) use tokio::process::Child;

pub(crate) fn spawn(command: std::process::Command) -> std::io::Result<Child> {
	let mut command = tokio::process::Command::from(command);
	command.kill_on_drop(true);
	// Isolate every external child from the host's console:
	//
	// - `CREATE_NO_WINDOW` gives the child its own *invisible* console instead
	//   of attaching it to ours. Console-sharing children can mutate shared
	//   console state behind the host's back — most notably the output
	//   codepage (PHP >=7.1 CLI issues the equivalent of `chcp` and skips the
	//   restore when killed; php.net request #73716), which degraded every
	//   non-ASCII glyph a hosting TUI painted into CP437 mojibake (`Γöé`).
	//   Inherited stdio handles are unaffected (handle-routed, not
	//   console-routed); interactive commands belong to the PTY path, which
	//   provisions a dedicated ConPTY anyway.
	// - `CREATE_NEW_PROCESS_GROUP` makes the child a ctrl-event group root.
	//   Windows cannot join an existing group, so this is applied uniformly
	//   here rather than per-command (`creation_flags` replaces rather than
	//   ORs; the `sys::windows::commands` ext traits intentionally leave
	//   creation flags alone).
	#[cfg(windows)]
	{
		use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};
		command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
	}
	command.spawn()
}
