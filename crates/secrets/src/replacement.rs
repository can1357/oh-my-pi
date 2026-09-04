use std::str;

use hmac::{Hmac, Mac as _};
use regex::Regex;
use sha2::Sha256;

/// Alphabet used by deterministic and keyed replacement runs.
pub const REPLACEMENT_CHARS: &[u8] =
	b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const NONMATCHING_REPLACEMENT_CHARS: &[u8] =
	b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,-./:;<=>?@[]^_{|}~";
const REGEX_REMATCH_BACKSCAN: usize = 512;

/// Surrounding text and byte span for a regex match.
#[derive(Clone, Copy, Debug)]
pub struct RegexMatchContext<'a> {
	/// Full text in which the match was found.
	pub text:  &'a str,
	/// Match start byte offset.
	pub start: usize,
	/// Match end byte offset.
	pub end:   usize,
}

/// Generates a deterministic, byte-length-preserving `ZZ` replacement.
pub fn generate_deterministic_replacement(secret: &str) -> String {
	let length = secret.encode_utf16().count();
	if length == 0 {
		return String::new();
	}
	let hash = bun_wyhash(secret.as_bytes());
	let mut output = String::with_capacity(length);
	output.push('Z');
	if length > 1 {
		output.push('Z');
	}
	let mut mixed = u128::from(hash);
	for index in output.len()..length {
		mixed ^= (index as u128 + 1)
			.checked_mul(0x9e37_79b9_7f4a_7c15)
			.expect("replacement length fits Bun bigint emulation");
		output.push(REPLACEMENT_CHARS[(mixed % REPLACEMENT_CHARS.len() as u128) as usize] as char);
	}
	output
}

/// Computes Bun-compatible Wyhash used by deterministic secret-safe
/// fingerprints.
pub fn bun_wyhash(input: &[u8]) -> u64 {
	const SECRET: [u64; 4] =
		[0xa076_1d64_78bd_642f, 0xe703_7ed1_a0b4_28db, 0x8ebc_6af0_9c88_c6e3, 0x5899_65cc_7537_4cc3];
	let initial = mix(SECRET[0], SECRET[1]);
	let mut state = [initial; 3];
	let length = input.len();
	let (a, b) = if length <= 16 {
		if length >= 4 {
			let end = length - 4;
			let quarter = (length >> 3) << 2;
			(
				(read4(input, 0) << 32) | read4(input, quarter),
				(read4(input, end) << 32) | read4(input, end - quarter),
			)
		} else if length > 0 {
			(
				(u64::from(input[0]) << 16)
					| (u64::from(input[length >> 1]) << 8)
					| u64::from(input[length - 1]),
				0,
			)
		} else {
			(0, 0)
		}
	} else {
		let mut offset = 0;
		if length >= 48 {
			while offset + 48 < length {
				state[0] = mix(read8(input, offset) ^ SECRET[1], read8(input, offset + 8) ^ state[0]);
				state[1] =
					mix(read8(input, offset + 16) ^ SECRET[2], read8(input, offset + 24) ^ state[1]);
				state[2] =
					mix(read8(input, offset + 32) ^ SECRET[3], read8(input, offset + 40) ^ state[2]);
				offset += 48;
			}
			state[0] ^= state[1] ^ state[2];
		}
		let mut cursor = offset;
		while cursor + 16 < length {
			state[0] = mix(read8(input, cursor) ^ SECRET[1], read8(input, cursor + 8) ^ state[0]);
			cursor += 16;
		}
		(read8(input, length - 16), read8(input, length - 8))
	};
	let product = u128::from(a ^ SECRET[1]).wrapping_mul(u128::from(b ^ state[0]));
	mix(product as u64 ^ SECRET[0] ^ length as u64, (product >> 64) as u64 ^ SECRET[1])
}

fn mix(left: u64, right: u64) -> u64 {
	let product = u128::from(left).wrapping_mul(u128::from(right));
	product as u64 ^ (product >> 64) as u64
}

fn read4(input: &[u8], offset: usize) -> u64 {
	u64::from(u32::from_le_bytes(input[offset..offset + 4].try_into().expect("four bytes")))
}

fn read8(input: &[u8], offset: usize) -> u64 {
	u64::from_le_bytes(input[offset..offset + 8].try_into().expect("eight bytes"))
}

/// Perturbs the sentinel when a whole replacement would equal its secret.
pub fn ensure_distinct_replacement(mut replacement: String, secret: &str) -> String {
	if !replacement.is_empty() && replacement == secret {
		let alternate = if replacement.as_bytes()[0] == REPLACEMENT_CHARS[0] {
			"B"
		} else {
			"A"
		};
		replacement.replace_range(..1, alternate);
	}
	replacement
}

/// Tests whether a candidate is re-matched over its substituted span in full
/// context.
pub fn regex_rematches_in_context(
	candidate: &str,
	regex: &Regex,
	context: RegexMatchContext<'_>,
) -> bool {
	if context.start > context.end
		|| context.end > context.text.len()
		|| !context.text.is_char_boundary(context.start)
		|| !context.text.is_char_boundary(context.end)
	{
		return true;
	}
	let mut probe =
		String::with_capacity(context.text.len() - (context.end - context.start) + candidate.len());
	probe.push_str(&context.text[..context.start]);
	probe.push_str(candidate);
	probe.push_str(&context.text[context.end..]);
	let span_end = context.start + candidate.len();
	regex
		.find_iter(&probe[context.start.saturating_sub(REGEX_REMATCH_BACKSCAN)..])
		.map(|found| {
			let offset = context.start.saturating_sub(REGEX_REMATCH_BACKSCAN);
			(offset + found.start(), offset + found.end())
		})
		.take_while(|(start, _)| *start < span_end)
		.any(|(_, end)| end > context.start)
}

