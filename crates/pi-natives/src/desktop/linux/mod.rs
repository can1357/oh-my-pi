pub mod ax;
pub mod wayland;
pub mod x11;

use std::{ffi::OsStr, os::unix::fs::FileTypeExt, path::Path};

use super::{
	backend::Backend,
	error::{CoreResult, DesktopError},
	types::DisplaySelector,
};

pub fn new_backend(display: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	let wayland = wayland_socket_exists(
		std::env::var_os("WAYLAND_SOCKET").as_deref(),
		std::env::var_os("WAYLAND_DISPLAY").as_deref(),
		std::env::var_os("XDG_RUNTIME_DIR").as_deref(),
	);
	if wayland {
		return Ok(Box::new(wayland::WaylandBackend::new(display)));
	}
	if std::env::var_os("DISPLAY").is_some() {
		return Ok(Box::new(x11::X11Backend::new(display)?));
	}
	Err(DesktopError::capture_failed(
		"no display server reachable (no Wayland socket and DISPLAY is not set)",
	))
}

/// Check for a Wayland compositor the way libwayland does. `WAYLAND_SOCKET` is
/// an inherited connection. An absolute `WAYLAND_DISPLAY` is the socket path.
/// A relative one lives under `XDG_RUNTIME_DIR`. The path has to be a unix
/// socket, so a name left over from a dead session, an empty value, or a name
/// a wrapper script set for its own reasons cannot hide a live X11 display.
fn wayland_socket_exists(
	socket_fd: Option<&OsStr>,
	display: Option<&OsStr>,
	runtime_dir: Option<&OsStr>,
) -> bool {
	if socket_fd.is_some() {
		return true;
	}
	let Some(display) = display.filter(|display| !display.is_empty()) else {
		return false;
	};
	let display = Path::new(display);
	if display.is_absolute() {
		return is_socket(display);
	}
	runtime_dir.is_some_and(|runtime_dir| is_socket(&Path::new(runtime_dir).join(display)))
}

fn is_socket(path: &Path) -> bool {
	std::fs::metadata(path).is_ok_and(|metadata| metadata.file_type().is_socket())
}

#[cfg(test)]
mod tests {
	use std::{ffi::OsString, os::unix::net::UnixListener, path::PathBuf};

	use super::*;

	struct RuntimeDir(PathBuf);

	impl RuntimeDir {
		fn new(test: &str) -> Self {
			let path = std::env::temp_dir().join(format!("omp-wayland-{test}-{}", std::process::id()));
			let _ = std::fs::remove_dir_all(&path);
			std::fs::create_dir_all(&path).expect("create runtime dir");
			Self(path)
		}

		fn as_os_str(&self) -> &OsStr {
			self.0.as_os_str()
		}
	}

	impl Drop for RuntimeDir {
		fn drop(&mut self) {
			let _ = std::fs::remove_dir_all(&self.0);
		}
	}

	fn os(value: &str) -> OsString {
		OsString::from(value)
	}

	#[test]
	fn ignores_wayland_display_without_socket() {
		let runtime = RuntimeDir::new("no-socket");
		std::fs::write(runtime.0.join("plain-file"), b"").expect("write file");

		assert!(!wayland_socket_exists(None, None, Some(runtime.as_os_str())));
		assert!(!wayland_socket_exists(None, Some(&os("")), Some(runtime.as_os_str())));
		assert!(!wayland_socket_exists(None, Some(&os("wayland-0")), Some(runtime.as_os_str())));
		assert!(!wayland_socket_exists(None, Some(&os("wayland-0")), None));
		assert!(!wayland_socket_exists(None, Some(&os("plain-file")), Some(runtime.as_os_str())));
	}

	#[test]
	fn accepts_relative_socket_under_runtime_dir() {
		let runtime = RuntimeDir::new("relative");
		let _listener = UnixListener::bind(runtime.0.join("wayland-0")).expect("bind socket");

		assert!(wayland_socket_exists(None, Some(&os("wayland-0")), Some(runtime.as_os_str())));
	}

	#[test]
	fn accepts_absolute_socket_path() {
		let runtime = RuntimeDir::new("absolute");
		let socket = runtime.0.join("compositor.sock");
		let _listener = UnixListener::bind(&socket).expect("bind socket");

		assert!(wayland_socket_exists(None, Some(socket.as_os_str()), None));
	}

	#[test]
	fn accepts_inherited_wayland_socket_fd() {
		assert!(wayland_socket_exists(Some(&os("3")), None, None));
	}
}
