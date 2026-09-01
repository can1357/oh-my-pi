//! Text → the marked stream: everything that happens before the tiling.
//!
//! Port of ctok's `normalize.py`:
//!
//! ```text
//! NFC + quote fold  ->  class split  ->  case marking  ->  boundary markers written in
//! ```
//!
//! [`stream_norm`] is the output: one byte string of UTF-8 text with word
//! boundaries, case and absorbed spaces written in as marker bytes, which
//! `engine.rs` then tiles. Every rule here is either a designed rewrite of the
//! text or a measured fact about the `count_tokens` oracle. No costs live in
//! this module.
//!
//! Nothing buffers decoded characters: [`nfc`] hands back its input borrowed
//! whenever no rule can fire on it (clean ASCII, the common case), runs are
//! byte ranges into that text, and a marker costs one byte. Unicode tables are
//! consulted only for characters that are neither ASCII nor ideographs.

use std::borrow::Cow;

use xutf::{
	GeneralCategory, GeneralCategoryGroup, IntoUnicodeNormalized, ToUnicodeNormalized, Ucd,
	canonical_combining_class, is_nfc, is_nfc_codepoints,
};

use super::constants::{
	BOW, CAPS, EOW, NON_SEPARATOR, SHIFT, fold_quote, in_separator_ranges, is_contraction_suffix,
	is_funny_space, is_punct_sym, is_stripped_control, is_stripped_private, is_symbol_letter,
	is_variation_selector,
};
use crate::utok::utf::Unit;

/// The stream class of one codepoint.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Class {
	/// Letters and marks that take the full word model.
	Wordy,
	/// Isolated-character path: CJK, astral, and everything unlisted.
	Hard,
	/// ASCII and Arabic-Indic decimal digits.
	Digit,
	/// Punctuation and symbols that tile over the punct vocabulary.
	Punct,
	/// Whitespace.
	Space,
	/// A combining mark with no letter in front of it to be its base.
	StrayMark,
}

/// One maximal same-class run, as a byte range into the normalized text.
#[derive(Clone, Copy)]
pub struct Run {
	pub cls:   Class,
	pub start: usize,
	pub end:   usize,
}

/// Frame scalars a family contributes to the encoder (ctok's `TokenizerModel`
/// metadata; the vocabulary itself lives in [`super::engine::VocabCore`]).
#[derive(Clone, Copy)]
pub struct FrameParams {
	/// Fixed cost of a single user message before its content.
	pub message_overhead: u32,
	/// v3 alone folds curly quotes to their ASCII forms.
	pub fold_quotes:      bool,
	/// Minimum span length for the ⟨caps⟩ marker; `None` disables it (v4.7+).
	pub allcaps_min:      Option<usize>,
	/// Whether the frame ends in a ⟨bow⟩ that absorbs one leading space.
	pub frame_bow:        bool,
	/// `true` for the measured trailing-newline ladder (v3/v4.7); `false` when
	/// the frame absorbs all trailing ASCII whitespace (v5).
	pub ladder:           bool,
}

// Python 3.13 ships Unicode 15.1 data; the source models know these Unicode
// 16.0 case pairs. Kept explicit so the port does not depend on the std
// Unicode revision.
const NEW_CASE_PAIRS: [(char, char); 2] = [('\u{1c89}', '\u{1c8a}'), ('\u{a7cb}', '\u{0264}')];

fn new_case_lower(c: char) -> Option<char> {
	NEW_CASE_PAIRS
		.iter()
		.find(|&&(u, _)| u == c)
		.map(|&(_, l)| l)
}

fn is_new_cased(c: char) -> bool {
	NEW_CASE_PAIRS.iter().any(|&(u, l)| u == c || l == c)
}

fn is_upper_x(c: char) -> bool {
	new_case_lower(c).is_some() || c.is_uppercase()
}

fn is_lower_x(c: char) -> bool {
	NEW_CASE_PAIRS.iter().any(|&(_, l)| l == c) || c.is_lowercase()
}

/// Whether the single-character full lowering of `c` is `c` itself.
fn lowers_to_self(c: char) -> bool {
	if new_case_lower(c).is_some() {
		return false;
	}
	let mut it = c.to_lowercase();
	it.next() == Some(c) && it.next().is_none()
}

/// Append one character's UTF-8 bytes.
#[inline]
fn push_char(c: char, out: &mut Vec<u8>) {
	let mut buf = [0u8; 4];
	out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
}

fn push_lower(c: char, out: &mut Vec<u8>) {
	match new_case_lower(c) {
		Some(l) => push_char(l, out),
		None => {
			for l in c.to_lowercase() {
				push_char(l, out);
			}
		},
	}
}

/// Whether [`nfc`] rewrites this ASCII byte: the stripped controls, plus NUL,
/// which folds to a space.
#[inline]
const fn ascii_needs_fold(b: u8) -> bool {
	matches!(b, 0x00..=0x08 | 0x0b..=0x1f | 0x7f)
}

