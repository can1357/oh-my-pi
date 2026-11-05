use std::io::Cursor;

use image::{DynamicImage, ImageFormat, Rgba, RgbaImage, imageops::FilterType};

use super::{
	error::{CoreResult, DesktopError},
	types::{CaptureCaps, CaptureRegion, DesktopDisplay, DesktopWindow, DisplaySelector},
};

pub const MAX_COMPOSITE_PIXELS: u64 = 268_435_456;

#[derive(Debug, Clone, PartialEq)]
struct FrameRegion {
	id:           String,
	scale:        f64,
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
struct DisplayGeometry {
	id:           String,
	x:            i32,
	y:            i32,
	width:        u32,
	height:       u32,
	scale:        f64,
	pixel_width:  u32,
	pixel_height: u32,
}

impl DisplayGeometry {
	fn matches(&self, display: &DesktopDisplay) -> bool {
		self.id == display.id
			&& self.x == display.x
			&& self.y == display.y
			&& self.width == display.width
			&& self.height == display.height
			&& self.scale == display.scale
			&& self.pixel_width == display.pixel_width
			&& self.pixel_height == display.pixel_height
	}
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
	layout:  Vec<DisplayGeometry>,
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
				id:           d.id.clone(),
				scale:        d.scale,
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
		Self { width, height, regions, layout: Vec::new(), kind: FrameKind::Desktop }
	}

	pub(crate) fn for_window(window: &DesktopWindow, px_width: u32, px_height: u32) -> Self {
		Self {
			width:   px_width,
			height:  px_height,
			regions: vec![FrameRegion {
				id:           window.id.clone(),
				scale:        f64::from(px_width) / f64::from(window.width.max(1)),
				x:            f64::from(window.x),
				y:            f64::from(window.y),
				width:        f64::from(window.width),
				height:       f64::from(window.height),
				pixel_x:      0.0,
				pixel_y:      0.0,
				pixel_width:  f64::from(px_width),
				pixel_height: f64::from(px_height),
			}],
			layout:  Vec::new(),
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
			layout:  Vec::new(),
			kind:    FrameKind::Identity,
		}
	}

	pub(crate) const fn dimensions(&self) -> (u32, u32) {
		(self.width, self.height)
	}

	pub(crate) fn record_layout(&mut self, displays: &[DesktopDisplay]) -> CoreResult<()> {
		if self.kind == FrameKind::Desktop
			&& self.regions.iter().any(|region| {
				!displays.iter().any(|display| {
					region.id == display.id
						&& region.x == f64::from(display.x)
						&& region.y == f64::from(display.y)
						&& region.width == f64::from(display.width)
						&& region.height == f64::from(display.height)
						&& region.scale == display.scale
				})
			}) {
			return Err(DesktopError::invalid_coordinate_frame(
				"desktop layout changed while capturing; capture this target again",
			));
		}
		self.layout = displays
			.iter()
			.map(|display| DisplayGeometry {
				id:           display.id.clone(),
				x:            display.x,
				y:            display.y,
				width:        display.width,
				height:       display.height,
				scale:        display.scale,
				pixel_width:  display.pixel_width,
				pixel_height: display.pixel_height,
			})
			.collect();
		Ok(())
	}

	pub(crate) fn validate_layout(&self, displays: &[DesktopDisplay]) -> CoreResult<()> {
		if self.layout.len() != displays.len()
			|| self
				.layout
				.iter()
				.any(|recorded| !displays.iter().any(|display| recorded.matches(display)))
		{
			return Err(DesktopError::invalid_coordinate_frame(
				"desktop display layout changed since capture; capture this target again before \
				 coordinate input or zoom",
			));
		}
		Ok(())
	}

	pub(crate) fn validate_window(&self, window: Option<&DesktopWindow>) -> CoreResult<()> {
		if let FrameKind::Window { captured_width, captured_height } = self.kind {
			let current = window.ok_or_else(|| {
				DesktopError::window_not_found("target window is no longer available")
			})?;
			if current.width != captured_width || current.height != captured_height {
				return Err(DesktopError::invalid_coordinate_frame(
					"target window was resized since capture; capture it again before coordinate input \
					 or zoom",
				));
			}
		}
		Ok(())
	}

	pub(crate) fn contains_display(&self, id: &str) -> bool {
		self.kind == FrameKind::Desktop && self.regions.iter().any(|region| region.id == id)
	}

	pub(crate) fn capture_selector(&self) -> Option<DisplaySelector> {
		if self.kind != FrameKind::Desktop {
			return None;
		}
		Some(match self.regions.as_slice() {
			[region] => DisplaySelector::Id(region.id.clone()),
			_ => DisplaySelector::All,
		})
	}

