//! Character encoding detection and decoding for web documents.

use encoding_rs::{Encoding, UTF_8, WINDOWS_1252};

use crate::dom;

pub(crate) fn charset(content_type: &str) -> Option<&'static Encoding> {
	content_type
		.split(';')
		.filter_map(|f| f.trim().split_once('='))
		.find(|(k, _)| k.trim().eq_ignore_ascii_case("charset"))
		.and_then(|(_, v)| Encoding::for_label(v.trim().trim_matches(['\'', '"']).as_bytes()))
}

fn meta_charset(bytes: &[u8]) -> Option<&'static Encoding> {
	// HTML encoding declarations must appear in the first 1024 bytes. Most pages
	// don't need a prescan.
	let prefix = &bytes[..bytes.len().min(1024)];
	if !prefix.windows(5).any(|s| s.eq_ignore_ascii_case(b"<meta")) {
		return None;
	}
	let prefix = String::from_utf8_lossy(prefix);
	let dom = dom::parse(&prefix).ok()?;
	for node in &dom {
		let dom::Node::Tag(tag) = node else {
			continue;
		};
		if tag.name() != "meta" {
			continue;
		}
		let encoding = tag
			.attr("charset")
			.and_then(|s| Encoding::for_label(s.as_bytes()))
			.or_else(|| {
				tag.attr("http-equiv")
					.filter(|v| v.eq_ignore_ascii_case("content-type"))
					.and_then(|_| tag.attr("content"))
					.and_then(charset)
			});
		if let Some(enc) = encoding {
			// A UTF-16 declaration in an ASCII-encoded meta element is interpreted
			// as UTF-8.
			return Some(if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
				UTF_8
			} else {
				enc
			});
		}
	}
	None
}

/// Decode bytes using a BOM, the transport charset, an HTML meta declaration,
/// or UTF-8 with a Windows-1252 fallback, in that order.
///
/// Strip control characters other than the whitespace used for document
/// layout.
pub fn decode(bytes: &[u8], content_type: Option<&str>, html: bool) -> String {
	let declared = Encoding::for_bom(bytes).or_else(|| {
		content_type
			.and_then(charset)
			.or_else(|| if html { meta_charset(bytes) } else { None })
			.map(|encoding| (encoding, 0))
	});
	let mut body = match declared {
		None => match str::from_utf8(bytes) {
			Ok(text) => std::borrow::Cow::Borrowed(text),
			Err(_) => WINDOWS_1252.decode_without_bom_handling(bytes).0,
		},
		Some((encoding, skip)) => encoding.decode_without_bom_handling(&bytes[skip..]).0,
	};
	let shown = |c: char| !c.is_control() || matches!(c, '\n' | '\r' | '\t' | '\x0c');
	if !body.chars().all(shown) {
		body.to_mut().retain(shown);
	}
	body.into_owned()
}

#[cfg(test)]
mod tests {
	use super::decode;

	#[test]
	fn decode_uses_bom_then_transport_then_html_meta() {
		let html = b"<meta charset=windows-1252><p>\x80</p>";
		assert!(decode(html, None, true).contains('€'));
		assert!(decode(html, Some("text/html; charset=\"windows-1251\""), true).contains('Ђ'));
		assert_eq!(decode(b"\xff\xfex\0", Some("text/plain; charset=windows-1252"), false), "x");
	}

	#[test]
	fn undeclared_legacy_bytes_and_stray_controls_still_render() {
		assert!(decode(b"<p>caf\xe9</p>", Some("text/html"), true).contains("café"));
		let bare = b"<meta http-equiv=Content-Type content='charset=windows-1251'><p>\x80</p>";
		assert!(decode(bare, None, true).contains('Ђ'));
		assert!(!decode(bare, Some("text/plain"), false).contains('Ђ'));
		let text = "a\x1b[1mb\u{85}c\tz".as_bytes();
		assert_eq!(decode(text, Some("text/plain"), false), "a[1mbc\tz");
	}
}