/// Apply the measured text normalization: NFC, control/private-use stripping,
/// NUL and exotic-space folding, Thai SARA AM composition, and (v3) quote
/// folding. Text no rule touches is returned borrowed. Lone surrogates cannot
/// exist in a Rust `str`; the JS boundary has already folded them to U+FFFD
/// exactly as the Python port does.
pub fn nfc(text: &str, fold_quotes: bool) -> Cow<'_, str> {
	if text.is_ascii() {
		// ASCII is closed under every rule here except control stripping, and
		// is always in NFC.
		if !text.bytes().any(ascii_needs_fold) {
			return Cow::Borrowed(text);
		}
		let mut out = String::with_capacity(text.len());
		for b in text.bytes() {
			match b {
				0x00 => out.push(' '),
				b if ascii_needs_fold(b) => {},
				b => out.push(char::from(b)),
			}
		}
		return Cow::Owned(out);
	}
	if is_nfc(text) {
		// Quick-check: composing is a no-op, fold straight off the input.
		return Cow::Owned(fold_chars(text.chars(), fold_quotes, text.len()));
	}
	let composed = text.to_nfc();
	let folded = fold_chars(composed.chars(), fold_quotes, composed.len());
	Cow::Owned(folded)
}

/// The post-NFC folding loop over an already-composed codepoint stream:
/// every fold [`nfc`] documents. `cap` is a capacity hint in bytes.
fn fold_chars(chars: impl Iterator<Item = char>, fold_quotes: bool, cap: usize) -> String {
	let mut out = String::with_capacity(cap);
	for c in chars {
		if is_stripped_control(c) {
			continue;
		}
		let c = if c == '\0' { ' ' } else { c };
		// Claude composes decomposed Thai SARA AM, whose compatibility
		// decomposition NFC leaves alone. Lao SARA AM does not fold.
		if c == '\u{0e32}' && out.ends_with('\u{0e4d}') {
			out.pop();
			out.push('\u{0e33}');
			continue;
		}
		if is_stripped_private(c) {
			continue;
		}
		let c = if fold_quotes { fold_quote(c) } else { c };
		out.push(if is_funny_space(c) { ' ' } else { c });
	}
	out
}

/// `units` reinterpreted as `&str` when the flavor is UTF-8 and the bytes are
/// valid — the common case, which keeps [`nfc`]'s borrowed fast path.
fn as_str<U: Unit>(units: &[U]) -> Option<&str> {
	std::str::from_utf8(U::as_utf8(units)?).ok()
}

/// Codepoints decoded permissively off raw units (utf.rs semantics: malformed
/// sequences and lone surrogates yield U+FFFD, consuming minimally).
struct UnitChars<'a, U: Unit> {
	units: &'a [U],
	pos:   usize,
}

impl<U: Unit> Iterator for UnitChars<'_, U> {
	type Item = char;

	#[inline]
	fn next(&mut self) -> Option<char> {
		if self.pos >= self.units.len() {
			return None;
		}
		let (c, n) = U::decode(self.units, self.pos);
		self.pos += n;
		Some(c)
	}
}

/// [`nfc`] over any input flavor. Valid UTF-8 keeps the borrowed fast path;
/// UTF-16/UTF-32 (and malformed UTF-8) decode permissively straight into the
/// folding loop when the stream is already NFC (the common case, one pass);
/// only NFC-dirty input pays a materialize-and-compose round.
pub fn nfc_units<U: Unit>(units: &[U], fold_quotes: bool) -> Cow<'_, str> {
	if let Some(text) = as_str(units) {
		return nfc(text, fold_quotes);
	}
	if is_nfc_codepoints(UnitChars { units, pos: 0 }.map(u32::from)) {
		return Cow::Owned(fold_chars(UnitChars { units, pos: 0 }, fold_quotes, units.len()));
	}
	let composed: String = UnitChars { units, pos: 0 }.collect::<String>().into_nfc();
	let folded = fold_chars(composed.chars(), fold_quotes, composed.len());
	Cow::Owned(folded)
}

/// Whether a codepoint uses the isolated character path for letters.
fn is_hard_cp(o: u32) -> bool {
	o >= 0x10000                  // all astral (CJK ext, astral scripts, emoji)
		|| (0x4e00..=0x9fff).contains(&o)   // CJK Unified
		|| (0x3400..=0x4dbf).contains(&o)   // CJK Ext A
		|| (0xf900..=0xfaff).contains(&o)   // CJK Compatibility
		|| (0xac00..=0xd7a3).contains(&o)   // Hangul syllables
		// The ideographic iteration and closing marks (々 〆) continue the Han
		// run they follow despite being letters by category.
		|| o == 0x3005 || o == 0x3006
		// Quranic annotation signs: measured as unattached marks.
		|| (0x06dd..=0x06e0).contains(&o)
		|| (0x06e9..=0x06ec).contains(&o)
}

