//! Kitty keyboard sequence matching utilities.
//!
//! # Overview
//! Parses Kitty keyboard protocol sequences and matches codepoints plus
//! modifiers.
//!
//! # Example
//! ```ignore
//! // JS: native.matchesKittySequence("\x1b[65;5u", 65, 4) -> true
//! // JS: native.parseKey("\x1b[65;5u", false) -> "ctrl+a"
//! ```

use std::borrow::Cow;

use napi::{JsString, Result};
use napi_derive::napi;
use phf::phf_map;

use crate::js;

const LOCK_MASK: u32 = 64 + 128;

// Internal sentinel codes for CSI 1;mod <letter> forms:
const ARROW_UP: i32 = -1;
const ARROW_DOWN: i32 = -2;
const ARROW_RIGHT: i32 = -3;
const ARROW_LEFT: i32 = -4;

const FUNC_DELETE: i32 = -10;
const FUNC_INSERT: i32 = -11;
const FUNC_PAGE_UP: i32 = -12;
const FUNC_PAGE_DOWN: i32 = -13;
const FUNC_HOME: i32 = -14;
const FUNC_END: i32 = -15;
const FUNC_CLEAR: i32 = -16;

const FUNC_F1: i32 = -20;
const FUNC_F2: i32 = -21;
const FUNC_F3: i32 = -22;
const FUNC_F4: i32 = -23;
const FUNC_F5: i32 = -24;
const FUNC_F6: i32 = -25;
const FUNC_F7: i32 = -26;
const FUNC_F8: i32 = -27;
const FUNC_F9: i32 = -28;
const FUNC_F10: i32 = -29;
const FUNC_F11: i32 = -30;
const FUNC_F12: i32 = -31;

const CP_ESCAPE: i32 = 27;
const CP_TAB: i32 = 9;
const CP_ENTER: i32 = 13;
const CP_SPACE: i32 = 32;
const CP_BACKSPACE: i32 = 127;
const CP_KP_0: i32 = 57399;
const CP_KP_1: i32 = 57400;
const CP_KP_2: i32 = 57401;
const CP_KP_3: i32 = 57402;
const CP_KP_4: i32 = 57403;
const CP_KP_5: i32 = 57404;
const CP_KP_6: i32 = 57405;
const CP_KP_7: i32 = 57406;
const CP_KP_8: i32 = 57407;
const CP_KP_9: i32 = 57408;
const CP_KP_DECIMAL: i32 = 57409;
const CP_KP_DIVIDE: i32 = 57410;
const CP_KP_MULTIPLY: i32 = 57411;
const CP_KP_SUBTRACT: i32 = 57412;
const CP_KP_ADD: i32 = 57413;
const CP_KP_ENTER: i32 = 57414;
const CP_KP_EQUALS: i32 = 57415;

const MOD_SHIFT: u32 = 1;
const MOD_ALT: u32 = 2;
const MOD_CTRL: u32 = 4;
const MOD_SUPER: u32 = 8;
const MOD_NUM_LOCK: u32 = 128;

/// Event types from Kitty keyboard protocol (flag 2).
#[napi]
pub enum KeyEventType {
	/// Key press event.
	Press   = 1,
	/// Key repeat event.
	Repeat  = 2,
	/// Key release event.
	Release = 3,
}

#[inline]
fn optional_kitty_event_type(event: Option<u32>) -> Option<KeyEventType> {
	event.and_then(|ev| match ev {
		1 => Some(KeyEventType::Press),
		2 => Some(KeyEventType::Repeat),
		3 => Some(KeyEventType::Release),
		_ => None,
	})
}

#[inline]
const fn map_keypad_nav(codepoint: i32) -> Option<i32> {
	match codepoint {
		CP_KP_0 => Some(FUNC_INSERT),
		CP_KP_1 => Some(FUNC_END),
		CP_KP_2 => Some(ARROW_DOWN),
		CP_KP_3 => Some(FUNC_PAGE_DOWN),
		CP_KP_4 => Some(ARROW_LEFT),
		CP_KP_5 => Some(FUNC_CLEAR),
		CP_KP_6 => Some(ARROW_RIGHT),
		CP_KP_7 => Some(FUNC_HOME),
		CP_KP_8 => Some(ARROW_UP),
		CP_KP_9 => Some(FUNC_PAGE_UP),
		CP_KP_DECIMAL => Some(FUNC_DELETE),
		_ => None,
	}
}

#[inline]
const fn keypad_num_lock_text_codepoint(codepoint: i32) -> Option<i32> {
	match codepoint {
		CP_KP_0 => Some(48),
		CP_KP_1 => Some(49),
		CP_KP_2 => Some(50),
		CP_KP_3 => Some(51),
		CP_KP_4 => Some(52),
		CP_KP_5 => Some(53),
		CP_KP_6 => Some(54),
		CP_KP_7 => Some(55),
		CP_KP_8 => Some(56),
		CP_KP_9 => Some(57),
		CP_KP_DECIMAL => Some(46),
		_ => None,
	}
}

#[inline]
const fn keypad_operator_text_codepoint(codepoint: i32) -> Option<i32> {
	match codepoint {
		CP_KP_DIVIDE => Some(47),
		CP_KP_MULTIPLY => Some(42),
		CP_KP_SUBTRACT => Some(45),
		CP_KP_ADD => Some(43),
		CP_KP_EQUALS => Some(61),
		_ => None,
	}
}

/// Parsed Kitty keyboard protocol sequence (subset we care about).
struct ParsedKittySequence {
	codepoint:       i32,
	shifted_key:     Option<i32>,
	base_layout_key: Option<i32>,
	text_codepoint:  Option<i32>,
	modifier:        u32,
	event_type:      Option<u32>,
}

/// Parsed Kitty keyboard protocol sequence result for a Kitty input sequence.
#[napi(object)]
pub struct ParsedKittyResult {
	/// Primary codepoint associated with the key.
	pub codepoint:       i32,
	/// Optional shifted key codepoint from the sequence.
	pub shifted_key:     Option<i32>,
	/// Optional base layout key codepoint from the sequence.
	pub base_layout_key: Option<i32>,
	/// Modifier bitmask (shift/alt/ctrl), excluding lock bits.
	pub modifier:        u32,
	/// Optional event type (1 = press, 2 = repeat, 3 = release).
	pub event_type:      Option<KeyEventType>,
}

/// Perfect hash map for legacy sequences - O(1) lookup
static LEGACY_SEQUENCES: phf::Map<&'static [u8], &'static str> = phf_map! {
	// Arrow keys (SS3 and CSI)
	b"\x1bOA" => "up", b"\x1bOB" => "down", b"\x1bOC" => "right", b"\x1bOD" => "left",
	b"\x1b[A" => "up", b"\x1b[B" => "down", b"\x1b[C" => "right", b"\x1b[D" => "left",
	// Home/End (multiple terminal variants)
	b"\x1bOH" => "home", b"\x1bOF" => "end",
	b"\x1b[H" => "home", b"\x1b[F" => "end",
	b"\x1b[1~" => "home", b"\x1b[7~" => "home",
	b"\x1b[4~" => "end", b"\x1b[8~" => "end",
	// Clear
	b"\x1b[E" => "clear", b"\x1bOE" => "clear", b"\x1bOe" => "ctrl+clear", b"\x1b[e" => "shift+clear",
	// Insert/Delete
	b"\x1b[2~" => "insert", b"\x1b[2$" => "shift+insert", b"\x1b[2^" => "ctrl+insert",
	b"\x1b[3~" => "delete", b"\x1b[3$" => "shift+delete", b"\x1b[3^" => "ctrl+delete",
	// Page Up/Down
	b"\x1b[5~" => "pageUp", b"\x1b[6~" => "pageDown",
	b"\x1b[[5~" => "pageUp", b"\x1b[[6~" => "pageDown",
	// Shift+arrow
	b"\x1b[a" => "shift+up", b"\x1b[b" => "shift+down", b"\x1b[c" => "shift+right", b"\x1b[d" => "shift+left",
	// Ctrl+arrow
	b"\x1bOa" => "ctrl+up", b"\x1bOb" => "ctrl+down", b"\x1bOc" => "ctrl+right", b"\x1bOd" => "ctrl+left",
	// Shift+page/home/end
	b"\x1b[5$" => "shift+pageUp", b"\x1b[6$" => "shift+pageDown",
	b"\x1b[7$" => "shift+home", b"\x1b[8$" => "shift+end",
	// Ctrl+page/home/end
	b"\x1b[5^" => "ctrl+pageUp", b"\x1b[6^" => "ctrl+pageDown",
	b"\x1b[7^" => "ctrl+home", b"\x1b[8^" => "ctrl+end",
	// Function keys (SS3, CSI tilde, Linux console)
	b"\x1bOP" => "f1", b"\x1bOQ" => "f2", b"\x1bOR" => "f3", b"\x1bOS" => "f4",
	b"\x1b[11~" => "f1", b"\x1b[12~" => "f2", b"\x1b[13~" => "f3", b"\x1b[14~" => "f4",
	b"\x1b[[A" => "f1", b"\x1b[[B" => "f2", b"\x1b[[C" => "f3", b"\x1b[[D" => "f4", b"\x1b[[E" => "f5",
	b"\x1b[15~" => "f5", b"\x1b[17~" => "f6", b"\x1b[18~" => "f7", b"\x1b[19~" => "f8",
	b"\x1b[20~" => "f9", b"\x1b[21~" => "f10", b"\x1b[23~" => "f11", b"\x1b[24~" => "f12",
};

