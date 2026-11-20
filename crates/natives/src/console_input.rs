//! Windows console input mode for a TUI that owns stdin.
//!
//! Raw mode (libuv's `ENABLE_WINDOW_INPUT` alone, which Bun's `setRawMode`
//! sets) makes the console report modified keys as console events that lose
//! their modifiers: Shift+Tab arrives as Tab. With
//! `ENABLE_VIRTUAL_TERMINAL_INPUT` it sends them as VT sequences (`CSI Z`)
//! instead.

use napi_derive::napi;

/// Add `ENABLE_VIRTUAL_TERMINAL_INPUT` to the stdin console's mode.
///
/// Call after entering raw mode, which clears it. Returns the mode found, for
/// `restoreConsoleInputMode`; `null` when stdin is not a console or the
/// console refuses VT input, and always off Windows.
#[napi]
#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
pub fn enable_console_vt_input() -> Option<u32> {
	#[cfg(windows)]
	{
		sys::enable_vt_input()
	}
	#[cfg(not(windows))]
	{
		None
	}
}

/// Put back a stdin console mode `enableConsoleVtInput` returned. False when
/// stdin is no longer a console or refuses the mode; always false off Windows.
#[napi]
#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
pub fn restore_console_input_mode(mode: u32) -> bool {
	#[cfg(windows)]
	{
		sys::stdin().is_some_and(|stdin| sys::set_mode(stdin, mode))
	}
	#[cfg(not(windows))]
	{
		let _ = mode;
		false
	}
}

#[cfg(windows)]
mod sys {
	use windows_sys::Win32::{
		Foundation::{HANDLE, INVALID_HANDLE_VALUE},
		System::Console::{
			CONSOLE_MODE, ENABLE_VIRTUAL_TERMINAL_INPUT, GetConsoleMode, GetStdHandle,
			STD_INPUT_HANDLE, SetConsoleMode,
		},
	};

	/// The process's stdin handle; `None` when it has none.
	pub(super) fn stdin() -> Option<HANDLE> {
		// SAFETY: plain query of the process's own standard handle.
		let handle = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
		(!handle.is_null() && handle != INVALID_HANDLE_VALUE).then_some(handle)
	}

	pub(super) fn enable_vt_input() -> Option<CONSOLE_MODE> {
		let stdin = stdin()?;
		let mut mode: CONSOLE_MODE = 0;
		// SAFETY: stdin is a live standard handle and mode is valid storage;
		// a handle that is not a console fails without writing.
		if unsafe { GetConsoleMode(stdin, &raw mut mode) } == 0 {
			return None;
		}
		let vt = mode | ENABLE_VIRTUAL_TERMINAL_INPUT;
		(vt == mode || set_mode(stdin, vt)).then_some(mode)
	}

	pub(super) fn set_mode(stdin: HANDLE, mode: CONSOLE_MODE) -> bool {
		// SAFETY: stdin is a live standard handle and the mode a flag word;
		// failure leaves the console as it was.
		unsafe { SetConsoleMode(stdin, mode) != 0 }
	}
}