/// A mark that terminates the orthographic syllable, and so separates word
/// runs: viramas (ccc 9, minus THAI PHINTHU) plus the measured ranges and
/// enumerated signs in `constants.rs`.
pub fn is_separator(c: char) -> bool {
	// No ASCII codepoint combines, and the measured ranges start at U+0300.
	!c.is_ascii() && is_separator_general(c)
}

fn is_separator_general(c: char) -> bool {
	(canonical_combining_class(c as u32) == 9 && c != NON_SEPARATOR) || in_separator_ranges(c as u32)
}

/// Stream class of every ASCII codepoint: the fast path of [`classify`], since
/// no rule below the 0x80 boundary needs a Unicode table. Pinned against the
/// general path by `ascii_class_table_matches_general`.
static ASCII_CLASS: [Class; 128] = {
	let mut table = [Class::Hard; 128];
	let mut i = 0usize;
	while i < 128 {
		table[i] = match i as u8 {
			b'\t' | b'\n' | 0x0b | 0x0c | b'\r' | b' ' => Class::Space,
			b'0'..=b'9' => Class::Digit,
			b'A'..=b'Z' | b'a'..=b'z' => Class::Wordy,
			// Every ASCII printable that is neither alphanumeric nor a space
			// is gc=P* or gc=S*, and both tile over the merged punct
			// vocabulary, so operators (`==`, `=>`, `});`) form one PUNCT run.
			0x21..=0x2f | 0x3a..=0x40 | 0x5b..=0x60 | 0x7b..=0x7e => Class::Punct,
			// C0 controls and DEL: stripped before classification ever sees
			// them, and HARD by the general path in any case.
			_ => Class::Hard,
		};
		i += 1;
	}
	table
};

pub fn classify(c: char) -> Class {
	if c.is_ascii() {
		return ASCII_CLASS[c as usize];
	}
	if is_ideograph(c as u32) {
		return Class::Hard;
	}
	classify_nonascii(c)
}

/// Han ideographs and Hangul syllables, which the isolated-character path
/// claims wholesale: gc=Lo throughout, so they take the HARD class, no border
/// marker and no digit border, with no Unicode lookup needed. Pinned against
/// the general path by `ideograph_shortcut_matches_general`.
const fn is_ideograph(o: u32) -> bool {
	matches!(o, 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xac00..=0xd7a3)
}

/// The stream class of one codepoint, derived from Unicode data and the
/// measured tables.
fn classify_nonascii(c: char) -> Class {
	if is_separator(c) {
		return Class::Hard; // separates word runs; `marks_like_punct` claims its borders
	}
	if is_new_cased(c) {
		return Class::Wordy;
	}
	let o = c as u32;
	let group = c.general_category_group();
	if group == GeneralCategoryGroup::Separator
		|| matches!(c, '\t' | '\n' | '\r' | '\u{0b}' | '\u{0c}')
	{
		return Class::Space;
	}
	if is_symbol_letter(o) {
		return Class::Wordy;
	}
	let cat = c.general_category();
	if cat == GeneralCategory::DecimalNumber
		&& (o < 0x80 || (0x0660..=0x0669).contains(&o) || (0x06f0..=0x06f9).contains(&o))
	{
		return Class::Digit;
	}
	if o < 0x80 && matches!(group, GeneralCategoryGroup::Punctuation | GeneralCategoryGroup::Symbol)
	{
		return Class::Punct;
	}
	if is_punct_sym(c) {
		return Class::Punct;
	}
	if is_variation_selector(c) {
		return Class::Hard; // gc=Mn, but they take no word model at all
	}
	if o == 0x0cf3 {
		// KANNADA SIGN COMBINING ANUSVARA ABOVE RIGHT: measured as plain word
		// material; pinned so older Unicode tables cannot drop it to HARD.
		return Class::Wordy;
	}
	if matches!(group, GeneralCategoryGroup::Letter | GeneralCategoryGroup::Mark) && !is_hard_cp(o) {
		return Class::Wordy;
	}
	Class::Hard
}

/// A Syriac vowel point or superscript alaph that acts as a word-forming
/// letter wherever no base can hold it.
fn is_syriac_vowel(c: char) -> bool {
	let o = c as u32;
	o == 0x0711 || (0x0730..=0x073f).contains(&o)
}

/// A combining mark, asked at a position where nothing before it can be its
/// base. Fires only where a mark's base is not a letter.
fn is_stray_mark(c: char) -> bool {
	!c.is_ascii() && is_stray_mark_general(c) // no ASCII codepoint combines
}

fn is_stray_mark_general(c: char) -> bool {
	if is_syriac_vowel(c) {
		return false; // a baseless Syriac vowel is a word-forming letter instead
	}
	canonical_combining_class(c as u32) != 0 && !is_separator(c)
}

