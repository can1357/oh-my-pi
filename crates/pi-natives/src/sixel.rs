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
		.array_windows()
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
/// (not resampled when it already has them), then partial alpha is composited
/// against `background_rgb` (packed `0xRRGGBB`). Fully transparent pixels
/// remain transparent. Encoding uses whole 6-pixel bands: a partial last band
/// is dropped, see [`band_rows`]. Prefer
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
	background_rgb: u32,
) -> Result<String> {
	encode_image(bytes.as_ref(), target_width_px, target_height_px, background_rgb)
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
	background_rgb: u32,
) -> task::Promise<String> {
	let bytes = bytes.to_vec();
	task::blocking("sixel.encode", (), move |_| {
		encode_image(&bytes, target_width_px, target_height_px, background_rgb)
	})
}

fn encode_image(
	bytes: &[u8],
	target_width_px: u32,
	target_height_px: u32,
	background_rgb: u32,
) -> Result<String> {
	if target_width_px == 0 || target_height_px == 0 {
		return Err(Error::from_reason("Target SIXEL dimensions must be greater than zero"));
	}
	if background_rgb > 0xffffff {
		return Err(Error::from_reason("SIXEL background must be a packed 24-bit RGB color"));
	}

	let source = decode_image_from_bytes(bytes)?;
	let needs_resize = source.width() != target_width_px || source.height() != target_height_px;
	let premultiplied = needs_resize && source.color().has_alpha();
	let mut rgba = if premultiplied {
		// Alpha is coverage: 0 is invisible, 255 is opaque. Stored RGB can still
		// contain colors when alpha is zero. Before averaging neighboring pixels,
		// weight RGB by coverage ("premultiply"): half-visible red becomes
		// (128, 0, 0, 128), not (255, 0, 0, 128). This keeps hidden colors out of
		// visible edges. Reuse RGBA8 storage; leave the background out until
		// later.
		let mut rgba = source.into_rgba8();
		for pixel in rgba.pixels_mut() {
			let alpha = u32::from(pixel[3]);
			if alpha == 255 {
				continue;
			}
			for channel in &mut pixel.0[..3] {
				*channel = ((u32::from(*channel) * alpha + 127) / 255) as u8;
			}
		}
		// Resize coverage-weighted RGB and alpha with the same filter.
		image::imageops::resize(&rgba, target_width_px, target_height_px, FilterType::Lanczos3)
	} else if needs_resize {
		// Opaque formats need neither a full-size RGBA conversion nor
		// premultiplication.
		source
			.resize_exact(target_width_px, target_height_px, FilterType::Lanczos3)
			.into_rgba8()
	} else {
		source.into_rgba8()
	};
	let width = target_width_px as usize;
	let rows = band_rows(target_height_px) as usize;
	let background =
		[(background_rgb >> 16) & 0xff, (background_rgb >> 8) & 0xff, background_rgb & 0xff];
	for pixel in rgba.pixels_mut() {
		let alpha = u32::from(pixel[3]);
		// Keep holes transparent; opaque pixels need no background contribution.
		if alpha == 0 || alpha == 255 {
			continue;
		}
		// SIXEL supports only fully visible or fully transparent pixels. For
		// partial coverage, add the background's uncovered share:
		// RGB * alpha + background * (1 - alpha), with alpha normalized to 0..1.
		// Premultiplied RGB already includes alpha; multiplying it again would
		// darken edges. Only the unscaled, straight-RGB path still needs it.
		for channel in 0..3 {
			let foreground = u32::from(pixel[channel]);
			let covered = if premultiplied {
				// Lanczos can overshoot near sharp edges. A coverage-weighted
				// channel cannot exceed alpha (half-visible white is at most 128).
				foreground.min(alpha) * 255
			} else {
				foreground * alpha
			};
			// Alpha uses 0..255 here; +127 rounds the division to nearest.
			pixel[channel] = ((covered + background[channel] * (255 - alpha) + 127) / 255) as u8;
		}
		pixel[3] = 255;
	}
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
	use image::Rgba;

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
		let sixel = encode_image(png, width, height, 0x000000).expect("SIXEL should encode");
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
	fn resized_fractional_edges_keep_coverage_without_hidden_color_bleed() {
		// A fractional-alpha source column next to transparency is the feathered
		// edge a straight-alpha resize mishandles: it double-darkens the coverage
		// and lets the hidden color bleed into it. Premultiplied Lanczos must
		// land on the same coverage regardless of what the a=0 column hides.
		// Keep foreground channels below 255: white could hide color bleed
		// because the final min(foreground, alpha) clamp clips it back to the
		// expected coverage. This colored edge must retain its channel ratios.
		for hidden in [Rgba([0, 0, 0, 0]), Rgba([255, 0, 0, 0])] {
			let source = RgbaImage::from_fn(3, 6, |x, _| match x {
				0 => Rgba([64, 128, 192, 255]),
				1 => Rgba([64, 128, 192, 128]),
				_ => hidden,
			});
			let mut png = Vec::new();
			DynamicImage::ImageRgba8(source)
				.write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
				.unwrap();

			for (background, expected) in [(0x000000, [32_u8, 64, 96]), (0xffffff, [159, 191, 223])] {
				let encoded = encode_image(&png, 1, 6, background).unwrap();
				let decoded_png = decode_sixel(encoded.as_bytes()).unwrap();
				let decoded = image::load_from_memory(&decoded_png).unwrap().into_rgba8();
				assert_eq!(decoded.dimensions(), (1, 6));
				for pixel in decoded.pixels() {
					assert_eq!(pixel[3], 255, "fractional coverage must not become a hole");
					for (channel, &want) in pixel.0[..3].iter().zip(expected.iter()) {
						assert!(
							channel.abs_diff(want) <= 2,
							"hidden={hidden:?}, background={background:06x}, actual={pixel:?}, \
							 expected={expected:?}"
						);
					}
				}
			}
		}
	}

	#[test]
	fn keeps_an_image_shorter_than_one_band() {
		let (_, png) = stripes_png(8, 4);
		assert_eq!(round_trip(&png, 8, 4).height(), 6);
	}

	#[test]
	fn resized_transparent_edges_keep_coverage_without_hidden_color_bleed() {
		for hidden in [Rgba([0, 0, 0, 0]), Rgba([255, 0, 0, 0])] {
			let source = RgbaImage::from_fn(2, 6, |x, _| {
				if x == 0 {
					Rgba([255, 255, 255, 255])
				} else {
					hidden
				}
			});
			let mut png = Vec::new();
			DynamicImage::ImageRgba8(source)
				.write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
				.unwrap();

			for (background, expected) in [(0x000000, 128_u8), (0xffffff, 255_u8)] {
				let encoded = encode_image(&png, 1, 6, background).unwrap();
				let decoded_png = decode_sixel(encoded.as_bytes()).unwrap();
				let decoded = image::load_from_memory(&decoded_png).unwrap().into_rgba8();
				assert_eq!(decoded.dimensions(), (1, 6));
				for pixel in decoded.pixels() {
					assert_eq!(pixel[3], 255, "resized coverage must remain visible");
					for channel in &pixel.0[..3] {
						assert!(
							channel.abs_diff(expected) <= 2,
							"hidden={hidden:?}, background={background:06x}, actual={pixel:?}, \
							 expected={expected}"
						);
					}
				}
			}
		}
	}

	#[test]
	fn fractional_alpha_roundtrips_over_terminal_backgrounds() {
		for source_alpha in [0, 1, 127, 128, 254, 255] {
			let input = Rgba([231, 53, 129, source_alpha]);
			// One visible color isolates composition from lossy palette merging.
			let source = RgbaImage::from_pixel(6, 6, input);
			let mut png = Vec::new();
			DynamicImage::ImageRgba8(source)
				.write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
				.unwrap();

			for background_rgb in [0x000000, 0x182c40, 0xffffff] {
				for (width, height) in [(6, 6), (12, 6)] {
					let encoded = encode_image(&png, width, height, background_rgb).unwrap();
					let decoded_png = decode_sixel(encoded.as_bytes()).unwrap();
					let decoded = image::load_from_memory(&decoded_png).unwrap().into_rgba8();
					assert_eq!(decoded.dimensions(), (width, height));

					for actual in decoded.pixels() {
						if source_alpha == 0 {
							assert_eq!(actual[3], 0, "fully transparent pixels must stay transparent");
							continue;
						}
						assert_eq!(actual[3], 255, "fractional coverage must not become a hole");
						for channel in 0..3 {
							let background = (background_rgb >> (16 - channel * 8)) & 0xff;
							let alpha = u32::from(source_alpha);
							let expected =
								((u32::from(input[channel]) * alpha + background * (255 - alpha) + 127)
									/ 255) as u8;
							// SIXEL palette channels use integer percentages, allowing
							// up to two byte levels of roundtrip quantization error.
							assert!(
								actual[channel].abs_diff(expected) <= 2,
								"background={background_rgb:06x}, size={width}x{height}, input={input:?}, \
								 actual={actual:?}, channel={channel}, expected={expected}"
							);
						}
					}
				}
			}
		}
	}
}