/// Pre-allocated single ASCII printable characters (33-126)
static ASCII_PRINTABLE: [&str; 94] = [
	"!", "\"", "#", "$", "%", "&", "'", "(", ")", "*", "+", ",", "-", ".", "/", "0", "1", "2", "3",
	"4", "5", "6", "7", "8", "9", ":", ";", "<", "=", ">", "?", "@", "A", "B", "C", "D", "E", "F",
	"G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y",
	"Z", "[", "\\", "]", "^", "_", "`", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l",
	"m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "{", "|", "}", "~",
];

/// Pre-allocated modifier+letter combinations
static CTRL_LETTERS: [&str; 26] = [
	"ctrl+a", "ctrl+b", "ctrl+c", "ctrl+d", "ctrl+e", "ctrl+f", "ctrl+g", "ctrl+h", "ctrl+i",
	"ctrl+j", "ctrl+k", "ctrl+l", "ctrl+m", "ctrl+n", "ctrl+o", "ctrl+p", "ctrl+q", "ctrl+r",
	"ctrl+s", "ctrl+t", "ctrl+u", "ctrl+v", "ctrl+w", "ctrl+x", "ctrl+y", "ctrl+z",
];

static ALT_LETTERS: [&str; 26] = [
	"alt+a", "alt+b", "alt+c", "alt+d", "alt+e", "alt+f", "alt+g", "alt+h", "alt+i", "alt+j",
	"alt+k", "alt+l", "alt+m", "alt+n", "alt+o", "alt+p", "alt+q", "alt+r", "alt+s", "alt+t",
	"alt+u", "alt+v", "alt+w", "alt+x", "alt+y", "alt+z",
];

static CTRL_ALT_LETTERS: [&str; 26] = [
	"ctrl+alt+a",
	"ctrl+alt+b",
	"ctrl+alt+c",
	"ctrl+alt+d",
	"ctrl+alt+e",
	"ctrl+alt+f",
	"ctrl+alt+g",
	"ctrl+alt+h",
	"ctrl+alt+i",
	"ctrl+alt+j",
	"ctrl+alt+k",
	"ctrl+alt+l",
	"ctrl+alt+m",
	"ctrl+alt+n",
	"ctrl+alt+o",
	"ctrl+alt+p",
	"ctrl+alt+q",
	"ctrl+alt+r",
	"ctrl+alt+s",
	"ctrl+alt+t",
	"ctrl+alt+u",
	"ctrl+alt+v",
	"ctrl+alt+w",
	"ctrl+alt+x",
	"ctrl+alt+y",
	"ctrl+alt+z",
];

static ALT_SHIFT_LETTERS: [&str; 26] = [
	"alt+shift+a",
	"alt+shift+b",
	"alt+shift+c",
	"alt+shift+d",
	"alt+shift+e",
	"alt+shift+f",
	"alt+shift+g",
	"alt+shift+h",
	"alt+shift+i",
	"alt+shift+j",
	"alt+shift+k",
	"alt+shift+l",
	"alt+shift+m",
	"alt+shift+n",
	"alt+shift+o",
	"alt+shift+p",
	"alt+shift+q",
	"alt+shift+r",
	"alt+shift+s",
	"alt+shift+t",
	"alt+shift+u",
	"alt+shift+v",
	"alt+shift+w",
	"alt+shift+x",
	"alt+shift+y",
	"alt+shift+z",
];

static LETTERS: [&str; 26] = [
	"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s",
	"t", "u", "v", "w", "x", "y", "z",
];

// =============================================================================
// Public API
// =============================================================================

/// Match Kitty protocol input against a codepoint and modifier mask.
///
/// Returns true when the parsed sequence matches the expected codepoint (or
/// base layout key) and modifier bits.
#[napi]
pub fn matches_kitty_sequence(
	data: JsString,
	expected_codepoint: i32,
	expected_modifier: u32,
) -> Result<bool> {
	let data = js::utf8(data)?;
	Ok(matches_kitty_sequence_inner(data.as_bytes(), expected_codepoint, expected_modifier))
}

fn matches_kitty_sequence_inner(
	data: &[u8],
	expected_codepoint: i32,
	expected_modifier: u32,
) -> bool {
	let Some(parsed) = parse_kitty_sequence_bytes(data) else {
		return false;
	};

	let actual_mod = parsed.modifier & !LOCK_MASK;
	let expected_mod = expected_modifier & !LOCK_MASK;
	if actual_mod != expected_mod {
		return false;
	}

	if parsed.codepoint == expected_codepoint {
		return true;
	}

	// Only fall back to a base-layout key for modified shortcuts whose codepoint is
	// not already a recognized ASCII letter or symbol. Unmodified input is text:
	// matching its physical base key would make Cyrillic "с" trigger plain "c".
	if actual_mod != 0
		&& let Some(base) = parsed.base_layout_key
		&& base == expected_codepoint
	{
		let cp = parsed.codepoint;
		let is_ascii_letter = u8::try_from(cp).is_ok_and(|b| b.is_ascii_alphabetic());
		let is_known_symbol = is_symbol_key(cp);
		if !is_ascii_letter && !is_known_symbol {
			return true;
		}
	}

	false
}

/// Check if a codepoint corresponds to a known symbol key.
#[inline]
const fn is_symbol_key(cp: i32) -> bool {
	matches!(
		cp,
		96  | // `
			34  | // "
			45  | // -
		61  | // =
		91  | // [
		93  | // ]
		92  | // \
		59  | // ;
		39  | // '
		44  | // ,
		46  | // .
		47  | // /
		33  | // !
		64  | // @
		35  | // #
		36  | // $
		37  | // %
		94  | // ^
		38  | // &
		42  | // *
		40  | // (
		41  | // )
		95  | // _
		43  | // +
		124 | // |
		126 | // ~
		123 | // {
		125 | // }
		58  | // :
		60  | // <
		62  | // >
		63 // ?
	)
}

/// Parse terminal input and return a normalized key identifier.
///
/// Returns a key id like "escape" or "ctrl+c", or None if unrecognized.
#[napi]
pub fn parse_key(data: JsString, kitty_protocol_active: bool) -> Result<Option<String>> {
	let data = js::utf8(data)?;
	Ok(parse_key_inner(data.as_bytes(), kitty_protocol_active).map(|key| key.into_owned()))
}

/// Check if input matches a legacy escape sequence for the given key name.
///
/// Returns true only when the byte sequence maps to the exact key identifier.
#[napi]
pub fn matches_legacy_sequence(data: JsString, key_name: JsString) -> Result<bool> {
	let data = js::utf8(data)?;
	let key_name = js::utf8(key_name)?;
	Ok(LEGACY_SEQUENCES
		.get(data.as_bytes())
		.is_some_and(|&id| id == &*key_name))
}

/// Match input data against a key identifier string.
///
/// Returns true when the bytes represent the specified key with modifiers.
#[napi]
pub fn matches_key(data: JsString, key_id: JsString, kitty_protocol_active: bool) -> Result<bool> {
	let data = js::utf8(data)?;
	let key_id = js::utf8(key_id)?;
	Ok(matches_key_inner(data.as_bytes(), &key_id, kitty_protocol_active))
}

/// Parse a Kitty keyboard protocol sequence.
///
/// Returns a structured parse result when the input is a valid Kitty sequence.
#[napi]
pub fn parse_kitty_sequence(data: JsString) -> Result<Option<ParsedKittyResult>> {
	let data = js::utf8(data)?;
	Ok(parse_kitty_sequence_bytes(data.as_bytes()).map(|parsed| ParsedKittyResult {
		codepoint:       parsed.codepoint,
		shifted_key:     parsed.shifted_key,
		base_layout_key: parsed.base_layout_key,
		modifier:        parsed.modifier,
		event_type:      optional_kitty_event_type(parsed.event_type),
	}))
}

// =============================================================================
// Key Matching
// =============================================================================

struct ParsedKeyId<'a> {
	key:      &'a str,
	modifier: u32,
}