/// Whether a digit receives a border marker: ASCII digits take none, every
/// other BMP decimal or other-number digit does. Astral digits take none.
fn digit_border(c: char) -> bool {
	// ASCII digits take no border, and ASCII holds no gc=No.
	!c.is_ascii() && digit_border_general(c)
}

fn digit_border_general(c: char) -> bool {
	let cat = c.general_category();
	(cat == GeneralCategory::OtherNumber || (cat == GeneralCategory::DecimalNumber && !c.is_ascii()))
		&& (c as u32) < 0x10000
}

/// A uniform run of decimal digits (Nd) or other numbers (No).
fn is_digit_run(body: &str) -> bool {
	if body.is_ascii() {
		// Nd is the only number category in ASCII, so a uniform run there is a
		// run of ASCII digits.
		return !body.is_empty() && body.bytes().all(|b| b.is_ascii_digit());
	}
	is_digit_run_general(body)
}

fn is_digit_run_general(body: &str) -> bool {
	let mut chars = body.chars();
	let Some(first) = chars.next() else {
		return false;
	};
	let category = first.general_category();
	if !matches!(category, GeneralCategory::DecimalNumber | GeneralCategory::OtherNumber) {
		return false;
	}
	chars.all(|c| c.general_category() == category)
}

/// Does a digit run write ⟨bow⟩ where it borders a space on the left? The
/// run's first character decides.
fn digit_bow(body: &str) -> bool {
	is_digit_run(body) && body.chars().next().is_some_and(digit_border)
}

/// Does a digit run write ⟨eow⟩ where it borders a single space on the right?
/// The run's last character decides.
fn digit_eow(body: &str) -> bool {
	is_digit_run(body) && body.chars().next_back().is_some_and(digit_border)
}

/// Whether the border-marker branch can claim this character: punctuation,
/// symbols, format characters, unassigned codepoints, and separator marks —
/// excluding ideographic punctuation and everything astral.
fn marks_like_punct(c: char) -> bool {
	if c.is_ascii() {
		// ASCII holds no separator mark, no gc=Cf and no unassigned codepoint,
		// so this is exactly the ASCII half of the PUNCT class.
		return ASCII_CLASS[c as usize] == Class::Punct;
	}
	if is_ideograph(c as u32) {
		return false; // gc=Lo: no border marker of its own
	}
	marks_like_punct_general(c)
}

fn marks_like_punct_general(c: char) -> bool {
	let o = c as u32;
	if o >= 0x10000 {
		return false;
	}
	if is_separator(c) {
		return true;
	}
	// gc=L*, gc=M*, gc=N* and gc=Z* are never gc=Cf or unassigned, so the
	// second category lookup is needed for gc=C* alone.
	match c.general_category_group() {
		GeneralCategoryGroup::Punctuation => !(0x3001..=0x303f).contains(&o),
		GeneralCategoryGroup::Symbol => true,
		GeneralCategoryGroup::Other => {
			matches!(c.general_category(), GeneralCategory::Format | GeneralCategory::Unassigned)
		},
		_ => false,
	}
}

/// Whether the first character of a hard run takes a left border marker.
fn hard_bow(body: &str) -> bool {
	body
		.chars()
		.next()
		.is_some_and(|c| is_variation_selector(c) || marks_like_punct(c))
}

/// Whether the last character of a hard run takes a right border marker.
fn hard_eow(body: &str) -> bool {
	body
		.chars()
		.next_back()
		.is_some_and(|c| is_variation_selector(c) || marks_like_punct(c))
}

/// Which pretoken alternative a character of a HARD run belongs to. A HARD run
/// is a run of our own class, not a pretoken: each sub-run takes its own
/// border markers.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum HardKind {
	Punct,
	Number,
	Letter,
}

fn hard_kind(c: char) -> HardKind {
	if is_ideograph(c as u32) {
		// The common HARD run: every character is a letter, so the sub-run
		// never breaks and no Unicode table is consulted.
		return HardKind::Letter;
	}
	hard_kind_general(c)
}

fn hard_kind_general(c: char) -> HardKind {
	if marks_like_punct_general(c) {
		HardKind::Punct
	} else if digit_border_general(c) {
		HardKind::Number
	} else {
		HardKind::Letter
	}
}

/// Close one class run, splitting a HARD run where the pretoken kind changes.
/// A variation selector never opens a sub-run — it rides its base's sub-run,
/// or `⚖️` would sever at the selector and lose its ⟨eow⟩.
fn push_run(runs: &mut Vec<Run>, s: &str, cls: Class, start: usize, end: usize) {
	if cls != Class::Hard {
		runs.push(Run { cls, start, end });
		return;
	}
	let body = &s[start..end];
	let mut chars = body.char_indices();
	let Some((_, first)) = chars.next() else {
		return;
	};
	let mut sub_start = start;
	let mut kind = hard_kind(first);
	for (off, ch) in chars {
		if is_variation_selector(ch) || hard_kind(ch) == kind {
			continue;
		}
		runs.push(Run { cls: Class::Hard, start: sub_start, end: start + off });
		sub_start = start + off;
		kind = hard_kind(ch);
	}
	runs.push(Run { cls: Class::Hard, start: sub_start, end });
}

