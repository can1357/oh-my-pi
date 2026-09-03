use std::io::Cursor;

use image::{DynamicImage, ImageFormat, RgbaImage, imageops::FilterType};

use super::{
	error::{CoreResult, DesktopError},
	types::{CaptureCaps, DesktopDisplay, DesktopWindow},
};

pub const MAX_COMPOSITE_PIXELS: u64 = 268_435_456;

#[derive(Debug, Clone, PartialEq)]
struct FrameRegion {
	x:            f64,
	y:            f64,
	width:        f64,
	height:       f64,
	pixel_x:      f64,
	pixel_y:      f64,
	pixel_width:  f64,
	pixel_height: f64,
}

#[derive(Debug, Clone, PartialEq)]
enum FrameKind {
	Desktop,
	Window { captured_width: u32, captured_height: u32 },
	Identity,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FrameGeometry {
	width:   u32,
	height:  u32,
	regions: Vec<FrameRegion>,
	kind:    FrameKind,
}

impl FrameGeometry {
	pub(crate) fn for_displays(displays: &[DesktopDisplay]) -> Self {
		let width = displays
			.iter()
			.map(|d| d.pixel_x.saturating_add(d.pixel_width))
			.max()
			.unwrap_or(0);
		let height = displays
			.iter()
			.map(|d| d.pixel_y.saturating_add(d.pixel_height))
			.max()
			.unwrap_or(0);
		let regions = displays
			.iter()
			.map(|d| FrameRegion {
				x:            f64::from(d.x),
				y:            f64::from(d.y),
				width:        f64::from(d.width),
				height:       f64::from(d.height),
				pixel_x:      f64::from(d.pixel_x),
				pixel_y:      f64::from(d.pixel_y),
				pixel_width:  f64::from(d.pixel_width),
				pixel_height: f64::from(d.pixel_height),
			})
			.collect();
		Self { width, height, regions, kind: FrameKind::Desktop }
	}

	pub(crate) fn for_window(window: &DesktopWindow, px_width: u32, px_height: u32) -> Self {
		Self {
			width:   px_width,
			height:  px_height,
			regions: vec![FrameRegion {
				x:            f64::from(window.x),
				y:            f64::from(window.y),
				width:        f64::from(window.width),
				height:       f64::from(window.height),
				pixel_x:      0.0,
				pixel_y:      0.0,
				pixel_width:  f64::from(px_width),
				pixel_height: f64::from(px_height),
			}],
			kind:    FrameKind::Window {
				captured_width:  window.width,
				captured_height: window.height,
			},
		}
	}

	pub(crate) const fn identity_global() -> Self {
		Self {
			width:   u32::MAX,
			height:  u32::MAX,
			regions: Vec::new(),
			kind:    FrameKind::Identity,
		}
	}

	pub(crate) fn map_point(
		&self,
		x: f64,
		y: f64,
		current_window: Option<&DesktopWindow>,
	) -> CoreResult<(f64, f64)> {
		if !x.is_finite()
			|| !y.is_finite()
			|| x < 0.0
			|| y < 0.0
			|| x >= f64::from(self.width)
			|| y >= f64::from(self.height)
		{
			return Err(DesktopError::invalid_coordinate_frame(format!(
				"coordinate ({x}, {y}) is outside the last capture frame ({}x{} px); pointer/hit-test \
				 coordinates are pixels in the most recent screenshot of this target",
				self.width, self.height
			)));
		}
		if self.kind == FrameKind::Identity {
			return Ok((x, y));
		}
		let region = self
			.regions
			.iter()
			.find(|r| {
				x >= r.pixel_x
					&& x < r.pixel_x + r.pixel_width
					&& y >= r.pixel_y
					&& y < r.pixel_y + r.pixel_height
			})
			.ok_or_else(|| {
				DesktopError::invalid_coordinate_frame(format!(
					"capture coordinate ({x}, {y}) falls between display regions; pick a point inside \
					 one display"
				))
			})?;
		let local_x = (x - region.pixel_x) * region.width / region.pixel_width;
		let local_y = (y - region.pixel_y) * region.height / region.pixel_height;
		match self.kind {
			FrameKind::Window { captured_width, captured_height } => {
				let current = current_window.ok_or_else(|| {
					DesktopError::window_not_found("target window is no longer available")
				})?;
				if current.width != captured_width || current.height != captured_height {
					return Err(DesktopError::invalid_coordinate_frame(
						"target window was resized since capture; capture it again before coordinate \
						 input",
					));
				}
				Ok((f64::from(current.x) + local_x, f64::from(current.y) + local_y))
			},
			FrameKind::Desktop => Ok((region.x + local_x, region.y + local_y)),
			FrameKind::Identity => Ok((x, y)),
		}
	}

