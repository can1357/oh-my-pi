use anyhow::{Context, Result};
use windows_sys::Win32::{
	Foundation::HWND,
	UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey},
};

use crate::config::Hotkey;

pub const HOTKEY_ID: i32 = 1;

pub struct RegisteredHotkey {
	hwnd: HWND,
}

impl RegisteredHotkey {
	pub fn register(hwnd: HWND, binding: Hotkey) -> Result<Self> {
		// SAFETY: `hwnd` is supplied by the host and the binding consists only of
		// validated integer modifier/key values; the result is checked.
		let registered = unsafe { RegisterHotKey(hwnd, HOTKEY_ID, binding.modifiers, binding.key) };
		if registered == 0 {
			return Err(std::io::Error::last_os_error())
				.context("global hotkey is already in use or unavailable");
		}
		Ok(Self { hwnd })
	}
}

impl Drop for RegisteredHotkey {
	fn drop(&mut self) {
		// SAFETY: This guard unregisters the same window/id pair it registered,
		// at most once during drop.
		unsafe { UnregisterHotKey(self.hwnd, HOTKEY_ID) };
	}
}
