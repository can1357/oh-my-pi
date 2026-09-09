//! Terminal graphics passthrough for binary device output.
//!
//! Image-returning devices write their pixels to stdout as a kitty graphics
//! direct transmission (`ESC _ G a=T,t=d,f=100,q=2,m=<more>;<base64> ESC \`)
//! so a kitty-compatible terminal renders them inline while plain text keeps
//! composing with pipes and redirection. The MIME type has no kitty key —
//! kitty rejects control blocks carrying unknown keys — so it rides in a
//! separate application program command (`ESC _ omp;mime=<type> ESC \`) that
//! terminals ignore, immediately before the transmission.
//!
//! [`extract_image_passthrough`] is the exact inverse: the Bash tool runs it
//! over captured shell output to attach the images and keep the surrounding
//! text clean, so remote images (over ssh, say) need no special tool.

use std::ops::Range;

use bytes::Bytes;
use omp_core::{Str, base64};

/// Raw image bytes per kitty chunk; encodes to exactly 4096 base64 characters.
const CHUNK_BYTES: usize = 3072;
const APC_START: &[u8] = b"\x1b_";
const APC_END: &[u8] = b"\x1b\\";
const MIME_MARKER: &[u8] = b"omp;mime=";

/// One image recovered from terminal graphics passthrough.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImagePassthrough {
	/// MIME type recorded beside the transmission, or sniffed from the bytes
	/// when no marker preceded it.
	pub mime:  Str,
	/// Exact image bytes.
	pub bytes: Bytes,
}

/// Appends `bytes` to `out` as a kitty direct transmission preceded by a MIME
/// marker.
///
/// `f=100` names PNG, the only compressed format kitty decodes; other image
/// types still round-trip through [`extract_image_passthrough`] unchanged, the
/// terminal merely declines to render them (`q=2` suppresses its reply).
pub fn encode_image_passthrough(mime: &str, bytes: &[u8], out: &mut Vec<u8>) {
	out.reserve(
		APC_START.len()
			+ MIME_MARKER.len()
			+ mime.len()
			+ APC_END.len()
			+ bytes.len().div_ceil(CHUNK_BYTES) * 40
			+ bytes.len().div_ceil(3) * 4,
	);
	out.extend_from_slice(APC_START);
	out.extend_from_slice(MIME_MARKER);
	out.extend_from_slice(mime.as_bytes());
	out.extend_from_slice(APC_END);
	let chunks = bytes.chunks(CHUNK_BYTES);
	let count = chunks.len().max(1);
	let mut chunks = chunks.peekable();
	let mut index = 0;
	loop {
		let chunk = chunks.next().unwrap_or_default();
		let more = index + 1 < count;
		out.extend_from_slice(APC_START);
		out.extend_from_slice(b"G");
		if index == 0 {
			out.extend_from_slice(b"a=T,t=d,f=100,q=2,");
		}
		out.extend_from_slice(if more { b"m=1;" } else { b"m=0;" });
		base64::encode(chunk).extend_into(out);
		out.extend_from_slice(APC_END);
		index += 1;
		if chunks.peek().is_none() {
			break;
		}
	}
}

/// Splits captured output into text with every passthrough removed and the
/// images it carried, in order.
///
/// Only sequences this module emits are consumed: `G`-prefixed kitty
/// transmissions and `omp;mime=` markers. Any other application program
/// command, an unterminated sequence, or a transmission whose payload is not
/// base64 stays in the text verbatim.
pub fn extract_image_passthrough(output: &[u8]) -> (Vec<u8>, Vec<ImagePassthrough>) {
	let (text, images, _) = extract_with_ranges(output);
	(text, images)
}

/// Locates valid image passthrough in `output`, returning the images and exact
/// byte ranges occupied by their framing. Ranges are ordered and disjoint so
/// callers can remove framing from a segmented transcript without joining or
/// truncating surrounding output.
pub fn image_passthrough_ranges(output: &[u8]) -> (Vec<ImagePassthrough>, Vec<Range<usize>>) {
	let (_, images, ranges) = extract_with_ranges(output);
	(images, ranges)
}

