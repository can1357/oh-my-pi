//! Clipboard utilities backed by arboard.
//!
//! Provides text copy and image read support across Linux, macOS, and Windows.
//! Performs text copy synchronously so macOS writes run on the caller thread.
//! This avoids worker-thread `AppKit` pasteboard warnings in CLI contexts.

use std::io::Cursor;

use arboard::{Clipboard, Error as ClipboardError, ImageData};
use image::{DynamicImage, ImageFormat, RgbaImage};
use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;

use crate::{js, task};

/// Clipboard image payload encoded as PNG bytes.
#[napi(object)]
pub struct ClipboardImage {
	/// PNG-encoded image bytes.
	pub data:      Uint8Array,
	/// MIME type for the encoded image payload.
	pub mime_type: String,
}

fn encode_png(image: ImageData<'_>) -> Result<Vec<u8>> {
	let width = u32::try_from(image.width)
		.map_err(|_| Error::from_reason("Clipboard image width overflow"))?;
	let height = u32::try_from(image.height)
		.map_err(|_| Error::from_reason("Clipboard image height overflow"))?;
	let bytes = image.bytes.into_owned();
	let buffer = RgbaImage::from_raw(width, height, bytes)
		.ok_or_else(|| Error::from_reason("Clipboard image buffer size mismatch"))?;
	rgba_to_png(buffer)
}

fn rgba_to_png(buffer: RgbaImage) -> Result<Vec<u8>> {
	let capacity = (buffer
		.width()
		.saturating_mul(buffer.height())
		.saturating_mul(4)) as usize;
	let mut output = Vec::with_capacity(capacity);
	DynamicImage::ImageRgba8(buffer)
		.write_to(&mut Cursor::new(&mut output), ImageFormat::Png)
		.map_err(|err| Error::from_reason(format!("Failed to encode clipboard image: {err}")))?;
	Ok(output)
}

/// Decode a packed DIB clipboard payload (`CF_DIB`: a `BITMAPINFOHEADER`-family
/// header, optional bitfield masks and palette, then the pixel array) into PNG
/// bytes.
///
/// The payload is wrapped in a synthesized `BITMAPFILEHEADER` and decoded
/// through the BMP *file* path so the explicit `bfOffBits` pins the pixel
/// offset. This matters: the header-less decode path arboard uses mis-places
/// the pixel offset for V4/V5 headers with `BI_BITFIELDS` compression (it
/// skips 12 trailing mask bytes that those headers embed instead), which is
/// why Qt-based screenshot tools (`PixPin`, `Snipaste`, ...) fail through
/// arboard in the first place (#3426).
#[cfg_attr(
	not(windows),
	allow(
		dead_code,
		reason = "reached only by the Windows clipboard fallback; kept target-independent so unit \
		          tests cover it on every host"
	)
)]
fn dib_to_png(dib: &[u8]) -> Result<Vec<u8>> {
	const FILE_HEADER_SIZE: u64 = 14;
	const INFO_HEADER_SIZE: u64 = 40;
	const BI_BITFIELDS: u32 = 3;

	if dib.len() < INFO_HEADER_SIZE as usize {
		return Err(Error::from_reason("Clipboard DIB shorter than BITMAPINFOHEADER"));
	}
	let u32_at =
		|at: usize| u32::from_le_bytes(dib[at..at + 4].try_into().expect("bounds checked above"));
	let header_size = u64::from(u32_at(0));
	if header_size < INFO_HEADER_SIZE || header_size > dib.len() as u64 {
		return Err(Error::from_reason("Clipboard DIB header size out of range"));
	}
	let bit_count = u16::from_le_bytes([dib[14], dib[15]]);
	let compression = u32_at(16);
	let colors_used = u64::from(u32_at(32));

	// A plain BITMAPINFOHEADER with BI_BITFIELDS is trailed by three DWORD
	// masks; larger (V2..V5) headers embed the masks in the header itself.
	let mask_bytes: u64 = if header_size == INFO_HEADER_SIZE && compression == BI_BITFIELDS {
		12
	} else {
		0
	};
	let palette_entries: u64 = if colors_used != 0 {
		colors_used
	} else if bit_count <= 8 {
		1u64 << bit_count
	} else {
		0
	};
	let pixel_offset =
		u32::try_from(FILE_HEADER_SIZE + header_size + mask_bytes + palette_entries * 4)
			.map_err(|_| Error::from_reason("Clipboard DIB layout overflow"))?;
	let file_size = u32::try_from(FILE_HEADER_SIZE + dib.len() as u64)
		.map_err(|_| Error::from_reason("Clipboard DIB too large"))?;

	let mut bmp = Vec::with_capacity(FILE_HEADER_SIZE as usize + dib.len());
	bmp.extend_from_slice(b"BM");
	bmp.extend_from_slice(&file_size.to_le_bytes());
	bmp.extend_from_slice(&0u32.to_le_bytes());
	bmp.extend_from_slice(&pixel_offset.to_le_bytes());
	bmp.extend_from_slice(dib);

	let decoded = image::load_from_memory_with_format(&bmp, ImageFormat::Bmp)
		.map_err(|err| Error::from_reason(format!("Failed to decode clipboard DIB: {err}")))?;
	rgba_to_png(decoded.into_rgba8())
}