	fn scaled(&mut self, ratio_x: f64, ratio_y: f64, width: u32, height: u32) {
		for region in &mut self.regions {
			region.pixel_x *= ratio_x;
			region.pixel_width *= ratio_x;
			region.pixel_y *= ratio_y;
			region.pixel_height *= ratio_y;
		}
		self.width = width;
		self.height = height;
	}

	pub(crate) fn display_metadata(&self, source: &[DesktopDisplay]) -> Vec<DesktopDisplay> {
		source
			.iter()
			.zip(&self.regions)
			.map(|(display, region)| DesktopDisplay {
				id:           display.id.clone(),
				name:         display.name.clone(),
				x:            display.x,
				y:            display.y,
				width:        display.width,
				height:       display.height,
				scale:        display.scale,
				pixel_x:      region.pixel_x.round() as u32,
				pixel_y:      region.pixel_y.round() as u32,
				pixel_width:  region.pixel_width.round().max(1.0) as u32,
				pixel_height: region.pixel_height.round().max(1.0) as u32,
				is_primary:   display.is_primary,
			})
			.collect()
	}
}

pub fn apply_capture_caps(
	mut image: RgbaImage,
	geometry: &mut FrameGeometry,
	caps: &CaptureCaps,
) -> CoreResult<RgbaImage> {
	if image.width() == 0 || image.height() == 0 {
		return Err(DesktopError::capture_failed("capture returned an empty image"));
	}
	if caps.max_width == Some(0) || caps.max_height == Some(0) {
		return Err(DesktopError::invalid_target("capture caps must be greater than zero"));
	}
	let mut ratio = 1.0f64;
	if let Some(max_width) = caps.max_width {
		ratio = ratio.min(f64::from(max_width) / f64::from(image.width()));
	}
	if let Some(max_height) = caps.max_height {
		ratio = ratio.min(f64::from(max_height) / f64::from(image.height()));
	}
	let width = (f64::from(image.width()) * ratio).round().max(1.0) as u32;
	let height = (f64::from(image.height()) * ratio).round().max(1.0) as u32;
	if u64::from(width) * u64::from(height) > MAX_COMPOSITE_PIXELS {
		return Err(DesktopError::capture_failed(format!(
			"composite {width}x{height} exceeds the native safety limit"
		)));
	}
	if width != image.width() || height != image.height() {
		let ratio_x = f64::from(width) / f64::from(image.width());
		let ratio_y = f64::from(height) / f64::from(image.height());
		image = image::imageops::resize(&image, width, height, FilterType::Triangle);
		geometry.scaled(ratio_x, ratio_y, width, height);
	}
	Ok(image)
}

pub fn encode_png(image: RgbaImage) -> CoreResult<Vec<u8>> {
	let mut png = Vec::with_capacity(image.len() / 2);
	DynamicImage::ImageRgba8(image)
		.write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
		.map_err(|error| DesktopError::capture_failed(format!("PNG encoding failed: {error}")))?;
	Ok(png)
}

#[cfg(test)]
mod tests {
	use image::Rgba;

	use super::*;

	fn display(scale: f64) -> DesktopDisplay {
		DesktopDisplay {
			id: "1".into(),
			name: "test".into(),
			x: 100,
			y: 50,
			width: 400,
			height: 300,
			scale,
			pixel_x: 0,
			pixel_y: 0,
			pixel_width: (400.0 * scale) as u32,
			pixel_height: (300.0 * scale) as u32,
			is_primary: true,
		}
	}
	fn window(x: i32, y: i32) -> DesktopWindow {
		DesktopWindow {
			id: "7".into(),
			title: "T".into(),
			app: "A".into(),
			pid: None,
			x,
			y,
			width: 400,
			height: 300,
			focused: false,
		}
	}

	#[test]
	fn pixel_to_logical_at_one_and_two_x() {
		for scale in [1.0, 2.0] {
			let f = FrameGeometry::for_displays(&[display(scale)]);
			assert_eq!(f.map_point(200.0 * scale, 100.0 * scale, None).unwrap(), (300.0, 150.0));
		}
	}
	#[test]
	fn moved_window_is_reanchored() {
		let f = FrameGeometry::for_window(&window(10, 20), 800, 600);
		assert_eq!(f.map_point(400.0, 300.0, Some(&window(110, 220))).unwrap(), (310.0, 370.0));
	}
	#[test]
	fn cap_scaling_adjusts_geometry() {
		let mut f = FrameGeometry::for_displays(&[display(2.0)]);
		let image = RgbaImage::from_pixel(800, 600, Rgba([0, 0, 0, 255]));
		let image = apply_capture_caps(image, &mut f, &CaptureCaps {
			max_width:  Some(400),
			max_height: Some(400),
		})
		.unwrap();
		assert_eq!((image.width(), image.height()), (400, 300));
		assert_eq!(f.map_point(200.0, 100.0, None).unwrap(), (300.0, 150.0));
	}
}
