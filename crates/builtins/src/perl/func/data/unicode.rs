//! Unicode case operations from perlfunc/perlunicode. Perl maps code points
//! independently (no contextual final sigma or locale-sensitive tailoring).

use crate::perl::{ast::Builtin, value::PStr};

use super::unicode_data::{EXPANSIONS, FOLD, LOWER, MARK_BOUNDARIES, Mapping, QUOTE_BOUNDARIES, TITLE, UPPER};

const COMBINING_GREEK_YPOGEGRAMMENI: u32 = 0x345;
const GREEK_CAPITAL_LETTER_IOTA: u32 = 0x399;

fn is_mark(cp: u32) -> bool { MARK_BOUNDARIES.partition_point(|&bound| bound <= cp) % 2 != 0 }

fn mapped(cp: u32, table: &[Mapping]) -> ([u32; 3], usize) {
	let i = table.partition_point(|&(lo, ..)| lo <= cp);
	if let Some(&(_, hi, step, delta)) = i.checked_sub(1).and_then(|i| table.get(i)) {
		if cp <= hi {
			if step == 0 {
				let expansion = EXPANSIONS[!delta as usize];
				let mut out = [0; 3];
				out[..expansion.len()].copy_from_slice(expansion);
				return (out, expansion.len());
			}
			if (hi - cp).is_multiple_of(step) {
				return ([cp.wrapping_add_signed(delta), 0, 0], 1);
			}
		}
	}
	([cp, 0, 0], 1)
}

/// Apply a full Perl case conversion to a string, with optional Latin-1 Unicode semantics.
pub(in crate::perl) fn map_case(mut s: PStr, b: Builtin, unicode_strings: bool) -> PStr {
	let first = matches!(b, Builtin::Lcfirst | Builtin::Ucfirst);
	let lower = matches!(b, Builtin::Lc | Builtin::Lcfirst | Builtin::Fc);
	if (!s.utf8 && !unicode_strings) || s.bytes.is_ascii() {
		if first {
			if let Some(c) = s.bytes.first_mut() {
				if lower { c.make_ascii_lowercase(); } else { c.make_ascii_uppercase(); }
			}
		} else if lower {
			s.bytes.make_ascii_lowercase();
		} else {
			s.bytes.make_ascii_uppercase();
		}
		return s;
	}
	let table = match b {
		Builtin::Lc | Builtin::Lcfirst => LOWER,
		Builtin::Uc => UPPER,
		Builtin::Ucfirst => TITLE,
		Builtin::Fc => FOLD,
		_ => unreachable!("not a case transform"),
	};
	if first {
		let Some(cp) = s.chars().next() else { return s; };
		let (mapped, count) = mapped(cp, table);
		if count == 1 && mapped[0] == cp { return s; }
		let mut replacement = PStr::from_codepoints(mapped[..count].iter().copied());
		if s.utf8 != replacement.utf8 { s.upgrade(); replacement.upgrade(); }
		let end = s.char_to_byte(1);
		s.bytes.splice(..end, replacement.bytes);
		return s;
	}
	// uc turns U+0345 into a capital iota, which is no longer a combining mark, so
	// (as perl's pp_uc does) it is emitted after the marks that follow it.
	let upper = b == Builtin::Uc;
	let mut iota_pending = false;
	let mut result = None;
	for (i, cp) in s.chars().enumerate() {
		if iota_pending && !is_mark(cp) {
			iota_pending = false;
			result.get_or_insert_with(|| clone_prefix(&s, i)).push_char(GREEK_CAPITAL_LETTER_IOTA);
		}
		if upper && cp == COMBINING_GREEK_YPOGEGRAMMENI {
			iota_pending = true;
			result.get_or_insert_with(|| clone_prefix(&s, i));
			continue;
		}
		let (mapped, count) = mapped(cp, table);
		if result.is_none() && count == 1 && mapped[0] == cp { continue; }
		let out = result.get_or_insert_with(|| clone_prefix(&s, i));
		for &c in &mapped[..count] { out.push_char(c); }
	}
	if iota_pending && let Some(out) = result.as_mut() { out.push_char(GREEK_CAPITAL_LETTER_IOTA); }
	result.unwrap_or(s)
}

fn clone_prefix(s: &PStr, chars: usize) -> PStr {
	let mut out = Vec::with_capacity(s.bytes.len());
	out.extend_from_slice(&s.bytes[..s.char_to_byte(chars)]);
	PStr::new(out, s.utf8)
}

/// Backslash literal syntax and non-ASCII characters selected by Perl's quoting rules.
pub(in crate::perl) fn quote_meta(s: PStr, unicode_strings: bool) -> PStr {
	let use_properties = s.utf8 || unicode_strings;
	let mut result = None;
	for (i, cp) in s.chars().enumerate() {
		let escape = if cp < 0x80 {
			let b = cp as u8;
			!(b.is_ascii_alphanumeric() || b == b'_')
		} else {
			!use_properties || QUOTE_BOUNDARIES.partition_point(|&bound| bound <= cp) % 2 != 0
		};
		if let Some(out) = result.as_mut() {
			let out: &mut PStr = out;
			if escape { out.push_char(u32::from(b'\\')); }
			out.push_char(cp);
		} else if escape {
			let mut out = clone_prefix(&s, i);
			out.push_char(u32::from(b'\\'));
			out.push_char(cp);
			result = Some(out);
		}
	}
	result.unwrap_or(s)
}
