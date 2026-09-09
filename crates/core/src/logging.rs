//! Process-wide stderr log gate used while the TUI owns the terminal.

use std::sync::atomic::{AtomicBool, Ordering};

static STDERR_MUTED: AtomicBool = AtomicBool::new(false);

/// Mutes or unmutes stderr log echo while the TUI owns the terminal.
#[inline]
pub fn set_stderr_muted(muted: bool) {
	STDERR_MUTED.store(muted, Ordering::Relaxed);
}

/// Returns whether stderr log echo is currently muted.
#[inline]
pub fn stderr_muted() -> bool {
	STDERR_MUTED.load(Ordering::Relaxed)
}