	pub(crate) fn validate_region(&self, region: &CaptureRegion) -> CoreResult<()> {
		let right = region.x + region.width;
		let bottom = region.y + region.height;
		if !region.x.is_finite()
			|| !region.y.is_finite()
			|| !region.width.is_finite()
			|| !region.height.is_finite()
			|| !right.is_finite()
			|| !bottom.is_finite()
			|| region.x < 0.0
			|| region.y < 0.0
			|| region.width <= 0.0
			|| region.height <= 0.0
			|| right <= region.x
			|| bottom <= region.y
			|| right > f64::from(self.width)
			|| bottom > f64::from(self.height)
		{
			return Err(DesktopError::invalid_coordinate_frame(format!(
				"zoom region must be a finite, positive rectangle inside the last full capture ({}x{} \
				 px)",
				self.width, self.height
			)));
		}
		Ok(())
	}

	pub(crate) fn crop_region(
		&self,
		image: RgbaImage,
		fresh: &Self,
		region: &CaptureRegion,
		caps: &CaptureCaps,
	) -> CoreResult<(RgbaImage, u32, u32)> {
		self.validate_region(region)?;
		let ratio_x = f64::from(fresh.width) / f64::from(self.width);
		let ratio_y = f64::from(fresh.height) / f64::from(self.height);
		let compatible = self.kind == fresh.kind
			&& self.regions.len() == fresh.regions.len()
			&& self
				.regions
				.iter()
				.zip(&fresh.regions)
				.all(|(base, current)| {
					base.id == current.id
						&& base.width == current.width
						&& base.height == current.height
						&& (self.kind != FrameKind::Desktop
							|| (base.x == current.x && base.y == current.y && base.scale == current.scale))
						&& base.pixel_x.mul_add(ratio_x, -current.pixel_x).abs() < 0.5
						&& base.pixel_y.mul_add(ratio_y, -current.pixel_y).abs() < 0.5
						&& base
							.pixel_width
							.mul_add(ratio_x, -current.pixel_width)
							.abs()
							< 0.5
						&& base
							.pixel_height
							.mul_add(ratio_y, -current.pixel_height)
							.abs()
							< 0.5
				});
		if !compatible
			|| image.dimensions() != fresh.dimensions()
			|| image.width() == 0
			|| image.height() == 0
		{
			return Err(DesktopError::invalid_coordinate_frame(
				"capture geometry changed since the full screenshot; capture this target again before \
				 zoom",
			));
		}
		let left = (region.x * ratio_x).floor() as u32;
		let top = (region.y * ratio_y).floor() as u32;
		let right = ((region.x + region.width) * ratio_x)
			.ceil()
			.min(f64::from(image.width())) as u32;
		let bottom = ((region.y + region.height) * ratio_y)
			.ceil()
			.min(f64::from(image.height())) as u32;
		if right <= left || bottom <= top {
			return Err(DesktopError::invalid_coordinate_frame(
				"zoom region contains no native pixels",
			));
		}
		let source_width = right - left;
		let source_height = bottom - top;
		if left == 0 && top == 0 && right == image.width() && bottom == image.height() {
			return Ok((apply_image_caps(image, caps)?, source_width, source_height));
		}
		let (width, height) = capped_dimensions(source_width, source_height, caps)?;
		let view = image::imageops::crop_imm(&image, left, top, source_width, source_height);
		let image = if (width, height) == (source_width, source_height) {
			view.to_image()
		} else {
			// Resize the view directly; never allocate an intermediate native-size
			// crop.
			image::imageops::resize(&*view, width, height, FilterType::Triangle)
		};
		Ok((image, source_width, source_height))
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
		self.validate_window(current_window)?;
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
			FrameKind::Window { .. } => {
				let current = current_window.ok_or_else(|| {
					DesktopError::window_not_found("target window is no longer available")
				})?;
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
		self
			.regions
			.iter()
			.filter_map(|region| {
				source
					.iter()
					.find(|display| display.id == region.id)
					.map(|display| (display, region))
			})
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

/// Places each `(image, pixel_x, pixel_y)` tile onto a `width`×`height`
/// canvas filled with `background`, clipping tiles at the canvas edge.
///
/// A lone tile that already covers the canvas is the composite itself, so the
/// common single-display capture skips a second full-frame allocation and copy.
/// Tiles are pulled one at a time so multi-display captures hold at most one
/// display image beside the canvas.
pub fn compose<I>(width: u32, height: u32, background: Rgba<u8>, tiles: I) -> CoreResult<RgbaImage>
where
	I: IntoIterator<Item = CoreResult<(RgbaImage, u32, u32)>>,
	I::IntoIter: ExactSizeIterator,
{
	let mut tiles = tiles.into_iter();
	let first = if tiles.len() == 1 {
		let (image, x, y) = tiles.next().expect("length checked above")?;
		if x == 0 && y == 0 && image.width() == width && image.height() == height {
			return Ok(image);
		}
		Some((image, x, y))
	} else {
		None
	};
	// `RgbaImage::new` takes zeroed memory straight from the allocator.
	let mut canvas = if background.0 == [0; 4] {
		RgbaImage::new(width, height)
	} else {
		RgbaImage::from_pixel(width, height, background)
	};
	let canvas_stride = width as usize * 4;
	for tile in first.map(Ok).into_iter().chain(tiles) {
		let (image, x, y) = tile?;
		let row_bytes = image.width().min(width.saturating_sub(x)) as usize * 4;
		if row_bytes == 0 {
			continue;
		}
		let left = x as usize * 4;
		let destination = canvas.chunks_exact_mut(canvas_stride).skip(y as usize);
		for (target, source) in destination.zip(image.chunks_exact(image.width() as usize * 4)) {
			target[left..left + row_bytes].copy_from_slice(&source[..row_bytes]);
		}
	}
	Ok(canvas)
}

pub fn apply_capture_caps(
	image: RgbaImage,
	geometry: &mut FrameGeometry,
	caps: &CaptureCaps,
) -> CoreResult<RgbaImage> {
	let (source_width, source_height) = image.dimensions();
	let image = apply_image_caps(image, caps)?;
	if image.width() != source_width || image.height() != source_height {
		geometry.scaled(
			f64::from(image.width()) / f64::from(source_width),
			f64::from(image.height()) / f64::from(source_height),
			image.width(),
			image.height(),
		);
	}
	Ok(image)
}

pub fn apply_image_caps(mut image: RgbaImage, caps: &CaptureCaps) -> CoreResult<RgbaImage> {
	let (width, height) = capped_dimensions(image.width(), image.height(), caps)?;
	if width != image.width() || height != image.height() {
		image = image::imageops::resize(&image, width, height, FilterType::Triangle);
	}
	Ok(image)
}

fn capped_dimensions(
	source_width: u32,
	source_height: u32,
	caps: &CaptureCaps,
) -> CoreResult<(u32, u32)> {
	if source_width == 0 || source_height == 0 {
		return Err(DesktopError::capture_failed("capture returned an empty image"));
	}
	if caps.max_width == Some(0) || caps.max_height == Some(0) {
		return Err(DesktopError::invalid_target("capture caps must be greater than zero"));
	}
	let mut ratio = 1.0f64;
	if let Some(max_width) = caps.max_width {
		ratio = ratio.min(f64::from(max_width) / f64::from(source_width));
	}
	if let Some(max_height) = caps.max_height {
		ratio = ratio.min(f64::from(max_height) / f64::from(source_height));
	}
	let width = (f64::from(source_width) * ratio).round().max(1.0) as u32;
	let height = (f64::from(source_height) * ratio).round().max(1.0) as u32;
	if u64::from(width) * u64::from(height) > MAX_COMPOSITE_PIXELS {
		return Err(DesktopError::capture_failed(format!(
			"composite {width}x{height} exceeds the native safety limit"
		)));
	}
	Ok((width, height))
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
	fn zoom_maps_capped_coordinates_to_fresh_native_pixels_without_mutating_base() {
		let fresh = FrameGeometry::for_window(&window(10, 20), 800, 600);
		let mut base = fresh.clone();
		apply_capture_caps(RgbaImage::new(800, 600), &mut base, &CaptureCaps {
			max_width:  Some(400),
			max_height: None,
		})
		.unwrap();
		let original = base.clone();
		let image = RgbaImage::from_fn(800, 600, |x, y| Rgba([(x / 4) as u8, (y / 4) as u8, 7, 255]));
		let (crop, source_width, source_height) = base
			.crop_region(
				image,
				&fresh,
				&CaptureRegion { x: 50.0, y: 30.0, width: 100.0, height: 75.0 },
				&CaptureCaps::default(),
			)
			.unwrap();
		assert_eq!((source_width, source_height), (200, 150));
		assert_eq!(crop.dimensions(), (200, 150));
		assert_eq!(crop.get_pixel(0, 0), &Rgba([25, 15, 7, 255]));
		assert_eq!(crop.get_pixel(199, 149), &Rgba([74, 52, 7, 255]));
		let output =
			apply_image_caps(crop, &CaptureCaps { max_width: Some(100), max_height: None }).unwrap();
		assert_eq!(output.dimensions(), (100, 75));
		assert_eq!(base, original);
		assert_eq!(base.map_point(200.0, 150.0, Some(&window(10, 20))).unwrap(), (210.0, 170.0));
	}

	#[test]
	fn zoom_rejects_non_finite_overflow_empty_and_out_of_frame_rectangles() {
		let frame = FrameGeometry::for_window(&window(10, 20), 800, 600);
		let valid = CaptureRegion { x: 0.0, y: 0.0, width: 800.0, height: 600.0 };
		assert!(frame.validate_region(&valid).is_ok());
		for region in [
			CaptureRegion { x: f64::NAN, ..valid },
			CaptureRegion { y: f64::INFINITY, ..valid },
			CaptureRegion { width: f64::NAN, ..valid },
			CaptureRegion { height: f64::INFINITY, ..valid },
			CaptureRegion { x: f64::MAX, width: f64::MAX, ..valid },
			CaptureRegion { width: 0.0, ..valid },
			CaptureRegion { height: -1.0, ..valid },
			CaptureRegion { x: -1.0, ..valid },
			CaptureRegion { x: 1.0, ..valid },
			CaptureRegion { y: 1.0, ..valid },
		] {
			assert_eq!(
				frame.validate_region(&region).unwrap_err().code,
				super::super::error::ErrorCode::InvalidCoordinateFrame
			);
		}
	}

	#[test]
	fn resized_window_rejects_pointer_and_zoom_but_moved_window_remains_valid() {
		let original = window(10, 20);
		let base = FrameGeometry::for_window(&original, 800, 600);
		let resized = DesktopWindow { width: 500, ..original };
		assert!(base.map_point(100.0, 100.0, Some(&resized)).is_err());
		let fresh = FrameGeometry::for_window(&resized, 1000, 600);
		assert!(
			base
				.crop_region(
					RgbaImage::new(1000, 600),
					&fresh,
					&CaptureRegion { x: 0.0, y: 0.0, width: 100.0, height: 100.0 },
					&CaptureCaps::default()
				)
				.is_err()
		);
		assert!(base.validate_window(Some(&window(300, 400))).is_ok());
	}

	#[test]
	fn layout_fingerprint_checks_all_displays_not_active_selection_or_enumeration_order() {
		let first = display(2.0);
		let second =
			DesktopDisplay { id: "2".to_string(), x: 500, is_primary: false, ..display(1.0) };
		let mut frame = FrameGeometry::for_displays(std::slice::from_ref(&first));
		frame
			.record_layout(&[first.clone(), second.clone()])
			.unwrap();
		assert!(
			frame
				.validate_layout(&[second.clone(), first.clone()])
				.is_ok()
		);
		assert_eq!(frame.display_metadata(&[second.clone(), first.clone()])[0].id, first.id);
		for changed in [
			DesktopDisplay { id: "replacement".to_string(), ..second.clone() },
			DesktopDisplay { x: 600, ..second.clone() },
			DesktopDisplay { width: 500, ..second.clone() },
			DesktopDisplay { scale: 2.0, ..second.clone() },
			DesktopDisplay { pixel_height: 600, ..second },
		] {
			assert!(frame.validate_layout(&[first.clone(), changed]).is_err());
		}
		assert!(frame.validate_layout(std::slice::from_ref(&first)).is_err());
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
	#[test]
	fn compose_places_and_clips_tiles() {
		let tile = |w, h, v| RgbaImage::from_pixel(w, h, Rgba([v, v, v, 255]));
		let sole = tile(3, 2, 7);
		let pointer = sole.as_raw().as_ptr();
		let same = compose(3, 2, Rgba([0; 4]), [Ok((sole, 0, 0))]).unwrap();
		assert_eq!(same.as_raw().as_ptr(), pointer);

		let canvas = compose(4, 2, Rgba([0, 0, 0, 255]), [
			Ok((tile(2, 2, 1), 0, 0)),
			Ok((tile(3, 3, 2), 3, 1)),
		])
		.unwrap();
		let mut reference = RgbaImage::from_pixel(4, 2, Rgba([0, 0, 0, 255]));
		image::imageops::replace(&mut reference, &tile(2, 2, 1), 0, 0);
		image::imageops::replace(&mut reference, &tile(3, 3, 2), 3, 1);
		assert_eq!(canvas, reference);
	}
}
