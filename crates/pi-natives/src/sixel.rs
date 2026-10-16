//! SIXEL terminal-image encoding and bounded decoding.
//!
//! Encodes PNG/JPEG/WebP/GIF images for terminal display and decodes captured
//! SIXEL control strings back to bounded PNG attachments.
//!
//! General-purpose image processing stays in `Bun.Image`; the native boundary
//! exists because SIXEL has no equivalent decoder there.

use std::io::Cursor;

use icy_sixel::{EncodeOptions, SixelImage, sixel_encode};
use image::{DynamicImage, ImageFormat, ImageReader, RgbaImage, imageops::FilterType};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::task;

const MAX_DECODED_PIXELS: usize = 4 * 1024 * 1024;
const MAX_IMAGE_EDGE: usize = 8192;
const MAX_SIXEL_BYTES: usize = 20 * 1024 * 1024;
const MAX_PNG_BYTES: usize = 20 * 1024 * 1024;

/// Decode one complete SIXEL control string into a PNG on the calling thread.
///
/// The decoder is deliberately bounded before handing the stream to
/// `icy_sixel`: raster declarations, repeats, and row advances are scanned
/// first so hostile dimensions cannot make the dependency allocate its much
/// larger internal maximum.
#[napi]
pub fn decode_sixel_to_png(bytes: Uint8Array) -> Result<Uint8Array> {
	if bytes.len() > MAX_SIXEL_BYTES {
		return Err(Error::from_reason("SIXEL payload exceeds the 20 MiB limit"));
	}
	decode_sixel(bytes.as_ref()).map(Uint8Array::from)
}

/// Same result as [`decode_sixel_to_png`], but the decode runs on the native
/// blocking pool instead of the JS thread.
#[napi]
pub fn decode_sixel_to_png_async(bytes: Uint8Array) -> task::Promise<Uint8Array> {
	// An oversized payload rejects without being copied off the JS heap.
	let bytes = (bytes.len() <= MAX_SIXEL_BYTES).then(|| bytes.to_vec());
	task::blocking("sixel.decode", (), move |_| {
		let bytes =
			bytes.ok_or_else(|| Error::from_reason("SIXEL payload exceeds the 20 MiB limit"))?;
		decode_sixel(&bytes).map(Uint8Array::from)
	})
}

fn decode_sixel(bytes: &[u8]) -> Result<Vec<u8>> {
	preflight_sixel_dimensions(bytes)?;

	let decoded = SixelImage::decode(bytes)
		.map_err(|err| Error::from_reason(format!("Failed to decode SIXEL: {err}")))?;
	guard_dimensions(decoded.width, decoded.height)?;

	let width =
		u32::try_from(decoded.width).map_err(|_| Error::from_reason("SIXEL width is too large"))?;
	let height =
		u32::try_from(decoded.height).map_err(|_| Error::from_reason("SIXEL height is too large"))?;
	let rgba = RgbaImage::from_raw(width, height, decoded.pixels)
		.ok_or_else(|| Error::from_reason("Decoded SIXEL pixel buffer has invalid dimensions"))?;
	let mut png = Vec::with_capacity(rgba.len().min(MAX_PNG_BYTES));
	DynamicImage::ImageRgba8(rgba)
		.write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
		.map_err(|err| Error::from_reason(format!("Failed to encode decoded SIXEL as PNG: {err}")))?;
	if png.len() > MAX_PNG_BYTES {
		return Err(Error::from_reason("Decoded SIXEL PNG exceeds the 20 MiB limit"));
	}
	Ok(png)
}

fn guard_dimensions(width: usize, height: usize) -> Result<()> {
	if width == 0
		|| height == 0
		|| width > MAX_IMAGE_EDGE
		|| height > MAX_IMAGE_EDGE
		|| width.saturating_mul(height) > MAX_DECODED_PIXELS
	{
		return Err(Error::from_reason("SIXEL image dimensions exceed the decode limit"));
	}
	Ok(())
}

fn preflight_sixel_dimensions(bytes: &[u8]) -> Result<()> {
	let payload_start = bytes
		.windows(2)
		.position(|window| window == b"\x1bP")
		.map(|index| index + 2)
		.or_else(|| {
			bytes
				.iter()
				.position(|byte| *byte == 0x90)
				.map(|index| index + 1)
		})
		.ok_or_else(|| Error::from_reason("SIXEL data is missing a DCS introducer"))?;
	let q = bytes[payload_start..]
		.iter()
		.position(|byte| *byte == b'q')
		.map(|index| payload_start + index + 1)
		.ok_or_else(|| Error::from_reason("SIXEL data is missing its q introducer"))?;

	let mut x = 0usize;
	let mut y = 0usize;
	let mut max_width = 0usize;
	let mut max_height = 0usize;
	let mut index = q;
	while index < bytes.len() {
		let byte = bytes[index];
		if byte == 0x9c || (byte == 0x1b && bytes.get(index + 1) == Some(&b'\\')) {
			break;
		}
		match byte {
			b'?'..=b'~' => {
				x = x.saturating_add(1);
				max_width = max_width.max(x);
				max_height = max_height.max(y.saturating_add(6));
			},
			b'!' => {
				let (count, next) = decimal(bytes, index + 1);
				if let Some(sixel) = bytes.get(next)
					&& (b'?'..=b'~').contains(sixel)
				{
					x = x.saturating_add(count);
					max_width = max_width.max(x);
					max_height = max_height.max(y.saturating_add(6));
					index = next;
				}
			},
			b'-' => {
				y = y.saturating_add(6);
				x = 0;
			},
			b'$' => x = 0,
			b'"' => {
				let mut values = [0usize; 4];
				let mut next = index + 1;
				for value in &mut values {
					let (parsed, end) = decimal(bytes, next);
					*value = parsed;
					next = end;
					if bytes.get(next) != Some(&b';') {
						break;
					}
					next += 1;
				}
				if values[2] > 0 || values[3] > 0 {
					guard_dimensions(values[2].max(1), values[3].max(1))?;
					max_width = max_width.max(values[2]);
					max_height = max_height.max(values[3]);
				}
				index = next.saturating_sub(1);
			},
			_ => {},
		}
		guard_dimensions(max_width.max(1), max_height.max(1))?;
		index += 1;
	}
	guard_dimensions(max_width.max(1), max_height.max(1))
}

