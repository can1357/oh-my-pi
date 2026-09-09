#[cfg(target_os = "windows")]
mod ax;
#[cfg(target_os = "windows")]
mod capture;
pub mod delivery;
#[cfg(target_os = "windows")]
mod input;

#[cfg(target_os = "windows")]
use enigo::Enigo;
#[cfg(target_os = "windows")]
use image::RgbaImage;

#[cfg(target_os = "windows")]
use self::ax::Win32Ax;
#[cfg(target_os = "windows")]
use super::backend::{AxBackend, Backend, DeliveryMode, PointerEvent};
#[cfg(target_os = "windows")]
use super::error::CoreResult;
#[cfg(target_os = "windows")]
use super::frame::FrameGeometry;
#[cfg(target_os = "windows")]
use super::keys::KeyName;
#[cfg(target_os = "windows")]
use super::types::{
	CaptureCaps, DesktopCapabilities, DesktopDisplay, DesktopWindow, DisplaySelector, Target,
};

#[cfg(target_os = "windows")]
pub(crate) struct Win32Backend {
	display:      DisplaySelector,
	global_input: Enigo,
	ax:           Win32Ax,
}

#[cfg(target_os = "windows")]
impl Win32Backend {
	pub(crate) fn new(display: DisplaySelector) -> CoreResult<Self> {
		// Initialize DPI awareness before xcap or input observes desktop geometry,
		// keeping both APIs in the same per-monitor physical coordinate regime.
		let global_input = input::create_global_input()?;
		let _ = capture::displays(&display)?;
		Ok(Self { display, global_input, ax: Win32Ax::new() })
	}
}

#[cfg(target_os = "windows")]
impl Backend for Win32Backend {
	fn capabilities(&mut self) -> DesktopCapabilities {
		let display_count = capture::displays(&self.display)
			.map_or(0, |displays| displays.len().min(u32::MAX as usize) as u32);
		DesktopCapabilities {
			backend: "win32".to_string(),
			display_server: Some("win32".to_string()),
			capture: display_count > 0,
			input: true,
			ax: true,
			background_window_input: true,
			delivery_modes: vec!["background".to_string(), "foreground".to_string()],
			capture_permission: if display_count > 0 {
				"granted"
			} else {
				"unknown"
			}
			.to_string(),
			input_permission: "granted".to_string(),
			ax_permission: "granted".to_string(),
			display_count,
		}
	}

	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
		capture::displays(&self.display)
	}

	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
		capture::windows()
	}

	fn capture(
		&mut self,
		target: &Target,
		_caps: &CaptureCaps,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		capture::capture(&self.display, target)
	}

	fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		_frame: &FrameGeometry,
		mode: DeliveryMode,
	) -> CoreResult<()> {
		input::pointer(&mut self.global_input, target, event, mode)
	}

	fn type_text(&mut self, target: &Target, text: &str, mode: DeliveryMode) -> CoreResult<()> {
		input::type_text(&mut self.global_input, target, text, mode)
	}

	fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
	) -> CoreResult<()> {
		input::key_chord(&mut self.global_input, target, keys, mode)
	}

	fn raise_window(&mut self, id: &str) -> CoreResult<()> {
		input::raise_window(id)
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend> {
		Some(&mut self.ax)
	}
}
