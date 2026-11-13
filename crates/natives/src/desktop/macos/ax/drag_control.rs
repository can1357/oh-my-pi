//! The control a background drag presses first, read before and after the
//! drag so a drag that moved nothing is not reported as done.

use objc2_application_services::AXUIElement;
use objc2_core_foundation::{CFNumber, CFRetained};

use super::{
	AxBounds, TextSurface, bounds, copy_attribute, copy_element, copy_elements, copy_string,
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

	/// Signed distance from the thumb's centre to the release, clamped to
	/// the track. Positive means an increment moves toward the release.
	pub(crate) fn distance_to(&self, x: f64, y: f64) -> Option<f64> {
		let frame = self.steps?;
		let thumb = copy_elements(&self.element, "AXChildren")
			.ok()?
			.into_iter()
			.find(|child| copy_string(child, "AXRole").as_deref() == Some("AXValueIndicator"))?;
		let thumb = bounds(&thumb)?;
		thumb_distance(frame, thumb, self.vertical, x, y)
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

fn thumb_distance(frame: AxBounds, thumb: AxBounds, vertical: bool, x: f64, y: f64) -> Option<f64> {
	let (start, length, centre, half, end) = if vertical {
		(frame.y, frame.height, thumb.y + thumb.height / 2.0, thumb.height / 2.0, y)
	} else {
		(frame.x, frame.width, thumb.x + thumb.width / 2.0, thumb.width / 2.0, x)
	};
	if length <= 2.0 * half {
		return None;
	}
	let distance = end.clamp(start + half, start + length - half) - centre;
	Some(if vertical { -distance } else { distance })
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_slider_path_past_the_track_finishes_at_its_limit() {
		let frame = AxBounds { x: 0.0, y: 0.0, width: 100.0, height: 16.0 };
		let thumb = AxBounds { x: 90.0, y: 0.0, width: 10.0, height: 16.0 };
		assert_eq!(thumb_distance(frame, thumb, false, 150.0, 8.0), Some(0.0));
	}
}
