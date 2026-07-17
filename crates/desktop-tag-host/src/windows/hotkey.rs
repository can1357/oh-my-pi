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
		unsafe { UnregisterHotKey(self.hwnd, HOTKEY_ID) };
	}
}