fn extract_with_ranges(output: &[u8]) -> (Vec<u8>, Vec<ImagePassthrough>, Vec<Range<usize>>) {
	let mut text = Vec::with_capacity(output.len());
	let mut images = Vec::new();
	let mut ranges = Vec::new();
	let mut pending_mime: Option<Str> = None;
	let mut image: Option<Vec<u8>> = None;
	let mut cursor = 0;
	while cursor < output.len() {
		let Some(offset) = find(&output[cursor..], APC_START) else {
			text.extend_from_slice(&output[cursor..]);
			break;
		};
		let start = cursor + offset;
		let body_start = start + APC_START.len();
		let Some(body_len) = find(&output[body_start..], APC_END) else {
			text.extend_from_slice(&output[cursor..]);
			break;
		};
		let body = &output[body_start..body_start + body_len];
		let end = body_start + body_len + APC_END.len();
		let consumed = match Apc::parse(body) {
			Some(Apc::Mime(mime)) => {
				pending_mime = Some(Str::new(mime));
				true
			},
			Some(Apc::Chunk { first, more, payload }) => match base64::decode(payload).into_vec() {
				Ok(decoded) => {
					match image.as_mut() {
						Some(buffer) if !first => buffer.extend_from_slice(&decoded),
						_ => image = Some(decoded),
					}
					if !more && let Some(bytes) = image.take() {
						let mime = pending_mime.take().unwrap_or_else(|| sniff_mime(&bytes));
						images.push(ImagePassthrough { mime, bytes: Bytes::from(bytes) });
					}
					true
				},
				Err(_) => false,
			},
			None => false,
		};
		if consumed {
			text.extend_from_slice(&output[cursor..start]);
			ranges.push(start..end);
		} else {
			text.extend_from_slice(&output[cursor..end]);
		}
		cursor = end;
	}
	(text, images, ranges)
}

enum Apc<'a> {
	Mime(&'a str),
	Chunk { first: bool, more: bool, payload: &'a [u8] },
}

impl<'a> Apc<'a> {
	fn parse(body: &'a [u8]) -> Option<Self> {
		if let Some(mime) = body.strip_prefix(MIME_MARKER) {
			return std::str::from_utf8(mime).ok().map(Apc::Mime);
		}
		let control = body.strip_prefix(b"G")?;
		let separator = control.iter().position(|byte| *byte == b';')?;
		let (keys, payload) = (&control[..separator], &control[separator + 1..]);
		let mut first = false;
		let mut more = false;
		for pair in keys.split(|byte| *byte == b',') {
			match pair {
				b"a=T" | b"a=t" => first = true,
				b"m=1" => more = true,
				b"m=0" => more = false,
				_ => {},
			}
		}
		Some(Apc::Chunk { first, more, payload })
	}
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
	haystack
		.windows(needle.len())
		.position(|window| window == needle)
}

fn sniff_mime(bytes: &[u8]) -> Str {
	Str::new_static(match bytes {
		[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, ..] => "image/png",
		[0xff, 0xd8, 0xff, ..] => "image/jpeg",
		[b'G', b'I', b'F', b'8', ..] => "image/gif",
		[b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
		[b'B', b'M', ..] => "image/bmp",
		_ => "application/octet-stream",
	})
}

#[cfg(test)]
mod tests {
	use super::{ImagePassthrough, encode_image_passthrough, extract_image_passthrough};

	const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

	fn png(len: usize) -> Vec<u8> {
		let mut bytes = PNG_MAGIC.to_vec();
		bytes.extend((0..len).map(|index| (index * 7 % 251) as u8));
		bytes
	}

	#[test]
	fn round_trip_recovers_bytes_mime_and_clean_text() {
		let image = png(10_000);
		let mut output = b"before\n".to_vec();
		encode_image_passthrough("image/png", &image, &mut output);
		output.extend_from_slice(b"\nafter\n");

		assert_eq!(output.windows(3).filter(|w| *w == b"\x1b_G").count(), 4);
		assert!(output.windows(6).any(|w| w == b"f=100,"));

		let (text, images) = extract_image_passthrough(&output);
		assert_eq!(text, b"before\n\nafter\n");
		assert_eq!(images, vec![ImagePassthrough { mime: "image/png".into(), bytes: image.into() }]);
	}

	#[test]
	fn non_png_mime_and_empty_image_round_trip() {
		let jpeg = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3];
		let mut output = Vec::new();
		encode_image_passthrough("image/jpeg", &jpeg, &mut output);
		encode_image_passthrough("image/x-empty", &[], &mut output);
		let (text, images) = extract_image_passthrough(&output);
		assert!(text.is_empty());
		assert_eq!(images.len(), 2);
		assert_eq!(images[0].mime.as_str(), "image/jpeg");
		assert_eq!(&images[0].bytes[..], &jpeg);
		assert_eq!(images[1].mime.as_str(), "image/x-empty");
		assert!(images[1].bytes.is_empty());
	}

	#[test]
	fn foreign_transmission_without_marker_is_sniffed() {
		let output = b"\x1b_Ga=T,f=100,m=0;/9j/4A==\x1b\\tail".to_vec();
		let (text, images) = extract_image_passthrough(&output);
		assert_eq!(text, b"tail");
		assert_eq!(images.len(), 1);
		assert_eq!(images[0].mime.as_str(), "image/jpeg");
	}

	#[test]
	fn foreign_apcs_and_unterminated_sequences_stay_in_text() {
		let output = b"a\x1b_Xother\x1b\\b\x1b_Gm=0;!!notbase64\x1b\\c\x1b_Gm=0;QUJD".to_vec();
		let (text, images) = extract_image_passthrough(&output);
		assert_eq!(text, output);
		assert!(images.is_empty());
	}
}
