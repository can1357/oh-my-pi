//! Marker notation and the measured character tables.
//!
//! Port of ctok's `constants.py`. The tables were measured against Anthropic's
//! `count_tokens`; tables noted as enumerated must stay enumerated — no Unicode
//! category rule reproduces them.

/// ⟨bow⟩ — begin-of-word marker byte.
pub const BOW: u8 = 0x01;
/// ⟨eow⟩ — end-of-word marker byte.
pub const EOW: u8 = 0x02;
// 0x03 is ⟨pad⟩, the message-frame marker: it never stands in the marked
// stream, only inside vocabulary pieces.
/// ⟨shift⟩ — title-case marker byte.
pub const SHIFT: u8 = 0x04;
/// ⟨caps⟩ — all-caps marker byte.
pub const CAPS: u8 = 0x05;

/// Whether `b` is one of the five marker bytes, ⟨bow⟩ through ⟨caps⟩.
///
/// ctok writes its markers as the noncharacters U+FDD0..=U+FDD4; this port and
/// its vocabulary generator write one C0 byte each instead, three times shorter
/// in the stream and in the matching automaton. Text cannot collide with them:
/// [`super::normalize::nfc`] folds NUL to a space and strips every other C0
/// control before a stream is written, so a marker byte in a stream is always a
/// marker — where ctok's spelling has to escape literal noncharacters out of
/// the way, this needs nothing.
pub const fn is_marker_byte(b: u8) -> bool {
	matches!(b, BOW..=CAPS)
}

/// Non-ASCII symbols/punctuation that tile over the punct vocabulary rather
/// than standing alone. Enumerated: the behaviour splits per codepoint with no
/// categorical rule (`（` is punct but `）` is hard). Anything unlisted stays
/// HARD.
pub const fn is_punct_sym(c: char) -> bool {
	matches!(
		c,
		'—' | '»'
			| '«' | '•'
			| '°' | '„'
			| '–' | '−'
			| '£' | '§'
			| '€' | '…'
			| '√' | '→'
			| '（' | '№'
			| '†' | '└'
			| '│' | '།'
			| '·' | '─'
			| '═' | '█'
	)
}

/// Symbol-letters measured to take the full word model exactly like Latin
/// letters. Enumerated blocks: category Nl/So/Lu splits both ways, and the
/// Hangzhou numerals (also Nl) measured markerless, so it is the block that
/// predicts, not the category.
pub const fn is_symbol_letter(o: u32) -> bool {
	matches!(o,
		0x16ee..=0x16f0     // Runic golden numbers (Nl, caseless)
		| 0x2160..=0x2188   // Roman numerals (Nl/Lu/Ll, cased pairs)
		| 0x24b6..=0x24e9   // circled letters (So, cased)
		| 0xa6e6..=0xa6ef   // Bamum number-letters (Nl, caseless)
	)
}

/// Variation selectors are gc=Mn but take no word model. The supplementary
/// selectors (U+E0100..) are astral and already HARD.
pub const fn is_variation_selector(c: char) -> bool {
	matches!(c, '\u{fe00}'..='\u{fe0f}')
}

/// The one canonical-combining-class-9 character that does not separate word
/// runs: U+0E3A THAI CHARACTER PHINTHU.
pub const NON_SEPARATOR: char = '\u{0e3a}';

/// The suffixes an apostrophe binds into the word ahead of it, deleting that
/// word's ⟨bow⟩. Standard English contraction set, lowercase and whole-word
/// only; measured per member.
pub const fn is_contraction_suffix(body: &[u8]) -> bool {
	matches!(body, b"s" | b"t" | b"d" | b"m" | b"ll" | b"re" | b"ve")
}

/// C0/C1 controls the API strips before tokenizing (cost 0): every gc=Cc
/// except TAB, LF and NUL.
pub const fn is_stripped_control(c: char) -> bool {
	matches!(c, '\u{01}'..='\u{08}' | '\u{0b}'..='\u{1f}' | '\u{7f}'..='\u{9f}')
}

/// BMP private use is stripped the same way; its two neighbours join into one
/// word. The supplementary private-use planes are unprobed and deliberately
/// left out.
pub const fn is_stripped_private(c: char) -> bool {
	matches!(c, '\u{e000}'..='\u{f8ff}')
}

/// Space separators the tokenizer treats identically to U+0020: all Zs except
/// U+3000 (ideographic space), plus Zl/Zp. TAB, LF and U+3000 each have their
/// own cost.
pub const fn is_funny_space(c: char) -> bool {
	matches!(
		c,
		'\u{a0}' | '\u{1680}' | '\u{2000}'
			..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}'
	)
}

