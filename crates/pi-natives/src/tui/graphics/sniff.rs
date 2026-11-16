//! Pixel dimensions from an image header: PNG, JPEG, GIF and WebP, the
//! formats inline images arrive in. Ported from pi-tui's
//! `get{Png,Jpeg,Gif,Webp}Dimensions`.

use base64::{
	Engine as _,
	engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig, general_purpose::STANDARD},
};

/// Image size in pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Dimensions {
	pub width_px:  u32,
	pub height_px: u32,
}

/// Base64 decoder as lenient as `Buffer.from(data, "base64")` about padding
/// and trailing bits.
const LENIENT: GeneralPurpose = GeneralPurpose::new(
	&base64::alphabet::STANDARD,
	GeneralPurposeConfig::new()
		.with_decode_padding_mode(DecodePaddingMode::Indifferent)
		.with_decode_allow_trailing_bits(true),
);

/// Decode base64 image data; line breaks and other ASCII whitespace are
/// skipped like `Buffer.from` does. `None` for anything else malformed.
pub fn decode_base64(data: &str) -> Option<Vec<u8>> {
	if let Ok(bytes) = LENIENT.decode(data) {
		return Some(bytes);
	}
	let compact: Vec<u8> = data
		.bytes()
		.filter(|byte| !byte.is_ascii_whitespace())
		.collect();
	LENIENT.decode(compact).ok()
}

/// Base64 characters covering the longest fixed-offset header (30 bytes of
/// WebP).
const HEADER_BASE64_LEN: usize = 40;

/// Dimensions of base64 `data` of `mime_type`, or `None` for another type
/// or a header that does not parse. Fixed-offset headers decode only their
/// prefix; JPEG scans its segments and decodes the whole image.
pub fn base64_dimensions(data: &str, mime_type: &str) -> Option<Dimensions> {
	let fixed_header = matches!(mime_type, "image/png" | "image/gif" | "image/webp");
	if fixed_header
		&& data.len() > HEADER_BASE64_LEN
		&& let Some(prefix) = data.get(..HEADER_BASE64_LEN)
		&& let Ok(header) = STANDARD.decode(prefix)
	{
		return dimensions(&header, mime_type);
	}
	dimensions(&decode_base64(data)?, mime_type)
}

/// Dimensions of image `bytes` of `mime_type`.
pub fn dimensions(bytes: &[u8], mime_type: &str) -> Option<Dimensions> {
	match mime_type {
		"image/png" => png(bytes),
		"image/jpeg" => jpeg(bytes),
		"image/gif" => gif(bytes),
		"image/webp" => webp(bytes),
		_ => None,
	}
}

fn u16_be(bytes: &[u8], at: usize) -> Option<u32> {
	Some(u32::from(u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?)))
}

fn u16_le(bytes: &[u8], at: usize) -> Option<u32> {
	Some(u32::from(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?)))
}

