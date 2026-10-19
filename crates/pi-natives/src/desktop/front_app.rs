//! The app in front of the user, read before omp's own input reaches a
//! background target, so it can be put back if that input brings another app
//! forward.
#![cfg_attr(test, allow(dead_code, reason = "reached only from JavaScript, through napi"))]

use napi_derive::napi;

use crate::task;

/// The app the user had in front when `macOSFrontApp()` read it.
#[napi(js_name = "MacOSFrontApp")]
pub struct MacosFrontApp {
	#[cfg(target_os = "macos")]
	app: super::macos::FrontApp,
}

#[napi]
impl MacosFrontApp {
	/// Puts this app back in front, without raising its windows, each time the
	/// app that took the front from it takes it again during the next
	/// `durationMs`. Ends early once a hardware mouse button or ⌘/⌃ is used
	/// after the app was read, the app came from a launcher or Spotlight panel,
	/// or a different app comes forward: that is the user picking an app.
	/// Typing does not end it, and a hand-back macOS refuses for a key typed
	/// meanwhile is asked again. Holds nothing when called over a second after
	/// the latest read, as picks made since then went unwatched. Owns desktop
	/// input/focus control only for each hand-back, and rejects if another
	/// operation owns it then. Resolves how many times it put the app back.
	#[napi]
	pub fn keep_in_front(&self, duration_ms: u32) -> task::Promise<u32> {
		#[cfg(target_os = "macos")]
		{
			let app = self.app;
			task::blocking("desktop.keepInFront", (), move |_| {
				app.keep_in_front(std::time::Duration::from_millis(duration_ms.into()))
					.map_err(Into::into)
			})
		}
		#[cfg(not(target_os = "macos"))]
		{
			let _ = duration_ms;
			task::blocking("desktop.keepInFront", (), |_| Ok(0))
		}
	}
}

/// The app macOS `WindowServer` has in front. `null` off macOS and when the
/// front-process SPI is unavailable.
#[napi(js_name = "macOSFrontApp")]
pub fn macos_front_app() -> Option<MacosFrontApp> {
	#[cfg(target_os = "macos")]
	{
		super::macos::front_app().map(|app| MacosFrontApp { app })
	}
	#[cfg(not(target_os = "macos"))]
	{
		None
	}
}