/// The text split into maximal same-class runs, with terminal marks as
/// unmarked separators and HARD runs split where the pretoken kind changes.
fn split_runs(s: &str) -> Vec<Run> {
	// Runs average a few bytes each: one allocation covers the typical text.
	let mut runs: Vec<Run> = Vec::with_capacity(s.len() / 3 + 8);
	let mut chars = s.char_indices();
	let Some((_, first)) = chars.next() else {
		return runs;
	};
	let mut start = 0usize;
	let mut cls = classify(first);
	if cls == Class::Wordy && is_stray_mark(first) {
		cls = Class::StrayMark; // nothing in front of it, so no letter can be its base
	}
	for (i, ch) in chars {
		let c = classify(ch);
		// Consecutive unattached marks are one regex-style run; an accent
		// riding a separator run opens a stray word like any other.
		if cls == Class::StrayMark && c == Class::Wordy && is_stray_mark(ch) {
			continue;
		}
		if c == cls {
			continue;
		}
		if c == Class::Wordy && cls != Class::Wordy && is_stray_mark(ch) {
			push_run(&mut runs, s, cls, start, i);
			start = i;
			cls = Class::StrayMark;
			continue;
		}
		push_run(&mut runs, s, cls, start, i);
		start = i;
		cls = c;
	}
	push_run(&mut runs, s, cls, start, s.len());
	runs
}

/// How a cased span is written into the stream (ctok's `mark_case`).
enum CaseForm {
	/// The span keeps its bytes.
	Literal,
	/// ⟨shift⟩ + fully lowered span.
	Shift,
	/// ⟨shift⟩ + lowered span with İ kept literal (İ is transparent to the
	/// title-case test and literal in the lowered body).
	ShiftKeepDotted,
	/// ⟨caps⟩ + fully lowered span.
	Caps,
}

fn span_is_upper(span: &str) -> bool {
	let mut saw_cased = false;
	for c in span.chars() {
		if is_upper_x(c) {
			saw_cased = true;
		} else if is_lower_x(c) {
			return false;
		}
	}
	saw_cased
}

/// Cased span → its marked form. A case marker fires only on a whole span:
/// pure all-caps of length ≥ `allcaps_min` becomes ⟨caps⟩ + lowercase, pure
/// title-case becomes ⟨shift⟩ + lowercase; everything else stays literal
/// (`GaN`/`WiFi`/`QQ` keep their bytes). `head_mark` means an unattached mark
/// opened the word, so neither marker can assert its lowered first letter.
fn case_form(span: &str, allcaps_min: Option<usize>, head_mark: bool) -> CaseForm {
	if head_mark {
		return CaseForm::Literal;
	}
	if span.is_ascii() {
		// A WORDY run of ASCII is letters only: ẞ and İ cannot appear, and
		// every ASCII letter has a distinct lowering, so no character can
		// block a marker. One pass settles both span shapes.
		let bytes = span.as_bytes();
		let mut any_upper = false;
		let mut any_lower = false;
		let mut upper_after_first = false;
		for (i, &b) in bytes.iter().enumerate() {
			if b.is_ascii_uppercase() {
				any_upper = true;
				upper_after_first |= i > 0;
			} else if b.is_ascii_lowercase() {
				any_lower = true;
			}
		}
		if allcaps_min.is_some_and(|min| span.len() >= min && any_upper && !any_lower) {
			return CaseForm::Caps;
		}
		if any_upper && !upper_after_first && bytes[0].is_ascii_uppercase() {
			return CaseForm::Shift;
		}
		return CaseForm::Literal;
	}
	if span.contains('ẞ') {
		return CaseForm::Literal;
	}
	let first = span.chars().next().expect("run bodies are non-empty");
	if span.contains('İ') {
		if is_upper_x(first)
			&& first != 'İ'
			&& !span.chars().skip(1).any(|c| c != 'İ' && is_upper_x(c))
		{
			return CaseForm::ShiftKeepDotted;
		}
		return CaseForm::Literal;
	}
	// A character with no lowered form blocks either marker: a marker in
	// front of an unchanged body over-counts.
	let unlowerable = span.chars().any(|c| {
		(is_new_cased(c)
			|| matches!(
				c.general_category_group(),
				GeneralCategoryGroup::Letter | GeneralCategoryGroup::Mark
			)) && !is_lower_x(c)
			&& (!is_upper_x(c) || lowers_to_self(c))
	});
	if let Some(min) = allcaps_min
		&& span.chars().count() >= min
		&& span_is_upper(span)
		&& !unlowerable
	{
		return CaseForm::Caps;
	}
	if lowers_to_self(first) {
		return CaseForm::Literal;
	}
	if is_upper_x(first) && !span.chars().skip(1).any(is_upper_x) {
		return CaseForm::Shift;
	}
	CaseForm::Literal
}

