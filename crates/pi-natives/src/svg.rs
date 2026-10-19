//! Safe SVG rasterization for terminal image previews.
//!
//! SVGs are parsed without loading file-backed image resources, capped to a
//! caller-provided canvas, and encoded as PNG for terminal graphics protocols.

use std::sync::{Arc, LazyLock};

use napi::{Result, bindgen_prelude::Uint8Array};
use napi_derive::napi;
use resvg::{tiny_skia, usvg};

use crate::task;

const MAX_RENDER_PIXELS: u64 = 16 * 1024 * 1024;

static FONT_DB: LazyLock<Arc<usvg::fontdb::Database>> = LazyLock::new(|| {
	let mut database = usvg::fontdb::Database::new();
	database.load_system_fonts();
	Arc::new(database)
});

/// Terminal cell size in device pixels, for [`rasterize_svg`] canvases a
/// terminal shows over whole cells.
#[napi(object)]
#[derive(Clone, Copy, Debug)]
pub struct SvgCell {
	pub width_px:  u32,
	pub height_px: u32,
}

/// Rasterize SVG/SVGZ bytes into a bounded PNG without resolving local files.
///
/// The image is drawn at `scale` times the SVG's intrinsic size (default 1;
/// above 1 renders vector content crisply at display resolution), then shrunk
/// as needed to fit `max_width_px` x `max_height_px` with its aspect ratio
/// kept. Conversion runs on the native blocking pool so parsing and rendering
/// do not stall the JavaScript event loop.
///
/// With `cell`, the limits round down to whole cells and the canvas pads with
/// transparency, right and bottom, to whole cells: a terminal placing the PNG
/// over `width / cell.width_px` columns and `height / cell.height_px` rows
/// shows it 1:1 instead of resampling it.
///
/// # Errors
/// Returns an error for invalid SVG data, zero/oversized limits, a zero cell
/// size, a scale that is not finite and positive, allocation failure, or PNG
/// encoding failure.
#[napi(js_name = "rasterizeSvg")]
pub fn rasterize_svg(
	input: Uint8Array,
	max_width_px: u32,
	max_height_px: u32,
	scale: Option<f64>,
	cell: Option<SvgCell>,
) -> task::Promise<Uint8Array> {
	let input = input.to_vec();
	task::blocking("svg.rasterize", (), move |_| {
		rasterize_svg_sync(&input, max_width_px, max_height_px, scale.unwrap_or(1.0), cell)
			.map(Uint8Array::from)
	})
}