/// Read the raw `CF_DIB` bytes from the Windows clipboard.
///
/// Windows synthesizes `CF_DIB` from whatever bitmap formats are present, so
/// it is available whenever the clipboard holds any image at all.
#[cfg(windows)]
fn read_raw_cf_dib() -> Option<Vec<u8>> {
	let clip = clipboard_win::Clipboard::new_attempts(10).ok()?;
	let mut dib = Vec::new();
	clipboard_win::raw::get_vec(clipboard_win::formats::CF_DIB, &mut dib).ok()?;
	drop(clip);
	(!dib.is_empty()).then_some(dib)
}

/// Copy plain text to the system clipboard.
///
/// # Parameters
/// - `text`: UTF-8 text to place on the clipboard.
///
/// # Errors
/// Returns an error if clipboard access fails.
#[napi]
pub fn copy_to_clipboard(text: JsString) -> Result<()> {
	set_clipboard_text(&js::utf8(text)?)
}

/// Linux: keep a single `arboard::Clipboard` alive for the whole process.
///
/// X11 (and Wayland) clipboards are owner-based: the process that set the
/// selection must stay alive and answer `SelectionRequest` events, otherwise
/// the contents vanish the moment the owner goes away. arboard serves those
/// requests from a global background thread that only lives as long as a
/// `Clipboard` instance exists — so creating a throwaway `Clipboard` per copy
/// (which is then dropped) tears that thread down immediately and leaves the
/// X11 clipboard empty even while our process keeps running (issue #2075).
/// Holding one instance for the lifetime of the process keeps that owner thread
/// serving, without shelling out to `xclip`/`wl-copy`. Wayland is unaffected
/// (`wl-clipboard-rs` forks its own serving process) but sharing the instance
/// is harmless there.
#[cfg(target_os = "linux")]
fn set_clipboard_text(text: &str) -> Result<()> {
	use std::sync::OnceLock;

	use parking_lot::Mutex;

	static CLIPBOARD: OnceLock<Mutex<Option<Clipboard>>> = OnceLock::new();
	let cell = CLIPBOARD.get_or_init(|| Mutex::new(None));
	let mut guard = cell.lock();
	if guard.is_none() {
		*guard = Some(
			Clipboard::new()
				.map_err(|err| Error::from_reason(format!("Failed to access clipboard: {err}")))?,
		);
	}
	guard
		.as_mut()
		.expect("clipboard initialized above")
		.set_text(text)
		.map_err(|err| Error::from_reason(format!("Failed to copy to clipboard: {err}")))?;
	Ok(())
}

/// macOS / Windows: the OS retains clipboard contents after the writing process
/// exits, so a transient `Clipboard` is sufficient. Keeping the write on the
/// calling thread also avoids worker-thread `AppKit` pasteboard warnings on
/// macOS.
#[cfg(not(target_os = "linux"))]
fn set_clipboard_text(text: &str) -> Result<()> {
	let mut clipboard = Clipboard::new()
		.map_err(|err| Error::from_reason(format!("Failed to access clipboard: {err}")))?;
	clipboard
		.set_text(text)
		.map_err(|err| Error::from_reason(format!("Failed to copy to clipboard: {err}")))?;
	Ok(())
}

