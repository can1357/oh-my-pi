//! Header-only image dimension probes.
//!
//! These probes inspect container headers only; they never decode pixel data.

/// An image container recognized from its magic bytes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImageFormat {
	/// Portable Network Graphics.
	Png,
	/// Joint Photographic Experts Group.
	Jpeg,
	/// Graphics Interchange Format.
	Gif,
	/// WebP.
	Webp,
}

impl ImageFormat {
	/// The container's IANA media type (`image/png`, …).
	#[must_use]
	pub const fn media_type(self) -> &'static str {
		match self {
			Self::Png => "image/png",
			Self::Jpeg => "image/jpeg",
			Self::Gif => "image/gif",
			Self::Webp => "image/webp",
		}
	}
}

/// Identifies a supported image container from its magic bytes.
pub fn format(bytes: &[u8]) -> Option<ImageFormat> {
	if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
		Some(ImageFormat::Png)
	} else if bytes.starts_with(&[0xff, 0xd8]) {
		Some(ImageFormat::Jpeg)
	} else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
		Some(ImageFormat::Gif)
	} else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
		Some(ImageFormat::Webp)
	} else {
		None
	}
}

/// Pixel dimensions read from an image header.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ImageDimensions {
	/// Image width in pixels.
	pub width:  u32,
	/// Image height in pixels.
	pub height: u32,
}

/// Reads pixel dimensions from a PNG, JPEG, GIF, or WebP header.
///
/// The format is selected from its magic bytes. Truncated or malformed headers
/// and unsupported formats return `None`.
pub fn dimensions(bytes: &[u8]) -> Option<ImageDimensions> {
	match format(bytes)? {
		ImageFormat::Png => png_dimensions(bytes),
		ImageFormat::Jpeg => jpeg_dimensions(bytes),
		ImageFormat::Gif => gif_dimensions(bytes),
		ImageFormat::Webp => webp_dimensions(bytes),
	}
}

fn image_dimensions(width: u32, height: u32) -> Option<ImageDimensions> {
	(width != 0 && height != 0).then_some(ImageDimensions { width, height })
}

fn png_dimensions(bytes: &[u8]) -> Option<ImageDimensions> {
	if bytes.get(12..16)? != b"IHDR" {
		return None;
	}
	let width = u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?);
	let height = u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?);
	image_dimensions(width, height)
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<ImageDimensions> {
	let mut at = 2;
	while at < bytes.len() {
		if bytes[at] != 0xff {
			at += 1;
			continue;
		}
		// A marker may have any number of FF padding bytes.
		while bytes.get(at) == Some(&0xff) {
			at += 1;
		}
		let marker = *bytes.get(at)?;
		at += 1;

		match marker {
			// Stuffed bytes are not segment markers. Once a scan begins, dimensions
			// must already have appeared, so continuing cannot discover a SOF safely.
			0x00 => continue,
			0xd9 | 0xda => return None,
			// Standalone markers have no length field.
			0x01 | 0xd0..=0xd8 => continue,
			_ => {},
		}

		let length = usize::from(u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?));
		if length < 2 {
			return None;
		}
		let end = at.checked_add(length)?;
		if end > bytes.len() {
			return None;
		}

		// SOF0..SOF15, excluding DHT (C4), JPG (C8), and DAC (CC).
		if matches!(marker, 0xc0..=0xcf) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
			if length < 7 {
				return None;
			}
			let height = u32::from(u16::from_be_bytes(bytes.get(at + 3..at + 5)?.try_into().ok()?));
			let width = u32::from(u16::from_be_bytes(bytes.get(at + 5..at + 7)?.try_into().ok()?));
			return image_dimensions(width, height);
		}
		at = end;
	}
	None
}

fn gif_dimensions(bytes: &[u8]) -> Option<ImageDimensions> {
	let width = u32::from(u16::from_le_bytes(bytes.get(6..8)?.try_into().ok()?));
	let height = u32::from(u16::from_le_bytes(bytes.get(8..10)?.try_into().ok()?));
	image_dimensions(width, height)
}