fn rasterize_svg_sync(
	input: &[u8],
	max_width_px: u32,
	max_height_px: u32,
	scale: f64,
	cell: Option<SvgCell>,
) -> Result<Vec<u8>> {
	if max_width_px == 0 || max_height_px == 0 {
		return Err(napi::Error::from_reason("SVG render limits must be greater than zero"));
	}
	if !scale.is_finite() || scale <= 0.0 {
		return Err(napi::Error::from_reason("SVG render scale must be finite and positive"));
	}
	let (max_width_px, max_height_px) = match cell {
		Some(cell) if cell.width_px == 0 || cell.height_px == 0 => {
			return Err(napi::Error::from_reason("SVG cell size must be greater than zero"));
		},
		Some(cell) => (
			(max_width_px / cell.width_px).max(1) * cell.width_px,
			(max_height_px / cell.height_px).max(1) * cell.height_px,
		),
		None => (max_width_px, max_height_px),
	};
	if u64::from(max_width_px) * u64::from(max_height_px) > MAX_RENDER_PIXELS {
		return Err(napi::Error::from_reason(format!(
			"SVG render limits exceed the {MAX_RENDER_PIXELS}-pixel safety cap"
		)));
	}

	let mut options = usvg::Options { fontdb: Arc::clone(&FONT_DB), ..usvg::Options::default() };
	// Repository-controlled SVGs must not read arbitrary host files through an
	// <image href="…"> reference. Embedded data URLs retain the default
	// resolver.
	options.image_href_resolver.resolve_string = Box::new(|_, _| None);
	let tree = usvg::Tree::from_data(input, &options)
		.map_err(|error| napi::Error::from_reason(format!("Failed to parse SVG: {error}")))?;
	let source = tree.size();
	let fit = (max_width_px as f32 / source.width())
		.min(max_height_px as f32 / source.height())
		.min(scale as f32);
	let mut width = (source.width() * fit).ceil().max(1.0) as u32;
	let mut height = (source.height() * fit).ceil().max(1.0) as u32;
	if let Some(cell) = cell {
		// The limits are whole cells, so padding stays within them; the clamp
		// only absorbs a float-rounded extra pixel.
		width = width.next_multiple_of(cell.width_px).min(max_width_px);
		height = height.next_multiple_of(cell.height_px).min(max_height_px);
	}
	let mut pixmap = tiny_skia::Pixmap::new(width, height)
		.ok_or_else(|| napi::Error::from_reason("Failed to allocate SVG render surface"))?;
	resvg::render(&tree, tiny_skia::Transform::from_scale(fit, fit), &mut pixmap.as_mut());
	pixmap
		.encode_png()
		.map_err(|error| napi::Error::from_reason(format!("Failed to encode SVG preview: {error}")))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn rasterizes_svg_at_intrinsic_size() {
		let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="12" height="7"><rect width="12" height="7" fill="red"/></svg>"#;
		let png = rasterize_svg_sync(svg, 100, 100, 1.0, None).expect("SVG should rasterize");
		let image = image::load_from_memory(&png).expect("result should be PNG");
		assert_eq!((image.width(), image.height()), (12, 7));
	}

	#[test]
	fn scales_past_intrinsic_size_within_limits() {
		let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 10"><rect width="40" height="10"/></svg>"#;
		let scaled = rasterize_svg_sync(svg, 1000, 1000, 2.5, None).expect("SVG should rasterize");
		let image = image::load_from_memory(&scaled).expect("result should be PNG");
		assert_eq!((image.width(), image.height()), (100, 25));
		// The limits still win over the requested scale, aspect ratio kept.
		let capped = rasterize_svg_sync(svg, 60, 1000, 2.5, None).expect("SVG should rasterize");
		let image = image::load_from_memory(&capped).expect("result should be PNG");
		assert_eq!((image.width(), image.height()), (60, 15));
	}

	#[test]
	fn pads_canvas_to_whole_cells() {
		let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 10"><rect width="40" height="10"/></svg>"#;
		let cell = SvgCell { width_px: 8, height_px: 18 };
		// A 100x25 drawing pads to 13x2 cells, transparent past the drawing.
		let png = rasterize_svg_sync(svg, 1000, 1000, 2.5, Some(cell)).expect("SVG should rasterize");
		let image = image::load_from_memory(&png)
			.expect("result should be PNG")
			.to_rgba8();
		assert_eq!(image.dimensions(), (104, 36));
		assert_eq!(image.get_pixel(99, 24)[3], 255);
		assert_eq!(image.get_pixel(100, 0)[3], 0);
		assert_eq!(image.get_pixel(0, 25)[3], 0);
		// The limits round down to whole cells: 60px holds 7 cells, so the
		// drawing shrinks to 56x14 rather than overflowing into an eighth.
		let capped =
			rasterize_svg_sync(svg, 60, 1000, 2.5, Some(cell)).expect("SVG should rasterize");
		let image = image::load_from_memory(&capped).expect("result should be PNG");
		assert_eq!((image.width(), image.height()), (56, 18));
	}

	#[test]
	fn rejects_unbounded_render_surface() {
		let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>"#;
		let error =
			rasterize_svg_sync(svg, 8192, 8192, 1.0, None).expect_err("oversized canvas should fail");
		assert!(error.reason.contains("safety cap"));
	}
}