/// The four standard curly quotes fold to their ASCII forms (v3 only; NFC does
/// not do this). The low-9 mark U+201E is a different token and is deliberately
/// not folded.
pub const fn fold_quote(c: char) -> char {
	match c {
		'\u{2018}' | '\u{2019}' => '\'',
		'\u{201c}' | '\u{201d}' => '"',
		_ => c,
	}
}

/// Marks that terminate the orthographic syllable and so separate word runs,
/// beyond the ccc-9 viramas: the measured U+0300 combining ranges, the swept
/// combining-block annotation ranges, and the enumerated separator signs
/// (Thai/Lao tone marks, nukta, Khmer consonant shifters, …). Merged into one
/// sorted range table; provenance per group lives in ctok's `constants.py`.
static SEPARATOR_RANGES: &[(u32, u32)] = &[
	(0x0300, 0x0344),
	(0x0346, 0x0362),
	(0x0483, 0x0489),
	(0x0591, 0x05af),
	(0x0658, 0x0658),
	(0x06df, 0x06e0),
	(0x06ea, 0x06ec),
	(0x0740, 0x074a),
	(0x07eb, 0x07f3),
	(0x07fd, 0x07fd),
	(0x0818, 0x0819),
	(0x082d, 0x082d),
	(0x0859, 0x085b),
	(0x0898, 0x089f),
	(0x08ca, 0x08d3),
	(0x08e0, 0x08e1),
	(0x08ea, 0x08ef),
	(0x093c, 0x093c),
	(0x0951, 0x0954),
	(0x09bc, 0x09bc),
	(0x09fe, 0x09fe),
	(0x0a3c, 0x0a3c),
	(0x0abc, 0x0abc),
	(0x0afd, 0x0aff),
	(0x0b3c, 0x0b3c),
	(0x0b55, 0x0b55),
	(0x0c3c, 0x0c3c),
	(0x0cbc, 0x0cbc),
	(0x0e47, 0x0e4c),
	(0x0e4e, 0x0e4e),
	(0x0ec8, 0x0ecc),
	(0x0ece, 0x0ece),
	(0x0f18, 0x0f19),
	(0x0f35, 0x0f35),
	(0x0f37, 0x0f37),
	(0x0f39, 0x0f39),
	(0x0f3e, 0x0f3f),
	(0x0f86, 0x0f87),
	(0x0fc6, 0x0fc6),
	(0x1037, 0x1037),
	(0x135d, 0x135f),
	(0x17b4, 0x17b5),
	(0x17c9, 0x17d1),
	(0x17d3, 0x17d3),
	(0x17dd, 0x17dd),
	(0x180b, 0x180d),
	(0x180f, 0x180f),
	(0x1939, 0x193b),
	(0x1a75, 0x1a7c),
	(0x1a7f, 0x1a7f),
	(0x1ab0, 0x1abe),
	(0x1ac1, 0x1acb),
	(0x1b34, 0x1b34),
	(0x1b6b, 0x1b73),
	(0x1be6, 0x1be6),
	(0x1c37, 0x1c37),
	(0x1cd0, 0x1ce8),
	(0x1ced, 0x1ced),
	(0x1cf4, 0x1cf4),
	(0x1cf7, 0x1cf7),
	(0x1cf8, 0x1cf9),
	(0x1dc0, 0x1dd2),
	(0x1df5, 0x1dff),
	(0x20d0, 0x20f0),
	(0x2cef, 0x2cf1),
	(0x302a, 0x302f),
	(0x3099, 0x309a),
	(0xa66f, 0xa672),
	(0xa67c, 0xa67d),
	(0xa6f0, 0xa6f1),
	(0xa8e0, 0xa8f1),
	(0xa92b, 0xa92d),
	(0xa9b3, 0xa9b3),
	(0xaabf, 0xaabf),
	(0xaac1, 0xaac1),
	(0xabec, 0xabec),
	(0xfe20, 0xfe2f),
];

/// Whether `o` falls in one of the measured separator ranges (excluding the
/// ccc-9 virama population, which [`super::normalize::is_separator`] handles).
pub fn in_separator_ranges(o: u32) -> bool {
	let idx = SEPARATOR_RANGES.partition_point(|&(lo, _)| lo <= o);
	idx > 0 && o <= SEPARATOR_RANGES[idx - 1].1
}
