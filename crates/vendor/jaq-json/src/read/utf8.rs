//! UTF-8 decoding as jq does it (src/jv_unicode.c).
use alloc::vec::Vec;

/// Marks a continuation byte in [`CODING_LENGTH`].
const CONTINUATION: u8 = 0xff;

/// Length of the sequence a byte starts (`utf8_coding_length`):
/// 0 for bytes that never start one, [`CONTINUATION`] for continuation bytes.
const fn coding_length(b: u8) -> u8 {
    match b {
        0x00..=0x7f => 1,
        0x80..=0xbf => CONTINUATION,
        0xc0 | 0xc1 | 0xf5..=0xff => 0,
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
    }
}

/// Smallest codepoint a sequence of the given length may encode (`utf8_first_codepoint`).
const FIRST_CODEPOINT: [u32; 5] = [0, 0, 0x80, 0x800, 0x10000];

/// Decode the codepoint starting `bytes`, as jq's `jvp_utf8_next`:
/// return it (`None` if invalid) and how many bytes it takes.
fn next(bytes: &[u8]) -> (Option<u32>, usize) {
    let first = bytes[0];
    if first < 0x80 {
        return (Some(first.into()), 1);
    }
    let length = coding_length(first);
    if length == 0 || length == CONTINUATION {
        return (None, 1);
    }
    let length = usize::from(length);
    if length > bytes.len() {
        return (None, bytes.len());
    }
    let mask = match length {
        2 => 0x1f,
        3 => 0x0f,
        _ => 0x07,
    };
    let mut codepoint = u32::from(first & mask);
    for (i, &b) in bytes[1..length].iter().enumerate() {
        if coding_length(b) != CONTINUATION {
            return (None, i + 1);
        }
        codepoint = (codepoint << 6) | u32::from(b & 0x3f);
    }
    let valid = codepoint >= FIRST_CODEPOINT[length]
        && !(0xd800..=0xdfff).contains(&codepoint)
        && codepoint <= 0x10ffff;
    (valid.then_some(codepoint), length)
}

/// Append `bytes` to `out`, replacing every invalid sequence by U+FFFD
/// the way jq's `jvp_string_copy_replace_bad` does.
pub fn push_lossy(out: &mut Vec<u8>, bytes: &[u8]) {
    if core::str::from_utf8(bytes).is_ok() {
        out.extend_from_slice(bytes);
        return;
    }
    let mut rest = bytes;
    while !rest.is_empty() {
        let (c, len) = next(rest);
        match c {
            Some(_) => out.extend_from_slice(&rest[..len]),
            None => out.extend_from_slice("\u{fffd}".as_bytes()),
        }
        rest = &rest[len..];
    }
}

/// `bytes` with invalid sequences replaced, as jq's `jv_string_sized`.
pub fn lossy(bytes: Vec<u8>) -> Vec<u8> {
    if core::str::from_utf8(&bytes).is_ok() {
        return bytes;
    }
    let mut out = Vec::with_capacity(bytes.len() + 8);
    push_lossy(&mut out, &bytes);
    out
}

/// How many bytes the codepoint that `bytes` ends in still lacks, as jq's
/// `jvp_utf8_backtrack`; `None` if its end is not a (partial) codepoint.
pub fn missing_bytes(bytes: &[u8]) -> Option<usize> {
    let mut seen = 0;
    for &b in bytes.iter().rev() {
        seen += 1;
        let length = coding_length(b);
        if length != CONTINUATION {
            return (length != 0).then(|| usize::from(length).checked_sub(seen)).flatten();
        }
    }
    None
}

/// Encode a codepoint that may be a surrogate, as jq's `jvp_utf8_encode`.
pub(crate) fn encode(codepoint: u32, out: &mut Vec<u8>) {
    match codepoint {
        0..=0x7f => out.push(codepoint as u8),
        0x80..=0x7ff => out.extend([0xc0 | (codepoint >> 6) as u8, 0x80 | (codepoint & 0x3f) as u8]),
        0x800..=0xffff => out.extend([
            0xe0 | (codepoint >> 12) as u8,
            0x80 | ((codepoint >> 6) & 0x3f) as u8,
            0x80 | (codepoint & 0x3f) as u8,
        ]),
        _ => out.extend([
            0xf0 | ((codepoint >> 18) & 0x07) as u8,
            0x80 | ((codepoint >> 12) & 0x3f) as u8,
            0x80 | ((codepoint >> 6) & 0x3f) as u8,
            0x80 | (codepoint & 0x3f) as u8,
        ]),
    }
}