fn emit_case_body(span: &str, form: &CaseForm, out: &mut Vec<u8>) {
	match form {
		CaseForm::Literal => out.extend_from_slice(span.as_bytes()),
		// Per-char lowering never applies Final_Sigma, so Σ lowers to σ
		// everywhere — exactly the oracle's ⟨caps⟩ body spelling.
		CaseForm::Shift | CaseForm::Caps => {
			if span.is_ascii() {
				out.extend(span.bytes().map(|b| b.to_ascii_lowercase()));
			} else {
				for c in span.chars() {
					push_lower(c, out);
				}
			}
		},
		CaseForm::ShiftKeepDotted => {
			let mut chars = span.chars();
			push_lower(chars.next().expect("run bodies are non-empty"), out);
			for c in chars {
				if c == 'İ' {
					push_char(c, out);
				} else {
					push_lower(c, out);
				}
			}
		},
	}
}

/// Whether run `i` is a lone `'` that opens the word after it (`a 'b`,
/// `'First`, `x 'REXX`). Only a punct run that is exactly `'` qualifies.
const fn opens_word(s: &str, runs: &[Run], i: usize) -> bool {
	let r = &runs[i];
	r.end - r.start == 1
		&& s.as_bytes()[r.start] == b'\''
		&& i + 1 < runs.len()
		&& matches!(runs[i + 1].cls, Class::Wordy | Class::StrayMark)
}

/// Does this run write a boundary marker of its own on its right edge?
fn takes_right_border(s: &str, run: &Run) -> bool {
	let body = &s[run.start..run.end];
	run.cls == Class::Punct
		|| hard_eow(body)
		|| (matches!(run.cls, Class::Digit | Class::Hard) && is_digit_run(body) && digit_eow(body))
}

/// Does a lone apostrophe immediately left of wordy run `i` supply that word's
/// ⟨bow⟩? `it's` is one word boundary, not two. Three conditions, all
/// measured: the suffix is a contraction suffix (whole-word, lowercase); the
/// apostrophe is a punct run of its own; and the run on the far side of the
/// apostrophe writes no right-hand border marker of its own.
fn contraction_seam(s: &str, runs: &[Run], i: usize) -> bool {
	if i == 0 {
		return false;
	}
	let r = &runs[i];
	if !is_contraction_suffix(&s.as_bytes()[r.start..r.end]) {
		return false;
	}
	let prev = &runs[i - 1];
	if prev.cls != Class::Punct || prev.end - prev.start != 1 || s.as_bytes()[prev.start] != b'\'' {
		return false;
	}
	i < 2 || !takes_right_border(s, &runs[i - 2])
}

/// Whether raw (pre-normalization) units supply the leading space the frame
/// absorbs. A space a fold produced or exposed is not absorbed.
pub fn raw_head_space_units<U: Unit>(units: &[U]) -> bool {
	!units.is_empty() && U::decode(units, 0).0 == ' '
}

/// `units` with the trailing ASCII-whitespace run removed (the v5 frame
/// absorbs it raw, before normalization). An ASCII-valued unit is a
/// standalone character in every flavor — never a UTF-8 continuation byte or
/// half a surrogate pair — so suffix trimming equals trimming decoded text.
pub fn trim_end_ws<U: Unit>(units: &[U]) -> &[U] {
	let Some(&last) = units.last() else {
		return units;
	};
	let mut buf = [last; 4];
	let ws: [U; 6] = [' ', '\t', '\n', '\r', '\u{0b}', '\u{0c}'].map(|c| {
		let n = U::encode(c, &mut buf);
		debug_assert_eq!(n, 1, "ASCII must encode as one unit");
		buf[0]
	});
	let mut end = units.len();
	while end > 0 && ws.contains(&units[end - 1]) {
		end -= 1;
	}
	&units[..end]
}

/// Byte offset where the character before `at` starts (`at` is a character
/// boundary with at least one character before it).
#[inline]
const fn prev_char_start(out: &[u8], at: usize) -> usize {
	let mut start = at - 1;
	while out[start] & 0xc0 == 0x80 {
		start -= 1;
	}
	start
}

