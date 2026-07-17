mod app;
mod capture;
mod gateway;
mod hotkey;
mod single_instance;
mod tray;

use anyhow::Result;
use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};

use crate::config::Config;

pub fn run(config: Result<Config>) -> Result<()> {
	app::run(config?)
}

pub fn report_fatal(error: &anyhow::Error) {
	let title = wide("Oh My Pi Desktop Tag");
	let message = wide(&format!("Desktop Tag could not start:\n{error:#}"));
	unsafe {
		MessageBoxW(std::ptr::null_mut(), message.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR)
	};
}

pub(crate) fn wide(value: &str) -> Vec<u16> {
	value.encode_utf16().chain(std::iter::once(0)).collect()
}