fn decimal(bytes: &[u8], mut index: usize) -> (usize, usize) {
	let mut value = 0usize;
	while let Some(&digit @ b'0'..=b'9') = bytes.get(index) {
		value = value
			.saturating_mul(10)
			.saturating_add((digit - b'0') as usize);
		index += 1;
	}
	(value, index)
}

/// Encode image bytes into a SIXEL escape sequence for terminal rendering, on
/// the calling thread.
///
/// The input image is decoded and resized to the requested pixel dimensions
/// (not resampled when it already has them), then encoded in whole 6-pixel
/// bands: a partial last band is dropped, see [`band_rows`]. Prefer
/// [`encode_sixel_async`] unless the caller cannot wait: the decode, resize
/// and dither block the JS thread.
///
/// # Errors
/// Returns an error if decoding, resizing, or SIXEL encoding fails.
#[napi]
pub fn encode_sixel(
	bytes: Uint8Array,
	target_width_px: u32,
	target_height_px: u32,
) -> Result<String> {
	encode_image(bytes.as_ref(), target_width_px, target_height_px)
}

/// Same result as [`encode_sixel`], but the decode, resize and dither run on
/// the native blocking pool, so they never stall the JavaScript event loop.
///
/// # Errors
/// Rejects if decoding, resizing, or SIXEL encoding fails.
#[napi]
pub fn encode_sixel_async(
	bytes: Uint8Array,
	target_width_px: u32,
	target_height_px: u32,
) -> task::Promise<String> {
	let bytes = bytes.to_vec();
	task::blocking("sixel.encode", (), move |_| {
		encode_image(&bytes, target_width_px, target_height_px)
	})
}

fn encode_image(bytes: &[u8], target_width_px: u32, target_height_px: u32) -> Result<String> {
	if target_width_px == 0 || target_height_px == 0 {
		return Err(Error::from_reason("Target SIXEL dimensions must be greater than zero"));
	}

	let source = decode_image_from_bytes(bytes)?;
	let resized = if source.width() == target_width_px && source.height() == target_height_px {
		source
	} else {
		source.resize_exact(target_width_px, target_height_px, FilterType::Lanczos3)
	};
	// Reuses the pixel buffer when the image is already RGBA8.
	let rgba = resized.into_rgba8();
	let width = target_width_px as usize;
	let rows = band_rows(target_height_px) as usize;
	let options = EncodeOptions::default();
	sixel_encode(&rgba.as_raw()[..width * rows * 4], width, rows, &options)
		.map_err(|err| Error::from_reason(format!("Failed to encode SIXEL: {err}")))
}

/// Pixel rows of a `height_px` image that SIXEL can show without growing it.
///
/// SIXEL draws in 6-pixel bands and terminals size a partial last band as a
/// whole one, so an image whose height is not a multiple of 6 reaches up to
/// 5 pixels further down: past the bottom of its cell box, which then takes an
/// extra text row. Cropping that band instead of scaling the image keeps the
/// rest pixel-exact. An image shorter than one band keeps its rows.
const fn band_rows(height_px: u32) -> u32 {
	if height_px < 6 {
		height_px
	} else {
		height_px - height_px % 6
	}
}

fn decode_image_from_bytes(bytes: &[u8]) -> Result<DynamicImage> {
	let reader = ImageReader::new(Cursor::new(bytes))
		.with_guessed_format()
		.map_err(|e| Error::from_reason(format!("Failed to detect image format: {e}")))?;

	reader
		.decode()
		.map_err(|e| Error::from_reason(format!("Failed to decode image: {e}")))
}

#[cfg(test)]
mod tests {
	use super::*;

	/// PNG of 1px black/white columns, which any resample turns gray.
	fn stripes_png(width: u32, height: u32) -> (RgbaImage, Vec<u8>) {
		let image = RgbaImage::from_fn(width, height, |x, _| {
			let v = if x % 2 == 0 { 255 } else { 0 };
			image::Rgba([v, v, v, 255])
		});
		let mut png = Vec::new();
		DynamicImage::ImageRgba8(image.clone())
			.write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
			.expect("PNG should encode");
		(image, png)
	}

	fn round_trip(png: &[u8], width: u32, height: u32) -> RgbaImage {
		let sixel = encode_image(png, width, height).expect("SIXEL should encode");
		let decoded = decode_sixel(sixel.as_bytes()).expect("SIXEL should decode");
		image::load_from_memory(&decoded)
			.expect("decoded SIXEL should be PNG")
			.to_rgba8()
	}

	#[test]
	fn crops_partial_band_without_resampling() {
		// A raster padded to 9x11 cells of 10x20: 220 rows end in a partial band.
		let (source, png) = stripes_png(90, 220);
		let shown = round_trip(&png, 90, 220);
		assert_eq!(shown.dimensions(), (90, 216));
		for (x, y, pixel) in shown.enumerate_pixels() {
			assert_eq!(pixel, source.get_pixel(x, y), "pixel ({x}, {y}) was resampled");
		}
	}

	#[test]
	fn keeps_an_image_shorter_than_one_band() {
		let (_, png) = stripes_png(8, 4);
		assert_eq!(round_trip(&png, 8, 4).height(), 6);
	}
}