/// Read an image from the system clipboard.
///
/// Returns `Ok(None)` when no image data is available.
///
/// # Errors
/// Returns an error if clipboard access fails or image encoding fails.
#[napi]
pub fn read_image_from_clipboard() -> task::Promise<Option<ClipboardImage>> {
	task::blocking("clipboard.read_image", (), move |_| -> Result<Option<ClipboardImage>> {
		let mut clipboard = Clipboard::new()
			.map_err(|err| Error::from_reason(format!("Failed to access clipboard: {err}")))?;
		match clipboard.get_image() {
			Ok(image) => {
				let bytes = encode_png(image)?;
				Ok(Some(ClipboardImage {
					data:      Uint8Array::from(bytes),
					mime_type: "image/png".to_string(),
				}))
			},
			Err(ClipboardError::ContentNotAvailable) => Ok(None),
			Err(err) => {
				// arboard rejects the CF_DIBV5 payloads Qt-based screenshot
				// tools (PixPin, Snipaste, ...) produce; decode the raw CF_DIB
				// ourselves before surfacing the error (#3426). A fallback
				// decode failure keeps the original arboard error.
				#[cfg(windows)]
				if let Some(bytes) = read_raw_cf_dib().and_then(|dib| dib_to_png(&dib).ok()) {
					return Ok(Some(ClipboardImage {
						data:      Uint8Array::from(bytes),
						mime_type: "image/png".to_string(),
					}));
				}
				Err(Error::from_reason(format!("Failed to read clipboard image: {err}")))
			},
		}
	})
}

#[cfg(test)]
mod tests {
	use super::dib_to_png;

	fn push32(v: u32, out: &mut Vec<u8>) {
		out.extend_from_slice(&v.to_le_bytes());
	}

	fn push16(v: u16, out: &mut Vec<u8>) {
		out.extend_from_slice(&v.to_le_bytes());
	}

	/// 2x2 bottom-up BGRA pixel array: memory rows are [red, green] (bottom)
	/// then [blue, white] (top), all with alpha 0xff.
	const PIXELS_2X2: [u8; 16] = [
		0x00, 0x00, 0xff, 0xff, // (0,1) red
		0x00, 0xff, 0x00, 0xff, // (1,1) green
		0xff, 0x00, 0x00, 0xff, // (0,0) blue
		0xff, 0xff, 0xff, 0xff, // (1,0) white
	];

	/// `CF_DIB` as Qt's clipboard writer emits it for 32-bit content: a plain
	/// `BITMAPINFOHEADER` with `BI_BITFIELDS` compression and three DWORD
	/// masks between header and pixels.
	fn qt_cf_dib(width: u32, height: u32, pixels_bgra: &[u8], compression: u32) -> Vec<u8> {
		let mut d = Vec::with_capacity(52 + pixels_bgra.len());
		push32(40, &mut d); // biSize
		push32(width, &mut d);
		push32(height, &mut d); // positive: bottom-up
		push16(1, &mut d); // biPlanes
		push16(32, &mut d); // biBitCount
		push32(compression, &mut d);
		push32(pixels_bgra.len() as u32, &mut d); // biSizeImage
		push32(0, &mut d); // biXPelsPerMeter
		push32(0, &mut d); // biYPelsPerMeter
		push32(0, &mut d); // biClrUsed
		push32(0, &mut d); // biClrImportant
		if compression == 3 {
			push32(0x00ff_0000, &mut d); // red mask
			push32(0x0000_ff00, &mut d); // green mask
			push32(0x0000_00ff, &mut d); // blue mask
		}
		d.extend_from_slice(pixels_bgra);
		d
	}

