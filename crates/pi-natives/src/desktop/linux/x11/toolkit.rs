//! Host and target-process heuristics for choosing an X11 input route.

use std::fs;

/// `WM_CLASS` fragments of clients known to discard `XSendEvent` input.
/// xterm drops synthetic events unless `allowSendEvents` is set.
const SYNTHETIC_DROPPING_CLASSES: [&str; 8] =
	["gtk", "gdk", "qt", "chrome", "chromium", "firefox", "mozilla", "xterm"];

/// Mapped libraries of toolkits that discard synthetic (`send_event`) X11
/// input: GTK 3/4 read `XInput2` only, `LibreOffice` VCL and Qt 5/6 filter it,
/// Firefox (libxul) and CEF embed those toolkits.
const SYNTHETIC_DROPPING_LIBRARIES: [&str; 8] = [
	"libgtk-3.so",
	"libgtk-4.so",
	"libvcl",
	"libmergedlo",
	"libQt5Gui",
	"libQt6Gui",
	"libxul.so",
	"libcef.so",
];

pub(super) fn class_drops_synthetic(wm_class: &str) -> bool {
	let class = wm_class.to_ascii_lowercase();
	SYNTHETIC_DROPPING_CLASSES
		.iter()
		.any(|needle| class.contains(needle))
}

/// MPX core events also reach core-protocol window managers, which can
/// activate/raise the target. Keep them disabled, and reject legacy clients
/// rather than pretending XI2 input reaches them.
pub(super) fn requires_core_events(wm_class: &str, pid: Option<u32>) -> bool {
	let class = wm_class.to_ascii_lowercase();
	class.split('\0').any(|part| matches!(part, "xterm" | "uxterm" | "rxvt" | "urxvt" | "xev" | "tk"))
		|| pid.is_some_and(|pid| {
			fs::read_to_string(format!("/proc/{pid}/maps")).is_ok_and(|maps| {
				maps.contains("/libtk8") || maps.contains("/libtk9") || maps.contains("/libXm.so")
			})
		})
}

/// Whether process `pid` runs a toolkit that silently drops `XSendEvent`
/// input, judged from its mapped libraries and Chromium's helper processes.
pub(super) fn process_drops_synthetic(pid: u32) -> bool {
	fs::read_to_string(format!("/proc/{pid}/maps")).is_ok_and(|maps| maps_drop_synthetic(&maps))
		|| chromium_embedder(pid)
}

fn maps_drop_synthetic(maps: &str) -> bool {
	SYNTHETIC_DROPPING_LIBRARIES
		.iter()
		.any(|library| maps.contains(library))
}

/// Chromium and Electron statically link their toolkit, so maps alone miss
/// them; their fingerprint is `--type=<renderer|zygote|gpu-process>` helper
/// processes forked by the embedder (or the switch on a single-process
/// embedder itself).
fn chromium_embedder(pid: u32) -> bool {
	if cmdline_is_chromium_helper(pid) {
		return true;
	}
	let Ok(tasks) = fs::read_dir(format!("/proc/{pid}/task")) else {
		return false;
	};
	tasks.flatten().any(|task| {
		fs::read_to_string(task.path().join("children")).is_ok_and(|children| {
			children
				.split_whitespace()
				.filter_map(|child| child.parse::<u32>().ok())
				.any(cmdline_is_chromium_helper)
		})
	})
}

fn cmdline_is_chromium_helper(pid: u32) -> bool {
	fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|raw| {
		raw.split(|&byte| byte == 0)
			.any(|arg| arg.starts_with(b"--type="))
	})
}

