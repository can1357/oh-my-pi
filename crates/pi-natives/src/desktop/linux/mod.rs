pub mod ax;
pub mod wayland;
pub mod x11;

use super::{
	backend::Backend,
	error::{CoreResult, DesktopError},
	types::DisplaySelector,
};

pub fn new_backend(display: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	if std::env::var_os("WAYLAND_DISPLAY").is_some() {
		return Ok(Box::new(wayland::WaylandBackend::new(display)));
	}
	if std::env::var_os("DISPLAY").is_some() {
		return Ok(Box::new(x11::X11Backend::new(display)?));
	}
	Err(DesktopError::capture_failed(
		"no display server (neither WAYLAND_DISPLAY nor DISPLAY is set)",
	))
}