fn u32_be(bytes: &[u8], at: usize) -> Option<u32> {
	Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn u32_le(bytes: &[u8], at: usize) -> Option<u32> {
	Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn u24_le(bytes: &[u8], at: usize) -> Option<u32> {
	let b = bytes.get(at..at + 3)?;
	Some(u32::from(b[0]) | (u32::from(b[1]) << 8) | (u32::from(b[2]) << 16))
}

/// PNG: the IHDR width/height right after the signature.
fn png(bytes: &[u8]) -> Option<Dimensions> {
	if bytes.len() < 24 || !bytes.starts_with(b"\x89PNG") {
		return None;
	}
	Some(Dimensions { width_px: u32_be(bytes, 16)?, height_px: u32_be(bytes, 20)? })
}

/// JPEG: walk the marker segments to the first baseline/extended/progressive
/// start-of-frame (`SOF0`..`SOF2`).
fn jpeg(bytes: &[u8]) -> Option<Dimensions> {
	if !bytes.starts_with(&[0xff, 0xd8]) {
		return None;
	}
	let mut offset = 2;
	while offset + 9 < bytes.len() {
		if bytes[offset] != 0xff {
			offset += 1;
			continue;
		}
		if (0xc0..=0xc2).contains(&bytes[offset + 1]) {
			return Some(Dimensions {
				height_px: u16_be(bytes, offset + 5)?,
				width_px:  u16_be(bytes, offset + 7)?,
			});
		}
		let length = u16_be(bytes, offset + 2)? as usize;
		if length < 2 {
			return None;
		}
		offset += 2 + length;
	}
	None
}

/// GIF: the logical screen size after the `GIF87a`/`GIF89a` signature.
fn gif(bytes: &[u8]) -> Option<Dimensions> {
	if bytes.len() < 10 || !(bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
		return None;
	}
	Some(Dimensions { width_px: u16_le(bytes, 6)?, height_px: u16_le(bytes, 8)? })
}

/// WebP: the frame size of the lossy (`VP8 `), lossless (`VP8L`) or
/// extended (`VP8X`) first chunk.
fn webp(bytes: &[u8]) -> Option<Dimensions> {
	if bytes.len() < 30 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
		return None;
	}
	match &bytes[12..16] {
		b"VP8 " => Some(Dimensions {
			width_px:  u16_le(bytes, 26)? & 0x3fff,
			height_px: u16_le(bytes, 28)? & 0x3fff,
		}),
		b"VP8L" => {
			let bits = u32_le(bytes, 21)?;
			Some(Dimensions { width_px: (bits & 0x3fff) + 1, height_px: ((bits >> 14) & 0x3fff) + 1 })
		},
		b"VP8X" => {
			Some(Dimensions { width_px: u24_le(bytes, 24)? + 1, height_px: u24_le(bytes, 27)? + 1 })
		},
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const ONE_PIXEL_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

	const fn dims(width_px: u32, height_px: u32) -> Dimensions {
		Dimensions { width_px, height_px }
	}

	#[test]
	fn reads_png_from_its_base64_prefix() {
		assert_eq!(base64_dimensions(ONE_PIXEL_PNG, "image/png"), Some(dims(1, 1)));
		let mut header = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
		header.extend_from_slice(&640u32.to_be_bytes());
		header.extend_from_slice(&480u32.to_be_bytes());
		assert_eq!(dimensions(&header, "image/png"), Some(dims(640, 480)));
		assert_eq!(dimensions(&header[..23], "image/png"), None);
		assert_eq!(dimensions(&header, "image/gif"), None);
		assert_eq!(base64_dimensions(ONE_PIXEL_PNG, "image/svg+xml"), None);
	}

	#[test]
	fn scans_jpeg_segments_to_the_start_of_frame() {
		let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0xaa, 0xbb];
		// SOF2: length, precision, height 300, width 200.
		jpeg.extend_from_slice(&[0xff, 0xc2, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x00, 0xc8, 0x03]);
		assert_eq!(dimensions(&jpeg, "image/jpeg"), Some(dims(200, 300)));
		// A segment length under 2 cannot advance.
		assert_eq!(
			dimensions(&[0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0, 0, 0, 0, 0, 0], "image/jpeg"),
			None
		);
		assert_eq!(dimensions(&[0xff, 0xd9], "image/jpeg"), None);
		let encoded = STANDARD.encode(&jpeg);
		assert_eq!(base64_dimensions(&encoded, "image/jpeg"), Some(dims(200, 300)));
	}

	#[test]
	fn reads_gif_logical_screen() {
		assert_eq!(dimensions(b"GIF89a\x0a\x00\x14\x00", "image/gif"), Some(dims(10, 20)));
		assert_eq!(dimensions(b"GIF87a\x0a\x00\x14\x00", "image/gif"), Some(dims(10, 20)));
		assert_eq!(dimensions(b"GIF90a\x0a\x00\x14\x00", "image/gif"), None);
	}

	#[test]
	fn reads_each_webp_frame_chunk() {
		let mut lossy = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
		lossy.resize(26, 0);
		lossy.extend_from_slice(&(0xc000u16 | 0x140).to_le_bytes());
		lossy.extend_from_slice(&240u16.to_le_bytes());
		assert_eq!(dimensions(&lossy, "image/webp"), Some(dims(320, 240)));

		let mut lossless = b"RIFF\0\0\0\0WEBPVP8L".to_vec();
		lossless.resize(21, 0);
		lossless.extend_from_slice(&(0x63u32 | (0x31 << 14)).to_le_bytes());
		lossless.resize(30, 0);
		assert_eq!(dimensions(&lossless, "image/webp"), Some(dims(100, 50)));

		let mut extended = b"RIFF\0\0\0\0WEBPVP8X".to_vec();
		extended.resize(24, 0);
		extended.extend_from_slice(&[0xff, 0x0f, 0x00, 0x7f, 0x00, 0x00]);
		assert_eq!(dimensions(&extended, "image/webp"), Some(dims(4096, 128)));
		assert_eq!(
			base64_dimensions(&STANDARD.encode(&extended), "image/webp"),
			Some(dims(4096, 128))
		);

		assert_eq!(dimensions(&extended[..29], "image/webp"), None);
	}

	#[test]
	fn decodes_base64_leniently() {
		assert_eq!(decode_base64("AA"), Some(vec![0]));
		assert_eq!(decode_base64("AA==\n"), Some(vec![0]));
		assert_eq!(decode_base64("A A=="), Some(vec![0]));
		assert_eq!(decode_base64("*"), None);
	}
}