fn parse_key_id(key_id: &str) -> Option<ParsedKeyId<'_>> {
	let s = key_id.trim();
	if s.is_empty() {
		return None;
	}

	// Support plus key as "++" or "ctrl++" etc.
	// In this case the trailing "++" means: delimiter '+' + key '+'
	let (prefix, forced_key_plus): (&str, bool) = if s == "+" {
		("", true)
	} else if let Some(stripped) = s.strip_suffix("++") {
		(stripped, true)
	} else {
		(s, false)
	};

	let mut modifier = 0;
	let mut key: Option<&str> = if forced_key_plus { Some("+") } else { None };

	for part in prefix.split('+') {
		let p = part.trim();
		let [c0, ..] = p.as_bytes() else {
			continue;
		};

		match c0 {
			b'c' | b'C' if p.eq_ignore_ascii_case("ctrl") => {
				modifier |= MOD_CTRL;
				continue;
			},
			b's' | b'S' if p.eq_ignore_ascii_case("shift") => {
				modifier |= MOD_SHIFT;
				continue;
			},
			b's' | b'S' if p.eq_ignore_ascii_case("super") => {
				modifier |= MOD_SUPER;
				continue;
			},
			b'a' | b'A' if p.eq_ignore_ascii_case("alt") => {
				modifier |= MOD_ALT;
				continue;
			},
			_ => {},
		}

		// Treat this as the key token (last non-modifier wins)
		key = Some(p);
	}

	let mut key = key?;
	// Optional aliases
	if key.eq_ignore_ascii_case("plus") {
		key = "+";
	} else if key.eq_ignore_ascii_case("esc") {
		key = "esc";
	}

	Some(ParsedKeyId { key, modifier })
}

#[inline]
const fn raw_ctrl_char(letter: u8) -> u8 {
	(letter.to_ascii_lowercase() - b'a') + 1
}

/// Control bytes that legacy terminals send for named keys (Backspace, Tab,
/// LF, CR/Enter, Escape, DEL).
///
/// In legacy encoding (no Kitty protocol, no `modifyOtherKeys`), pressing
/// Ctrl+H/I/J/M/[ produces the same single byte the terminal also sends for
/// Backspace/Tab/Enter/Escape. Without an enhanced encoding the two are
/// physically indistinguishable, so we resolve them to the named key — that's
/// what every user expects when they press Enter — and require the enhanced
/// encoding to match `ctrl+<letter>` separately.
#[inline]
const fn is_named_key_legacy_byte(b: u8) -> bool {
	matches!(b, 0x08 | 0x09 | 0x0a | 0x0d | 0x1b | 0x7f)
}

/// CTRL+symbol legacy mappings
const fn ctrl_symbol_to_byte(symbol: u8) -> Option<u8> {
	match symbol {
		// 0x40 -> 0, 0x5b|0x5c|..-> 0x1b|0x1c|..
		b'@' | b'[' | b'\\' | b']' | b'^' | b'_' => Some(symbol - 0x40),
		b'-' => Some(0x1f),
		_ => None,
	}
}

/// Parse xterm "modifyOtherKeys" format:
///   CSI 27 ; modifiers ; keycode ~
/// Some implementations omit the trailing '~':
///   CSI 27 ; modifiers ; keycode
#[inline]
fn parse_modify_other_keys(bytes: &[u8]) -> Option<(u32, i32)> {
	if bytes.len() < 7 || !bytes.starts_with(b"\x1b[27;") {
		return None;
	}

	let mut end = bytes.len();
	if bytes.last() == Some(&b'~') {
		end -= 1;
	}
	if end <= 5 {
		return None;
	}

	let mut idx = 5; // after "\x1b[27;"
	let (mod_value, next_idx) = parse_digits(bytes, idx, end)?;
	idx = next_idx;

	if idx >= end || bytes[idx] != b';' {
		return None;
	}
	idx += 1;

	let (keycode_u32, next_idx) = parse_digits(bytes, idx, end)?;
	idx = next_idx;

	if idx != end || mod_value == 0 {
		return None;
	}

	let modifier = mod_value - 1;
	let keycode = i32::try_from(keycode_u32).ok()?;
	Some((modifier, keycode))
}

