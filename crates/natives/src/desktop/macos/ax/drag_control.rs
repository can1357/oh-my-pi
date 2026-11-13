//! The control a background drag presses first, read before and after the
//! drag so a drag that moved nothing is not reported as done.

use objc2_application_services::AXUIElement;
use objc2_core_foundation::{CFNumber, CFRetained};

use super::{
	AxBounds, TextSurface, bounds, copy_attribute, copy_element, copy_string,
	copy_strings_from_action_names, open_menu::hit_test, perform_action, probe_application,
	text_surface,
};
use crate::desktop::error::CoreResult;

/// The element of `pid` at global point `(x, y)`, where a background drag
/// presses.
pub(crate) struct Pressed {
	element: CFRetained<AXUIElement>,
	role:    Option<String>,
}

pub(crate) fn pressed_at(pid: libc::pid_t, x: f64, y: f64) -> Option<Pressed> {
	let app = probe_application(pid)?;
	let element = hit_test(&app, x, y)?;
	let role = copy_string(&element, "AXRole");
	Some(Pressed { element, role })
}

impl Pressed {
	/// The control whose value the press moves, and that value: the element
	/// itself, or for a value indicator (a slider's knob, a scroll bar's
	/// thumb) its control. `None` when it publishes no numeric `AXValue`.
	pub(crate) fn control(&self) -> Option<(Control, f64)> {
		let element = if self.role.as_deref() == Some("AXValueIndicator") {
			copy_element(&self.element, "AXParent")?
		} else {
			self.element.clone()
		};
		let value = number(&element, "AXValue")?;
		let role = copy_string(&element, "AXRole")?;
		// A scroll bar's value is the fraction scrolled, 0 to 1.
		let range = number(&element, "AXMinValue")
			.zip(number(&element, "AXMaxValue"))
			.or_else(|| (role == "AXScrollBar").then_some((0.0, 1.0)));
		let vertical =
			copy_string(&element, "AXOrientation").as_deref() == Some("AXVerticalOrientation");
		let steps = (role == "AXSlider" && text_surface(&element) == TextSurface::Web)
			.then(|| {
				let actions = copy_strings_from_action_names(&element).ok()?;
				let steps = ["AXIncrement", "AXDecrement"]
					.iter()
					.all(|action| actions.iter().any(|name| name == action));
				steps.then(|| bounds(&element)).flatten()
			})
			.flatten();
		Some((Control { element, role, range, vertical, steps }, value))
	}
}

/// A control that tracks a drag itself and publishes its position as a
/// number: a slider, a scroll bar, a splitter.
pub(crate) struct Control {
	element:             CFRetained<AXUIElement>,
	pub(crate) role:     String,
	/// `AXMinValue` and `AXMaxValue`, when it publishes both.
	pub(crate) range:    Option<(f64, f64)>,
	pub(crate) vertical: bool,
	/// For a slider a web page draws that takes `AXIncrement` and
	/// `AXDecrement`, its frame: a page may take none of a background drag's
	/// moves, so a drag that leaves it short is stepped on.
	pub(crate) steps:    Option<AxBounds>,
}

impl Control {
	pub(crate) fn value(&self) -> Option<f64> {
		number(&self.element, "AXValue")
	}

	/// Moves the control one step up (`AXIncrement`) or down (`AXDecrement`).
	pub(crate) fn step(&self, up: bool) -> CoreResult<()> {
		perform_action(&self.element, if up { "AXIncrement" } else { "AXDecrement" })
	}

	/// Whether a pointer moving by `(dx, dy)` moves the control toward its
	/// maximum: rightward on a horizontal slider or scroll bar, up on a
	/// vertical slider (its maximum is at the top), down on a vertical scroll
	/// bar. `None` for any other control (a splitter, a stepper), whose
	/// direction its orientation does not tell.
	pub(crate) fn toward_max(&self, dx: f64, dy: f64) -> Option<bool> {
		match (self.role.as_str(), self.vertical) {
			("AXSlider" | "AXScrollBar", false) => Some(dx > 0.0),
			("AXSlider", true) => Some(dy < 0.0),
			("AXScrollBar", true) => Some(dy > 0.0),
			_ => None,
		}
	}
}

fn number(element: &AXUIElement, attribute: &str) -> Option<f64> {
	copy_attribute(element, attribute)?
		.downcast::<CFNumber>()
		.ok()?
		.as_f64()
		.filter(|value| value.is_finite())
}