fn webp_dimensions(bytes: &[u8]) -> Option<ImageDimensions> {
	if bytes.get(8..12)? != b"WEBP" {
		return None;
	}
	match bytes.get(12..16)? {
		b"VP8 " => {
			let width = u32::from(u16::from_le_bytes(bytes.get(26..28)?.try_into().ok()?) & 0x3fff);
			let height = u32::from(u16::from_le_bytes(bytes.get(28..30)?.try_into().ok()?) & 0x3fff);
			image_dimensions(width, height)
		},
		b"VP8L" => {
			let packed = u32::from_le_bytes(bytes.get(21..25)?.try_into().ok()?);
			let width = (packed & 0x3fff) + 1;
			let height = ((packed >> 14) & 0x3fff) + 1;
			image_dimensions(width, height)
		},
		b"VP8X" => {
			let packed = bytes.get(24..30)?;
			let width = u32::from(packed[0]) | u32::from(packed[1]) << 8 | u32::from(packed[2]) << 16;
			let height = u32::from(packed[3]) | u32::from(packed[4]) << 8 | u32::from(packed[5]) << 16;
			image_dimensions(width + 1, height + 1)
		},
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn assert_dimensions(bytes: &[u8], width: u32, height: u32) {
		assert_eq!(dimensions(bytes), Some(ImageDimensions { width, height }));
	}
	#[test]
	fn sniffs_supported_magic_bytes() {
		assert_eq!(format(b"\x89PNG\r\n\x1a\n"), Some(ImageFormat::Png));
		assert_eq!(format(&[0xff, 0xd8]), Some(ImageFormat::Jpeg));
		assert_eq!(format(b"GIF89a"), Some(ImageFormat::Gif));
		assert_eq!(format(b"RIFF\0\0\0\0WEBP"), Some(ImageFormat::Webp));
		assert_eq!(format(b"RIFF\0\0\0\0WAVE"), None);
		assert_eq!(format(b"garbage"), None);
	}

	#[test]
	fn probes_png_ihdr() {
		let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
		bytes.extend_from_slice(&640_u32.to_be_bytes());
		bytes.extend_from_slice(&480_u32.to_be_bytes());
		assert_dimensions(&bytes, 640, 480);
	}

	#[test]
	fn probes_jpeg_baseline_and_progressive_sof() {
		for marker in [0xc0, 0xc2] {
			let bytes = [
				0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, marker, 0x00, 0x08, 8, 0x01, 0xe0,
				0x02, 0x80, 1,
			];
			assert_dimensions(&bytes, 640, 480);
		}
	}

	#[test]
	fn probes_gif87a_and_gif89a() {
		for signature in [b"GIF87a", b"GIF89a"] {
			let mut bytes = signature.to_vec();
			bytes.extend_from_slice(&320_u16.to_le_bytes());
			bytes.extend_from_slice(&200_u16.to_le_bytes());
			assert_dimensions(&bytes, 320, 200);
		}
	}

	#[test]
	fn probes_webp_vp8() {
		let mut bytes = vec![0; 30];
		bytes[0..4].copy_from_slice(b"RIFF");
		bytes[8..12].copy_from_slice(b"WEBP");
		bytes[12..16].copy_from_slice(b"VP8 ");
		bytes[26..28].copy_from_slice(&(0xc000_u16 | 0x03e8).to_le_bytes());
		bytes[28..30].copy_from_slice(&(0x8000_u16 | 0x02bc).to_le_bytes());
		assert_dimensions(&bytes, 1000, 700);
	}

	#[test]
	fn probes_webp_vp8l() {
		let mut bytes = vec![0; 25];
		bytes[0..4].copy_from_slice(b"RIFF");
		bytes[8..12].copy_from_slice(b"WEBP");
		bytes[12..16].copy_from_slice(b"VP8L");
		let packed = (511_u32 - 1) | ((257_u32 - 1) << 14);
		bytes[21..25].copy_from_slice(&packed.to_le_bytes());
		assert_dimensions(&bytes, 511, 257);
	}

	#[test]
	fn probes_webp_vp8x() {
		let mut bytes = vec![0; 30];
		bytes[0..4].copy_from_slice(b"RIFF");
		bytes[8..12].copy_from_slice(b"WEBP");
		bytes[12..16].copy_from_slice(b"VP8X");
		bytes[24..27].copy_from_slice(&[0xff, 0x00, 0x01]);
		bytes[27..30].copy_from_slice(&[0x01, 0x02, 0x03]);
		assert_dimensions(&bytes, 65_792, 197_122);
	}

	#[test]
	fn rejects_truncated_headers() {
		let headers: &[&[u8]] = &[
			b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0",
			&[0xff, 0xd8, 0xff, 0xc0, 0, 8, 8],
			b"GIF89a\x01",
			b"RIFF\0\0\0\0WEBPVP8 ",
			b"RIFF\0\0\0\0WEBPVP8L",
			b"RIFF\0\0\0\0WEBPVP8X",
		];
		for header in headers {
			assert_eq!(dimensions(header), None, "accepted truncated header: {header:?}");
		}
	}
}
