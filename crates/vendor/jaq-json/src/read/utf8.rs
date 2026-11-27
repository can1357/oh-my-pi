//! UTF-8 decoding as jq does it (`src/jv_unicode.c`). Valid runs are measured
//! with xutf's SIMD validator; only the bytes it rejects follow jq's rules.
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

/// How many bytes jq's `jvp_utf8_next` replaces by one U+FFFD at the start of
/// `bytes`, which start an ill-formed sequence: one for a byte no sequence
/// starts with, all of them for a sequence they cut short, the bytes before
/// one that is no continuation, else the whole sequence (an overlong form,
/// surrogate or codepoint past U+10FFFF). Not the maximal subpart
/// `String::from_utf8_lossy` replaces.
fn invalid_len(bytes: &[u8]) -> usize {
    let length = coding_length(bytes[0]);
    if length == 0 || length == CONTINUATION {
        return 1;
    }
    let length = usize::from(length);
    if length > bytes.len() {
        return bytes.len();
    }
    bytes[1..length]
        .iter()
        .position(|&b| coding_length(b) != CONTINUATION)
        .map_or(length, |i| i + 1)
}

/// Append `bytes` to `out`, replacing every invalid sequence by U+FFFD
/// the way jq's `jvp_string_copy_replace_bad` does.
pub fn push_lossy(out: &mut Vec<u8>, mut bytes: &[u8]) {
    loop {
        let valid = xutf::valid_prefix(bytes);
        out.extend_from_slice(valid.as_bytes());
        bytes = &bytes[valid.len()..];
        if bytes.is_empty() {
            return;
        }
        out.extend_from_slice("\u{fffd}".as_bytes());
        bytes = &bytes[invalid_len(bytes)..];
    }
}

/// `bytes` with invalid sequences replaced, as jq's `jv_string_sized`.
pub fn lossy(bytes: Vec<u8>) -> Vec<u8> {
    let valid = xutf::valid_prefix(&bytes).len();
    if valid == bytes.len() {
        return bytes;
    }
    let mut out = Vec::with_capacity(bytes.len() + 8);
    out.extend_from_slice(&bytes[..valid]);
    push_lossy(&mut out, &bytes[valid..]);
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
