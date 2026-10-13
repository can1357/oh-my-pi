//! Sessionless on-screen window roster: what the OS is showing right now,
//! popup menus, pickers and system panels included.
#![cfg_attr(test, allow(dead_code, reason = "reached only from JavaScript, through napi"))]

use napi::Result;
use napi_derive::napi;

/// One on-screen window from the unfiltered roster. Unlike
/// [`super::DesktopWindow`] it keeps popup menus, pickers and system panels,
/// which publish no title or sharing state and sit above layer 0.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct DesktopRosterWindow {
	/// `kCGWindowNumber`, decimal; the same id `listWindows` reports.
	pub id:     String,
	/// Owning process id.
	pub pid:    u32,
	/// Owning process name.
	pub app:    String,
	/// Window title; empty without Screen Recording permission and for
	/// windows that publish none.
	pub title:  String,
	pub x:      f64,
	pub y:      f64,
	pub width:  f64,
	pub height: f64,
	/// `kCGWindowLayer`: 0 for ordinary windows, 3 for floating panels, 101
	/// for popup menus, higher for system panels.
	pub layer:  i32,
	/// `kCGWindowAlpha`; 0 is an invisible overlay.
	pub alpha:  f64,
	/// Whether `listWindows` reports this window, so `computer.window(id)`
	/// resolves it.
	pub listed: bool,
}

/// Samples every on-screen window, front to back, in one `WindowServer` pass,
/// with no desktop session and no permission prompt. Empty off macOS.
#[napi]
pub fn desktop_window_roster() -> Result<Vec<DesktopRosterWindow>> {
	#[cfg(target_os = "macos")]
	{
		super::macos::window_roster().map_err(napi::Error::from)
	}
	#[cfg(not(target_os = "macos"))]
	{
		Ok(Vec::new())
	}
}