/// Write ⟨bow⟩, applying the seam law: in `⟨eow⟩ ' ' [case markers] ⟨bow⟩` the
/// space is not written as a character. `guard` is the byte length of `out`
/// just past the last dropped seam's ⟨bow⟩; the character before the ⟨eow⟩ has
/// to start at or after it, which is what keeps the rewrite non-overlapping
/// and left-to-right, exactly as `re.sub` scans.
fn push_bow(out: &mut Vec<u8>, guard: &mut usize) {
	let mut case_at = out.len();
	while case_at >= 1 && matches!(out[case_at - 1], SHIFT | CAPS) {
		case_at -= 1;
	}
	// `case_at` is where this run's case markers begin: a seam needs ⟨eow⟩ and
	// a space in front of them, plus a character before the ⟨eow⟩ that no
	// earlier seam has consumed.
	let seam = case_at >= 3
		&& out[case_at - 1] == b' '
		&& out[case_at - 2] == EOW
		&& prev_char_start(out, case_at - 2) >= *guard;
	if seam {
		// Drop the space, sliding this run's case markers down over it.
		out.copy_within(case_at.., case_at - 1);
		out.truncate(out.len() - 1);
	}
	out.push(BOW);
	if seam {
		*guard = out.len();
	}
}

/// The marked stream over already-normalized text, in the internal marked
/// form. A WORDY run is bracketed by ⟨bow⟩/⟨eow⟩ and case-normalized; the
/// ⟨eow⟩⟨bow⟩ seam encodes a single space between two such runs; punct, digit,
/// separator and stray-mark runs receive their measured boundary markers.
pub fn stream_norm(norm: &str, p: &FrameParams, raw_head_space: bool) -> Vec<u8> {
	let mut s = norm;
	// The frame's tail for a ladder family; a "free" family was stripped on
	// the raw text instead (see `content_token_count`).
	if p.ladder {
		s = s.trim_end_matches('\n');
	}
	// A single leading space is dropped where the frame ends in ⟨bow⟩: that
	// ⟨bow⟩ is the space (' a' = 1). Two or more are a whitespace-run token
	// and stay.
	if p.frame_bow
		&& raw_head_space
		&& s.as_bytes().first() == Some(&b' ')
		&& s.as_bytes().get(1) != Some(&b' ')
	{
		s = &s[1..];
	}

	let runs = split_runs(s);
	if runs.is_empty() {
		// Content that normalizes away entirely still pays for the frame's
		// ⟨bow⟩; with nothing to attach to it, it tiles as itself.
		return if p.frame_bow { vec![BOW] } else { Vec::new() };
	}
	let bytes = s.as_bytes();

	let borders_space = |i: usize, side: isize| -> bool {
		let at = i as isize + side;
		if at < 0 {
			return p.frame_bow; // message start counts: the frame ends in ⟨bow⟩, which is a space
		}
		let at = at as usize;
		if at >= runs.len() {
			return false; // message end does not: the trailing frame is not a space
		}
		let r = &runs[at];
		if r.cls != Class::Space {
			return false;
		}
		if side < 0 {
			bytes[r.end - 1] == b' '
		} else {
			// Run-kills-marker: a right-hand marker is written for the seam
			// space only, never before a run of two or more spaces.
			bytes[r.start] == b' ' && (r.end - r.start < 2 || bytes[r.start + 1] != b' ')
		}
	};

	let mut out: Vec<u8> = Vec::with_capacity(s.len() + s.len() / 2 + 16);
	// Byte length of `out` just past the last seam-dropped space's ⟨bow⟩.
	let mut guard = 0usize;
	let head_quote = opens_word(s, &runs, 0);
	let first = &runs[0];
	let first_body = &s[first.start..first.end];
	let has_own_bow = !head_quote
		&& (matches!(first.cls, Class::Wordy | Class::Punct | Class::StrayMark)
			|| hard_bow(first_body)
			|| (matches!(first.cls, Class::Digit | Class::Hard) && digit_bow(first_body))
			|| (first.cls == Class::Space && bytes[first.start] == b' '));
	if !has_own_bow && p.frame_bow {
		// The frame ends in ⟨bow⟩, always; a run that supplies none leaves it
		// to be written here, where it tiles as itself. A word-opening `'`
		// receives the frame's space as the character it is.
		if head_quote {
			out.push(b' ');
		} else {
			out.push(BOW);
		}
	}

	for i in 0..runs.len() {
		let r = &runs[i];
		let body = &s[r.start..r.end];
		match r.cls {
			Class::Wordy => {
				// Flanked on both sides, except where a contraction apostrophe
				// is already its opening boundary or an unattached mark run
				// already opened this word.
				let fused = i > 0 && runs[i - 1].cls == Class::StrayMark;
				let form = case_form(body, p.allcaps_min, fused);
				match form {
					CaseForm::Shift | CaseForm::ShiftKeepDotted => out.push(SHIFT),
					CaseForm::Caps => out.push(CAPS),
					CaseForm::Literal => {},
				}
				if !(fused || contraction_seam(s, &runs, i)) {
					push_bow(&mut out, &mut guard);
				}
				emit_case_body(body, &form, &mut out);
				out.push(EOW);
			},
			Class::StrayMark => {
				// A stray-mark pretoken is a word: ⟨bow⟩ on the left always,
				// ⟨eow⟩ on the right against everything except a letter, which
				// is the rest of the same word.
				push_bow(&mut out, &mut guard);
				out.extend_from_slice(body.as_bytes());
				let letter_follows = i + 1 < runs.len() && runs[i + 1].cls == Class::Wordy;
				if !letter_follows {
					out.push(EOW);
				}
			},
			_ if r.cls == Class::Punct || hard_bow(body) || hard_eow(body) => {
				// A punct span is marked only on the side that borders
				// whitespace: `a! b` gets `!⟨eow⟩`, `a!b` a bare `!`.
				let takes_bow = borders_space(i, -1)
					&& !opens_word(s, &runs, i)
					&& (r.cls == Class::Punct || hard_bow(body));
				if takes_bow {
					push_bow(&mut out, &mut guard);
				}
				out.extend_from_slice(body.as_bytes());
				if borders_space(i, 1) && (r.cls == Class::Punct || hard_eow(body)) {
					out.push(EOW);
				}
			},
			Class::Digit | Class::Hard if is_digit_run(body) => {
				// Same border markers as punctuation, decided per border
				// character; deliberately no lookback across the space.
				if digit_bow(body) && borders_space(i, -1) {
					push_bow(&mut out, &mut guard);
				}
				out.extend_from_slice(body.as_bytes());
				if digit_eow(body) && borders_space(i, 1) {
					out.push(EOW);
				}
			},
			_ => out.extend_from_slice(body.as_bytes()), // HARD letter scripts and whitespace
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::{
		ASCII_CLASS, Class, classify, classify_nonascii, digit_border, digit_border_general,
		hard_kind, hard_kind_general, is_digit_run, is_digit_run_general, is_separator,
		is_separator_general, is_stray_mark, is_stray_mark_general, marks_like_punct,
		marks_like_punct_general,
	};

	/// Every ASCII shortcut has to answer exactly what the Unicode-table path
	/// answers. These decide run splitting and boundary markers, so one wrong
	/// answer silently changes counts for the most common input there is —
	/// and the shortcuts are justified by claims about Unicode data
	/// (no ASCII codepoint combines, ASCII has no gc=No/gc=Cf, …) that only an
	/// exhaustive comparison can hold to account.
	#[test]
	fn ascii_fast_paths_match_general() {
		for i in 0u8..128 {
			let c = char::from(i);
			let at = format!("ascii {i:#04x}");
			assert_eq!(ASCII_CLASS[i as usize], classify_nonascii(c), "class {at}");
			assert_eq!(is_separator(c), is_separator_general(c), "separator {at}");
			assert_eq!(is_stray_mark(c), is_stray_mark_general(c), "stray mark {at}");
			assert_eq!(digit_border(c), digit_border_general(c), "digit border {at}");
			assert_eq!(marks_like_punct(c), marks_like_punct_general(c), "punct-like {at}");
			let body = c.to_string();
			assert_eq!(is_digit_run(&body), is_digit_run_general(&body), "digit run {at}");
		}
		// The ASCII digit-run shortcut also has to agree on runs, not just on
		// single characters: uniform, mixed, and empty.
		for body in ["", "0", "12", "123456789", "1a", "a1", "1 2", "٣", "1٣", "½", "12½"] {
			assert_eq!(is_digit_run(body), is_digit_run_general(body), "digit run {body:?}");
		}
	}

	/// PUNCT is the class `marks_like_punct` mirrors on ASCII; if that ever
	/// stops holding, the shortcut above is reading the wrong table.
	#[test]
	fn ascii_punct_class_is_punct_like() {
		for i in 0u8..128 {
			let c = char::from(i);
			assert_eq!(
				ASCII_CLASS[i as usize] == Class::Punct,
				marks_like_punct_general(c),
				"ascii {i:#04x}"
			);
		}
	}

	/// The ideograph shortcut answers for ~38 k codepoints without a Unicode
	/// lookup; if any of them is not gc=Lo in the vendored tables (an
	/// unassigned hole, a future reassignment), the shortcut would silently
	/// mark borders differently, so every codepoint in the ranges is compared.
	#[test]
	fn ideograph_shortcut_matches_general() {
		let ranges = [0x3400u32..=0x4dbf, 0x4e00..=0x9fff, 0xac00..=0xd7a3];
		let mut checked = 0usize;
		for cp in ranges.into_iter().flatten() {
			let c = char::from_u32(cp).expect("ideograph ranges hold no surrogate");
			assert_eq!(classify(c), classify_nonascii(c), "class {cp:#06x}");
			assert_eq!(marks_like_punct(c), marks_like_punct_general(c), "punct-like {cp:#06x}");
			assert_eq!(hard_kind(c), hard_kind_general(c), "hard kind {cp:#06x}");
			checked += 1;
		}
		assert_eq!(checked, 0x4dbf - 0x3400 + 0x9fff - 0x4e00 + 0xd7a3 - 0xac00 + 3);
	}
}
