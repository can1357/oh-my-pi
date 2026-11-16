//! Windows console codepage guard.

use std::sync::atomic::{AtomicU32, Ordering};

use windows_sys::Win32::System::Console::{
	GetConsoleCP, GetConsoleOutputCP, SetConsoleCP, SetConsoleOutputCP,
};

/// UTF-8 codepage id for `SetConsoleCP`/`SetConsoleOutputCP`.
const CP_UTF8: u32 = 65001;

/// The last foreign output codepage warned about, so a child that keeps
/// flipping to the same page is reported once.
static LAST_WARNED_CODEPAGE: AtomicU32 = AtomicU32::new(0);

/// Re-assert the UTF-8 console codepages before output is written.
///
/// The runtime sets both console codepages to UTF-8 (65001) at startup, and
/// output is handed to `WriteFile` as UTF-8 bytes, which conhost translates
/// using the *current* console output codepage. Child processes spawned by
/// tools (bash commands, MCP/LSP servers, eval kernels) share this console,
/// and some flip the codepage behind our back: PHP >=7.1 CLI issues the
/// equivalent of `chcp` whenever `internal_encoding` mismatches the console
/// codepage (php.net request #73716) and skips the restore when killed — and
/// two PHP processes in a pipeline race their restores. Once the codepage
/// falls back to an OEM page (437/850), every non-ASCII glyph the TUI paints
/// is mis-translated: box-drawing borders degrade into `Γöé`/`ΓöÇ` mojibake on
/// the next full repaint (most visibly ctrl+o expand, which rewrites every
/// row).
///
/// `GetConsoleOutputCP` is one cheap console call per write; the setter only
/// runs after a foreign flip. A reading of 0 means "no console" — leave that
/// alone. Guarding the write chokepoint (rather than per-spawn cleanup)
/// covers every console-sharing child and long-running processes that flip
/// the codepage mid-session.
pub(super) fn ensure_utf8() {
	// SAFETY: takes no arguments and only reads the attached console's state.
	let output = unsafe { GetConsoleOutputCP() };
	if output != 0 && output != CP_UTF8 {
		// SAFETY: takes a plain codepage id; failure leaves the console as is.
		unsafe { SetConsoleOutputCP(CP_UTF8) };
		if LAST_WARNED_CODEPAGE.swap(output, Ordering::Relaxed) != output {
			::log::warn!(
				"console output codepage changed to {output} by a child process; restoring UTF-8"
			);
		}
	}
	// SAFETY: takes no arguments and only reads the attached console's state.
	let input = unsafe { GetConsoleCP() };
	if input != 0 && input != CP_UTF8 {
		// SAFETY: takes a plain codepage id; failure leaves the console as is.
		unsafe { SetConsoleCP(CP_UTF8) };
	}
}
