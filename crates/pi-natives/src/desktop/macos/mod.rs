mod ax;
mod capture;
mod input;
mod skylight;

use image::RgbaImage;
use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};

use self::{ax::MacAx, capture::MacCapture, input::MacInput};
use super::{
	backend::{AxBackend, Backend, DeliveryMode, PointerEvent},
	error::{CoreResult, DesktopError},
	frame::FrameGeometry,
	keys::KeyName,
	types::{
		CaptureCaps, DesktopCapabilities, DesktopDisplay, DesktopWindow, DisplaySelector, Target,
	},
};

pub struct MacosBackend {
	capture: MacCapture,
	input:   MacInput,
	ax:      MacAx,
}

impl MacosBackend {
	pub(crate) fn new(display: DisplaySelector) -> CoreResult<Self> {
		Ok(Self {
			capture: MacCapture::new(display),
			input:   MacInput::new()?,
			ax:      MacAx::new(),
		})
	}

	fn require_input_permission() -> CoreResult<()> {
		if ax::is_trusted() {
			Ok(())
		} else {
			Err(DesktopError::permission_denied(
				"macOS Accessibility permission is required for native input",
			))
		}
	}
}

impl Backend for MacosBackend {
	fn capabilities(&mut self) -> DesktopCapabilities {
		let capture_permission = capture::capture_permission();
		let input_permission = ax::is_trusted();
		let display_count = if capture_permission {
			self
				.capture
				.displays()
				.map_or(0, |displays| u32::try_from(displays.len()).unwrap_or(u32::MAX))
		} else {
			0
		};
		DesktopCapabilities {
			backend: "quartz".to_string(),
			display_server: Some("Quartz WindowServer".to_string()),
			capture: capture_permission && display_count > 0,
			input: input_permission,
			ax: input_permission,
			background_window_input: input_permission && skylight::is_available(),
			delivery_modes: vec!["background".to_string(), "foreground".to_string()],
			capture_permission: permission_label(capture_permission),
			input_permission: permission_label(input_permission),
			ax_permission: permission_label(input_permission),
			display_count,
		}
	}

	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
		self.capture.displays()
	}

	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
		self.capture.windows()
	}

	fn capture(
		&mut self,
		target: &Target,
		_caps: &CaptureCaps,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		self.capture.capture(target)
	}

	fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		_frame: &FrameGeometry,
		mode: DeliveryMode,
	) -> CoreResult<()> {
		Self::require_input_permission()?;
		self.input.pointer(target, event, mode, &self.capture)
	}

	fn type_text(&mut self, target: &Target, text: &str, mode: DeliveryMode) -> CoreResult<()> {
		Self::require_input_permission()?;
		self.input.type_text(target, text, mode, &self.capture)
	}

	fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
	) -> CoreResult<()> {
		Self::require_input_permission()?;
		self.input.key_chord(target, keys, mode, &self.capture)
	}

	fn raise_window(&mut self, id: &str) -> CoreResult<()> {
		Self::require_input_permission()?;
		let window = self.capture.window(id)?;
		self.ax.raise(&window)?;
		let pid = window.pid.ok_or_else(|| {
			DesktopError::input_failed(format!("window {id} has no owning process id"))
		})?;
		let pid = i32::try_from(pid).map_err(|_| {
			DesktopError::input_failed(format!("window {id} has an invalid process id"))
		})?;
		let app =
			NSRunningApplication::runningApplicationWithProcessIdentifier(pid).ok_or_else(|| {
				DesktopError::window_not_found(format!(
					"application for window '{id}' is no longer running"
				))
			})?;
		if !app.activateWithOptions(NSApplicationActivationOptions::empty()) {
			return Err(DesktopError::input_failed(format!(
				"activation request for window '{id}' was rejected"
			)));
		}
		Ok(())
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend> {
		Some(&mut self.ax)
	}
}

fn permission_label(granted: bool) -> String {
	if granted {
		"granted".to_string()
	} else {
		"denied".to_string()
	}
}