	/// `CF_DIBV5` as `PixPin` (Qt) places it, after arboard's
	/// `maybe_tweak_header` rewrite: a 124-byte `BITMAPV5HEADER` carrying
	/// `BI_BITFIELDS` compression with the BGRA masks embedded in the header
	/// and pixels immediately after it. This is the exact buffer shape that
	/// arboard's header-less BMP decode rejects with `ConversionFailure`
	/// (issue #3426); the file-header wrap must decode it.
	fn pixpin_dibv5_tweaked(width: u32, height: u32, pixels_bgra: &[u8]) -> Vec<u8> {
		let mut d = Vec::with_capacity(124 + pixels_bgra.len());
		push32(124, &mut d); // bV5Size
		push32(width, &mut d);
		push32(height, &mut d);
		push16(1, &mut d); // bV5Planes
		push16(32, &mut d); // bV5BitCount
		push32(3, &mut d); // bV5Compression = BI_BITFIELDS (arboard-tweaked)
		push32(0, &mut d); // bV5SizeImage
		push32(0, &mut d); // bV5XPelsPerMeter
		push32(0, &mut d); // bV5YPelsPerMeter
		push32(0, &mut d); // bV5ClrUsed
		push32(0, &mut d); // bV5ClrImportant
		push32(0x00ff_0000, &mut d); // bV5RedMask
		push32(0x0000_ff00, &mut d); // bV5GreenMask
		push32(0x0000_00ff, &mut d); // bV5BlueMask
		push32(0xff00_0000, &mut d); // bV5AlphaMask
		push32(0x7352_4742, &mut d); // bV5CSType = LCS_sRGB
		d.extend_from_slice(&[0u8; 36]); // bV5Endpoints
		push32(0, &mut d); // bV5GammaRed
		push32(0, &mut d); // bV5GammaGreen
		push32(0, &mut d); // bV5GammaBlue
		push32(4, &mut d); // bV5Intent = LCS_GM_IMAGES
		push32(0, &mut d); // bV5ProfileData
		push32(0, &mut d); // bV5ProfileSize
		push32(0, &mut d); // bV5Reserved
		assert_eq!(d.len(), 124);
		d.extend_from_slice(pixels_bgra);
		d
	}

	fn decode_pixels(png: &[u8]) -> (u32, u32, Vec<[u8; 4]>) {
		let img = image::load_from_memory(png).expect("fallback output must be valid PNG");
		let rgba = img.into_rgba8();
		let (w, h) = rgba.dimensions();
		let px = rgba.pixels().map(|p| p.0).collect();
		(w, h, px)
	}

	const RED: [u8; 4] = [255, 0, 0, 255];
	const GREEN: [u8; 4] = [0, 255, 0, 255];
	const BLUE: [u8; 4] = [0, 0, 255, 255];
	const WHITE: [u8; 4] = [255, 255, 255, 255];

	#[test]
	fn decodes_qt_cf_dib_with_bitfields_masks() {
		let dib = qt_cf_dib(2, 2, &PIXELS_2X2, 3);
		let png = dib_to_png(&dib).expect("BI_BITFIELDS CF_DIB must decode");
		let (w, h, px) = decode_pixels(&png);
		assert_eq!((w, h), (2, 2));
		// Row order flipped versus the bottom-up pixel array; BGRA -> RGBA.
		assert_eq!(px, vec![BLUE, WHITE, RED, GREEN]);
	}

	#[test]
	fn decodes_pixpin_dibv5_payload_that_arboard_rejects() {
		let dib = pixpin_dibv5_tweaked(2, 2, &PIXELS_2X2);
		let png = dib_to_png(&dib).expect("V5 BI_BITFIELDS DIB must decode");
		let (w, h, px) = decode_pixels(&png);
		assert_eq!((w, h), (2, 2));
		assert_eq!(px, vec![BLUE, WHITE, RED, GREEN]);
	}

	#[test]
	fn decodes_plain_bi_rgb_dib() {
		// The common "copy image" payload: BI_RGB, 32-bit, no masks. The
		// fourth byte is unused per the DIB contract — zero it to prove the
		// decode still yields opaque pixels.
		let mut pixels = PIXELS_2X2;
		for alpha in pixels.iter_mut().skip(3).step_by(4) {
			*alpha = 0;
		}
		let dib = qt_cf_dib(2, 2, &pixels, 0);
		let png = dib_to_png(&dib).expect("BI_RGB CF_DIB must decode");
		let (w, h, px) = decode_pixels(&png);
		assert_eq!((w, h), (2, 2));
		assert_eq!(px, vec![BLUE, WHITE, RED, GREEN]);
	}

	#[test]
	fn rejects_malformed_dib() {
		assert!(dib_to_png(&[0u8; 12]).is_err(), "short buffer must not decode");
		let mut oversized_header = qt_cf_dib(2, 2, &PIXELS_2X2, 3);
		oversized_header[0..4].copy_from_slice(&0xffff_ffffu32.to_le_bytes());
		assert!(dib_to_png(&oversized_header).is_err(), "header size beyond buffer must not decode");
	}
}