fn matches_key_inner(bytes: &[u8], key_id: &str, kitty_protocol_active: bool) -> bool {
	let Some(ParsedKeyId { key, modifier }) = parse_key_id(key_id) else {
		return false;
	};

	// ESC-prefixed sequences (terminals with metaSendsEscape / "Use Option as
	// Meta"): \x1b\x1b[...] = Alt + inner-key. Strip the ESC prefix and match the
	// inner sequence against the base key (without alt modifier).
	// Example: \x1b\x1b[A matches "alt+up" because \x1b[A matches "up".
	// Active in BOTH legacy and kitty mode (mixed mode) because terminals like
	// Zellij in mixed mode may send legacy Alt sequences alongside Kitty ones.
	if modifier & MOD_ALT != 0
		&& bytes.len() > 2
		&& bytes[0] == 0x1b
		&& bytes[1] == 0x1b
		&& (bytes[2] == b'[' || bytes[2] == b'O')
	{
		let inner_modifier = modifier & !MOD_ALT;
		let inner_key_id: String = if inner_modifier == 0 {
			key.to_string()
		} else {
			let mut s = String::with_capacity(16);
			if inner_modifier & MOD_SHIFT != 0 {
				s.push_str("shift+");
			}
			if inner_modifier & MOD_CTRL != 0 {
				s.push_str("ctrl+");
			}
			s.push_str(key);
			s
		};
		return matches_key_inner(&bytes[1..], &inner_key_id, true);
	}

	// Parse Kitty once (avoid repeated parsing in branches).
	let kitty_parsed = parse_kitty_sequence_bytes(bytes);
	let kitty_matches = |codepoint: i32, m: u32| -> bool {
		let Some(p) = kitty_parsed.as_ref() else {
			return false;
		};
		if p.event_type == Some(3) {
			return false;
		}
		let actual_mod = p.modifier & !LOCK_MASK;
		let expected_mod = m & !LOCK_MASK;
		if actual_mod != expected_mod {
			return false;
		}
		let mut parsed_codepoint = p.codepoint;
		let mut parsed_base = p.base_layout_key;
		if p.text_codepoint.is_none() {
			if let Some(text_codepoint) = keypad_operator_text_codepoint(parsed_codepoint) {
				parsed_codepoint = text_codepoint;
				parsed_base = None;
			} else if actual_mod == 0 {
				if let Some(text_codepoint) = keypad_num_lock_text_codepoint(parsed_codepoint) {
					parsed_codepoint = text_codepoint;
					parsed_base = None;
				} else if p.modifier & MOD_NUM_LOCK != 0 {
					if let Some(mapped) = map_keypad_nav(parsed_codepoint) {
						parsed_codepoint = mapped;
					}
					if let Some(base) = parsed_base
						&& let Some(mapped) = map_keypad_nav(base)
					{
						parsed_base = Some(mapped);
					}
				}
			} else {
				if let Some(mapped) = map_keypad_nav(parsed_codepoint) {
					parsed_codepoint = mapped;
				}
				if let Some(base) = parsed_base
					&& let Some(mapped) = map_keypad_nav(base)
				{
					parsed_base = Some(mapped);
				}
			}
		}
		if parsed_codepoint == codepoint {
			return true;
		}
		if actual_mod != 0
			&& let Some(base) = parsed_base
			&& base == codepoint
		{
			let is_ascii_letter =
				u8::try_from(parsed_codepoint).is_ok_and(|b| b.is_ascii_alphabetic());
			let is_known_symbol = is_symbol_key(parsed_codepoint);
			if !is_ascii_letter && !is_known_symbol {
				return true;
			}
		}
		false
	};

	// Parse modifyOtherKeys once.
	let mok = parse_modify_other_keys(bytes);
	let mok_matches =
		|keycode: i32, m: u32| -> bool { mok.is_some_and(|(mm, kk)| kk == keycode && mm == m) };

	// Named keys (case-insensitive)
	if key.eq_ignore_ascii_case("escape") || key.eq_ignore_ascii_case("esc") {
		if modifier != 0 {
			return false;
		}
		return bytes == b"\x1b" || kitty_matches(CP_ESCAPE, 0);
	}

	if key.eq_ignore_ascii_case("space") {
		// legacy ctrl+space
		if modifier == MOD_CTRL && bytes == b"\x00" {
			return true;
		}
		// legacy alt+space (only reliable when not disambiguated)
		if modifier == MOD_ALT && !kitty_protocol_active && bytes == b"\x1b " {
			return true;
		}

		if modifier == 0 {
			return bytes == b" " || kitty_matches(CP_SPACE, 0);
		}
		return kitty_matches(CP_SPACE, modifier) || mok_matches(CP_SPACE, modifier);
	}

	if key.eq_ignore_ascii_case("tab") {
		// shift+tab classic
		if modifier == MOD_SHIFT {
			return bytes == b"\x1b[Z"
				|| kitty_matches(CP_TAB, MOD_SHIFT)
				|| mok_matches(CP_TAB, MOD_SHIFT);
		}

		// alt+tab stays ESC+TAB in many legacy/kitty-disambiguate scenarios (Tab is an
		// exception).
		if modifier == MOD_ALT && bytes == b"\x1b\t" {
			return true;
		}

		// plain tab (treat LF/CR elsewhere)
		if modifier == 0 {
			return bytes == b"\t" || kitty_matches(CP_TAB, 0);
		}

		// ctrl+tab etc are only distinguishable in enhanced modes (CSI-u /
		// modifyOtherKeys)
		return kitty_matches(CP_TAB, modifier) || mok_matches(CP_TAB, modifier);
	}

	if key.eq_ignore_ascii_case("enter") || key.eq_ignore_ascii_case("return") {
		// alt+enter is commonly ESC + CR/LF even when kitty disambiguation is on
		// (Enter is an exception).
		if modifier == MOD_ALT && (bytes == b"\x1b\r" || bytes == b"\x1b\n") {
			return true;
		}

		// unmodified enter
		if modifier == 0 {
			return bytes == b"\r"
				|| bytes == b"\n"
				|| bytes == b"\x1bOM"
				|| kitty_matches(CP_ENTER, 0)
				|| kitty_matches(CP_KP_ENTER, 0);
		}

		// modified enter is only reliably representable when encoded (CSI-u /
		// modifyOtherKeys)
		return kitty_matches(CP_ENTER, modifier)
			|| kitty_matches(CP_KP_ENTER, modifier)
			|| mok_matches(CP_ENTER, modifier)
			|| mok_matches(CP_KP_ENTER, modifier);
	}

	if key.eq_ignore_ascii_case("backspace") {
		// alt+backspace is commonly ESC + (DEL or BS) even in kitty disambiguate mode
		// (Backspace is an exception).
		if modifier == MOD_ALT {
			return bytes == b"\x1b\x7f"
				|| bytes == b"\x1b\x08"
				|| kitty_matches(CP_BACKSPACE, MOD_ALT)
				|| mok_matches(CP_BACKSPACE, MOD_ALT);
		}

		if modifier == 0 {
			return bytes == b"\x7f" || bytes == b"\x08" || kitty_matches(CP_BACKSPACE, 0);
		}

		return kitty_matches(CP_BACKSPACE, modifier) || mok_matches(CP_BACKSPACE, modifier);
	}

	if key.eq_ignore_ascii_case("insert") {
		if modifier == 0 {
			return matches_legacy_key(bytes, "insert") || kitty_matches(FUNC_INSERT, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "insert", modifier)
			|| kitty_matches(FUNC_INSERT, modifier);
	}

	if key.eq_ignore_ascii_case("delete") {
		if modifier == 0 {
			return matches_legacy_key(bytes, "delete") || kitty_matches(FUNC_DELETE, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "delete", modifier)
			|| kitty_matches(FUNC_DELETE, modifier);
	}

	if key.eq_ignore_ascii_case("clear") {
		if modifier == 0 {
			return matches_legacy_key(bytes, "clear") || kitty_matches(FUNC_CLEAR, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "clear", modifier)
			|| kitty_matches(FUNC_CLEAR, modifier);
	}

	if key.eq_ignore_ascii_case("home") {
		if modifier == 0 {
			return matches_legacy_key(bytes, "home") || kitty_matches(FUNC_HOME, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "home", modifier)
			|| kitty_matches(FUNC_HOME, modifier);
	}

	if key.eq_ignore_ascii_case("end") {
		if modifier == 0 {
			return matches_legacy_key(bytes, "end") || kitty_matches(FUNC_END, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "end", modifier)
			|| kitty_matches(FUNC_END, modifier);
	}

	if key.eq_ignore_ascii_case("pageup") {
		if modifier == 0 {
			return matches_legacy_key(bytes, "pageUp") || kitty_matches(FUNC_PAGE_UP, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "pageUp", modifier)
			|| kitty_matches(FUNC_PAGE_UP, modifier);
	}

	if key.eq_ignore_ascii_case("pagedown") {
		if modifier == 0 {
			return matches_legacy_key(bytes, "pageDown") || kitty_matches(FUNC_PAGE_DOWN, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "pageDown", modifier)
			|| kitty_matches(FUNC_PAGE_DOWN, modifier);
	}

	if key.eq_ignore_ascii_case("up") {
		if modifier == MOD_ALT {
			return kitty_matches(ARROW_UP, MOD_ALT);
		}
		if modifier == 0 {
			return matches_legacy_key(bytes, "up") || kitty_matches(ARROW_UP, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "up", modifier)
			|| kitty_matches(ARROW_UP, modifier);
	}

	if key.eq_ignore_ascii_case("down") {
		if modifier == MOD_ALT {
			return kitty_matches(ARROW_DOWN, MOD_ALT);
		}
		if modifier == 0 {
			return matches_legacy_key(bytes, "down") || kitty_matches(ARROW_DOWN, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "down", modifier)
			|| kitty_matches(ARROW_DOWN, modifier);
	}

	if key.eq_ignore_ascii_case("left") {
		if modifier == MOD_ALT {
			return bytes == b"\x1b[1;3D"
				|| (!kitty_protocol_active && bytes == b"\x1bB")
				|| kitty_matches(ARROW_LEFT, MOD_ALT);
		}
		if modifier == MOD_CTRL {
			return bytes == b"\x1b[1;5D"
				|| matches_legacy_modifier_sequence(bytes, "left", MOD_CTRL)
				|| kitty_matches(ARROW_LEFT, MOD_CTRL);
		}
		if modifier == 0 {
			return matches_legacy_key(bytes, "left") || kitty_matches(ARROW_LEFT, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "left", modifier)
			|| kitty_matches(ARROW_LEFT, modifier);
	}

	if key.eq_ignore_ascii_case("right") {
		if modifier == MOD_ALT {
			return bytes == b"\x1b[1;3C"
				|| (!kitty_protocol_active && bytes == b"\x1bF")
				|| kitty_matches(ARROW_RIGHT, MOD_ALT);
		}
		if modifier == MOD_CTRL {
			return bytes == b"\x1b[1;5C"
				|| matches_legacy_modifier_sequence(bytes, "right", MOD_CTRL)
				|| kitty_matches(ARROW_RIGHT, MOD_CTRL);
		}
		if modifier == 0 {
			return matches_legacy_key(bytes, "right") || kitty_matches(ARROW_RIGHT, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "right", modifier)
			|| kitty_matches(ARROW_RIGHT, modifier);
	}

	// Function keys (now allow modifiers via CSI forms too)
	let f_code = match key.as_bytes() {
		[b'f' | b'F', n @ b'1'..=b'9'] => Some(FUNC_F1 + (n - b'1') as i32),
		[b'f' | b'F', b'1', b'0'] => Some(FUNC_F10),
		[b'f' | b'F', b'1', b'1'] => Some(FUNC_F11),
		[b'f' | b'F', b'1', b'2'] => Some(FUNC_F12),
		_ => None,
	};

	if let Some(cp) = f_code {
		if modifier == 0 {
			return matches_legacy_key(bytes, key);
		}
		return kitty_matches(cp, modifier);
	}

	// Single-character keys: accept any ASCII graphic char (0x21..=0x7E).
	if let [ch] = key.as_bytes() {
		if !ch.is_ascii_graphic() {
			return false;
		}

		let ch = ch.to_ascii_lowercase();
		let codepoint = ch as i32;
		let is_letter = ch.is_ascii_lowercase();

		// Legacy ctrl+alt+letter is ESC followed by the control character.
		// tmux extkeys/CSI-u and Kitty mixed modes can still pass these legacy Meta
		// pairs through, so accept them even when enhanced keyboard reporting is
		// active. If that legacy form does not match, continue so CSI-u and
		// modifyOtherKeys sequences from tmux can still be recognized.
		// Legacy ESC+ctrl-char would also match Alt+Enter/Alt+Backspace/etc;
		// skip the legacy fast-path for those bytes and let kitty/modifyOtherKeys
		// disambiguate.
		if modifier == (MOD_CTRL | MOD_ALT) && is_letter {
			let ctrl_char = raw_ctrl_char(ch);
			if bytes.len() == 2
				&& bytes[0] == 0x1b
				&& bytes[1] == ctrl_char
				&& !is_named_key_legacy_byte(ctrl_char)
			{
				return true;
			}
		}

		// alt+letter can remain ESC+letter inside tmux/Kitty mixed modes. If that
		// legacy form does not match, fall through so CSI-u and modifyOtherKeys
		// encodings still match.
		if modifier == MOD_ALT && is_letter && bytes.len() == 2 && bytes[0] == 0x1b && bytes[1] == ch
		{
			return true;
		}

		// alt+shift+letter can remain ESC+UPPERCASE inside tmux/Kitty mixed modes.
		if modifier == (MOD_ALT | MOD_SHIFT)
			&& is_letter
			&& bytes.len() == 2
			&& bytes[0] == 0x1b
			&& bytes[1] == ch.to_ascii_uppercase()
		{
			return true;
		}

		// ctrl+key
		if modifier == MOD_CTRL {
			if is_letter {
				let raw = raw_ctrl_char(ch);
				// `\r`/`\t`/`\x08`/`\x1b`/`\n` are physically the same byte the terminal
				// sends for Enter/Tab/Backspace/Escape, so the legacy fast-path can only
				// claim them when the byte is not a named key. Enhanced encodings still
				// match below via kitty_matches/mok_matches.
				if bytes.len() == 1 && bytes[0] == raw && !is_named_key_legacy_byte(raw) {
					return true;
				}
				return mok_matches(codepoint, MOD_CTRL) || kitty_matches(codepoint, MOD_CTRL);
			}

			// ctrl+symbol legacy mapping (layout dependent). Same caveat as above: skip
			// the fast-path when the produced byte coincides with a named key (e.g.
			// ctrl+[ → ESC).
			if let Some(legacy_ctrl) = ctrl_symbol_to_byte(ch)
				&& bytes == [legacy_ctrl]
				&& !is_named_key_legacy_byte(legacy_ctrl)
			{
				return true;
			}

			return mok_matches(codepoint, MOD_CTRL) || kitty_matches(codepoint, MOD_CTRL);
		}

		// ctrl+shift
		if modifier == (MOD_CTRL | MOD_SHIFT) {
			return kitty_matches(codepoint, MOD_SHIFT + MOD_CTRL)
				|| mok_matches(codepoint, MOD_SHIFT + MOD_CTRL);
		}

		// shift+key (letters can match uppercase in plain legacy mode)
		if modifier == MOD_SHIFT {
			if is_letter && bytes.len() == 1 && bytes[0] == ch.to_ascii_uppercase() {
				return true;
			}
			return kitty_matches(codepoint, MOD_SHIFT) || mok_matches(codepoint, MOD_SHIFT);
		}

		// other modifier combinations
		if modifier != 0 {
			return kitty_matches(codepoint, modifier) || mok_matches(codepoint, modifier);
		}

		// plain key
		return (bytes.len() == 1 && bytes[0] == ch) || kitty_matches(codepoint, 0);
	}

	false
}

/// Check if bytes match a legacy key sequence
fn matches_legacy_key(bytes: &[u8], key: &str) -> bool {
	LEGACY_SEQUENCES.get(bytes).is_some_and(|&id| id == key)
}

/// Check if bytes match a legacy modifier sequence (shift/ctrl variants)
fn matches_legacy_modifier_sequence(bytes: &[u8], key: &str, modifier: u32) -> bool {
	if modifier == MOD_SHIFT {
		let expected = match key {
			"up" => Some("shift+up"),
			"down" => Some("shift+down"),
			"right" => Some("shift+right"),
			"left" => Some("shift+left"),
			"clear" => Some("shift+clear"),
			"insert" => Some("shift+insert"),
			"delete" => Some("shift+delete"),
			"pageUp" => Some("shift+pageUp"),
			"pageDown" => Some("shift+pageDown"),
			"home" => Some("shift+home"),
			"end" => Some("shift+end"),
			_ => None,
		};
		if let Some(expected_key) = expected {
			return LEGACY_SEQUENCES
				.get(bytes)
				.is_some_and(|&id| id == expected_key);
		}
	} else if modifier == MOD_CTRL {
		let expected = match key {
			"up" => Some("ctrl+up"),
			"down" => Some("ctrl+down"),
			"right" => Some("ctrl+right"),
			"left" => Some("ctrl+left"),
			"clear" => Some("ctrl+clear"),
			"insert" => Some("ctrl+insert"),
			"delete" => Some("ctrl+delete"),
			"pageUp" => Some("ctrl+pageUp"),
			"pageDown" => Some("ctrl+pageDown"),
			"home" => Some("ctrl+home"),
			"end" => Some("ctrl+end"),
			_ => None,
		};
		if let Some(expected_key) = expected {
			return LEGACY_SEQUENCES
				.get(bytes)
				.is_some_and(|&id| id == expected_key);
		}
	}
	false
}

// =============================================================================
// Core Parsing
// =============================================================================

#[inline]
fn parse_key_inner(bytes: &[u8], kitty_protocol_active: bool) -> Option<Cow<'static, str>> {
	// Fast path: single byte (most common for typing)
	if bytes.len() == 1 {
		return parse_single_byte(bytes[0]);
	}

	// All escape sequences start with ESC
	if bytes.first() != Some(&0x1b) {
		return None;
	}

	// Two-byte ESC sequences are legacy Meta/Alt keypresses. Handle them before
	// the legacy table so ESC+p from Ghostty/tmux is parsed as Alt+P rather than
	// the historical ESC+p Alt+Up compatibility alias.
	if bytes.len() == 2
		&& let Some(key) = parse_esc_pair(bytes[1], kitty_protocol_active)
	{
		return Some(key);
	}

	// O(1) lookup in perfect hash map for legacy sequences
	if let Some(&key_id) = LEGACY_SEQUENCES.get(bytes) {
		return Some(Cow::Borrowed(key_id));
	}

	// xterm modifyOtherKeys (CSI 27;...;...~)
	if let Some((mods, keycode)) = parse_modify_other_keys(bytes) {
		let key_name = format_key_name(keycode)?;
		if mods == 0 {
			return Some(Cow::Borrowed(key_name));
		}
		return Some(Cow::Owned(format_with_mods(mods & !LOCK_MASK, key_name)));
	}

	// Try Kitty protocol sequences (including enhanced CSI-u with optional text
	// field)
	if let Some(parsed) = parse_kitty_sequence_bytes(bytes) {
		if parsed.event_type == Some(3) {
			return None;
		}
		return format_kitty_key(&parsed);
	}

	// ESC-prefixed sequences (terminals with metaSendsEscape / "Use Option as
	// Meta"): \x1b + inner-sequence = Alt modifier on that key.
	// Example: iTerm2 "Use Option as Meta" sends \x1b\x1b[A for Alt+Up.
	// Active in BOTH legacy and kitty mode (mixed mode) because terminals like
	// Zellij in mixed mode may send legacy Alt sequences alongside Kitty ones.
	if bytes.len() > 2
		&& bytes[0] == 0x1b
		&& bytes[1] == 0x1b
		&& (bytes[2] == b'[' || bytes[2] == b'O')
		&& let Some(inner_key) = parse_key_inner(&bytes[1..], true)
	{
		return Some(Cow::Owned(format!("alt+{inner_key}")));
	}

	// Fixed CSI / SS3 sequences not covered by LEGACY_SEQUENCES
	match bytes {
		b"\x1b[Z" => Some(Cow::Borrowed("shift+tab")),
		b"\x1bOM" => Some(Cow::Borrowed("enter")), // keypad enter (SS3 M)
		_ => None,
	}
}

#[inline]
fn parse_single_byte(code: u8) -> Option<Cow<'static, str>> {
	match code {
		0x1b => Some(Cow::Borrowed("escape")),
		b'\t' => Some(Cow::Borrowed("tab")),
		b'\r' | b'\n' => Some(Cow::Borrowed("enter")),
		0x00 => Some(Cow::Borrowed("ctrl+space")),
		b' ' => Some(Cow::Borrowed("space")),
		0x7f | 0x08 => Some(Cow::Borrowed("backspace")),
		28 => Some(Cow::Borrowed("ctrl+\\")),
		29 => Some(Cow::Borrowed("ctrl+]")),
		30 => Some(Cow::Borrowed("ctrl+^")),
		31 => Some(Cow::Borrowed("ctrl+_")),
		1..=26 => Some(Cow::Borrowed(CTRL_LETTERS[(code - 1) as usize])),
		b'a'..=b'z' => Some(Cow::Borrowed(LETTERS[(code - b'a') as usize])),
		33..=126 => Some(Cow::Borrowed(ASCII_PRINTABLE[(code - 33) as usize])),
		_ => None,
	}
}

#[inline]
fn parse_esc_pair(code: u8, kitty_protocol_active: bool) -> Option<Cow<'static, str>> {
	// These remain ESC-prefixed even in kitty "disambiguate" mode in many
	// terminals.
	match code {
		0x7f | 0x08 => return Some(Cow::Borrowed("alt+backspace")),
		b'\r' | b'\n' => return Some(Cow::Borrowed("alt+enter")),
		b'\t' => return Some(Cow::Borrowed("alt+tab")),
		_ => {},
	}

	// Historical cursor-key aliases used by some legacy terminals. Keep them in
	// legacy mode only; in mixed modes (tmux extkeys/CSI-u, Kitty, etc.) ESC+B/F
	// are real Alt+Shift+B/F keypresses.
	if !kitty_protocol_active {
		match code {
			b' ' => return Some(Cow::Borrowed("alt+space")),
			b'B' => return Some(Cow::Borrowed("alt+left")),
			b'F' => return Some(Cow::Borrowed("alt+right")),
			_ => {},
		}
	}

	match code {
		1..=26 => Some(Cow::Borrowed(CTRL_ALT_LETTERS[(code - 1) as usize])),
		b'a'..=b'z' => Some(Cow::Borrowed(ALT_LETTERS[(code - b'a') as usize])),
		b'A'..=b'Z' => Some(Cow::Borrowed(ALT_SHIFT_LETTERS[(code - b'A') as usize])),
		_ => None,
	}
}

// =============================================================================
// Kitty Protocol Parsing
// =============================================================================

fn parse_kitty_sequence_bytes(bytes: &[u8]) -> Option<ParsedKittySequence> {
	if bytes.len() < 4 || bytes[0] != 0x1b || bytes[1] != b'[' {
		return None;
	}

	match *bytes.last()? {
		b'u' => parse_csi_u(bytes),
		b'~' => parse_functional(bytes),
		// CSI 1;mod <letter>
		b'A' | b'B' | b'C' | b'D' | b'E' | b'F' | b'H' | b'P' | b'Q' | b'R' | b'S' => {
			parse_csi_1_letter(bytes)
		},
		_ => None,
	}
}

fn parse_csi_u(bytes: &[u8]) -> Option<ParsedKittySequence> {
	let end = bytes.len() - 1; // index of 'u'
	let mut idx = 2;

	// unicode-key-code
	let (codepoint_u32, next_idx) = parse_digits(bytes, idx, end)?;
	let codepoint = i32::try_from(codepoint_u32).ok()?;
	idx = next_idx;

	// :alternate-key-codes (shifted[:base_layout])
	let mut shifted_key = None;
	let mut base_layout_key = None;
	if idx < end && bytes[idx] == b':' {
		idx += 1;

		let (shifted_value, next_idx) = parse_optional_digits(bytes, idx, end);
		shifted_key = shifted_value.and_then(|v| i32::try_from(v).ok());
		idx = next_idx;

		if idx < end && bytes[idx] == b':' {
			idx += 1;
			let (base_value, next_idx) = parse_digits(bytes, idx, end)?;
			base_layout_key = Some(i32::try_from(base_value).ok()?);
			idx = next_idx;
		}
	}

	// ;modifiers:event-type   (modifiers field may be omitted OR empty if followed
	// by ;text)
	let mut mod_value: u32 = 1;
	let mut event_type: Option<u32> = None;

	if idx < end && bytes[idx] == b';' {
		idx += 1;

		// modifiers digits may be absent (e.g. CSI 0;;229u)
		if idx < end && bytes[idx].is_ascii_digit() {
			let (v, next_idx) = parse_digits(bytes, idx, end)?;
			mod_value = v;
			idx = next_idx;
		} else {
			mod_value = 1;
		}

		// :event-type (allow even if modifiers were empty -> treat as modifiers=1)
		if idx < end && bytes[idx] == b':' {
			idx += 1;
			let (ev, next_idx) = parse_digits(bytes, idx, end)?;
			event_type = Some(ev);
			idx = next_idx;
		}
	}

	// ;text-as-codepoints (optional, may be empty)
	let mut text_codepoint: Option<i32> = None;
	let mut text_count: u32 = 0;
	if idx < end && bytes[idx] == b';' {
		idx += 1;
		// validate "digits(:digits)*" but allow empty and ignore values
		while idx < end {
			if bytes[idx] == b':' {
				idx += 1;
				continue;
			}
			let (cp, next_idx) = parse_digits(bytes, idx, end)?;
			text_count += 1;
			if text_count == 1 {
				if cp >= 32 {
					let cp_i32 = i32::try_from(cp).ok();
					if let Some(value) = cp_i32
						&& char::from_u32(cp).is_some()
					{
						text_codepoint = Some(value);
					}
				}
			} else {
				text_codepoint = None;
			}
			idx = next_idx;
			if idx < end && bytes[idx] == b':' {
				idx += 1;
			}
		}
	}

	if idx != end || mod_value == 0 {
		return None;
	}

	Some(ParsedKittySequence {
		codepoint,
		shifted_key,
		base_layout_key,
		text_codepoint,
		modifier: mod_value - 1,
		event_type,
	})
}

fn parse_csi_1_letter(bytes: &[u8]) -> Option<ParsedKittySequence> {
	if !bytes.starts_with(b"\x1b[1;") {
		return None;
	}

	let end = bytes.len();
	let mut idx = 4;
	let (mod_value, next_idx) = parse_digits(bytes, idx, end)?;
	idx = next_idx;

	let mut event_type = None;
	if idx < end && bytes[idx] == b':' {
		idx += 1;
		let (ev, next_idx) = parse_digits(bytes, idx, end)?;
		event_type = Some(ev);
		idx = next_idx;
	}

	if idx + 1 != end || mod_value == 0 {
		return None;
	}

	let codepoint = match bytes[idx] {
		b'A' => ARROW_UP,
		b'B' => ARROW_DOWN,
		b'C' => ARROW_RIGHT,
		b'D' => ARROW_LEFT,
		b'H' => FUNC_HOME,
		b'F' => FUNC_END,
		b'E' => FUNC_CLEAR,
		b'P' => FUNC_F1,
		b'Q' => FUNC_F2,
		b'R' => FUNC_F3,
		b'S' => FUNC_F4,
		_ => return None,
	};

	Some(ParsedKittySequence {
		codepoint,
		shifted_key: None,
		base_layout_key: None,
		text_codepoint: None,
		modifier: mod_value - 1,
		event_type,
	})
}

fn parse_functional(bytes: &[u8]) -> Option<ParsedKittySequence> {
	let end = bytes.len() - 1; // index of '~'
	let mut idx = 2;
	let (key_num, next_idx) = parse_digits(bytes, idx, end)?;
	idx = next_idx;

	let mod_value = if idx < end && bytes[idx] == b';' {
		idx += 1;
		let (v, next_idx) = parse_digits(bytes, idx, end)?;
		idx = next_idx;
		v
	} else {
		1
	};

	let mut event_type = None;
	if idx < end && bytes[idx] == b':' {
		idx += 1;
		let (ev, next_idx) = parse_digits(bytes, idx, end)?;
		event_type = Some(ev);
		idx = next_idx;
	}

	if idx != end || mod_value == 0 {
		return None;
	}

	let codepoint = match key_num {
		// Common functional keys
		2 => FUNC_INSERT,
		3 => FUNC_DELETE,
		5 => FUNC_PAGE_UP,
		6 => FUNC_PAGE_DOWN,

		// Home/End variants
		1 | 7 => FUNC_HOME,
		4 | 8 => FUNC_END,

		// Function keys (terminfo-style)
		11 => FUNC_F1,
		12 => FUNC_F2,
		13 => FUNC_F3,
		14 => FUNC_F4,
		15 => FUNC_F5,
		17 => FUNC_F6,
		18 => FUNC_F7,
		19 => FUNC_F8,
		20 => FUNC_F9,
		21 => FUNC_F10,
		23 => FUNC_F11,
		24 => FUNC_F12,

		_ => return None,
	};

	Some(ParsedKittySequence {
		codepoint,
		shifted_key: None,
		base_layout_key: None,
		text_codepoint: None,
		modifier: mod_value - 1,
		event_type,
	})
}

// =============================================================================
// Formatting
// =============================================================================

fn format_kitty_key(parsed: &ParsedKittySequence) -> Option<Cow<'static, str>> {
	let effective_mod = parsed.modifier & !LOCK_MASK;
	if effective_mod & !(MOD_SHIFT | MOD_CTRL | MOD_ALT | MOD_SUPER) != 0 {
		return None;
	}
	let effective_codepoint =
		if let Some(text_codepoint) = keypad_operator_text_codepoint(parsed.codepoint) {
			text_codepoint
		} else {
			let cp = parsed.codepoint;
			let is_ascii_letter = u8::try_from(cp).is_ok_and(|b| b.is_ascii_alphabetic());
			let is_known_symbol = is_symbol_key(cp);
			if effective_mod == 0 || is_ascii_letter || is_known_symbol {
				cp
			} else {
				parsed.base_layout_key.unwrap_or(cp)
			}
		};

	if effective_mod == 0 {
		if let Some(text_codepoint) = parsed.text_codepoint
			&& let Some(key_name) = format_key_name(text_codepoint)
		{
			return Some(Cow::Borrowed(key_name));
		}
		if let Some(text_codepoint) = keypad_num_lock_text_codepoint(parsed.codepoint)
			&& let Some(key_name) = format_key_name(text_codepoint)
		{
			return Some(Cow::Borrowed(key_name));
		}
		return format_key_name(effective_codepoint).map(Cow::Borrowed);
	}

	let key_name = format_key_name(effective_codepoint)?;
	Some(Cow::Owned(format_with_mods(effective_mod, key_name)))
}

#[inline]
fn format_key_name(codepoint: i32) -> Option<&'static str> {
	match codepoint {
		CP_ESCAPE => Some("escape"),
		CP_TAB => Some("tab"),
		CP_ENTER | CP_KP_ENTER => Some("enter"),
		CP_SPACE => Some("space"),
		CP_BACKSPACE => Some("backspace"),
		CP_KP_0 => Some("insert"),
		CP_KP_1 => Some("end"),
		CP_KP_2 => Some("down"),
		CP_KP_3 => Some("pageDown"),
		CP_KP_4 => Some("left"),
		CP_KP_5 => Some("clear"),
		CP_KP_6 => Some("right"),
		CP_KP_7 => Some("home"),
		CP_KP_8 => Some("up"),
		CP_KP_9 => Some("pageUp"),
		CP_KP_DECIMAL => Some("delete"),

		FUNC_DELETE => Some("delete"),
		FUNC_INSERT => Some("insert"),
		FUNC_HOME => Some("home"),
		FUNC_END => Some("end"),
		FUNC_PAGE_UP => Some("pageUp"),
		FUNC_PAGE_DOWN => Some("pageDown"),
		FUNC_CLEAR => Some("clear"),

		ARROW_UP => Some("up"),
		ARROW_DOWN => Some("down"),
		ARROW_LEFT => Some("left"),
		ARROW_RIGHT => Some("right"),

		FUNC_F1 => Some("f1"),
		FUNC_F2 => Some("f2"),
		FUNC_F3 => Some("f3"),
		FUNC_F4 => Some("f4"),
		FUNC_F5 => Some("f5"),
		FUNC_F6 => Some("f6"),
		FUNC_F7 => Some("f7"),
		FUNC_F8 => Some("f8"),
		FUNC_F9 => Some("f9"),
		FUNC_F10 => Some("f10"),
		FUNC_F11 => Some("f11"),
		FUNC_F12 => Some("f12"),

		// Any printable ASCII can be represented without allocation via the static table.
		33..=126 => Some(ASCII_PRINTABLE[(codepoint - 33) as usize]),
		_ => None,
	}
}

#[inline]
fn format_with_mods(mods: u32, key_name: &str) -> String {
	let mut result = String::with_capacity(16);
	if mods & MOD_SHIFT != 0 {
		result.push_str("shift+");
	}
	if mods & MOD_CTRL != 0 {
		result.push_str("ctrl+");
	}
	if mods & MOD_ALT != 0 {
		result.push_str("alt+");
	}
	if mods & MOD_SUPER != 0 {
		result.push_str("super+");
	}
	result.push_str(key_name);
	result
}

// =============================================================================
// Digit Parsing Helpers
// =============================================================================

#[inline]
fn parse_digits(bytes: &[u8], mut idx: usize, end: usize) -> Option<(u32, usize)> {
	if idx >= end || !bytes[idx].is_ascii_digit() {
		return None;
	}

	let mut value: u32 = 0;
	while idx < end && bytes[idx].is_ascii_digit() {
		value = value
			.checked_mul(10)?
			.checked_add(u32::from(bytes[idx] - b'0'))?;
		idx += 1;
	}

	Some((value, idx))
}

#[inline]
fn parse_optional_digits(bytes: &[u8], idx: usize, end: usize) -> (Option<u32>, usize) {
	if idx >= end || !bytes[idx].is_ascii_digit() {
		return (None, idx);
	}
	parse_digits(bytes, idx, end).map_or((None, idx), |(v, i)| (Some(v), i))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn esc_prefix_alt_arrows_mixed_mode() {
		// Mixed mode: legacy Alt sequences must parse even when kitty is active
		assert!(matches_key_inner(b"\x1b\x1b[A", "alt+up", true));
		assert!(matches_key_inner(b"\x1b\x1b[B", "alt+down", true));
		assert!(matches_key_inner(b"\x1b\x1b[C", "alt+right", true));
		assert!(matches_key_inner(b"\x1b\x1b[D", "alt+left", true));
		assert_eq!(parse_key_inner(b"\x1b\x1b[A", true).as_deref(), Some("alt+up"));
		assert_eq!(parse_key_inner(b"\x1b\x1b[B", true).as_deref(), Some("alt+down"));
		// Bare double ESC should NOT be parsed as alt
		assert_eq!(parse_key_inner(b"\x1b\x1b", true).as_deref(), None);
	}

	#[test]
	fn esc_pair_alt_letters_mixed_mode() {
		// tmux 3.6 with `extended-keys-format csi-u` can enable enhanced keyboard
		// handling while still forwarding Alt+letter as the legacy ESC+letter form.
		for active in [false, true] {
			assert_eq!(parse_key_inner(b"\x1bp", active).as_deref(), Some("alt+p"));
			assert_eq!(parse_key_inner(b"\x1bh", active).as_deref(), Some("alt+h"));
			assert_eq!(parse_key_inner(b"\x1bP", active).as_deref(), Some("alt+shift+p"));
			assert_eq!(parse_key_inner(b"\x1b\x10", active).as_deref(), Some("ctrl+alt+p"));
			assert!(matches_key_inner(b"\x1bp", "alt+p", active));
			assert!(matches_key_inner(b"\x1bh", "alt+h", active));
			assert!(matches_key_inner(b"\x1bP", "alt+shift+p", active));
			assert!(matches_key_inner(b"\x1b\x10", "ctrl+alt+p", active));
			assert!(!matches_key_inner(b"\x1bp", "alt+up", active));
			assert!(!matches_key_inner(b"\x1bn", "alt+down", active));
			assert!(!matches_key_inner(b"\x1bb", "alt+left", active));
			assert!(!matches_key_inner(b"\x1bf", "alt+right", active));
		}
		assert!(matches_key_inner(b"\x1b[1;3A", "alt+up", true));
		assert!(matches_key_inner(b"\x1b[112;3u", "alt+p", true));
		assert!(matches_key_inner(b"\x1b[27;3;112~", "alt+p", false));
		for active in [false, true] {
			assert_eq!(parse_key_inner(b"\x1b\n", active).as_deref(), Some("alt+enter"));
			assert!(matches_key_inner(b"\x1b\n", "alt+enter", active));
		}
	}

	#[test]
	fn uppercase_meta_b_f_stay_legacy_arrow_aliases_only_without_kitty() {
		assert_eq!(parse_key_inner(b"\x1bB", false).as_deref(), Some("alt+left"));
		assert_eq!(parse_key_inner(b"\x1bF", false).as_deref(), Some("alt+right"));
		assert_eq!(parse_key_inner(b"\x1bB", true).as_deref(), Some("alt+shift+b"));
		assert_eq!(parse_key_inner(b"\x1bF", true).as_deref(), Some("alt+shift+f"));
		assert!(matches_key_inner(b"\x1bB", "alt+left", false));
		assert!(matches_key_inner(b"\x1bF", "alt+right", false));
		assert!(!matches_key_inner(b"\x1bB", "alt+left", true));
		assert!(!matches_key_inner(b"\x1bF", "alt+right", true));
	}

	#[test]
	fn esc_prefix_csi_only() {
		// Only CSI and SS3 inner sequences parse as Alt; other double-ESC does not
		assert_eq!(parse_key_inner(b"\x1b\x1bX", true).as_deref(), None);
		assert_eq!(parse_key_inner(b"\x1b\x1bX", false).as_deref(), None);
	}

	#[test]
	fn matches_key_ignores_kitty_release_events() {
		assert!(matches_key_inner(b"\x1b[127u", "backspace", true));
		assert!(matches_key_inner(b"\x1b[127;1:2u", "backspace", true));
		assert!(!matches_key_inner(b"\x1b[127;1:3u", "backspace", true));
	}

	#[test]
	fn unmodified_non_latin_text_does_not_match_base_layout_shortcuts() {
		let plain_cyrillic_c = b"\x1b[1089::99u";
		assert!(!matches_key_inner(plain_cyrillic_c, "c", true));
		assert_eq!(parse_key_inner(plain_cyrillic_c, true).as_deref(), None);
		assert!(!matches_kitty_sequence_inner(plain_cyrillic_c, i32::from(b'c'), 0));

		let ctrl_cyrillic_c = b"\x1b[1089::99;5u";
		assert!(matches_key_inner(ctrl_cyrillic_c, "ctrl+c", true));
		assert_eq!(parse_key_inner(ctrl_cyrillic_c, true).as_deref(), Some("ctrl+c"));
		assert!(matches_kitty_sequence_inner(ctrl_cyrillic_c, i32::from(b'c'), MOD_CTRL));
	}

	#[test]
	fn parse_key_ignores_kitty_sequences_with_unsupported_modifiers() {
		// Hyper (16) and meta (32) are kitty modifier bits we do not surface
		// because nothing in the editor binds them. Wire mod 17 = mask 16 = hyper.
		assert_eq!(parse_key_inner(b"\x1b[99;17u", true).as_deref(), None);
		// Wire mod 33 = mask 32 = meta.
		assert_eq!(parse_key_inner(b"\x1b[99;33u", true).as_deref(), None);
	}

	#[test]
	fn parse_key_ignores_kitty_release_events() {
		assert_eq!(parse_key_inner(b"\x1b[127u", true).as_deref(), Some("backspace"));
		assert_eq!(parse_key_inner(b"\x1b[127;1:2u", true).as_deref(), Some("backspace"));
		assert_eq!(parse_key_inner(b"\x1b[127;1:3u", true).as_deref(), None);
	}

	#[test]
	fn keypad_digits_stay_text_with_or_without_num_lock_modifier() {
		for bytes in [b"\x1b[57400u".as_slice(), b"\x1b[57400;129u".as_slice()] {
			assert_eq!(parse_key_inner(bytes, true).as_deref(), Some("1"));
			assert!(matches_key_inner(bytes, "1", true));
			assert!(!matches_key_inner(bytes, "end", true));
		}
		assert_eq!(parse_key_inner(b"\x1b[57404u", true).as_deref(), Some("5"));
		assert!(matches_key_inner(b"\x1b[57404u", "5", true));
		assert!(!matches_key_inner(b"\x1b[57404u", "clear", true));
	}

	#[test]
	fn keypad_operators_stay_text() {
		assert_eq!(parse_key_inner(b"\x1b[57410u", true).as_deref(), Some("/"));
		assert!(matches_key_inner(b"\x1b[57410u", "/", true));
		assert_eq!(parse_key_inner(b"\x1b[57413;5u", true).as_deref(), Some("ctrl++"));
		assert!(matches_key_inner(b"\x1b[57413;5u", "ctrl++", true));
	}

	#[test]
	fn modified_num_lock_keypad_keys_still_match_navigation() {
		assert_eq!(parse_key_inner(b"\x1b[57400;133u", true).as_deref(), Some("ctrl+end"));
		assert!(matches_key_inner(b"\x1b[57400;133u", "ctrl+end", true));
		assert!(!matches_key_inner(b"\x1b[57400;133u", "1", true));
	}

	#[test]
	fn ctrl_alt_letter_falls_through_to_csi_u_and_mok() {
		// Legacy ESC+ctrl-char form (tmux without modifyOtherKeys) keeps matching.
		assert!(matches_key_inner(b"\x1b\x01", "ctrl+alt+a", false));
		// CSI-u form: \x1b[<codepoint>;<mod>u, mod = (ctrl|alt)+1 = 7.
		assert!(matches_key_inner(b"\x1b[97;7u", "ctrl+alt+a", false));
		// modifyOtherKeys form: \x1b[27;<mod>;<codepoint>~, mod = 7.
		assert!(matches_key_inner(b"\x1b[27;7;97~", "ctrl+alt+a", false));
		// Unrelated bytes still do not match.
		assert!(!matches_key_inner(b"\x1b[97;7u", "ctrl+alt+b", false));
	}

	#[test]
	fn ctrl_letter_does_not_steal_named_key_legacy_bytes() {
		// Issue #1354: pressing Enter sends `\r` (0x0d) and that byte is also
		// the legacy encoding of Ctrl+M. In legacy mode the two are physically
		// indistinguishable, so `\r` MUST resolve to Enter and MUST NOT match
		// ctrl+m. Same goes for the other named-key collisions.
		assert!(matches_key_inner(b"\r", "enter", false));
		assert!(!matches_key_inner(b"\r", "ctrl+m", false));

		assert!(matches_key_inner(b"\n", "enter", false));
		assert!(!matches_key_inner(b"\n", "ctrl+j", false));

		assert!(matches_key_inner(b"\t", "tab", false));
		assert!(!matches_key_inner(b"\t", "ctrl+i", false));

		assert!(matches_key_inner(b"\x08", "backspace", false));
		assert!(!matches_key_inner(b"\x08", "ctrl+h", false));

		assert!(matches_key_inner(b"\x1b", "escape", false));
		assert!(!matches_key_inner(b"\x1b", "ctrl+[", false));

		// Non-colliding ctrl+letter still works through the legacy fast-path.
		assert!(matches_key_inner(b"\x03", "ctrl+c", false));
		assert!(matches_key_inner(b"\x18", "ctrl+x", false));

		// Enhanced encodings still let ctrl+<colliding-letter> match — that's
		// the whole point of the protocol upgrade.
		assert!(matches_key_inner(b"\x1b[109;5u", "ctrl+m", true));
		assert!(matches_key_inner(b"\x1b[27;5;109~", "ctrl+m", false));
		assert!(matches_key_inner(b"\x1b[105;5u", "ctrl+i", true));
		assert!(matches_key_inner(b"\x1b[27;5;91~", "ctrl+[", false));
	}

	#[test]
	fn ctrl_alt_letter_does_not_steal_alt_enter() {
		// `\x1b\r` is Alt+Enter in legacy mode; it must not also satisfy
		// ctrl+alt+m. Enhanced encodings still match.
		assert!(matches_key_inner(b"\x1b\r", "alt+enter", false));
		assert!(!matches_key_inner(b"\x1b\r", "ctrl+alt+m", false));
		assert!(!matches_key_inner(b"\x1b\t", "ctrl+alt+i", false));
		assert!(!matches_key_inner(b"\x1b\x08", "ctrl+alt+h", false));

		// CSI-u / modifyOtherKeys forms still resolve ctrl+alt+<colliding>.
		assert!(matches_key_inner(b"\x1b[109;7u", "ctrl+alt+m", true));
		assert!(matches_key_inner(b"\x1b[27;7;109~", "ctrl+alt+m", false));
	}

	#[test]
	fn super_alt_backspace_matches_ghostty_default() {
		// Issue #2064: Ghostty on macOS reports Option+Backspace as kitty
		// modifier 11 (wire) = 10 (mask) = super(8)|alt(2). Before super
		// support landed, the matcher rejected this entirely.
		assert!(matches_key_inner(b"\x1b[127;11u", "super+alt+backspace", true));
		assert!(matches_key_inner(b"\x1b[127;11u", "alt+super+backspace", true));
		assert_eq!(parse_key_inner(b"\x1b[127;11u", true).as_deref(), Some("alt+super+backspace"));
		// Plain alt+backspace must still NOT match — the modifier really is super|alt.
		assert!(!matches_key_inner(b"\x1b[127;11u", "alt+backspace", true));
		// And plain backspace (mod 0) must still not match a super+alt-modified press.
		assert!(!matches_key_inner(b"\x1b[127;11u", "backspace", true));
		// Release events stay ignored: super+alt+backspace release must not match a
		// press.
		assert!(!matches_key_inner(b"\x1b[127;11:3u", "super+alt+backspace", true));
		assert_eq!(parse_key_inner(b"\x1b[127;11:3u", true).as_deref(), None);
	}

	#[test]
	fn super_modifier_parses_for_arbitrary_keys() {
		// Cmd+letter on macOS under kitty flag=1+: super(8)+'a'(97) → wire mod 9.
		assert!(matches_key_inner(b"\x1b[97;9u", "super+a", true));
		assert_eq!(parse_key_inner(b"\x1b[97;9u", true).as_deref(), Some("super+a"));
		// Cmd+Shift+letter: super(8)|shift(1) = 9 mask, wire 10.
		assert!(matches_key_inner(b"\x1b[97;10u", "super+shift+a", true));
		assert!(matches_key_inner(b"\x1b[97;10u", "shift+super+a", true));
		assert_eq!(parse_key_inner(b"\x1b[97;10u", true).as_deref(), Some("shift+super+a"));
	}
}