/// KDE Plasma 6 / Qt 6 clients on X11 can crash session-wide when a uinput
/// device is hot-plugged into Xorg, so the MPX route (which hot-plugs its
/// slaves) must not even be attempted there.
fn kde_x11_uinput_hotplug_is_unsafe(
	session_type: Option<&str>,
	desktops: [Option<&str>; 3],
	kde_full_session: Option<&str>,
	display: Option<&str>,
	wayland_display: Option<&str>,
) -> bool {
	let nonempty = |value: Option<&str>| value.is_some_and(|value| !value.trim().is_empty());
	let explicit_x11 = session_type.is_some_and(|value| value.eq_ignore_ascii_case("x11"));
	let explicit_wayland = session_type.is_some_and(|value| value.eq_ignore_ascii_case("wayland"));
	if explicit_wayland || (!explicit_x11 && nonempty(wayland_display)) {
		return false;
	}
	let kde_desktop = desktops.iter().flatten().any(|value| {
		value
			.split([':', ';', ','])
			.map(str::trim)
			.any(|token| token.eq_ignore_ascii_case("kde") || token.eq_ignore_ascii_case("plasma"))
	});
	let kde_full = kde_full_session.is_some_and(|value| {
		matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes")
	});
	(explicit_x11 || nonempty(display)) && (kde_desktop || kde_full)
}

pub(super) fn kde_x11_uinput_hotplug_is_unsafe_from_env() -> bool {
	let var = |name: &str| std::env::var(name).ok();
	let session_type = var("XDG_SESSION_TYPE");
	let current_desktop = var("XDG_CURRENT_DESKTOP");
	let session_desktop = var("XDG_SESSION_DESKTOP");
	let desktop_session = var("DESKTOP_SESSION");
	let kde_full_session = var("KDE_FULL_SESSION");
	let display = var("DISPLAY");
	let wayland_display = var("WAYLAND_DISPLAY");
	kde_x11_uinput_hotplug_is_unsafe(
		session_type.as_deref(),
		[current_desktop.as_deref(), session_desktop.as_deref(), desktop_session.as_deref()],
		kde_full_session.as_deref(),
		display.as_deref(),
		wayland_display.as_deref(),
	)
}

/// File name of the X server binary serving `DISPLAY`, read through the PID
/// in its `/tmp/.X{N}-lock` file. Servers without udev/libinput hotplug
/// (Xvfb, Xtigervnc/Xvnc) can never turn a uinput device into an X slave.
pub(super) fn x_server_exe_name() -> Option<String> {
	let display = std::env::var("DISPLAY").ok()?;
	let number = display.rsplit(':').next()?.split('.').next()?.trim();
	if number.is_empty() {
		return None;
	}
	let lock = fs::read_to_string(format!("/tmp/.X{number}-lock")).ok()?;
	let pid = lock.trim().parse::<u32>().ok()?;
	fs::read_link(format!("/proc/{pid}/exe"))
		.ok()
		.and_then(|exe| exe.file_name()?.to_str().map(str::to_owned))
		.or_else(|| {
			fs::read_to_string(format!("/proc/{pid}/comm"))
				.ok()
				.map(|comm| comm.trim().to_owned())
		})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn kde_x11_sessions_disable_uinput_hotplug() {
		let unsafe_for = |session, desktop, full, display, wayland| {
			kde_x11_uinput_hotplug_is_unsafe(session, [desktop, None, None], full, display, wayland)
		};
		assert!(unsafe_for(Some("x11"), Some("KDE"), None, None, None));
		assert!(unsafe_for(None, Some("ubuntu:plasma"), None, Some(":0"), None));
		assert!(unsafe_for(None, None, Some("true"), Some(":0"), None));
		// Explicit X11 wins over a stray WAYLAND_DISPLAY (nested compositor).
		assert!(unsafe_for(Some("x11"), Some("KDE"), None, Some(":0"), Some("wayland-0")));
		assert!(!unsafe_for(Some("wayland"), Some("KDE"), None, Some(":0"), None));
		assert!(!unsafe_for(None, Some("KDE"), None, Some(":0"), Some("wayland-0")));
		assert!(!unsafe_for(Some("x11"), Some("GNOME"), None, Some(":0"), None));
		assert!(!unsafe_for(None, Some("KDE"), None, None, None));
	}
}
