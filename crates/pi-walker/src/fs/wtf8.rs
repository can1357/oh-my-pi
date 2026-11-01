//! WTF-8 conversions for Windows names: UTF-8, except unpaired surrogates
//! keep their 3-byte generalized encoding so names round-trip exactly (the
//! encoding of `OsStr::as_encoded_bytes` on Windows). Platform-neutral so the
//! round trip is tested everywhere.

/// Appends UTF-16 `src` to `dst` as WTF-8.
pub(crate) fn push_wtf8(dst: &mut Vec<u8>, src: impl IntoIterator<Item = u16>) {
	for unit in char::decode_utf16(src) {
		match unit {
			Ok(c) if c.is_ascii() => dst.push(c as u8),
			Ok(c) => dst.extend_from_slice(c.encode_utf8(&mut [0; char::MAX_LEN_UTF8]).as_bytes()),
			Err(err) => {
				let c = err.unpaired_surrogate();
				dst.extend_from_slice(&[
					0xe0 | (c >> 12) as u8,
					0x80 | ((c >> 6) & 0x3f) as u8,
					0x80 | (c & 0x3f) as u8,
				]);
			},
		}
	}
}

/// Appends WTF-8 `src` to `dst` as UTF-16, mapping `/` to `\` so
/// multi-component relative names resolve in the NT namespace. Malformed
/// sequences become U+FFFD.
pub(crate) fn push_wide(dst: &mut Vec<u16>, src: &[u8]) {
	const REPLACEMENT: u16 = 0xfffd;
	let mut i = 0;
	while i < src.len() {
		let b = src[i];
		if b < 0x80 {
			dst.push(if b == b'/' {
				u16::from(b'\\')
			} else {
				u16::from(b)
			});
			i += 1;
			continue;
		}
		let (len, init) = match b {
			0xc0..=0xdf => (2, b & 0x1f),
			0xe0..=0xef => (3, b & 0x0f),
			0xf0..=0xf7 => (4, b & 0x07),
			_ => (0, 0),
		};
		let tail = src.get(i + 1..i + len.max(1));
		if len == 0 || !tail.is_some_and(|tail| tail.iter().all(|&c| c & 0xc0 == 0x80)) {
			dst.push(REPLACEMENT);
			i += 1;
			continue;
		}
		let cp = tail
			.unwrap_or_default()
			.iter()
			.fold(u32::from(init), |cp, &c| (cp << 6) | u32::from(c & 0x3f));
		i += len;
		match cp {
			0..=0xffff => dst.push(cp as u16),
			0x1_0000..=0x10_ffff => {
				let v = cp - 0x1_0000;
				dst.push(0xd800 + (v >> 10) as u16);
				dst.push(0xdc00 + (v & 0x3ff) as u16);
			},
			_ => dst.push(REPLACEMENT),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Unpaired surrogates survive UTF-16 -> WTF-8 -> UTF-16; paired ones
	/// become ordinary UTF-8.
	#[test]
	fn wtf8_round_trips_unpaired_surrogates() {
		let cases: [&[u16]; 5] =
			[&[0x61, 0x62], &[0xd83d, 0xde00], &[0xd800], &[0x61, 0xdc00, 0x62], &[
				0xdbff, 0xd800, 0xdfff,
			]];
		for wide in cases {
			let mut wtf8 = Vec::new();
			push_wtf8(&mut wtf8, wide.iter().copied());
			let mut back = Vec::new();
			push_wide(&mut back, &wtf8);
			assert_eq!(back, wide, "round trip of {wide:x?} via {wtf8:x?}");
		}
		let mut wtf8 = Vec::new();
		push_wtf8(&mut wtf8, [0xd83d, 0xde00, 0xd800]);
		assert_eq!(wtf8, b"\xf0\x9f\x98\x80\xed\xa0\x80");
	}

	#[test]
	fn wide_maps_slashes_and_replaces_malformed_bytes() {
		let mut wide = Vec::new();
		push_wide(&mut wide, b"a/b\xffc\xe2\x82");
		assert_eq!(wide, [0x61, 0x5c, 0x62, 0xfffd, 0x63, 0xfffd, 0xfffd]);
	}

	#[cfg(windows)]
	#[test]
	fn wtf8_matches_os_str_encoding() {
		use std::{ffi::OsString, os::windows::ffi::OsStringExt};
		let wide = [0x61, 0xd800, 0xd83d, 0xde00];
		let mut wtf8 = Vec::new();
		push_wtf8(&mut wtf8, wide);
		assert_eq!(wtf8, OsString::from_wide(&wide).as_encoded_bytes());
	}
}
