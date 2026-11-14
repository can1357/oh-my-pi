mod activity;
mod capture;
mod input;
mod keymap;
pub(crate) mod listener;
mod mpx;
mod toolkit;
mod uinput;
mod wm;

use capture::X11Capture;
use image::RgbaImage;
use input::X11Input;

use super::ax::{AtSpiAx, ElementFocus, TextRoute};
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
		let input = X11Input::new(capture.connection(), capture.root(), None)?;
		let ax = AtSpiAx::new()
			.ok()
			.map(|ax| ax.with_native_windows(Box::new(capture.clone())));
		Ok(Self { capture, input, ax, display_server: std::env::var("DISPLAY").ok() })
	}
}

impl Backend for X11Backend {
	fn capabilities(&mut self) -> DesktopCapabilities {
		let displays = self.capture.displays();
		let watched = self
			.input
			.watch_user()
			.and_then(|activity| activity.sync())
			.is_ok();
		DesktopCapabilities {
			backend: "x11".to_string(),
			display_server: self.display_server.clone(),
			capture: displays.is_ok(),
			input: true,
			ax: self.ax.is_some(),
			background_window_input: true,
			takeover: watched,
			applications: crate::desktop::applications::supported(),
			menus: self.ax.is_some(),
			held_input: true,
			spaces: false,
			global_escape: watched
				&& std::env::var_os("WAYLAND_DISPLAY").is_none()
				&& !std::env::var("XDG_SESSION_TYPE")
					.is_ok_and(|session| session.eq_ignore_ascii_case("wayland")),
			secure_input: false,
			secure_input_app: None,
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

	fn admit_takeover(&mut self) -> CoreResult<()> {
		self.input.admit_takeover()
	}

	fn takeover_admitted(&mut self) -> CoreResult<bool> {
		self.input.takeover_admitted()
	}

	fn capture(
		&mut self,
		target: &Target,
		_caps: &CaptureCaps,
		selector: Option<&DisplaySelector>,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		// Inspection remains available when watching fails; takeover propagates
		// the retained startup error before activation or input.
		let _ = self.input.watch_user();
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

	/// Background text goes in through the element's AT-SPI text interface
	/// first, which needs neither focus nor keys. Background keys go to an
	/// element only when they reach it through its window's keyboard: an
	/// AT-SPI focus request makes GTK and Chromium present the window, which
	/// takes the user's focus.
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
	/// Puts text in through the element's AT-SPI text interface; `Absent`
	/// for a chord.
	fn insert_text(&mut self) -> CoreResult<TextRoute>;
	/// The element's focus state and the toolkit reporting it.
	fn focus_state(&mut self) -> CoreResult<ElementFocus>;
	/// Sends the keys to the element's window in the background.
	fn send_background(&mut self) -> CoreResult<()>;
	/// Takes the element's window over, focuses the element inside the
	/// takeover, and sends the keys.
	fn send_takeover(&mut self) -> CoreResult<()>;
}

/// In the background, text the element takes through its AT-SPI text
/// interface goes no further; otherwise keys go out only to an element that
/// already holds its window's keyboard focus, read without focusing anything.
/// Takeover focuses the element and sends keys.
fn deliver_element_keys(
	window: &str,
	mode: DeliveryMode,
	route: &mut impl ElementKeys,
) -> CoreResult<ElementDelivery> {
	if mode == DeliveryMode::Background {
		let declined = match route.insert_text()? {
			TextRoute::Inserted => return Ok(ElementDelivery::Delivered),
			TextRoute::Absent => None,
			TextRoute::Declined(reason) => Some(reason),
		};
		if let Some(refusal) = background_element_refusal(window, &route.focus_state()?, declined) {
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
	fn insert_text(&mut self) -> CoreResult<TextRoute> {
		let ElementInput::Text(text) = self.keys else {
			return Ok(TextRoute::Absent);
		};
		self.token.check()?;
		self.ax.type_text(self.element, text)
	}

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
/// application does not name is not trusted either. `declined` says why the
/// element's accessibility text route went unused, when it did.
fn background_element_refusal(
	window: &str,
	focus: &ElementFocus,
	declined: Option<&str>,
) -> Option<DesktopError> {
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
	let declined = declined
		.map_or_default(|why| format!("; its accessibility text route was not used, since {why}"));
	Some(DesktopError::background_unavailable(format!(
		"{reason}, and focusing it would bring that window to the front{declined}; no input was sent"
	)))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::desktop::error::ErrorCode;

	/// Records which steps of an element input ran, in order.
	struct Recorder {
		text:    TextRoute,
		focused: bool,
		toolkit: &'static str,
		version: &'static str,
		steps:   Vec<&'static str>,
	}

	impl ElementKeys for Recorder {
		fn insert_text(&mut self) -> CoreResult<TextRoute> {
			self.steps.push("insert text");
			Ok(self.text)
		}

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

	fn deliver_text(
		mode: DeliveryMode,
		text: TextRoute,
		focused: bool,
		toolkit: &'static str,
		version: &'static str,
	) -> (CoreResult<ElementDelivery>, Vec<&'static str>) {
		let mut route = Recorder { text, focused, toolkit, version, steps: Vec::new() };
		(deliver_element_keys("42", mode, &mut route), route.steps)
	}

	fn deliver(
		mode: DeliveryMode,
		focused: bool,
		toolkit: &'static str,
		version: &'static str,
	) -> (CoreResult<ElementDelivery>, Vec<&'static str>) {
		deliver_text(mode, TextRoute::Absent, focused, toolkit, version)
	}

	#[test]
	fn background_text_the_element_takes_needs_no_focus_and_no_keys() {
		// Unfocused, in a toolkit whose focus is not trusted: keys would be
		// refused, and takeover would follow.
		let inserted = TextRoute::Inserted;
		let (delivered, steps) =
			deliver_text(DeliveryMode::Background, inserted, false, "Qt", "6.10.1");
		assert!(matches!(delivered, Ok(ElementDelivery::Delivered)));
		assert_eq!(steps, ["insert text"]);

		// Takeover sends keys, as `takeover: true` asks and as the rerun after a
		// background refusal needs: that attempt already tried the text route.
		let (delivered, steps) =
			deliver_text(DeliveryMode::Foreground, inserted, false, "Qt", "6.10.1");
		assert!(matches!(delivered, Ok(ElementDelivery::Delivered)));
		assert_eq!(steps, ["takeover keys"]);
	}

	#[test]
	fn a_declined_text_route_is_named_in_the_refusal() {
		let declined = TextRoute::Declined("the field would skip its validator");
		let (delivered, steps) =
			deliver_text(DeliveryMode::Background, declined, false, "Qt", "6.10.1");
		let Err(error) = delivered else {
			panic!("a declined element was sent keys")
		};
		assert_eq!(error.code, ErrorCode::BackgroundUnavailable);
		assert!(
			error.message.ends_with(
				"; its accessibility text route was not used, since the field would skip its \
				 validator; no input was sent"
			),
			"{}",
			error.message
		);
		assert_eq!(steps, ["insert text", "read focus"]);
	}

	#[test]
	fn a_declined_unfocused_entry_keeps_the_key_route() {
		let declined = TextRoute::Declined("the field's selection after focusing is unknown");
		let (delivered, steps) =
			deliver_text(DeliveryMode::Background, declined, false, "gtk", "3.24.41");
		let Err(error) = delivered else {
			panic!("an unfocused entry was sent background keys")
		};
		assert_eq!(error.code, ErrorCode::BackgroundUnavailable);
		assert_eq!(steps, ["insert text", "read focus"]);

		let (delivered, steps) =
			deliver_text(DeliveryMode::Foreground, declined, false, "gtk", "3.24.41");
		assert!(matches!(delivered, Ok(ElementDelivery::Delivered)));
		assert_eq!(steps, ["takeover keys"]);
	}

	/// An insert that failed may still have reached the element (a timeout or
	/// a cancel), so no keys follow it: they could type the text twice.
	#[test]
	fn a_failed_text_insert_sends_no_keys() {
		struct Failing(Vec<&'static str>);

		impl ElementKeys for Failing {
			fn insert_text(&mut self) -> CoreResult<TextRoute> {
				self.0.push("insert text");
				Err(crate::desktop::linux::ax::not_answering())
			}

			fn focus_state(&mut self) -> CoreResult<ElementFocus> {
				self.0.push("read focus");
				Ok(ElementFocus {
					focused: true,
					toolkit: "gtk".to_owned(),
					version: "3.24.41".to_owned(),
				})
			}

			fn send_background(&mut self) -> CoreResult<()> {
				self.0.push("background keys");
				Ok(())
			}

			fn send_takeover(&mut self) -> CoreResult<()> {
				self.0.push("takeover keys");
				Ok(())
			}
		}

		let mut route = Failing(Vec::new());
		let Err(error) = deliver_element_keys("42", DeliveryMode::Background, &mut route) else {
			panic!("keys followed a failed insert")
		};
		assert_eq!(error.code, ErrorCode::Timeout);
		assert_eq!(route.0, ["insert text"]);
	}

	#[test]
	fn background_element_keys_go_only_to_a_gtk3_window_focus_widget() {
		let (delivered, steps) = deliver(DeliveryMode::Background, true, "gtk", "3.24.41");
		assert!(matches!(delivered, Ok(ElementDelivery::Delivered)));
		assert_eq!(steps, ["insert text", "read focus", "background keys"]);

		for (focused, toolkit, version) in
			[(false, "gtk", "3.24.41"), (true, "Chromium", "1.0"), (true, "", "")]
		{
			let (delivered, steps) = deliver(DeliveryMode::Background, focused, toolkit, version);
			let Err(error) = delivered else {
				panic!("{toolkit} {version} focused={focused} was sent")
			};
			assert_eq!(error.code, ErrorCode::BackgroundUnavailable);
			assert!(error.message.ends_with("; no input was sent"), "{}", error.message);
			assert_eq!(
				steps,
				["insert text", "read focus"],
				"nothing focused or sent after a refusal"
			);
		}

		for mode in [DeliveryMode::Foreground, DeliveryMode::ForegroundReturnFocus] {
			let (delivered, steps) = deliver(mode, false, "Chromium", "1.0");
			assert!(matches!(delivered, Ok(ElementDelivery::Delivered)));
			assert_eq!(steps, ["takeover keys"]);
		}
	}
}
