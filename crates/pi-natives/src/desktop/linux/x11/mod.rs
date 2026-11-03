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

use super::ax::{AtSpiAx, ElementFocus};
use crate::desktop::{
	ax::AxHandle,
	backend::{AxBackend, Backend, DeliveryMode, ElementDelivery, ElementInput, PointerEvent},
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

	/// Background keys go to an element only when they reach it through its
	/// window's keyboard: an AT-SPI focus request makes GTK and Chromium
	/// present the window, which takes the user's focus.
	fn element_input(
		&mut self,
		element: &AxHandle,
		input: &ElementInput,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<ElementDelivery> {
		let windows = self.windows()?;
		let ax = self.ax.as_mut().ok_or_else(DesktopError::ax_unsupported)?;
		let window = ax.window_id(element, &windows)?;
		if mode == DeliveryMode::Background {
			if let Some(refusal) = background_element_refusal(&window, &ax.element_focus(element)?) {
				return Err(refusal);
			}
		} else {
			ax.focus(element)?;
		}
		let target = Target::Window(window);
		match input {
			ElementInput::Text(text) => self.type_text(&target, text, mode, token)?,
			ElementInput::Chord(keys) => self.key_chord(&target, keys, mode, token)?,
		}
		Ok(ElementDelivery::Delivered)
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend> {
		self.ax.as_mut().map(|ax| ax as &mut dyn AxBackend)
	}
}

/// Why background keys sent to `window` would miss an element reporting
/// `focus`. GTK 3 reports `Focused` only for its window's focus widget
/// (`gtkwidgetaccessible.c`); Chromium reports its page's focused node while
/// the omnibox or another view holds the window's keyboard.
fn background_element_refusal(window: &str, focus: &ElementFocus) -> Option<DesktopError> {
	let gtk3 = focus.toolkit.eq_ignore_ascii_case("gtk") && focus.version.starts_with("3.");
	let reason = if !gtk3 {
		format!(
			"keys sent to window {window} may not reach the element, since its {} toolkit does not \
			 report which element holds the window's keyboard",
			focus.toolkit
		)
	} else if !focus.focused {
		format!("the element does not hold the keyboard focus of window {window}")
	} else {
		return None;
	};
	Some(DesktopError::background_unavailable(format!(
		"{reason}, and focusing it would bring that window to the front; no input was sent"
	)))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::desktop::error::ErrorCode;

	#[test]
	fn background_element_keys_go_only_to_a_gtk3_window_focus_widget() {
		let focus = |focused, toolkit: &str, version: &str| ElementFocus {
			focused,
			toolkit: toolkit.to_owned(),
			version: version.to_owned(),
		};
		assert!(background_element_refusal("42", &focus(true, "gtk", "3.24.41")).is_none());
		for refused in [focus(false, "gtk", "3.24.41"), focus(true, "Chromium", "1.0")] {
			let error = background_element_refusal("42", &refused).expect("refused");
			assert_eq!(error.code, ErrorCode::BackgroundUnavailable);
			assert!(error.message.ends_with("; no input was sent"), "{}", error.message);
		}
	}
}
