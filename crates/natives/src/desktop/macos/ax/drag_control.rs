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
	pub(crate) fn role(&self) -> Option<&str> {
		self.role.as_deref()
	}

	/// The control whose value the press moves, and that value: the element
	/// itself, or for a value indicator (a slider's knob, a scroll bar's
	/// thumb) its control. `None` unless it is a slider or scroll bar
	/// ([`tracked`]) publishing a numeric `AXValue`.
	pub(crate) fn control(&self) -> Option<(Control, f64)> {
		let element = if self.role.as_deref() == Some("AXValueIndicator") {
			copy_element(&self.element, "AXParent")?
		} else {
			self.element.clone()
		};
		tracked(copy_string(&element, "AXRole"), |role| {
			let value = number(&element, "AXValue")?;
			// A scroll bar's value is the fraction scrolled, 0 to 1.
			let range = number(&element, "AXMinValue")
				.zip(number(&element, "AXMaxValue"))
				.or_else(|| (role == "AXScrollBar").then_some((0.0, 1.0)));
			let vertical =
				copy_string(&element, "AXOrientation").as_deref() == Some("AXVerticalOrientation");
			let web = text_surface(&element) == TextSurface::Web;
			let steps = (role == "AXSlider" && web)
				.then(|| {
					let actions = copy_strings_from_action_names(&element).ok()?;
					let steps = ["AXIncrement", "AXDecrement"]
						.iter()
						.all(|action| actions.iter().any(|name| name == action));
					steps.then(|| bounds(&element)).flatten()
				})
				.flatten();
			let frame = (!web).then(|| bounds(&element)).flatten();
			Some((Control { element, role, range, vertical, frame, steps }, value))
		})
	}
}

/// Runs `read` on a slider or scroll bar only, before any of its values is
/// read. A drag from a checkbox, radio button or stepper need not change its
/// value (a row reorder, a segmented control), and a splitter publishes no
/// range, so one held at its stop cannot be told from one that ignored the
/// drag.
fn tracked<T>(role: Option<String>, read: impl FnOnce(String) -> Option<T>) -> Option<T> {
	role
		.filter(|role| matches!(role.as_str(), "AXSlider" | "AXScrollBar"))
		.and_then(read)
}

/// A control that tracks a drag itself and publishes its position as a
/// number: a slider or a scroll bar.
pub(crate) struct Control {
	element:             CFRetained<AXUIElement>,
	pub(crate) role:     String,
	/// `AXMinValue` and `AXMaxValue`, when it publishes both.
	pub(crate) range:    Option<(f64, f64)>,
	pub(crate) vertical: bool,
	/// A native control's frame, whose scale follows its orientation.
	pub(crate) frame:    Option<AxBounds>,
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

	/// Where a press on this web slider's track stands for a release at
	/// `(x, y)`: the point moved inside its frame along the track and to the
	/// middle across it, when the slider itself (or its thumb) is what `pid`
	/// hit-tests there. The hit test also [publishes](Self::publish) the
	/// slider's value.
	pub(crate) fn track_point(&self, pid: libc::pid_t, x: f64, y: f64) -> Option<(f64, f64)> {
		let at = track_point(self.steps?, self.vertical, x, y)?;
		let hit = pressed_at(pid, at.0, at.1)?;
		let hit = if hit.role() == Some("AXValueIndicator") {
			copy_element(&hit.element, "AXParent")?
		} else {
			hit.element
		};
		(*hit == *self.element).then_some(at)
	}

	/// Hit-tests `pid` at `(x, y)`, on this slider, so Chromium publishes its
	/// value. On macOS 26.5, Chrome 154 and Electron 33 kept the `AXValue` a
	/// range input had before a background drag or press changed it until an
	/// accessibility hit test reached the slider, then published the page's
	/// value within 300 ms (21/21); a hit test elsewhere in the page did not
	/// (0/6), nor did waiting 2 s, hovering, focusing it or `AXScrollToVisible`.
	pub(crate) fn publish(pid: libc::pid_t, x: f64, y: f64) {
		pressed_at(pid, x, y);
	}

	/// Movement along the control's track; perpendicular motion cannot move it.
	pub(crate) const fn movement(&self, dx: f64, dy: f64) -> f64 {
		if self.vertical { dy.abs() } else { dx.abs() }
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

/// `(x, y)` clamped a pixel inside `frame` along its track, and at the
/// middle of the frame across it; `None` for a frame too short to press.
fn track_point(frame: AxBounds, vertical: bool, x: f64, y: f64) -> Option<(f64, f64)> {
	let (start, length) = if vertical {
		(frame.y, frame.height)
	} else {
		(frame.x, frame.width)
	};
	if length <= 2.0 {
		return None;
	}
	let along = if vertical { y } else { x }.clamp(start + 1.0, start + length - 1.0);
	Some(if vertical {
		(frame.x + frame.width / 2.0, along)
	} else {
		(along, frame.y + frame.height / 2.0)
	})
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

	#[test]
	fn a_press_for_a_release_past_the_track_lands_just_inside_its_end() {
		let frame = AxBounds { x: 10.0, y: 20.0, width: 300.0, height: 22.0 };
		assert_eq!(track_point(frame, false, 400.0, 90.0), Some((309.0, 31.0)));
		assert_eq!(track_point(frame, false, 160.0, 25.0), Some((160.0, 31.0)));
		let column = AxBounds { x: 10.0, y: 20.0, width: 22.0, height: 180.0 };
		assert_eq!(track_point(column, true, 0.0, -5.0), Some((21.0, 21.0)));
		assert_eq!(
			track_point(AxBounds { x: 0.0, y: 0.0, width: 2.0, height: 9.0 }, false, 1.0, 1.0),
			None
		);
	}

	#[test]
	fn a_drag_from_a_checkbox_or_splitter_tracks_nothing_and_reads_no_value() {
		// A row reorder from a checkbox leaves its value as it was, and a
		// splitter dragged against its stop does not move: neither drag is
		// judged, so it returns done whatever its value reads.
		for role in ["AXCheckBox", "AXSplitter"] {
			let read = tracked(Some(role.to_string()), |_| -> Option<()> { panic!("{role} read") });
			assert!(read.is_none(), "{role}");
		}
		for role in ["AXSlider", "AXScrollBar"] {
			assert_eq!(tracked(Some(role.to_string()), Some).as_deref(), Some(role));
		}
	}
}
