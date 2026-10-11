mod capture;
mod input;
mod keymap;
mod mpx;
mod toolkit;
mod uinput;
mod wm;

use capture::X11Capture;
use image::RgbaImage;
use input::X11Input;

use super::ax::AtSpiAx;
use crate::desktop::{
	backend::{AxBackend, Backend, DeliveryMode, PointerEvent},
	control::OperationToken,
	error::{CoreResult, DesktopError},
	frame::FrameGeometry,
	keys::KeyName,
	types::{
		CaptureCaps, DesktopCapabilities, DesktopDisplay, DesktopWindow, DisplaySelector, Target,
	},
};

pub struct X11Backend {
	capture:        X11Capture,
	input:          X11Input,
	ax:             Option<AtSpiAx>,
	display_server: Option<String>,
}

impl X11Backend {
	pub(crate) fn new(display: DisplaySelector) -> CoreResult<Self> {
		let capture = X11Capture::new(display)?;
		let input = X11Input::new(capture.connection(), capture.root())?;
		let ax = AtSpiAx::new().ok();
		Ok(Self { capture, input, ax, display_server: std::env::var("DISPLAY").ok() })
	}
}

impl Backend for X11Backend {
	fn capabilities(&mut self) -> DesktopCapabilities {
		let displays = self.capture.displays();
		DesktopCapabilities {
			backend: "x11".to_string(),
			display_server: self.display_server.clone(),
			capture: displays.is_ok(),
			input: true,
			ax: self.ax.is_some(),
			background_window_input: true,
			takeover: true,
			applications: crate::desktop::applications::supported(),
			menus: self.ax.is_some(),
			held_input: true,
			spaces: false,
			global_escape: std::env::var_os("WAYLAND_DISPLAY").is_none()
				&& !std::env::var("XDG_SESSION_TYPE")
					.is_ok_and(|session| session.eq_ignore_ascii_case("wayland")),
			capture_permission: if displays.is_ok() {
				"granted"
			} else {
				"unavailable"
			}
			.to_string(),
			input_permission: "granted".to_string(),
			ax_permission: if self.ax.is_some() {
				"granted"
			} else {
				"unavailable"
			}
			.to_string(),
			display_count: displays.map_or(0, |items| u32::try_from(items.len()).unwrap_or(u32::MAX)),
			screen_locked: false,
			display_asleep: false,
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
		selector: Option<&DisplaySelector>,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		self.capture.capture(target, selector)
	}

	fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		_frame: &FrameGeometry,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		self.input.pointer(target, event, mode)
	}

	fn type_text(
		&mut self,
		target: &Target,
		text: &str,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		self.input.type_text(target, text, mode)
	}

	fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		self.input.key_chord(target, keys, mode)
	}

	fn hold_keys(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		duration: std::time::Duration,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		self.input.hold_keys(target, keys, duration, mode)
	}

	fn menu_items(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
	) -> CoreResult<Vec<crate::desktop::menus::DesktopMenuItem>> {
		super::menus::items(window, path)
	}

	fn menu_select(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		super::menus::select(window, path)
	}

	fn raise_window(&mut self, id: &str, token: &OperationToken) -> CoreResult<()> {
		token.check()?;
		let window = id
			.parse::<u32>()
			.map_err(|_| DesktopError::window_not_found(format!("invalid X11 window id {id}")))?;
		self.input.raise_window(window)
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend> {
		self.ax.as_mut().map(|ax| ax as &mut dyn AxBackend)
	}
}
