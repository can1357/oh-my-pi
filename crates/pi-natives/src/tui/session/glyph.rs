//! Glyph Protocol reply decoding.
//!
//! Transport is APC `ESC _ 25a1 ; <verb> [; k=v]* [; payload] ESC \` with four
//! verbs — `s` (support query), `q` (coverage query), `r` (register), `c`
//! (clear). The JS host owns the icon bundle and pre-encodes the queries and
//! registrations ([`GlyphProbe`](crate::tui::types::GlyphProbe)); the session
//! drives the handshake and decodes the terminal's replies here.
//!
//! Spec: <https://github.com/raphamorim/rio/blob/main/specs/glyph-protocol.md>

/// APC introducer plus the protocol identifier (U+25A1 WHITE SQUARE as
/// lowercase hex).
const PREFIX: &str = "\x1b_25a1;";
const ST: &str = "\x1b\\";

/// Terminal reply to any Glyph Protocol verb, decoded from its APC body.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum GlyphReply<'a> {
	/// `s`: the outline formats the terminal accepts.
	Support { formats: Vec<&'a str> },
	/// `q`: which sources (system font, session glossary) render `cp`.
	Coverage { cp: i64, coverage: Vec<&'a str> },
	/// `r`: registration acknowledgement.
	Registered { cp: i64, status: i64, reason: Option<&'a str> },
	/// `c`: clear acknowledgement.
	Cleared { status: i64, reason: Option<&'a str> },
}

/// Whether `sequence` is a complete Glyph Protocol APC message.
fn is_glyph_sequence(sequence: &str) -> bool {
	sequence.starts_with(PREFIX) && sequence.ends_with(ST)
}

/// Leading integer of `text` in `radix` (10 or 16), the way the replies were
/// always read: optional whitespace and sign, an optional `0x` for hex, then
/// as many digits as there are. `None` when no digit follows.
fn leading_int(text: &str, radix: u32) -> Option<i64> {
	let text = text.trim_start();
	let (negative, text) = match text.as_bytes().first() {
		Some(b'-') => (true, &text[1..]),
		Some(b'+') => (false, &text[1..]),
		_ => (false, text),
	};
	let text = if radix == 16 {
		text
			.strip_prefix("0x")
			.or_else(|| text.strip_prefix("0X"))
			.unwrap_or(text)
	} else {
		text
	};
	let mut value: Option<i64> = None;
	for digit in text.chars().map_while(|ch| ch.to_digit(radix)) {
		value = Some(
			value
				.unwrap_or(0)
				.saturating_mul(i64::from(radix))
				.saturating_add(i64::from(digit)),
		);
	}
	value.map(|value| if negative { -value } else { value })
}

/// Empty list values (`fmt=` / `status=`) mean "none", not one empty name.
fn list(value: Option<&str>) -> Vec<&str> {
	value
		.filter(|value| !value.is_empty())
		.map_or_else(Vec::new, |value| value.split(',').collect())
}

/// Decode a terminal reply. Returns `None` for anything that is not a
/// well-formed Glyph Protocol message; unknown keys are ignored per §11 so
/// future parameters never break detection.
pub(super) fn parse_glyph_reply(sequence: &str) -> Option<GlyphReply<'_>> {
	if !is_glyph_sequence(sequence) {
		return None;
	}
	let body = &sequence[PREFIX.len()..sequence.len() - ST.len()];
	let mut parts = body.split(';');
	let verb = parts.next()?;
	let (mut fmt, mut cp, mut status, mut reason) = (None, None, None, None);
	for part in parts {
		// An empty key (`=value`) names no parameter.
		let Some((key, value)) = part.split_once('=') else {
			continue;
		};
		match key {
			"fmt" => fmt = Some(value),
			"cp" => cp = Some(value),
			"status" => status = Some(value),
			"reason" => reason = Some(value),
			_ => {},
		}
	}
	match verb {
		"s" => Some(GlyphReply::Support { formats: list(fmt) }),
		"q" => Some(GlyphReply::Coverage { cp: leading_int(cp?, 16)?, coverage: list(status) }),
		"r" => Some(GlyphReply::Registered {
			cp: leading_int(cp?, 16)?,
			status: leading_int(status?, 10)?,
			reason,
		}),
		"c" => Some(GlyphReply::Cleared { status: leading_int(status?, 10)?, reason }),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_every_reply_verb_and_treats_empty_lists_as_none() {
		assert_eq!(
			parse_glyph_reply("\x1b_25a1;s;fmt=glyf,colrv0,colrv1\x1b\\"),
			Some(GlyphReply::Support { formats: vec!["glyf", "colrv0", "colrv1"] })
		);
		assert_eq!(
			parse_glyph_reply("\x1b_25a1;s;fmt=\x1b\\"),
			Some(GlyphReply::Support { formats: vec![] })
		);
		assert_eq!(
			parse_glyph_reply("\x1b_25a1;q;cp=e0a0;status=system,glossary\x1b\\"),
			Some(GlyphReply::Coverage { cp: 0xe0a0, coverage: vec!["system", "glossary"] })
		);
		assert_eq!(
			parse_glyph_reply("\x1b_25a1;q;cp=e0a0;status=\x1b\\"),
			Some(GlyphReply::Coverage { cp: 0xe0a0, coverage: vec![] })
		);
		assert_eq!(
			parse_glyph_reply("\x1b_25a1;r;cp=100000;status=3;reason=payload_too_large\x1b\\"),
			Some(GlyphReply::Registered {
				cp:     0x10_0000,
				status: 3,
				reason: Some("payload_too_large"),
			})
		);
		assert_eq!(
			parse_glyph_reply("\x1b_25a1;c;status=0\x1b\\"),
			Some(GlyphReply::Cleared { status: 0, reason: None })
		);
	}

	#[test]
	fn rejects_foreign_apcs_unknown_verbs_and_malformed_numerics() {
		assert_eq!(parse_glyph_reply("\x1b_Ga=t,i=1;AAAA\x1b\\"), None);
		assert_eq!(parse_glyph_reply("\x1b_25a1;x;cp=e000\x1b\\"), None);
		assert_eq!(parse_glyph_reply("\x1b_25a1;r;status=0\x1b\\"), None);
		assert_eq!(parse_glyph_reply("\x1b_25a1;s;fmt=glyf"), None);
		assert_eq!(parse_glyph_reply("\x1b_25a1;q;cp=zz\x1b\\"), None);
	}

	#[test]
	fn ignores_unknown_keys_and_keyless_parts() {
		assert_eq!(
			parse_glyph_reply("\x1b_25a1;s;future=1;=x;fmt=glyf\x1b\\"),
			Some(GlyphReply::Support { formats: vec!["glyf"] })
		);
	}
}
