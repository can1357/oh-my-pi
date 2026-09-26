//! Win32 uses physical desktop pixels end-to-end. Monitor DPI scale is
//! metadata, not a transform of the global coordinate origin or capture atlas.

use super::super::{
	error::{CoreResult, DesktopError},
	frame::MAX_COMPOSITE_PIXELS,
	types::DesktopDisplay,
};

#[derive(Debug)]
pub(super) struct PhysicalLayout {
	left: i32,
	top: i32,
	pub(super) width: u32,
	pub(super) height: u32,
}

impl PhysicalLayout {
	pub(super) fn new<'a>(displays: impl Iterator<Item = &'a DesktopDisplay>) -> CoreResult<Self> {
		let mut left = i32::MAX;
		let mut top = i32::MAX;
		let mut right = i64::MIN;
		let mut bottom = i64::MIN;
		for display in displays {
			if display.width == 0 || display.height == 0 {
				return Err(DesktopError::capture_failed("Win32 returned an empty display rectangle"));
			}
			left = left.min(display.x);
			top = top.min(display.y);
			right = right.max(i64::from(display.x) + i64::from(display.width));
			bottom = bottom.max(i64::from(display.y) + i64::from(display.height));
		}
		if right == i64::MIN {
			return Err(DesktopError::capture_failed("Win32 reported no active displays"));
		}
		let width = u32::try_from(right - i64::from(left))
			.map_err(|_| DesktopError::capture_failed("Win32 desktop width exceeds the native range"))?;
		let height = u32::try_from(bottom - i64::from(top))
			.map_err(|_| DesktopError::capture_failed("Win32 desktop height exceeds the native range"))?;
		if u64::from(width) * u64::from(height) > MAX_COMPOSITE_PIXELS {
			return Err(DesktopError::capture_failed(format!(
				"Win32 composite {width}x{height} exceeds the native safety limit"
			)));
		}
		Ok(Self { left, top, width, height })
	}

	/// Places a display from the same enumeration in the normalized atlas.
	pub(super) fn place(&self, display: &mut DesktopDisplay) {
		// Layout construction validated the complete bounding box before any
		// image allocation. Subtract in i64 to support negative desktop origins.
		display.pixel_x = (i64::from(display.x) - i64::from(self.left)) as u32;
		display.pixel_y = (i64::from(display.y) - i64::from(self.top)) as u32;
		display.pixel_width = display.width;
		display.pixel_height = display.height;
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::desktop::frame::FrameGeometry;

	fn display(x: i32, y: i32, width: u32, height: u32, scale: f64) -> DesktopDisplay {
		DesktopDisplay {
			id: format!("{x},{y}"),
			name: String::new(),
			x,
			y,
			width,
			height,
			scale,
			pixel_x: 0,
			pixel_y: 0,
			pixel_width: 0,
			pixel_height: 0,
			is_primary: x == 0 && y == 0,
		}
	}

	#[test]
	fn adjacent_mixed_dpi_monitors_do_not_overlap_or_rescale() {
		let mut displays = [
			display(0, 0, 1920, 1080, 1.0),
			display(1920, 0, 3840, 2160, 2.0),
		];
		let layout = PhysicalLayout::new(displays.iter()).unwrap();
		for display in &mut displays {
			layout.place(display);
		}
		assert_eq!((layout.width, layout.height), (5760, 2160));
		assert_eq!(displays[0].pixel_x + displays[0].pixel_width, displays[1].pixel_x);
		let frame = FrameGeometry::for_displays(&displays);
		assert_eq!(frame.map_point(1919.0, 500.0, None).unwrap(), (1919.0, 500.0));
		assert_eq!(frame.map_point(1920.0, 500.0, None).unwrap(), (1920.0, 500.0));
		assert_eq!(frame.map_point(5000.0, 1800.0, None).unwrap(), (5000.0, 1800.0));
	}

	#[test]
	fn negative_monitor_origins_round_trip_from_normalized_capture_pixels() {
		let mut displays = [
			display(-2560, -200, 2560, 1440, 2.0),
			display(0, 0, 1920, 1080, 1.0),
		];
		let layout = PhysicalLayout::new(displays.iter()).unwrap();
		for display in &mut displays {
			layout.place(display);
		}
		assert_eq!((layout.width, layout.height), (4480, 1440));
		let frame = FrameGeometry::for_displays(&displays);
		assert_eq!(frame.map_point(100.0, 100.0, None).unwrap(), (-2460.0, -100.0));
		assert_eq!(frame.map_point(2660.0, 400.0, None).unwrap(), (100.0, 200.0));
		assert!(frame.map_point(3000.0, 100.0, None).is_err());
	}
}