/// Performs a bounded fixed-point search for a same-length non-matching
/// marker.
pub fn find_non_matching_replacement(
	value: &str,
	regex: &Regex,
	context: RegexMatchContext<'_>,
) -> Option<String> {
	let length = value.encode_utf16().count();
	if length == 0 {
		return None;
	}
	let mut candidate = vec![NONMATCHING_REPLACEMENT_CHARS[0]; length];
	for position in 0..length {
		for &byte in NONMATCHING_REPLACEMENT_CHARS {
			candidate[position] = byte;
			let candidate = str::from_utf8(&candidate).expect("replacement alphabet is ASCII");
			if candidate != value && !regex_rematches_in_context(candidate, regex, context) {
				return Some(candidate.to_owned());
			}
		}
		candidate[position] = NONMATCHING_REPLACEMENT_CHARS[0];
	}
	for &byte in NONMATCHING_REPLACEMENT_CHARS {
		candidate.fill(byte);
		let candidate = str::from_utf8(&candidate).expect("replacement alphabet is ASCII");
		if candidate != value && !regex_rematches_in_context(candidate, regex, context) {
			return Some(candidate.to_owned());
		}
	}
	for whitespace in *b" \t" {
		candidate.fill(whitespace);
		let full = str::from_utf8(&candidate).expect("replacement alphabet is ASCII");
		if full != value && !regex_rematches_in_context(full, regex, context) {
			return Some(full.to_owned());
		}
		candidate.fill(NONMATCHING_REPLACEMENT_CHARS[0]);
		for position in 0..length {
			candidate[position] = whitespace;
			let mixed = str::from_utf8(&candidate).expect("replacement alphabet is ASCII");
			if mixed != value && !regex_rematches_in_context(mixed, regex, context) {
				return Some(mixed.to_owned());
			}
			candidate[position] = NONMATCHING_REPLACEMENT_CHARS[0];
		}
	}
	None
}

/// Builds a deterministic key-derived replacement run for a pathological regex.
pub fn build_keyed_replacement_run(key: &str, length: usize) -> String {
	let mut output = String::with_capacity(length);
	let mut block = 0_u64;
	while output.len() < length {
		let mut mac =
			Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC accepts every key size");
		let (length_bytes, length_start) = decimal_bytes(length as u64);
		let (block_bytes, block_start) = decimal_bytes(block);
		mac.update(b"replace-chunk\0");
		mac.update(&length_bytes[length_start..]);
		mac.update(b"\0");
		mac.update(&block_bytes[block_start..]);
		for byte in mac.finalize().into_bytes() {
			if output.len() == length {
				break;
			}
			output.push(REPLACEMENT_CHARS[byte as usize % REPLACEMENT_CHARS.len()] as char);
		}
		block += 1;
	}
	output
}

const fn decimal_bytes(mut value: u64) -> ([u8; 20], usize) {
	let mut bytes = [0_u8; 20];
	let mut cursor = bytes.len();
	loop {
		cursor -= 1;
		bytes[cursor] = b'0' + (value % 10) as u8;
		value /= 10;
		if value == 0 {
			return (bytes, cursor);
		}
	}
}

/// Chooses a stable default replacement, using the keyed pathological fallback
/// when required.
pub fn regex_replacement(
	value: &str,
	regex: &Regex,
	context: RegexMatchContext<'_>,
	key: &str,
) -> String {
	let deterministic = generate_deterministic_replacement(value);
	if deterministic != value && !regex_rematches_in_context(&deterministic, regex, context) {
		return deterministic;
	}
	find_non_matching_replacement(value, regex, context).unwrap_or_else(|| {
		let length = value.encode_utf16().count();
		if length <= 2 {
			build_keyed_replacement_run(key, length)
		} else {
			let mut replacement = String::with_capacity(length);
			replacement.push_str("ZZ");
			replacement.push_str(&build_keyed_replacement_run(key, length - 2));
			replacement
		}
	})
}

/// Reports whether a default regex replacement cannot safely distinguish a 1–2
/// byte match.
pub fn regex_has_unresolvable_short_match_fallback(regex: &Regex) -> bool {
	[1_usize, 2].into_iter().any(|length| {
		let probe = "\0".repeat(length);
		find_non_matching_replacement(&probe, regex, RegexMatchContext {
			text:  &probe,
			start: 0,
			end:   length,
		})
		.is_none()
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn replacement_matches_pi_vectors_and_is_distinct() {
		assert_eq!(bun_wyhash(b""), 290_873_116_282_709_081);
		assert_eq!(bun_wyhash(b"abc"), 190_542_993_387_777_138);
		assert_eq!(bun_wyhash("é".as_bytes()), 1_783_465_187_472_633_034);
		assert_eq!(bun_wyhash(&[b'a'; 49]), 9_848_643_853_843_152_978);
		assert_eq!(bun_wyhash(&[b'a'; 100]), 7_077_612_499_900_502_782);
		assert_eq!(generate_deterministic_replacement("secret"), "ZZrF26");
		assert_eq!(generate_deterministic_replacement("é").len(), 1);
		assert_eq!(ensure_distinct_replacement("ZZ".to_owned(), "ZZ"), "AZ");
	}

	#[test]
	fn bounded_search_finds_fixed_point() {
		let regex = Regex::new("[A-Za-z0-9]{4}").expect("regex");
		let text = "key=abcd";
		let replacement = find_non_matching_replacement("abcd", &regex, RegexMatchContext {
			text,
			start: 4,
			end: 8,
		})
		.expect("punctuation candidate");
		assert!(!regex_rematches_in_context(&replacement, &regex, RegexMatchContext {
			text,
			start: 4,
			end: 8
		}));
	}
}
