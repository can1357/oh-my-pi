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
		let mut route = X11ElementKeys {
			ax,
			input: &mut self.input,
			element,
			window: &window,
			keys: input,
			token,
		};
		deliver_element_keys(&window, mode, &mut route)
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend> {
		self.ax.as_mut().map(|ax| ax as &mut dyn AxBackend)
	}
}

/// The steps of keyboard input addressed to an element, apart so their order
/// is testable without an X server.
trait ElementKeys {
	/// The element's focus state and the toolkit reporting it.
	fn focus_state(&mut self) -> CoreResult<ElementFocus>;
	/// Sends the keys to the element's window in the background.
	fn send_background(&mut self) -> CoreResult<()>;
	/// Takes the element's window over, focuses the element inside the
	/// takeover, and sends the keys.
	fn send_takeover(&mut self) -> CoreResult<()>;
}

/// Background keys go out only to an element that already holds its window's
/// keyboard focus, read without focusing anything; takeover focuses it.
fn deliver_element_keys(
	window: &str,
	mode: DeliveryMode,
	route: &mut impl ElementKeys,
) -> CoreResult<ElementDelivery> {
	if mode == DeliveryMode::Background {
		if let Some(refusal) = background_element_refusal(window, &route.focus_state()?) {
			return Err(refusal);
		}
		route.send_background()?;
	} else {
		route.send_takeover()?;
	}
	Ok(ElementDelivery::Delivered)
}

struct X11ElementKeys<'a> {
	ax:      &'a mut AtSpiAx,
	input:   &'a mut X11Input,
	element: &'a AxHandle,
	window:  &'a str,
	keys:    &'a ElementInput,
	token:   &'a OperationToken,
}

impl ElementKeys for X11ElementKeys<'_> {
	fn focus_state(&mut self) -> CoreResult<ElementFocus> {
		self.ax.element_focus(self.element)
	}

	fn send_background(&mut self) -> CoreResult<()> {
		self.token.check()?;
		let target = Target::Window(self.window.to_owned());
		match self.keys {
			ElementInput::Text(text) => self
				.input
				.type_text(&target, text, DeliveryMode::Background),
			ElementInput::Chord(keys) => self
				.input
				.key_chord(&target, keys, DeliveryMode::Background),
		}
	}

	fn send_takeover(&mut self) -> CoreResult<()> {
		self.token.check()?;
		let window = self.window.parse::<u32>().map_err(|_| {
			DesktopError::window_not_found(format!("invalid X11 window id {}", self.window))
		})?;
		let Self { ax, input, element, keys, .. } = self;
		// The focus request may activate the window, so it runs after the
		// takeover has recorded the user's window to hand back to.
		input.foreground_keys_after(window, keys, || ax.focus(element))
	}
}

/// Why background keys sent to `window` would miss an element reporting
/// `focus`. GTK 3 reports `Focused` only for its window's focus widget
/// (`gtkwidgetaccessible.c`); Chromium reports its page's focused node while
/// the omnibox or another view holds the window's keyboard. A toolkit the
/// application does not name is not trusted either.
fn background_element_refusal(window: &str, focus: &ElementFocus) -> Option<DesktopError> {
	let gtk3 = focus.toolkit.eq_ignore_ascii_case("gtk") && focus.version.starts_with("3.");
	let reason = if !gtk3 {
		let toolkit = if focus.toolkit.is_empty() {
			"unidentified"
		} else {
			&focus.toolkit
		};
		format!(
			"keys sent to window {window} may not reach the element, since its {toolkit} toolkit \
			 does not report which element holds the window's keyboard"
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

	/// Records which steps of an element input ran, in order.
	struct Recorder {
		focused: bool,
		toolkit: &'static str,
		version: &'static str,
		steps:   Vec<&'static str>,
	}

	impl ElementKeys for Recorder {
		fn focus_state(&mut self) -> CoreResult<ElementFocus> {
			self.steps.push("read focus");
			Ok(ElementFocus {
				focused: self.focused,
				toolkit: self.toolkit.to_owned(),
				version: self.version.to_owned(),
			})
		}

		fn send_background(&mut self) -> CoreResult<()> {
			self.steps.push("background keys");
			Ok(())
		}

		fn send_takeover(&mut self) -> CoreResult<()> {
			self.steps.push("takeover keys");
			Ok(())
		}
	}

	fn deliver(
		mode: DeliveryMode,
		focused: bool,
		toolkit: &'static str,
		version: &'static str,
	) -> (CoreResult<ElementDelivery>, Vec<&'static str>) {
		let mut route = Recorder { focused, toolkit, version, steps: Vec::new() };
		(deliver_element_keys("42", mode, &mut route), route.steps)
	}

	#[test]
	fn background_element_keys_go_only_to_a_gtk3_window_focus_widget() {
		let (delivered, steps) = deliver(DeliveryMode::Background, true, "gtk", "3.24.41");
		assert!(matches!(delivered, Ok(ElementDelivery::Delivered)));
		assert_eq!(steps, ["read focus", "background keys"]);

		for (focused, toolkit, version) in
			[(false, "gtk", "3.24.41"), (true, "Chromium", "1.0"), (true, "", "")]
		{
			let (delivered, steps) = deliver(DeliveryMode::Background, focused, toolkit, version);
			let Err(error) = delivered else {
				panic!("{toolkit} {version} focused={focused} was sent")
			};
			assert_eq!(error.code, ErrorCode::BackgroundUnavailable);
			assert!(error.message.ends_with("; no input was sent"), "{}", error.message);
			assert_eq!(steps, ["read focus"], "nothing focused or sent after a refusal");
		}

		for mode in [DeliveryMode::Foreground, DeliveryMode::ForegroundReturnFocus] {
			let (delivered, steps) = deliver(mode, false, "Chromium", "1.0");
			assert!(matches!(delivered, Ok(ElementDelivery::Delivered)));
			assert_eq!(steps, ["takeover keys"]);
		}
	}
}
