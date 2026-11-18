//! The magic(5) rule language: parser for the bundled database and the
//! matcher that runs it against a buffer.
//!
//! A port of file 5.41's `apprentice.c` (parsing, strength ordering) and
//! `softmagic.c` (matching, printing). It follows the C control flow line by
//! line, including the quirks that shape real output (64-byte descriptions,
//! 128-byte string windows, bounds checks that ignore a `use` base offset), so
//! the bundled rules print what libmagic prints. `der` rules never match.

use std::{
	borrow::Cow,
	collections::HashMap,
	fmt::Write as _,
	ops::Range,
	sync::{LazyLock, OnceLock},
};

use jiff::{Timestamp, tz::TimeZone};
use regex::bytes::{Regex, RegexBuilder};

use super::text::looks_utf8;

// `struct magic` flag bits.
const INDIR: u8 = 0x01;
const OFFADD: u8 = 0x02;
const INDIROFFADD: u8 = 0x04;
const UNSIGNED: u8 = 0x08;
const NOSPACE: u8 = 0x10;
/// The entry is a binary test; set on top-level lines only.
pub(super) const BINTEST: u8 = 0x20;
/// The entry is a text test; set on top-level lines only.
pub(super) const TEXTTEST: u8 = 0x40;
const OFFNEGATIVE: u8 = 0x80;

// Mask and indirect-offset operators.
const OP_AND: u8 = 0;
const OP_OR: u8 = 1;
const OP_XOR: u8 = 2;
const OP_ADD: u8 = 3;
const OP_MINUS: u8 = 4;
const OP_MULTIPLY: u8 = 5;
const OP_DIVIDE: u8 = 6;
const OP_MODULO: u8 = 7;
const OPS_MASK: u8 = 0x07;
const OP_SIGNED: u8 = 0x20;
const OP_INVERSE: u8 = 0x40;
const OP_INDIRECT: u8 = 0x80;

// String modifier flags.
const STRING_COMPACT_WHITESPACE: u32 = 1 << 0;
const STRING_COMPACT_OPTIONAL_WHITESPACE: u32 = 1 << 1;
const STRING_IGNORE_LOWERCASE: u32 = 1 << 2;
const STRING_IGNORE_UPPERCASE: u32 = 1 << 3;
const REGEX_OFFSET_START: u32 = 1 << 4;
const STRING_TEXTTEST: u32 = 1 << 5;
const STRING_BINTEST: u32 = 1 << 6;
const PSTRING_1_LE: u32 = 1 << 7;
const PSTRING_2_BE: u32 = 1 << 8;
const PSTRING_2_LE: u32 = 1 << 9;
const PSTRING_4_BE: u32 = 1 << 10;
const PSTRING_4_LE: u32 = 1 << 11;
const REGEX_LINE_COUNT: u32 = 1 << 11;
const PSTRING_LEN: u32 = PSTRING_1_LE | PSTRING_2_LE | PSTRING_2_BE | PSTRING_4_LE | PSTRING_4_BE;
const PSTRING_LENGTH_INCLUDES_ITSELF: u32 = 1 << 12;
const STRING_TRIM: u32 = 1 << 13;
const STRING_FULL_WORD: u32 = 1 << 14;
const INDIRECT_RELATIVE: u32 = 1 << 0;

/// `MAXstring`: the window a string comparison sees.
const MAX_STRING: usize = 128;
/// `MAXDESC - 1`: descriptions are cut to this many bytes.
const MAX_DESC: usize = 63;
/// `MAXMIME - 1`.
const MAX_MIME: usize = 79;
/// `sizeof(ext) - 1`.
const MAX_EXT: usize = 63;
/// The scratch buffer libmagic prints search and regex matches through.
const PRINT_MAX: usize = 511;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
	Byte,
	Short,
	Long,
	Quad,
	Float,
	Double,
	Date,
	LDate,
	QDate,
	QLDate,
	QWDate,
	Str,
	PStr,
	Str16,
	Regex,
	Search,
	Default,
	Clear,
	Name,
	Use,
	Indirect,
	Guid,
	Offset,
	Id3,
	/// `der` and the varints: parsed so the entry keeps its shape, never
	/// matched.
	Unsupported,
}

impl Kind {
	/// `IS_STRING`.
	const fn is_string(self) -> bool {
		matches!(
			self,
			Self::Str | Self::PStr | Self::Str16 | Self::Regex | Self::Search | Self::Indirect | Self::Name | Self::Use
		)
	}

	/// `typesize`: bytes a numeric type reads.
	const fn size(self) -> Option<usize> {
		match self {
			Self::Byte => Some(1),
			Self::Short => Some(2),
			Self::Long | Self::Date | Self::LDate | Self::Float => Some(4),
			Self::Quad | Self::QDate | Self::QLDate | Self::QWDate | Self::Double | Self::Offset => Some(8),
			Self::Guid => Some(16),
			_ => None,
		}
	}
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Endian {
	Native,
	Little,
	Big,
	Middle,
}

/// The type keywords in `type_tbl` order: lookup is by prefix, first hit wins.
const TYPES: &[(&str, Kind, Endian)] = &[
	("byte", Kind::Byte, Endian::Native),
	("short", Kind::Short, Endian::Native),
	("default", Kind::Default, Endian::Native),
	("long", Kind::Long, Endian::Native),
	("string", Kind::Str, Endian::Native),
	("date", Kind::Date, Endian::Native),
	("beshort", Kind::Short, Endian::Big),
	("belong", Kind::Long, Endian::Big),
	("bedate", Kind::Date, Endian::Big),
	("leshort", Kind::Short, Endian::Little),
	("lelong", Kind::Long, Endian::Little),
	("ledate", Kind::Date, Endian::Little),
	("pstring", Kind::PStr, Endian::Native),
	("ldate", Kind::LDate, Endian::Native),
	("beldate", Kind::LDate, Endian::Big),
	("leldate", Kind::LDate, Endian::Little),
	("regex", Kind::Regex, Endian::Native),
	("bestring16", Kind::Str16, Endian::Big),
	("lestring16", Kind::Str16, Endian::Little),
	("search", Kind::Search, Endian::Native),
	("medate", Kind::Date, Endian::Middle),
	("meldate", Kind::LDate, Endian::Middle),
	("melong", Kind::Long, Endian::Middle),
	("quad", Kind::Quad, Endian::Native),
	("lequad", Kind::Quad, Endian::Little),
	("bequad", Kind::Quad, Endian::Big),
	("qdate", Kind::QDate, Endian::Native),
	("leqdate", Kind::QDate, Endian::Little),
	("beqdate", Kind::QDate, Endian::Big),
	("qldate", Kind::QLDate, Endian::Native),
	("leqldate", Kind::QLDate, Endian::Little),
	("beqldate", Kind::QLDate, Endian::Big),
	("float", Kind::Float, Endian::Native),
	("befloat", Kind::Float, Endian::Big),
	("lefloat", Kind::Float, Endian::Little),
	("double", Kind::Double, Endian::Native),
	("bedouble", Kind::Double, Endian::Big),
	("ledouble", Kind::Double, Endian::Little),
	("leid3", Kind::Id3, Endian::Little),
	("beid3", Kind::Id3, Endian::Big),
	("indirect", Kind::Indirect, Endian::Native),
	("qwdate", Kind::QWDate, Endian::Native),
	("leqwdate", Kind::QWDate, Endian::Little),
	("beqwdate", Kind::QWDate, Endian::Big),
	("name", Kind::Name, Endian::Native),
	("use", Kind::Use, Endian::Native),
	("clear", Kind::Clear, Endian::Native),
	("der", Kind::Unsupported, Endian::Native),
	("guid", Kind::Guid, Endian::Native),
	("offset", Kind::Offset, Endian::Native),
	("bevarint", Kind::Unsupported, Endian::Big),
	("levarint", Kind::Unsupported, Endian::Little),
];

/// A rule's comparison value.
enum Value<'a> {
	Num(u64),
	Float(f64),
	Bytes(Cow<'a, [u8]>),
	Regex(Box<LazyRegex<'a>>),
	Guid([u8; 16]),
}

/// A regex rule's pattern, compiled on first use.
struct LazyRegex<'a> {
	pattern:  Cow<'a, [u8]>,
	compiled: OnceLock<Option<Regex>>,
}

/// One line of a magic entry (`struct magic`).
struct Magic<'a> {
	cont_level: u16,
	flag:       u8,
	reln:       u8,
	kind:       Kind,
	endian:     Endian,
	in_kind:    Kind,
	in_endian:  Endian,
	in_op:      u8,
	mask_op:    u8,
	factor_op:  u8,
	factor:     u8,
	vallen:     u8,
	offset:     i32,
	in_offset:  i32,
	num_mask:   u64,
	str_range:  u32,
	str_flags:  u32,
	value:      Value<'a>,
	desc:       &'a [u8],
	mime:       &'a [u8],
	ext:        &'a [u8],
	apple:      &'a [u8],
}

impl Magic<'_> {
	/// The string value; empty for numeric rules.
	fn bytes(&self) -> &[u8] {
		match &self.value {
			Value::Bytes(bytes) => bytes,
			Value::Regex(regex) => &regex.pattern,
			_ => &[],
		}
	}

	/// The value as the C string libmagic prints: cut at the first NUL.
	fn c_str(&self) -> &[u8] {
		c_str(self.bytes())
	}

	const fn num(&self) -> u64 {
		match self.value {
			Value::Num(value) => value,
			_ => 0,
		}
	}
}

/// A parsed magic database: every entry's lines, ordered by strength.
pub(super) struct Db<'a> {
	magics: Vec<Magic<'a>>,
	/// The matchable entries, strongest first.
	order:  Vec<Range<u32>>,
	/// `name` entries by name.
	names:  HashMap<&'a [u8], Range<u32>>,
}

const fn is_space(c: u8) -> bool {
	matches!(c, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r')
}

fn at(s: &[u8], i: usize) -> u8 {
	s.get(i).copied().unwrap_or(0)
}

fn c_str(s: &[u8]) -> &[u8] {
	&s[..memchr::memchr(0, s).unwrap_or(s.len())]
}

fn eat_tab(s: &[u8], mut i: usize) -> usize {
	while i < s.len() && is_space(s[i]) {
		i += 1;
	}
	i
}

/// `strtoull(s, &end, 0)`: the value and the bytes consumed, `0` consumed
/// when there is no number.
fn strtoull(s: &[u8]) -> (u64, usize) {
	let mut i = eat_tab(s, 0);
	let negative = at(s, i) == b'-';
	if matches!(at(s, i), b'+' | b'-') {
		i += 1;
	}
	let mut base = 10u64;
	if at(s, i) == b'0' {
		if at(s, i + 1) | 0x20 == b'x' && at(s, i + 2).is_ascii_hexdigit() {
			base = 16;
			i += 2;
		} else {
			base = 8;
		}
	}
	let start = i;
	let mut value = 0u64;
	while let Some(digit) = (at(s, i) as char).to_digit(base as u32) {
		value = value.wrapping_mul(base).wrapping_add(u64::from(digit));
		i += 1;
	}
	if i == start {
		return (0, 0);
	}
	(if negative { value.wrapping_neg() } else { value }, i)
}

/// `strtod`: decimal floats only, which is all the rules use.
fn strtod(s: &[u8]) -> (f64, usize) {
	let start = eat_tab(s, 0);
	let mut i = start;
	if matches!(at(s, i), b'+' | b'-') {
		i += 1;
	}
	let digits = |i: &mut usize| {
		let from = *i;
		while at(s, *i).is_ascii_digit() {
			*i += 1;
		}
		*i > from
	};
	let mut any = digits(&mut i);
	if at(s, i) == b'.' {
		i += 1;
		any |= digits(&mut i);
	}
	if !any {
		return (0.0, 0);
	}
	if at(s, i) | 0x20 == b'e' {
		let mut exponent = i + 1;
		if matches!(at(s, exponent), b'+' | b'-') {
			exponent += 1;
		}
		if digits(&mut exponent) {
			i = exponent;
		}
	}
	let text = std::str::from_utf8(&s[start..i]).unwrap_or("0");
	(text.parse().unwrap_or(0.0), i)
}

/// `eatsize`: the C size suffix of a number (`10UL`).
fn eat_size(s: &[u8], mut i: usize) -> usize {
	if at(s, i) | 0x20 == b'u' {
		i += 1;
	}
	if matches!(at(s, i) | 0x20, b'l' | b's' | b'h' | b'b' | b'c') {
		i += 1;
	}
	i
}

/// `getstr`: the value up to the first unescaped whitespace, C escapes
/// resolved, and the bytes consumed.
fn getstr(s: &[u8]) -> (Cow<'_, [u8]>, usize) {
	let end = s.iter().position(|&c| is_space(c)).unwrap_or(s.len());
	if !s[..end].contains(&b'\\') {
		return (Cow::Borrowed(&s[..end]), end);
	}
	let mut out = Vec::with_capacity(end);
	let mut i = 0;
	while i < s.len() {
		let c = s[i];
		if is_space(c) {
			break;
		}
		i += 1;
		if c != b'\\' {
			out.push(c);
			continue;
		}
		let Some(&escaped) = s.get(i) else { break };
		i += 1;
		match escaped {
			b'a' => out.push(0x07),
			b'b' => out.push(0x08),
			b'f' => out.push(0x0c),
			b'n' => out.push(b'\n'),
			b'r' => out.push(b'\r'),
			b't' => out.push(b'\t'),
			b'v' => out.push(0x0b),
			b'0'..=b'7' => {
				let mut value = u32::from(escaped - b'0');
				for _ in 0..2 {
					match at(s, i) {
						digit @ b'0'..=b'7' => {
							value = (value << 3) | u32::from(digit - b'0');
							i += 1;
						},
						_ => break,
					}
				}
				out.push(value as u8);
			},
			b'x' => {
				let mut value = u32::from(b'x');
				if let Some(high) = (at(s, i) as char).to_digit(16) {
					value = high;
					i += 1;
					if let Some(low) = (at(s, i) as char).to_digit(16) {
						value = (value << 4) + low;
						i += 1;
					}
				}
				out.push(value as u8);
			},
			other => out.push(other),
		}
	}
	(Cow::Owned(out), i)
}

/// `file_signextend`: sign-extends `v` from the rule's type unless the rule
/// compares unsigned.
fn sign_extend(m: &Magic, v: u64) -> u64 {
	if m.flag & UNSIGNED != 0 {
		return v;
	}
	match m.kind {
		Kind::Byte => v as i8 as i64 as u64,
		Kind::Short => v as i16 as i64 as u64,
		Kind::Long | Kind::Date | Kind::LDate | Kind::Float => v as i32 as i64 as u64,
		_ => v,
	}
}

fn get_op(c: u8) -> Option<u8> {
	Some(match c {
		b'&' => OP_AND,
		b'|' => OP_OR,
		b'^' => OP_XOR,
		b'+' => OP_ADD,
		b'-' => OP_MINUS,
		b'*' => OP_MULTIPLY,
		b'/' => OP_DIVIDE,
		b'%' => OP_MODULO,
		_ => return None,
	})
}

fn get_type(s: &[u8]) -> Option<(Kind, Endian, usize)> {
	TYPES
		.iter()
		.find(|(name, ..)| s.starts_with(name.as_bytes()))
		.map(|&(name, kind, endian)| (kind, endian, name.len()))
}

/// `get_standard_integer_type`: the SUS `d`/`u` types with a size suffix.
fn standard_integer_type(s: &[u8]) -> Option<(Kind, usize)> {
	let next = at(s, 1);
	if next.is_ascii_alphabetic() {
		let kind = match next {
			b'C' => Kind::Byte,
			b'S' => Kind::Short,
			b'I' | b'L' => Kind::Long,
			b'Q' => Kind::Quad,
			_ => return None,
		};
		Some((kind, 2))
	} else if next.is_ascii_digit() {
		let kind = match next {
			b'1' => Kind::Byte,
			b'2' => Kind::Short,
			b'4' => Kind::Long,
			b'8' => Kind::Quad,
			_ => return None,
		};
		Some((kind, 2))
	} else {
		Some((Kind::Long, 1))
	}
}

/// `file_parse_guid`: the 16 bytes a GUID occupies on disk.
fn parse_guid(s: &[u8]) -> Option<[u8; 16]> {
	let text = std::str::from_utf8(s.get(..36)?).ok()?;
	let mut parts = text.split('-');
	let data1 = u32::from_str_radix(parts.next()?, 16).ok()?;
	let data2 = u16::from_str_radix(parts.next()?, 16).ok()?;
	let data3 = u16::from_str_radix(parts.next()?, 16).ok()?;
	let data4 = u16::from_str_radix(parts.next()?, 16).ok()?;
	let tail = u64::from_str_radix(parts.next()?, 16).ok()?;
	let mut guid = [0; 16];
	guid[..4].copy_from_slice(&data1.to_le_bytes());
	guid[4..6].copy_from_slice(&data2.to_le_bytes());
	guid[6..8].copy_from_slice(&data3.to_le_bytes());
	guid[8..10].copy_from_slice(&data4.to_be_bytes());
	guid[10..].copy_from_slice(&tail.to_be_bytes()[2..]);
	Some(guid)
}

/// `parse`: one rule line.
fn parse_line(line: &[u8]) -> Option<Magic<'_>> {
	let l = line;
	let mut i = 0;
	while at(l, i) == b'>' {
		i += 1;
	}
	let cont_level = u16::try_from(i).ok()?;
	let mut flag = 0u8;
	if at(l, i) == b'&' {
		i += 1;
		flag |= OFFADD;
	}
	if at(l, i) == b'(' {
		i += 1;
		flag |= INDIR;
		if flag & OFFADD != 0 {
			flag = (flag & !OFFADD) | INDIROFFADD;
		}
		if at(l, i) == b'&' {
			i += 1;
			flag |= OFFADD;
		}
	}
	if cont_level == 0 && flag & (OFFADD | INDIROFFADD) != 0 {
		return None;
	}
	if at(l, i) == b'-' {
		i += 1;
		flag |= OFFNEGATIVE;
	}
	let (offset, used) = strtoull(&l[i..]);
	if used == 0 {
		return None;
	}
	i += used;
	let offset = offset as i64 as i32;

	let (mut in_kind, mut in_endian, mut in_op, mut in_offset) = (Kind::Long, Endian::Native, 0u8, 0i32);
	if flag & INDIR != 0 {
		if matches!(at(l, i), b'.' | b',') {
			if l[i] == b',' {
				in_op |= OP_SIGNED;
			}
			i += 1;
			(in_kind, in_endian) = match at(l, i) {
				b'l' => (Kind::Long, Endian::Little),
				b'L' => (Kind::Long, Endian::Big),
				b'm' => (Kind::Long, Endian::Middle),
				b'h' | b's' => (Kind::Short, Endian::Little),
				b'H' | b'S' => (Kind::Short, Endian::Big),
				b'c' | b'b' | b'C' | b'B' => (Kind::Byte, Endian::Native),
				b'e' | b'f' | b'g' => (Kind::Double, Endian::Little),
				b'E' | b'F' | b'G' => (Kind::Double, Endian::Big),
				b'i' => (Kind::Id3, Endian::Little),
				b'I' => (Kind::Id3, Endian::Big),
				b'q' => (Kind::Quad, Endian::Little),
				b'Q' => (Kind::Quad, Endian::Big),
				_ => return None,
			};
			i += 1;
		}
		if at(l, i) == b'~' {
			in_op |= OP_INVERSE;
			i += 1;
		}
		if let Some(op) = get_op(at(l, i)) {
			in_op |= op;
			i += 1;
		}
		if at(l, i) == b'(' {
			in_op |= OP_INDIRECT;
			i += 1;
		}
		if at(l, i).is_ascii_digit() || at(l, i) == b'-' {
			let (value, used) = strtoull(&l[i..]);
			if used == 0 {
				return None;
			}
			in_offset = value as i64 as i32;
			i += used;
		}
		if at(l, i) != b')' {
			return None;
		}
		i += 1;
		if in_op & OP_INDIRECT != 0 {
			if at(l, i) != b')' {
				return None;
			}
			i += 1;
		}
	}
	i = eat_tab(l, i);

	// The type: a keyword, optionally `u`-prefixed, or an SUS integer type.
	let mut typed = None;
	if at(l, i) == b'u' {
		if let Some((kind, endian, len)) = get_type(&l[i + 1..]) {
			typed = Some((kind, endian, len + 1));
		} else if let Some((kind, len)) = standard_integer_type(&l[i..]) {
			typed = Some((kind, Endian::Native, len));
		}
		if typed.is_some() {
			flag |= UNSIGNED;
		}
	} else if let Some(found) = get_type(&l[i..]) {
		typed = Some(found);
	} else if at(l, i) == b'd' {
		typed = standard_integer_type(&l[i..]).map(|(kind, len)| (kind, Endian::Native, len));
	} else if at(l, i) == b's' && !at(l, i + 1).is_ascii_alphabetic() {
		typed = Some((Kind::Str, Endian::Native, 1));
	}
	if typed.is_none() {
		// The special keywords cannot take the unsigned prefix.
		typed = get_type(&l[i..]).filter(|(kind, ..)| matches!(kind, Kind::Unsupported | Kind::Name | Kind::Use));
	}
	let (kind, endian, len) = typed?;
	i += len;
	if kind == Kind::Name && cont_level != 0 {
		return None;
	}

	let mut mask_op = 0u8;
	if at(l, i) == b'~' {
		if !kind.is_string() {
			mask_op |= OP_INVERSE;
		}
		i += 1;
	}
	let mut str_range = 0u32;
	let mut str_flags = if kind == Kind::PStr { PSTRING_1_LE } else { 0 };
	let mut num_mask = 0u64;
	// Sign extension reads the flag and kind, so the rule exists before its
	// mask and value do.
	let mut m = Magic {
		cont_level,
		flag,
		reln: b'=',
		kind,
		endian,
		in_kind,
		in_endian,
		in_op,
		mask_op,
		factor_op: 0,
		factor: 0,
		vallen: 0,
		offset,
		in_offset,
		num_mask: 0,
		str_range: 0,
		str_flags: 0,
		value: Value::Num(0),
		desc: &[],
		mime: &[],
		ext: &[],
		apple: &[],
	};
	if let Some(op) = get_op(at(l, i)) {
		if kind.is_string() {
			if op != OP_DIVIDE {
				return None;
			}
			if kind == Kind::Indirect {
				loop {
					i += 1;
					match at(l, i) {
						c if is_space(c) => break,
						b'r' => str_flags |= INDIRECT_RELATIVE,
						_ => return None,
					}
				}
			} else {
				i = parse_string_modifier(l, i, kind, &mut str_range, &mut str_flags)?;
			}
		} else {
			i += 1;
			mask_op |= op;
			let (value, used) = strtoull(&l[i..]);
			i += used;
			num_mask = sign_extend(&m, value);
			i = eat_size(l, i);
		}
	}
	m.mask_op = mask_op;
	m.num_mask = num_mask;
	m.str_range = str_range;
	m.str_flags = str_flags;
	i = eat_tab(l, i);

	match at(l, i) {
		c @ (b'>' | b'<' | b'&' | b'^' | b'=') => {
			m.reln = c;
			i += 1;
			if at(l, i) == b'=' {
				i += 1;
			}
		},
		b'!' => {
			m.reln = b'!';
			i += 1;
		},
		b'x' if i + 1 >= l.len() || is_space(l[i + 1]) => {
			m.reln = b'x';
			i += 1;
		},
		_ => {},
	}

	// `getvalue`: an `x` relation takes no value.
	let stringy = matches!(
		kind,
		Kind::Str | Kind::PStr | Kind::Str16 | Kind::Regex | Kind::Search | Kind::Name | Kind::Use
	);
	if m.reln == b'x' {
		if stringy {
			m.value = Value::Bytes(Cow::Borrowed(&[]));
		}
	} else if stringy {
		let (value, used) = getstr(&l[i..]);
		if value.len() >= MAX_STRING {
			return None;
		}
		i += used;
		let mut vallen = value.len();
		if kind == Kind::PStr {
			vallen += pstring_length_size(str_flags)?;
		}
		m.vallen = vallen as u8;
		m.value = if kind == Kind::Regex {
			Value::Regex(Box::new(LazyRegex { pattern: value, compiled: OnceLock::new() }))
		} else {
			Value::Bytes(value)
		};
	} else {
		match kind {
			Kind::Unsupported => i += getstr(&l[i..]).1,
			Kind::Float | Kind::Double => {
				let (value, used) = strtod(&l[i..]);
				i += used;
				m.value = Value::Float(if kind == Kind::Float { f64::from(value as f32) } else { value });
			},
			Kind::Guid => {
				m.value = Value::Guid(parse_guid(&l[i..])?);
				i += 36;
			},
			_ => {
				let (value, used) = strtoull(&l[i..]);
				m.value = Value::Num(sign_extend(&m, value));
				i = eat_size(l, i + used);
			},
		}
	}

	i = eat_tab(l, i);
	if at(l, i) == 0x08 {
		i += 1;
		m.flag |= NOSPACE;
	} else if at(l, i) == b'\\' && at(l, i + 1) == b'b' {
		i += 2;
		m.flag |= NOSPACE;
	}
	let desc = l.get(i..).unwrap_or(&[]);
	m.desc = &desc[..desc.len().min(MAX_DESC)];
	Some(m)
}

/// `parse_string_modifier`: the `/flags` of a string type; returns the index
/// of the whitespace that ends them.
fn parse_string_modifier(l: &[u8], mut i: usize, kind: Kind, range: &mut u32, flags: &mut u32) -> Option<usize> {
	let set_length = |flags: &mut u32, length: u32| {
		if kind != Kind::PStr {
			return None;
		}
		*flags = (*flags & !PSTRING_LEN) | length;
		Some(())
	};
	loop {
		i += 1;
		let c = at(l, i);
		if is_space(c) {
			return Some(i);
		}
		match c {
			b'0'..=b'9' => {
				let (value, used) = strtoull(&l[i..]);
				*range = value as u32;
				i += used - 1;
			},
			b'W' => *flags |= STRING_COMPACT_WHITESPACE,
			b'w' => *flags |= STRING_COMPACT_OPTIONAL_WHITESPACE,
			b'c' => *flags |= STRING_IGNORE_LOWERCASE,
			b'C' => *flags |= STRING_IGNORE_UPPERCASE,
			b's' => *flags |= REGEX_OFFSET_START,
			b'b' => *flags |= STRING_BINTEST,
			b't' => *flags |= STRING_TEXTTEST,
			b'T' => *flags |= STRING_TRIM,
			b'f' => *flags |= STRING_FULL_WORD,
			b'B' => set_length(flags, PSTRING_1_LE)?,
			b'H' => set_length(flags, PSTRING_2_BE)?,
			b'h' => set_length(flags, PSTRING_2_LE)?,
			b'L' => set_length(flags, PSTRING_4_BE)?,
			b'l' => {
				if !matches!(kind, Kind::PStr | Kind::Regex) {
					return None;
				}
				*flags = (*flags & !PSTRING_LEN) | PSTRING_4_LE;
			},
			b'J' => {
				if kind != Kind::PStr {
					return None;
				}
				*flags |= PSTRING_LENGTH_INCLUDES_ITSELF;
			},
			_ => return None,
		}
		// Several `/` may separate modifiers.
		if at(l, i + 1) == b'/' && !is_space(at(l, i + 2)) {
			i += 1;
		}
	}
}

const fn pstring_length_size(flags: u32) -> Option<usize> {
	match flags & PSTRING_LEN {
		PSTRING_1_LE => Some(1),
		PSTRING_2_LE | PSTRING_2_BE => Some(2),
		PSTRING_4_LE | PSTRING_4_BE => Some(4),
		_ => None,
	}
}

/// `nonmagic`: the literal length of a regex, for strength.
fn nonmagic(pattern: &[u8]) -> usize {
	let mut count = 0;
	let mut i = 0;
	while i < pattern.len() {
		match pattern[i] {
			b'\\' => {
				if i + 1 < pattern.len() {
					i += 1;
				}
				count += 1;
			},
			b'?' | b'*' | b'.' | b'+' | b'^' | b'$' => {},
			b'[' => {
				while i < pattern.len() && pattern[i] != b']' {
					i += 1;
				}
				// The closing bracket is the expression's one character.
				if i < pattern.len() {
					count += 1;
				}
			},
			b'{' => {
				while i < pattern.len() && pattern[i] != b'}' {
					i += 1;
				}
			},
			_ => count += 1,
		}
		i += 1;
	}
	count.max(1)
}

/// `apprentice_magic_strength`.
fn strength(m: &Magic) -> usize {
	const MULT: isize = 10;
	if m.kind == Kind::Default {
		return 0;
	}
	let mut val: isize = 2 * MULT;
	let vallen = isize::from(m.vallen);
	match m.kind {
		Kind::PStr | Kind::Str => val += vallen * MULT,
		Kind::Str16 => val += vallen * MULT / 2,
		Kind::Search => {
			if vallen != 0 {
				val += vallen * (MULT / vallen).max(1);
			}
		},
		Kind::Regex => {
			let literal = nonmagic(m.c_str()) as isize;
			val += literal * (MULT / literal).max(1);
		},
		Kind::Indirect | Kind::Name | Kind::Use | Kind::Id3 | Kind::Clear | Kind::Default => {},
		Kind::Unsupported => val += MULT,
		kind => val += kind.size().unwrap_or(0) as isize * MULT,
	}
	match m.reln {
		b'x' | b'!' => val = 0,
		b'=' => val += MULT,
		b'>' | b'<' => val -= 2 * MULT,
		b'^' | b'&' => val -= MULT,
		_ => {},
	}
	let factor = isize::from(m.factor);
	match m.factor_op {
		b'+' => val += factor,
		b'-' => val -= factor,
		b'*' => val *= factor,
		b'/' => val /= factor.max(1),
		_ => {},
	}
	if val <= 0 {
		val = 1;
	}
	if m.desc.is_empty() {
		val += 1;
	}
	val as usize
}

/// `set_test_type`: whether a top-level line is a text or a binary test.
fn test_type(m: &Magic) -> u8 {
	match m.kind {
		Kind::Str | Kind::PStr | Kind::Str16 => {
			if m.str_flags & STRING_TEXTTEST != 0 {
				TEXTTEST
			} else {
				BINTEST
			}
		},
		Kind::Regex | Kind::Search => {
			let mut flag = 0;
			if m.str_flags & STRING_BINTEST != 0 {
				flag |= BINTEST;
			}
			if m.str_flags & STRING_TEXTTEST != 0 {
				flag |= TEXTTEST;
			}
			if flag != 0 {
				flag
			} else if looks_utf8(m.bytes(), None) <= 0 {
				BINTEST
			} else {
				TEXTTEST
			}
		},
		Kind::Default | Kind::Clear | Kind::Name | Kind::Use | Kind::Indirect | Kind::Id3 => 0,
		_ => BINTEST,
	}
}

/// The characters a `!:mime`, `!:ext` or `!:apple` annotation may hold.
fn annotation<'a>(line: &'a [u8], extra: &[u8], max: usize) -> &'a [u8] {
	let start = eat_tab(line, 0);
	let len = line[start..]
		.iter()
		.take(max)
		.take_while(|&&c| c.is_ascii_alphanumeric() || extra.contains(&c))
		.count();
	&line[start..start + len]
}

impl<'a> Db<'a> {
	/// Parses magic sources, in the order given. Rules of equal strength
	/// keep their source order, as libmagic's sort leaves them on glibc.
	pub fn parse(sources: &[&'a [u8]]) -> Self {
		Self::parse_ranked(sources, |_, _| 0)
	}

	/// [`Db::parse`] with the order of equal-strength rules given by `rank`,
	/// which maps a source's index and a rule's index among that source's
	/// top-level rules to its place.
	fn parse_ranked(sources: &[&'a [u8]], rank: impl Fn(usize, u32) -> u32) -> Self {
		struct Entry {
			range:    Range<u32>,
			strength: usize,
			rank:     u32,
		}
		let mut magics: Vec<Magic<'a>> = Vec::new();
		let mut entries: Vec<Entry> = Vec::new();
		let mut names = HashMap::new();
		// Start and rank of the entry being read; `None` while skipping a
		// broken one.
		let mut current: Option<(usize, u32)> = None;
		let close = |magics: &mut Vec<Magic<'a>>,
		             entries: &mut Vec<Entry>,
		             names: &mut HashMap<&'a [u8], Range<u32>>,
		             (start, rank): (usize, u32)| {
			let range = start as u32..magics.len() as u32;
			let top = &mut magics[start];
			if top.kind == Kind::Name {
				if let Value::Bytes(Cow::Borrowed(name)) = &top.value {
					names.entry(*name).or_insert(range);
				}
			} else {
				let test = test_type(top);
				top.flag |= test;
				entries.push(Entry { strength: strength(top), range, rank });
			}
		};
		for (index, source) in sources.iter().enumerate() {
			let mut ordinal = 0;
			for line in source.split(|&c| c == b'\n') {
				if line.is_empty() || line[0] == b'#' {
					continue;
				}
				if let Some(bang) = line.strip_prefix(b"!:") {
					let Some((start, _)) = current else { continue };
					let last = magics.len() - 1;
					if let Some(rest) = bang.strip_prefix(b"mime") {
						if magics[last].mime.is_empty() && !magics[last].desc.is_empty() {
							magics[last].mime = annotation(rest, b"+-/.$?:{}", MAX_MIME);
						}
					} else if let Some(rest) = bang.strip_prefix(b"apple") {
						if magics[last].apple.is_empty() && !magics[last].desc.is_empty() {
							magics[last].apple = annotation(rest, b"!+-./?", 8);
						}
					} else if let Some(rest) = bang.strip_prefix(b"ext") {
						if magics[last].ext.is_empty() && !magics[last].desc.is_empty() {
							magics[last].ext = annotation(rest, b",!+-/@?_$&", MAX_EXT);
						}
					} else if let Some(rest) = bang.strip_prefix(b"strength") {
						let top = &mut magics[start];
						let at_op = eat_tab(rest, 0);
						let op = at(rest, at_op);
						if top.factor_op == 0 && top.kind != Kind::Name && matches!(op, b'+' | b'-' | b'*' | b'/') {
							let (factor, used) = strtoull(&rest[at_op + 1..]);
							let end = at(rest, at_op + 1 + used);
							if factor <= 255 && (end == 0 || is_space(end)) && !(factor == 0 && op == b'/') {
								top.factor_op = op;
								top.factor = factor as u8;
							}
						}
					}
					continue;
				}
				let top_level = line[0] != b'>';
				if top_level && let Some(open) = current.take() {
					close(&mut magics, &mut entries, &mut names, open);
				}
				if !top_level && current.is_none() {
					continue;
				}
				let parsed = parse_line(line);
				if top_level {
					ordinal += 1;
				}
				match parsed {
					Some(magic) => {
						if top_level {
							current = Some((magics.len(), rank(index, ordinal - 1)));
						}
						magics.push(magic);
					},
					// A broken top-level line takes its continuations with it.
					None if top_level => current = None,
					None => {},
				}
			}
			if let Some(open) = current.take() {
				close(&mut magics, &mut entries, &mut names, open);
			}
		}
		// The sort is stable: equally ranked ties keep source order.
		entries.sort_by(|a, b| b.strength.cmp(&a.strength).then(a.rank.cmp(&b.rank)));
		Self { magics, order: entries.into_iter().map(|entry| entry.range).collect(), names }
	}

	fn entry(&self, range: &Range<u32>) -> &[Magic<'a>] {
		&self.magics[range.start as usize..range.end as usize]
	}
}

/// The `# Magdir/<name>` sections of a bundled database.
fn sections(text: &'static [u8]) -> Vec<(&'static [u8], &'static [u8])> {
	const MARK: &[u8] = b"# Magdir/";
	let mut found = Vec::new();
	let mut open: Option<(&'static [u8], usize)> = None;
	let mut position = 0;
	for line in text.split_inclusive(|&c| c == b'\n') {
		if let Some(name) = line.strip_prefix(MARK) {
			if let Some((name, start)) = open.take() {
				found.push((name, &text[start..position]));
			}
			open = Some((name.trim_ascii_end(), position + line.len()));
		}
		position += line.len();
	}
	if let Some((name, start)) = open {
		found.push((name, &text[start..]));
	}
	found
}

/// The bundled database: file 5.41's rules. `darwin` selects Apple's variants
/// of the Mach-O, Java-class and C rules (and its own additions), tried in the
/// order of the database macOS compiles from them.
pub(super) fn builtin(darwin: bool) -> &'static Db<'static> {
	static UPSTREAM: LazyLock<Db<'static>> = LazyLock::new(|| {
		let sources: Vec<&'static [u8]> =
			sections(include_bytes!("magic.txt")).into_iter().map(|(_, body)| body).collect();
		Db::parse(&sources)
	});
	static APPLE: LazyLock<Db<'static>> = LazyLock::new(|| {
		let apple = sections(include_bytes!("magic-apple.txt"));
		let mut all = sections(include_bytes!("magic.txt"));
		all.retain(|(name, _)| !apple.iter().any(|(replaced, _)| replaced == name));
		all.extend(apple);
		// libmagic loads a magic directory in `strcmp` order.
		all.sort_by(|a, b| a.0.cmp(b.0));
		let order: HashMap<(&[u8], u32), u32> = include_bytes!("magic-apple.order")
			.split(|&c| c == b'\n')
			.filter(|line| !line.is_empty() && line[0] != b'#')
			.zip(0..)
			.filter_map(|(line, place)| {
				let space = memchr::memchr(b' ', line)?;
				let ordinal = std::str::from_utf8(&line[space + 1..]).ok()?.parse().ok()?;
				Some(((&line[..space], ordinal), place))
			})
			.collect();
		let (names, sources): (Vec<&[u8]>, Vec<&[u8]>) = all.into_iter().unzip();
		Db::parse_ranked(&sources, |source, ordinal| {
			order.get(&(names[source], ordinal)).copied().unwrap_or(u32::MAX)
		})
	});
	if darwin { &APPLE } else { &UPSTREAM }
}

/// Where the bytes at the end of the file come from: rules with negative
/// offsets read them.
pub(super) trait TailSource {
	/// The file's last bytes, as many as the head buffer holds; `None` when
	/// the input is not a regular file, where such rules never match.
	fn tail(&self) -> Option<&[u8]>;
}

/// An input without a readable end: a pipe, or decompressed data.
pub(super) struct NoTail;

impl TailSource for NoTail {
	fn tail(&self) -> Option<&[u8]> {
		None
	}
}

/// The data a match runs against (`struct buffer`).
#[derive(Clone, Copy)]
pub(super) struct Buf<'d> {
	pub data: &'d [u8],
	pub tail: &'d dyn TailSource,
}

/// What a match prints.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Report {
	/// Descriptions.
	Description,
	/// `!:mime` types.
	Mime,
	/// `!:ext` lists.
	Extension,
	/// `!:apple` creator/type codes.
	Apple,
	/// Nothing: `--mime-encoding` alone only needs to know whether text
	/// rules match.
	Silent,
}

/// The engine limits `-P` sets, and the output switches.
#[derive(Clone, Copy)]
pub(super) struct Limits {
	pub indir_max:  u16,
	pub name_max:   u16,
	pub regex_max:  usize,
	pub keep_going: bool,
	pub raw:        bool,
}

#[derive(Clone, Copy, Default)]
struct Level {
	off:       i32,
	got_match: bool,
}

/// `ms->search`: the region a search or regex rule scans, as offsets into
/// the buffer the rule reads.
#[derive(Clone, Copy, Default)]
struct Search {
	/// Where the region starts; `None` is libmagic's NULL pointer.
	start:  Option<usize>,
	len:    usize,
	offset: usize,
	rm_len: usize,
}

/// The flags `match` threads through its recursion.
struct Shared {
	printed_something: bool,
	need_separator:    bool,
	indir_count:       u16,
	name_count:        u16,
}

/// Which entries a `match` call walks.
enum List<'r> {
	All,
	One(&'r Range<u32>),
}

/// One soft-magic run over a buffer (`struct magic_set`).
pub(super) struct Matcher<'m, 'a> {
	db:      &'m Db<'a>,
	report:  Report,
	limits:  Limits,
	zone:    &'m TimeZone,
	/// The description being built.
	pub out: Vec<u8>,
	/// The file's mode; ELF analysis rewrites the execute bits, which the
	/// `${x?…}` descriptions read.
	pub mode: u32,
	offset:  i32,
	eoffset: i32,
	levels:  Vec<Level>,
	search:  Search,
	/// `ms_value`: the bytes at the rule's offset, zero padded.
	val:     [u8; MAX_STRING],
	num:     u64,
	float:   f64,
}

const fn oob(nbytes: usize, offset: u32, need: usize) -> bool {
	nbytes < offset as usize || need > nbytes - offset as usize
}

fn read_uint(bytes: &[u8], size: usize, endian: Endian) -> u64 {
	let mut raw = [0u8; 8];
	raw[..size].copy_from_slice(&bytes[..size]);
	match endian {
		Endian::Little => u64::from_le_bytes(raw),
		Endian::Native if cfg!(target_endian = "little") => u64::from_le_bytes(raw),
		Endian::Native | Endian::Big => {
			raw[..size].reverse();
			u64::from_le_bytes(raw)
		},
		// PDP order: the two 16-bit halves swapped.
		Endian::Middle => {
			u64::from(raw[1]) << 24 | u64::from(raw[0]) << 16 | u64::from(raw[3]) << 8 | u64::from(raw[2])
		},
	}
}

/// `cvt_flip`: a `use \^name` swaps the explicit byte orders.
const fn flip_endian(endian: Endian, flip: bool) -> Endian {
	match (endian, flip) {
		(Endian::Little, true) => Endian::Big,
		(Endian::Big, true) => Endian::Little,
		(endian, _) => endian,
	}
}

fn sext(signed: bool, size: usize, value: u64) -> i64 {
	if !signed {
		return value as i64;
	}
	match size {
		1 => i64::from(value as i8),
		2 => i64::from(value as i16),
		4 => i64::from(value as i32),
		_ => value as i64,
	}
}

fn cvt_id3(v: u32) -> u32 {
	(v & 0x7f) | ((v >> 8) & 0x7f) << 7 | ((v >> 16) & 0x7f) << 14 | ((v >> 24) & 0x7f) << 21
}

/// `do_ops`: an indirect offset's arithmetic.
fn do_ops(m: &Magic, lhs: i64, off: i64) -> u32 {
	let mut offset = if off == 0 {
		lhs
	} else {
		match m.in_op & OPS_MASK {
			OP_AND => lhs & off,
			OP_OR => lhs | off,
			OP_XOR => lhs ^ off,
			OP_ADD => lhs.wrapping_add(off),
			OP_MINUS => lhs.wrapping_sub(off),
			OP_MULTIPLY => lhs.wrapping_mul(off),
			OP_DIVIDE => lhs.wrapping_div(off),
			_ => lhs.wrapping_rem(off),
		}
	};
	if m.in_op & OP_INVERSE != 0 {
		offset = !offset;
	}
	offset as u32
}

/// `file_strncmp`: 0 on a match, otherwise the difference at the first
/// mismatch. `a` is the rule's value, zero padded to `len`; `b` is the data,
/// zero padded.
fn strncmp(a: &[u8], b: &[u8], len: usize, maxlen: usize, flags: u32) -> u64 {
	let diff = |b: u8, a: u8| (i64::from(b) - i64::from(a)) as u64;
	let mut v = 0u64;
	if flags == 0 {
		for i in 0..len {
			v = diff(at(b, i), at(a, i));
			if v != 0 {
				break;
			}
		}
		return v;
	}
	let whitespace = flags & (STRING_COMPACT_WHITESPACE | STRING_COMPACT_OPTIONAL_WHITESPACE) != 0;
	let end = if whitespace { maxlen } else { len };
	let (mut ai, mut bi) = (0usize, 0usize);
	let mut left = len;
	while left > 0 {
		left -= 1;
		if bi >= end {
			v = 1;
			break;
		}
		let (ca, cb) = (at(a, ai), at(b, bi));
		if flags & STRING_IGNORE_LOWERCASE != 0 && ca.is_ascii_lowercase() {
			v = diff(cb.to_ascii_lowercase(), ca);
			ai += 1;
			bi += 1;
			if v != 0 {
				break;
			}
		} else if flags & STRING_IGNORE_UPPERCASE != 0 && ca.is_ascii_uppercase() {
			v = diff(cb.to_ascii_uppercase(), ca);
			ai += 1;
			bi += 1;
			if v != 0 {
				break;
			}
		} else if flags & STRING_COMPACT_WHITESPACE != 0 && is_space(ca) {
			ai += 1;
			if is_space(cb) {
				bi += 1;
				if !is_space(at(a, ai)) {
					while bi < end && is_space(at(b, bi)) {
						bi += 1;
					}
				}
			} else {
				v = 1;
				break;
			}
		} else if flags & STRING_COMPACT_OPTIONAL_WHITESPACE != 0 && is_space(ca) {
			ai += 1;
			while bi < end && is_space(at(b, bi)) {
				bi += 1;
			}
		} else {
			v = diff(cb, ca);
			ai += 1;
			bi += 1;
			if v != 0 {
				break;
			}
		}
	}
	if left == 0 && v == 0 && flags & STRING_FULL_WORD != 0 {
		let next = at(b, bi);
		if next != 0 && !is_space(next) {
			v = 1;
		}
	}
	v
}

/// Translates a POSIX extended regex, as `regcomp` reads it, to the `regex`
/// crate's syntax with `REG_NEWLINE` semantics.
fn translate_ere(pattern: &[u8]) -> String {
	fn push_literal(out: &mut String, c: u8) {
		if c.is_ascii_alphanumeric() || c == b' ' || c == b'_' {
			out.push(c as char);
		} else {
			let _ = write!(out, "\\x{c:02X}");
		}
	}
	let p = pattern;
	let mut out = String::with_capacity(p.len() + 8);
	// Whether a repetition operator has something to repeat.
	let mut atom = false;
	let mut i = 0;
	while i < p.len() {
		let c = p[i];
		i += 1;
		match c {
			b'\\' => {
				let Some(&escaped) = p.get(i) else {
					out.push_str("\\\\");
					break;
				};
				i += 1;
				match escaped {
					b'w' | b'W' | b's' | b'S' | b'd' | b'D' | b'b' | b'B' | b'<' | b'>' => {
						out.push('\\');
						out.push(escaped as char);
					},
					_ => push_literal(&mut out, escaped),
				}
				atom = true;
			},
			b'[' => {
				out.push('[');
				let negated = at(p, i) == b'^';
				if negated {
					out.push('^');
					i += 1;
				}
				let first = i;
				while i < p.len() && (p[i] != b']' || i == first) {
					if p[i] == b'[' && matches!(at(p, i + 1), b':' | b'.' | b'=') {
						let kind = p[i + 1];
						let close = (i + 2..p.len().saturating_sub(1)).find(|&j| p[j] == kind && p[j + 1] == b']');
						if let Some(close) = close {
							if kind == b':' {
								out.push_str(&String::from_utf8_lossy(&p[i..close + 2]));
							} else {
								for &member in &p[i + 2..close] {
									push_literal(&mut out, member);
								}
							}
							i = close + 2;
							continue;
						}
					}
					// A `-` between two members is a range; elsewhere it is
					// itself.
					if p[i] == b'-' && i != first && at(p, i + 1) != b']' && i + 1 < p.len() {
						out.push('-');
					} else {
						push_literal(&mut out, p[i]);
					}
					i += 1;
				}
				if negated {
					out.push_str("\\n");
				}
				out.push(']');
				i += 1;
				atom = true;
			},
			b'{' => {
				let mut j = i;
				while at(p, j).is_ascii_digit() {
					j += 1;
				}
				let has_min = j > i;
				if at(p, j) == b',' {
					j += 1;
					while at(p, j).is_ascii_digit() {
						j += 1;
					}
				}
				if atom && has_min && at(p, j) == b'}' {
					out.push_str(&String::from_utf8_lossy(&p[i - 1..=j]));
					i = j + 1;
				} else {
					out.push_str("\\{");
					atom = true;
				}
			},
			b'*' | b'+' | b'?' => {
				if atom {
					out.push(c as char);
				} else {
					push_literal(&mut out, c);
					atom = true;
				}
			},
			b'(' | b'|' | b'^' => {
				out.push(c as char);
				atom = false;
			},
			b')' | b'$' | b'.' => {
				out.push(c as char);
				atom = true;
			},
			_ => {
				push_literal(&mut out, c);
				atom = true;
			},
		}
	}
	out
}

impl LazyRegex<'_> {
	fn get(&self, ignore_case: bool) -> Option<&Regex> {
		self
			.compiled
			.get_or_init(|| {
				RegexBuilder::new(&translate_ere(c_str(&self.pattern)))
					.unicode(false)
					.multi_line(true)
					.case_insensitive(ignore_case)
					.build()
					.ok()
			})
			.as_ref()
	}
}

/// The argument a description's conversion formats.
enum Arg<'x> {
	/// An integer, sign-extended; `quad` selects the `%lld` family.
	Int { value: u64, unsigned: bool, quad: bool },
	Str(&'x [u8]),
	Float(f64),
}

/// A parsed `printf` conversion.
#[derive(Default)]
struct Spec {
	left:      bool,
	plus:      bool,
	space:     bool,
	alt:       bool,
	zero:      bool,
	width:     usize,
	precision: Option<usize>,
	long:      bool,
	quad:      bool,
	conv:      u8,
}

/// Parses the conversion after a `%`; returns it and its length.
fn parse_spec(f: &[u8]) -> Option<(Spec, usize)> {
	let mut spec = Spec::default();
	let mut i = 0;
	loop {
		match at(f, i) {
			b'-' => spec.left = true,
			b'+' => spec.plus = true,
			b' ' => spec.space = true,
			b'#' => spec.alt = true,
			b'0' => spec.zero = true,
			_ => break,
		}
		i += 1;
	}
	while at(f, i).is_ascii_digit() {
		spec.width = spec.width * 10 + usize::from(f[i] - b'0');
		i += 1;
	}
	if at(f, i) == b'.' {
		i += 1;
		let mut precision = 0;
		while at(f, i).is_ascii_digit() {
			precision = precision * 10 + usize::from(f[i] - b'0');
			i += 1;
		}
		spec.precision = Some(precision);
	}
	match at(f, i) {
		b'h' => {
			i += 1;
			if at(f, i) == b'h' {
				i += 1;
			}
		},
		b'l' => {
			i += 1;
			if at(f, i) == b'l' {
				i += 1;
				spec.quad = true;
			} else {
				spec.long = true;
			}
		},
		b'q' => {
			i += 1;
			spec.quad = true;
		},
		_ => {},
	}
	spec.conv = at(f, i);
	matches!(spec.conv, b'd' | b'i' | b'o' | b'u' | b'x' | b'X' | b'c' | b's' | b'e' | b'E' | b'f' | b'g')
		.then_some((spec, i + 1))
}

/// `fmtcheck`: whether `desc` can take the argument the rule's type supplies.
/// libmagic falls back to the bare default format when it cannot.
fn format_fits(desc: &[u8], arg: &Arg) -> bool {
	let mut conversions = 0;
	let mut i = 0;
	while let Some(found) = memchr::memchr(b'%', &desc[i..]) {
		i += found + 1;
		if at(desc, i) == b'%' {
			i += 1;
			continue;
		}
		let Some((spec, len)) = parse_spec(&desc[i..]) else { return false };
		i += len;
		conversions += 1;
		let fits = match (arg, spec.conv) {
			(Arg::Int { quad, .. }, b'd' | b'i' | b'o' | b'u' | b'x' | b'X') => !spec.long && spec.quad == *quad,
			(Arg::Int { quad: false, .. }, b'c') => !spec.long && !spec.quad,
			(Arg::Str(_), b's') => !spec.long && !spec.quad,
			(Arg::Float(_), b'e' | b'E' | b'f' | b'g') => !spec.long && !spec.quad,
			_ => false,
		};
		if !fits || conversions > 1 {
			return false;
		}
	}
	true
}

fn pad(out: &mut Vec<u8>, spec: &Spec, body: &[u8], zero_ok: bool, sign_len: usize) {
	let fill = spec.width.saturating_sub(body.len());
	if spec.left {
		out.extend_from_slice(body);
		out.resize(out.len() + fill, b' ');
	} else if spec.zero && zero_ok {
		// Zeros go between the sign or radix prefix and the digits.
		out.extend_from_slice(&body[..sign_len]);
		out.resize(out.len() + fill, b'0');
		out.extend_from_slice(&body[sign_len..]);
	} else {
		out.resize(out.len() + fill, b' ');
		out.extend_from_slice(body);
	}
}

fn format_int(out: &mut Vec<u8>, spec: &Spec, value: u64, quad: bool) {
	let mut body = Vec::with_capacity(24);
	let digits = match spec.conv {
		b'd' | b'i' => {
			let signed = if quad { value as i64 } else { i64::from(value as i32) };
			if signed < 0 {
				body.push(b'-');
			} else if spec.plus {
				body.push(b'+');
			} else if spec.space {
				body.push(b' ');
			}
			signed.unsigned_abs().to_string()
		},
		conv => {
			let unsigned = if quad { value } else { u64::from(value as u32) };
			match conv {
				b'o' => {
					if spec.alt {
						body.push(b'0');
					}
					format!("{unsigned:o}")
				},
				b'x' => {
					if spec.alt && unsigned != 0 {
						body.extend_from_slice(b"0x");
					}
					format!("{unsigned:x}")
				},
				b'X' => {
					if spec.alt && unsigned != 0 {
						body.extend_from_slice(b"0X");
					}
					format!("{unsigned:X}")
				},
				_ => unsigned.to_string(),
			}
		},
	};
	let prefix = body.len();
	if let Some(precision) = spec.precision {
		body.resize(prefix + precision.saturating_sub(digits.len()), b'0');
		// `%.0d` of zero prints nothing.
		if !(precision == 0 && digits == "0") {
			body.extend_from_slice(digits.as_bytes());
		}
	} else if !(spec.conv == b'o' && spec.alt && digits == "0") {
		body.extend_from_slice(digits.as_bytes());
	}
	pad(out, spec, &body, spec.precision.is_none(), prefix);
}

/// C's `%e`: at least two exponent digits.
fn format_exp(value: f64, precision: usize, upper: bool) -> String {
	let text = format!("{value:.precision$e}");
	let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
	let exponent: i32 = exponent.parse().unwrap_or(0);
	let sign = if exponent < 0 { '-' } else { '+' };
	format!("{mantissa}{}{sign}{:02}", if upper { 'E' } else { 'e' }, exponent.abs())
}

/// C's `%g`.
fn format_general(value: f64, precision: usize, alt: bool) -> String {
	if !value.is_finite() {
		return if value.is_nan() { "nan".to_owned() } else if value < 0.0 { "-inf".to_owned() } else { "inf".to_owned() };
	}
	let precision = precision.max(1);
	let exponent = if value == 0.0 {
		0
	} else {
		// Rounding to the precision can bump the exponent.
		let digits = precision - 1;
		let rounded = format!("{value:.digits$e}");
		rounded.split_once('e').and_then(|(_, e)| e.parse::<i32>().ok()).unwrap_or(0)
	};
	let strip = |text: String| {
		if alt || !text.contains('.') {
			return text;
		}
		text.trim_end_matches('0').trim_end_matches('.').to_owned()
	};
	if exponent < -4 || exponent >= precision as i32 {
		let text = format_exp(value, precision - 1, false);
		let (mantissa, tail) = text.split_once('e').unwrap_or((&text, "+00"));
		format!("{}e{tail}", strip(mantissa.to_owned()))
	} else {
		let decimals = (precision as i32 - 1 - exponent).max(0) as usize;
		strip(format!("{value:.decimals$}"))
	}
}

/// Formats `desc` with its one argument, as `file_printf` does. A `%c` of
/// NUL ends the C string there, so the rest of `desc` is dropped.
fn printf(out: &mut Vec<u8>, desc: &[u8], arg: &Arg) {
	if !desc.contains(&b'%') {
		out.extend_from_slice(desc);
		return;
	}
	let default: &[u8] = match arg {
		Arg::Int { unsigned: false, quad: false, .. } => b"%d",
		Arg::Int { unsigned: true, quad: false, .. } => b"%u",
		Arg::Int { unsigned: false, quad: true, .. } => b"%lld",
		Arg::Int { unsigned: true, quad: true, .. } => b"%llu",
		Arg::Str(_) => b"%s",
		Arg::Float(_) => b"%g",
	};
	let desc = if format_fits(desc, arg) { desc } else { default };
	let mut i = 0;
	while i < desc.len() {
		let Some(found) = memchr::memchr(b'%', &desc[i..]) else {
			out.extend_from_slice(&desc[i..]);
			break;
		};
		out.extend_from_slice(&desc[i..i + found]);
		i += found + 1;
		if at(desc, i) == b'%' {
			out.push(b'%');
			i += 1;
			continue;
		}
		let Some((spec, len)) = parse_spec(&desc[i..]) else { break };
		i += len;
		match (arg, spec.conv) {
			(Arg::Int { value, .. }, b'c') => {
				if *value as u8 == 0 {
					return;
				}
				pad(out, &spec, &[*value as u8], false, 0);
			},
			(Arg::Int { value, quad, .. }, _) => format_int(out, &spec, *value, *quad),
			(Arg::Str(text), _) => {
				let text = &text[..spec.precision.map_or(text.len(), |precision| precision.min(text.len()))];
				pad(out, &spec, text, false, 0);
			},
			(Arg::Float(value), conv) => {
				let precision = spec.precision.unwrap_or(6);
				let mut text = match conv {
					b'e' | b'E' => format_exp(*value, precision, conv == b'E'),
					b'f' => format!("{value:.precision$}"),
					_ => format_general(*value, precision, spec.alt),
				};
				let sign_len = usize::from(text.starts_with('-'));
				if sign_len == 0 && (spec.plus || spec.space) {
					text.insert(0, if spec.plus { '+' } else { ' ' });
				}
				let sign_len = usize::from(matches!(text.as_bytes().first(), Some(b'-' | b'+' | b' ')));
				pad(out, &spec, text.as_bytes(), true, sign_len);
			},
		}
	}
}

/// `check_fmt`: whether `desc` holds a `%…s` conversion.
fn has_string_conversion(desc: &[u8]) -> bool {
	let mut i = 0;
	while let Some(found) = memchr::memchr(b'%', &desc[i..]) {
		i += found + 1;
		let mut j = i;
		while matches!(at(desc, j), b'-' | b'.' | b'0'..=b'9') {
			j += 1;
		}
		if at(desc, j) == b's' {
			return true;
		}
	}
	false
}

/// `varexpand`: resolves `${x?yes:no}` on the file's execute bits.
fn varexpand(text: &[u8], mode: u32) -> Cow<'_, [u8]> {
	if memchr::memmem::find(text, b"${").is_none() {
		return Cow::Borrowed(text);
	}
	let mut out = Vec::with_capacity(text.len());
	let mut rest = text;
	while let Some(found) = memchr::memmem::find(rest, b"${") {
		out.extend_from_slice(&rest[..found]);
		let body = &rest[found + 2..];
		let expanded = (|| {
			if at(body, 0) != b'x' || at(body, 1) != b'?' {
				return None;
			}
			let colon = memchr::memchr(b':', &body[2..])? + 2;
			let close = memchr::memchr(b'}', &body[colon + 1..])? + colon + 1;
			let chosen = if mode & 0o111 != 0 { &body[2..colon] } else { &body[colon + 1..close] };
			Some((chosen, close + 1))
		})();
		let Some((chosen, used)) = expanded else {
			// A malformed expansion leaves the description as written.
			return Cow::Borrowed(text);
		};
		out.extend_from_slice(chosen);
		rest = &body[used..];
	}
	out.extend_from_slice(rest);
	Cow::Owned(out)
}

/// `asctime` of `seconds`, in `zone` when given, else UTC.
fn format_time(seconds: i64, zone: Option<&TimeZone>) -> String {
	const DAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
	const MONTHS: [&str; 12] =
		["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	let Ok(timestamp) = Timestamp::from_second(seconds) else {
		return "*Invalid time*".to_owned();
	};
	let time = timestamp.to_zoned(zone.cloned().unwrap_or(TimeZone::UTC));
	format!(
		"{} {}{:3} {:02}:{:02}:{:02} {}",
		DAYS[time.weekday().to_monday_zero_offset() as usize],
		MONTHS[(time.month() - 1) as usize],
		time.day(),
		time.hour(),
		time.minute(),
		time.second(),
		time.year()
	)
}

/// `file_printable`: non-printable bytes as `\ooo`.
fn printable(text: &[u8], raw: bool) -> Cow<'_, [u8]> {
	let text = c_str(text);
	if raw || text.iter().all(|c| (0x20..0x7f).contains(c)) {
		return Cow::Borrowed(text);
	}
	let mut out = Vec::with_capacity(text.len() + 8);
	for &c in text {
		if (0x20..0x7f).contains(&c) {
			out.push(c);
		} else {
			out.extend_from_slice(&[b'\\', b'0' + (c >> 6), b'0' + ((c >> 3) & 7), b'0' + (c & 7)]);
		}
	}
	Cow::Owned(out)
}

fn trim(text: &[u8]) -> &[u8] {
	let start = text.iter().position(|&c| !is_space(c)).unwrap_or(text.len());
	let end = text.iter().rposition(|&c| !is_space(c)).map_or(start, |last| last + 1);
	&text[start..end]
}

impl<'m, 'a> Matcher<'m, 'a> {
	/// A matcher over `db` for a file of mode `mode`.
	pub fn new(db: &'m Db<'a>, report: Report, limits: Limits, zone: &'m TimeZone, mode: u32) -> Self {
		Self {
			db,
			report,
			limits,
			zone,
			out: Vec::new(),
			mode,
			offset: 0,
			eoffset: 0,
			levels: Vec::new(),
			search: Search::default(),
			val: [0; MAX_STRING],
			num: 0,
			float: 0.0,
		}
	}

	/// `file_softmagic`: runs the entries of test type `mode` over `b`,
	/// appending to [`Matcher::out`]. Returns 1 when something was reported,
	/// 0 when nothing matched, -1 when a recursion limit was hit.
	pub fn softmagic(&mut self, b: Buf<'_>, mode: u8, text: bool) -> i32 {
		let mut shared = Shared { printed_something: false, need_separator: false, indir_count: 0, name_count: 0 };
		let (mut returnval, mut found) = (0, false);
		self.run(&List::All, b, 0, mode, text, false, &mut shared, &mut returnval, &mut found)
	}

	fn check_mem(&mut self, level: usize) {
		if level >= self.levels.len() {
			self.levels.resize(level + 20, Level::default());
		}
		self.levels[level].got_match = false;
	}

	/// `match`.
	#[allow(clippy::too_many_arguments, reason = "mirrors libmagic's match()")]
	fn run<'d>(
		&mut self,
		list: &List<'_>,
		b: Buf<'d>,
		o: usize,
		mode: u8,
		text: bool,
		flip: bool,
		shared: &mut Shared,
		returnval: &mut i32,
		found_match: &mut bool,
	) -> i32 {
		let db = self.db;
		let print = self.report == Report::Description;
		let mut firstline = true;
		self.check_mem(0);
		let ranges: &[Range<u32>] = match list {
			List::All => &db.order,
			List::One(range) => std::slice::from_ref(*range),
		};
		'entries: for range in ranges {
			let entry = db.entry(range);
			let mut m = &entry[0];
			if m.kind != Kind::Name {
				const FILTER: u32 = STRING_BINTEST | STRING_TEXTTEST;
				let wrong_text = m.kind.is_string()
					&& ((text && m.str_flags & FILTER == STRING_BINTEST)
						|| (!text && m.str_flags & FILTER == STRING_TEXTTEST));
				if wrong_text || m.flag & mode != mode {
					continue;
				}
			}
			let mut cont_level = 0usize;
			let mut bb: &'d [u8] = &[];
			if !self.set_offset(m, &mut bb, b, o, cont_level) {
				continue;
			}
			let flush = match self.get(m, b, bb, o, cont_level, mode, text, flip, shared, returnval, found_match) {
				-1 => return -1,
				0 => m.reln != b'!',
				_ => {
					if m.kind == Kind::Indirect {
						*found_match = true;
						*returnval = 1;
					}
					!self.check(m, bb)
				},
			};
			if flush {
				continue;
			}
			if self.annotate(m, firstline) {
				*found_match = true;
				shared.need_separator = true;
				shared.printed_something = true;
				*returnval = 1;
				return 1;
			}
			if !m.desc.is_empty() {
				*found_match = true;
				if print {
					*returnval = 1;
					shared.need_separator = true;
					shared.printed_something = true;
					self.print_sep(firstline);
					self.print(m, bb);
				}
			}
			let Some(off) = self.offset_after(m, bb.len()) else { continue };
			self.levels[cont_level].off = off;
			cont_level += 1;
			self.check_mem(cont_level);

			for next in &entry[1..] {
				m = next;
				let level = usize::from(m.cont_level);
				if cont_level < level {
					continue;
				}
				if cont_level > level {
					// The end of the deeper level's continuations.
					cont_level = level;
				}
				if !self.set_offset(m, &mut bb, b, o, cont_level) {
					continue 'entries;
				}
				if m.flag & OFFADD != 0 {
					if cont_level == 0 {
						return 0;
					}
					self.offset = self.offset.wrapping_add(self.levels[cont_level - 1].off);
				}
				let matched = match self.get(m, b, bb, o, cont_level, mode, text, flip, shared, returnval, found_match) {
					-1 => return -1,
					0 => {
						if m.reln != b'!' {
							continue;
						}
						true
					},
					_ => {
						if m.kind == Kind::Indirect {
							*found_match = true;
							*returnval = 1;
						}
						self.check(m, bb)
					},
				};
				if !matched {
					continue;
				}
				if m.kind == Kind::Clear {
					self.levels[cont_level].got_match = false;
				} else if self.levels[cont_level].got_match {
					if m.kind == Kind::Default {
						continue;
					}
				} else {
					self.levels[cont_level].got_match = true;
				}
				if self.annotate(m, firstline) {
					*found_match = true;
					shared.need_separator = true;
					shared.printed_something = true;
					*returnval = 1;
					return 1;
				}
				if !m.desc.is_empty() {
					*found_match = true;
					if print {
						*returnval = 1;
						if !shared.printed_something {
							shared.printed_something = true;
							self.print_sep(firstline);
						}
						if shared.need_separator && m.flag & NOSPACE == 0 {
							self.out.push(b' ');
						}
						self.print(m, bb);
						shared.need_separator = true;
					}
				}
				// A continuation whose end runs off the buffer still matched,
				// but its deeper lines are skipped.
				if let Some(off) = self.offset_after(m, bb.len()) {
					self.levels[cont_level].off = off;
					cont_level += 1;
				}
				self.check_mem(cont_level);
			}
			if shared.printed_something {
				firstline = false;
			}
			if *found_match {
				if !self.limits.keep_going {
					return *returnval;
				}
				// So the next match prints a separator.
				shared.printed_something = false;
				firstline = false;
			}
		}
		*returnval
	}

	/// `msetoffset`: positions the rule, choosing between the buffer and the
	/// file's tail. `false` drops the entry.
	fn set_offset<'d>(&mut self, m: &Magic, bb: &mut &'d [u8], b: Buf<'d>, o: usize, cont_level: usize) -> bool {
		if m.flag & OFFNEGATIVE != 0 {
			let offset = m.offset.wrapping_neg();
			if cont_level > 0 && m.flag & (OFFADD | INDIROFFADD) != 0 {
				*bb = b.data;
				self.offset = offset;
				self.eoffset = 0;
				return true;
			}
			let Some(tail) = b.tail.tail() else { return false };
			if o != 0 || m.offset as u32 as usize > tail.len() {
				return false;
			}
			*bb = tail;
			self.offset = (tail.len() - m.offset as u32 as usize) as i32;
			self.eoffset = self.offset;
		} else if cont_level == 0 {
			*bb = b.data;
			self.offset = m.offset;
			self.eoffset = 0;
		} else {
			self.offset = self.eoffset.wrapping_add(m.offset);
		}
		true
	}

	/// `mcopy`: loads the bytes at `offset` into the value window, or sets up
	/// the search region.
	fn copy(&mut self, m: &Magic, indirect: bool, s: &[u8], offset: u32) {
		let nbytes = s.len();
		let mut offset = offset as usize;
		if !indirect {
			match m.kind {
				Kind::Search | Kind::Unsupported => {
					offset = offset.min(nbytes);
					self.search.start = Some(offset);
					self.search.len = nbytes - offset;
					self.search.offset = offset;
					return;
				},
				Kind::Regex => {
					if nbytes < offset {
						self.search.len = 0;
						self.search.start = None;
						return;
					}
					let (line_count, mut byte_count) = if m.str_flags & REGEX_LINE_COUNT != 0 {
						(m.str_range as usize, m.str_range as usize * 80)
					} else {
						(0, m.str_range as usize)
					};
					if byte_count == 0 || byte_count > nbytes - offset {
						byte_count = nbytes - offset;
					}
					byte_count = byte_count.min(self.limits.regex_max);
					let end = offset + byte_count;
					let mut last = end;
					let mut lines = line_count;
					let mut at_byte = offset;
					while lines > 0 && at_byte < end {
						let found = memchr::memchr(b'\n', &s[at_byte..end])
							.or_else(|| memchr::memchr(b'\r', &s[at_byte..end]));
						let Some(found) = found else { break };
						let mut line_end = at_byte + found;
						if line_end + 1 < end && s[line_end] == b'\r' && s[line_end + 1] == b'\n' {
							line_end += 1;
						}
						if line_end + 1 < end && s[line_end] == b'\n' {
							line_end += 1;
						}
						last = line_end;
						lines -= 1;
						at_byte = line_end + 1;
					}
					if lines > 0 {
						last = end;
					}
					self.search = Search { start: Some(offset), len: last - offset, offset, rm_len: 0 };
					return;
				},
				Kind::Str16 if offset < nbytes => {
					self.val = [0; MAX_STRING];
					let big = m.endian == Endian::Big;
					let mut src = offset + usize::from(big);
					let mut dst = 0;
					while src < nbytes && dst < MAX_STRING - 1 {
						let mut c = s[src];
						if c == 0 {
							let other = if big { s[src - 1] != 0 } else { src + 1 < nbytes && s[src + 1] != 0 };
							if other {
								c = b' ';
							}
						}
						self.val[dst] = c;
						src += 2;
						dst += 1;
					}
					return;
				},
				_ => {},
			}
		}
		self.val = [0; MAX_STRING];
		if m.kind == Kind::Offset {
			self.val[..8].copy_from_slice(&(offset as u64).to_ne_bytes());
			return;
		}
		if offset < nbytes {
			let len = (nbytes - offset).min(MAX_STRING);
			self.val[..len].copy_from_slice(&s[offset..offset + len]);
		}
	}

	/// `mget`: fetches the rule's value, resolving indirect offsets and
	/// running `indirect` and `use` rules. 1 when there is a value to check,
	/// 0 when the rule cannot match, -1 on a recursion limit.
	#[allow(clippy::too_many_arguments, reason = "mirrors libmagic's mget()")]
	fn get<'d>(
		&mut self,
		m: &Magic,
		b: Buf<'d>,
		s: &'d [u8],
		o: usize,
		cont_level: usize,
		mode: u8,
		text: bool,
		mut flip: bool,
		shared: &mut Shared,
		returnval: &mut i32,
		found_match: &mut bool,
	) -> i32 {
		let nbytes = s.len();
		let mut offset = self.offset as u32;
		if shared.indir_count >= self.limits.indir_max || shared.name_count >= self.limits.name_max {
			return -1;
		}
		self.copy(m, m.flag & INDIR != 0, s, offset.wrapping_add(o as u32));

		if m.flag & INDIR != 0 {
			let mut off = i64::from(m.in_offset);
			let signed = m.in_op & OP_SIGNED != 0;
			let in_endian = flip_endian(m.in_endian, flip);
			let size = match m.in_kind {
				Kind::Byte => 1,
				Kind::Short => 2,
				Kind::Long | Kind::Id3 => 4,
				Kind::Quad => 8,
				_ => return 0,
			};
			if m.in_op & OP_INDIRECT != 0 {
				let at_offset = (i64::from(offset) + off) as u32;
				if oob(nbytes, at_offset, size) {
					return 0;
				}
				let start = at_offset as usize;
				off = sext(signed, size, read_uint(&s[start..start + size], size, in_endian));
			}
			if oob(nbytes, offset, size) {
				return 0;
			}
			let mut lhs = read_uint(&self.val, size, in_endian);
			if m.in_kind == Kind::Id3 {
				lhs = u64::from(cvt_id3(lhs as u32));
			}
			offset = do_ops(m, sext(signed, size, lhs), off);
			if m.flag & INDIROFFADD != 0 {
				if cont_level == 0 {
					return 0;
				}
				offset = offset.wrapping_add(self.levels[cont_level - 1].off as u32);
				if offset == 0 {
					return 0;
				}
			}
			self.copy(m, false, s, offset);
			self.offset = offset as i32;
		}

		match m.kind {
			Kind::Byte | Kind::Short | Kind::Long | Kind::Date | Kind::LDate | Kind::Float | Kind::Double | Kind::Guid => {
				if oob(nbytes, offset, m.kind.size().unwrap_or(0)) {
					return 0;
				}
			},
			Kind::Str | Kind::PStr | Kind::Search => {
				if oob(nbytes, offset, usize::from(m.vallen)) {
					return 0;
				}
			},
			Kind::Regex => {
				if nbytes < offset as usize {
					return 0;
				}
			},
			Kind::Indirect => {
				if m.str_flags & INDIRECT_RELATIVE != 0 {
					offset = offset.wrapping_add(o as u32);
				}
				if offset == 0 || nbytes < offset as usize {
					return 0;
				}
				let saved = std::mem::take(&mut self.out);
				shared.indir_count += 1;
				let inner = Buf { data: &s[offset as usize..], tail: b.tail };
				let (mut inner_returnval, mut inner_found) = (0, false);
				let rv = self.run(
					&List::All,
					inner,
					0,
					BINTEST,
					text,
					false,
					shared,
					&mut inner_returnval,
					&mut inner_found,
				);
				let nested = std::mem::replace(&mut self.out, saved);
				if rv == 1 {
					if self.report == Report::Description {
						printf(&mut self.out, m.desc, &Arg::Int {
							value:    u64::from(offset),
							unsigned: true,
							quad:     false,
						});
					}
					self.out.extend_from_slice(&nested);
				}
				return rv;
			},
			Kind::Use => {
				if nbytes < offset as usize {
					return 0;
				}
				let mut name = m.bytes();
				if let Some(rest) = name.strip_prefix(b"^") {
					name = rest;
					flip = !flip;
				}
				let db = self.db;
				let Some(range) = db.names.get(name) else { return -1 };
				let saved_levels = self.levels.clone();
				let old_separator = shared.need_separator;
				if m.flag & NOSPACE != 0 {
					shared.need_separator = false;
				}
				let mut nested_found = false;
				shared.name_count += 1;
				let eoffset = self.eoffset;
				let rv = self.run(
					&List::One(range),
					b,
					offset as usize + o,
					mode,
					text,
					flip,
					shared,
					returnval,
					&mut nested_found,
				);
				self.num = u64::from(nested_found);
				shared.name_count -= 1;
				*found_match |= nested_found;
				self.levels = saved_levels;
				if rv != 1 {
					shared.need_separator = old_separator;
				}
				self.offset = offset as i32;
				self.eoffset = eoffset;
				return rv;
			},
			Kind::Name => {
				if self.report == Report::Description {
					self.out.extend_from_slice(m.desc);
				}
				return 1;
			},
			Kind::Unsupported | Kind::Id3 => return 0,
			_ => {},
		}
		i32::from(self.convert(m, flip))
	}

	/// `mconvert`: decodes the value window per the rule's type and applies
	/// its mask.
	fn convert(&mut self, m: &Magic, flip: bool) -> bool {
		let endian = flip_endian(m.endian, flip);
		match m.kind {
			Kind::Byte | Kind::Short | Kind::Long | Kind::Quad | Kind::Offset | Kind::Date | Kind::LDate | Kind::QDate
			| Kind::QLDate | Kind::QWDate => {
				let size = m.kind.size().unwrap_or(8);
				let mask = if size == 8 { u64::MAX } else { (1u64 << (size * 8)) - 1 };
				let mut v = read_uint(&self.val, size, endian) & mask;
				if m.num_mask != 0 {
					let n = m.num_mask & mask;
					v = match m.mask_op & OPS_MASK {
						OP_AND => v & n,
						OP_OR => v | n,
						OP_XOR => v ^ n,
						OP_ADD => v.wrapping_add(n),
						OP_MINUS => v.wrapping_sub(n),
						OP_MULTIPLY => v.wrapping_mul(n),
						OP_DIVIDE => {
							if n == 0 {
								return false;
							}
							v / n
						},
						_ => {
							if n == 0 {
								return false;
							}
							v % n
						},
					} & mask;
				}
				if m.mask_op & OP_INVERSE != 0 {
					v = !v & mask;
				}
				self.num = v;
			},
			Kind::Float | Kind::Double => {
				let mut v = if m.kind == Kind::Float {
					f64::from(f32::from_bits(read_uint(&self.val, 4, endian) as u32))
				} else {
					f64::from_bits(read_uint(&self.val, 8, endian))
				};
				if m.num_mask != 0 {
					let n = m.num_mask as f64;
					match m.mask_op & OPS_MASK {
						OP_ADD => v += n,
						OP_MINUS => v -= n,
						OP_MULTIPLY => v *= n,
						OP_DIVIDE => v /= n,
						_ => {},
					}
				}
				self.float = v;
			},
			Kind::Str | Kind::Str16 => self.val[MAX_STRING - 1] = 0,
			Kind::PStr => {
				let Some(size) = pstring_length_size(m.str_flags) else { return false };
				let raw = &self.val;
				let mut len = match m.str_flags & PSTRING_LEN {
					PSTRING_1_LE => usize::from(raw[0]),
					PSTRING_2_LE => usize::from(u16::from_le_bytes([raw[0], raw[1]])),
					PSTRING_2_BE => usize::from(u16::from_be_bytes([raw[0], raw[1]])),
					PSTRING_4_LE => u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize,
					_ => u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize,
				};
				if m.str_flags & PSTRING_LENGTH_INCLUDES_ITSELF != 0 {
					len = len.wrapping_sub(size);
				}
				let max = MAX_STRING - size;
				if len >= max {
					len = max;
				}
				self.val.copy_within(size..size + len, 0);
				self.val[len] = 0;
			},
			_ => {},
		}
		true
	}

	/// `magiccheck`: compares the fetched value with the rule's.
	fn check(&mut self, m: &Magic, s: &[u8]) -> bool {
		let l;
		let v;
		match m.kind {
			Kind::Float | Kind::Double => {
				let expected = match m.value {
					Value::Float(value) => value,
					_ => 0.0,
				};
				return match m.reln {
					b'x' => true,
					b'!' => self.float != expected,
					b'=' => self.float == expected,
					b'>' => self.float > expected,
					b'<' => self.float < expected,
					_ => false,
				};
			},
			Kind::Default | Kind::Clear => {
				l = 0;
				v = 0;
			},
			Kind::Str | Kind::PStr | Kind::Str16 => {
				l = 0;
				let flags = if m.kind == Kind::Str16 { 0 } else { m.str_flags };
				v = strncmp(m.bytes(), &self.val, usize::from(m.vallen), MAX_STRING, flags);
			},
			Kind::Search => {
				let Some(start) = self.search.start else { return false };
				let region = &s[start..start + self.search.len];
				let pattern = m.bytes();
				let slen = pattern.len();
				l = 0;
				let mut mismatch = 0u64;
				if slen > 0 && m.str_flags == 0 {
					let mut limit = m.str_range as usize + slen;
					if m.str_range == 0 || region.len() < limit {
						limit = region.len();
					}
					match memchr::memmem::find(&region[..limit], pattern) {
						Some(index) => {
							self.search.offset += index;
							self.search.rm_len = region.len() - index;
						},
						None => mismatch = 1,
					}
				} else {
					let mut index = 0usize;
					while m.str_range == 0 || index < m.str_range as usize {
						if slen + index > region.len() {
							mismatch = 1;
							break;
						}
						mismatch = strncmp(pattern, &region[index..], slen, region.len() - index, m.str_flags);
						if mismatch == 0 {
							self.search.offset += index;
							self.search.rm_len = region.len() - index;
							break;
						}
						index += 1;
					}
				}
				v = mismatch;
			},
			Kind::Regex => {
				let Some(start) = self.search.start else { return false };
				let Value::Regex(lazy) = &m.value else { return false };
				let ignore_case = m.str_flags & (STRING_IGNORE_LOWERCASE | STRING_IGNORE_UPPERCASE) != 0;
				let Some(regex) = lazy.get(ignore_case) else { return false };
				// libmagic copies the region and terminates the copy over its
				// last byte, so that byte is never searched.
				let region = &s[start..start + self.search.len];
				let subject = c_str(&region[..region.len().saturating_sub(1)]);
				l = 0;
				match regex.find(subject) {
					Some(found) => {
						self.search.start = Some(start + found.start());
						self.search.offset += found.start();
						self.search.rm_len = found.len();
						v = 0;
					},
					None => v = 1,
				}
			},
			Kind::Use => return self.num != 0,
			Kind::Name | Kind::Indirect => return true,
			Kind::Guid => {
				l = 0;
				let expected = match &m.value {
					Value::Guid(guid) => guid,
					_ => return false,
				};
				v = u64::from(self.val[..16] != expected[..]);
			},
			Kind::Unsupported | Kind::Id3 => return false,
			_ => {
				l = m.num();
				v = self.num;
			},
		}
		let v = sign_extend(m, v);
		match m.reln {
			b'x' => true,
			b'!' => v != l,
			b'=' => v == l,
			b'>' => {
				if m.flag & UNSIGNED != 0 {
					v > l
				} else {
					(v as i64) > (l as i64)
				}
			},
			b'<' => {
				if m.flag & UNSIGNED != 0 {
					v < l
				} else {
					(v as i64) < (l as i64)
				}
			},
			b'&' => v & l == l,
			b'^' => v & l != l,
			_ => false,
		}
	}

	/// `handle_annotation`: in the MIME, extension and creator modes, reports
	/// the rule's annotation and ends the match.
	fn annotate(&mut self, m: &Magic, firstline: bool) -> bool {
		let text: Cow<'_, [u8]> = match self.report {
			Report::Apple if !m.apple.is_empty() => Cow::Borrowed(m.apple),
			Report::Extension if !m.ext.is_empty() => Cow::Borrowed(m.ext),
			Report::Mime if !m.mime.is_empty() => varexpand(m.mime, self.mode),
			_ => return false,
		};
		self.print_sep(firstline);
		self.out.extend_from_slice(&text);
		true
	}

	/// `print_sep`: the `-k` separator between matches.
	fn print_sep(&mut self, firstline: bool) {
		if !firstline {
			self.out.extend_from_slice(b"\n- ");
		}
	}

	/// The fetched string as the C string libmagic prints, cut at a line end
	/// when the rule's value is empty.
	fn fetched_str(&self, m: &Magic) -> &[u8] {
		let text = c_str(&self.val);
		if m.bytes().first().is_none_or(|&c| c == 0) {
			let end = text.iter().position(|&c| c == b'\r' || c == b'\n').unwrap_or(text.len());
			&text[..end]
		} else {
			text
		}
	}

	/// `mprint`: formats the rule's description with its value.
	fn print(&mut self, m: &Magic, s: &[u8]) {
		let desc = varexpand(m.desc, self.mode);
		let raw = self.limits.raw;
		let mut out = std::mem::take(&mut self.out);
		match m.kind {
			Kind::Byte | Kind::Short | Kind::Long | Kind::Quad | Kind::Offset => {
				let unsigned = m.flag & UNSIGNED != 0;
				let value = sign_extend(m, self.num);
				let quad = matches!(m.kind, Kind::Quad | Kind::Offset);
				if has_string_conversion(&desc) {
					let text = if unsigned { value.to_string() } else { (value as i64).to_string() };
					printf(&mut out, &desc, &Arg::Str(text.as_bytes()))
				} else {
					printf(&mut out, &desc, &Arg::Int { value, unsigned, quad })
				}
			},
			Kind::Str | Kind::PStr | Kind::Str16 => {
				if m.reln == b'=' || m.reln == b'!' {
					printf(&mut out, &desc, &Arg::Str(&printable(m.c_str(), raw)))
				} else {
					let mut text = self.fetched_str(m);
					if m.str_flags & STRING_TRIM != 0 {
						text = trim(text);
					}
					printf(&mut out, &desc, &Arg::Str(&printable(text, raw)))
				}
			},
			Kind::Date | Kind::LDate | Kind::QDate | Kind::QLDate | Kind::QWDate => {
				let seconds = match m.kind {
					Kind::Date | Kind::LDate => i64::from(self.num as u32),
					// Windows FILETIME: 100 ns ticks since 1601.
					Kind::QWDate => (self.num / 10_000_000) as i64 - 11_644_473_600,
					_ => self.num as i64,
				};
				let zone = matches!(m.kind, Kind::LDate | Kind::QLDate).then_some(self.zone);
				printf(&mut out, &desc, &Arg::Str(format_time(seconds, zone).as_bytes()))
			},
			Kind::Float | Kind::Double => {
				if has_string_conversion(&desc) {
					let text = format_general(self.float, 6, false);
					printf(&mut out, &desc, &Arg::Str(text.as_bytes()))
				} else {
					printf(&mut out, &desc, &Arg::Float(self.float))
				}
			},
			Kind::Search | Kind::Regex => {
				let matched = self.search.start.map_or(&[][..], |start| {
					let end = (start + self.search.rm_len).min(s.len());
					c_str(&s[start.min(end)..end])
				});
				let matched = if m.str_flags & STRING_TRIM != 0 { trim(matched) } else { matched };
				let shown = printable(matched, self.limits.raw);
				printf(&mut out, &desc, &Arg::Str(&shown[..shown.len().min(PRINT_MAX)]))
			},
			Kind::Guid => {
				let g = &self.val;
				let text = format!(
					"{:08X}-{:04X}-{:04X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}",
					u32::from_le_bytes([g[0], g[1], g[2], g[3]]),
					u16::from_le_bytes([g[4], g[5]]),
					u16::from_le_bytes([g[6], g[7]]),
					g[8],
					g[9],
					g[10],
					g[11],
					g[12],
					g[13],
					g[14],
					g[15]
				);
				printf(&mut out, &desc, &Arg::Str(text.as_bytes()))
			},
			Kind::Default | Kind::Clear => out.extend_from_slice(m.desc),
			_ => {},
		}
		self.out = out;
	}

	/// `moffset`: where the next relative offset counts from; `None` when
	/// that falls outside the buffer.
	fn offset_after(&self, m: &Magic, nbytes: usize) -> Option<i32> {
		let offset = self.offset;
		let o = match m.kind {
			Kind::Byte => offset.wrapping_add(1),
			Kind::Short => offset.wrapping_add(2),
			Kind::Long | Kind::Date | Kind::LDate | Kind::Float => offset.wrapping_add(4),
			Kind::Quad | Kind::QDate | Kind::QLDate | Kind::Double => offset.wrapping_add(8),
			Kind::Str | Kind::PStr | Kind::Str16 => {
				if m.reln == b'=' || m.reln == b'!' {
					offset.wrapping_add(i32::from(m.vallen))
				} else {
					let mut o = offset.wrapping_add(self.fetched_str(m).len() as i32);
					if m.kind == Kind::PStr {
						o = o.wrapping_add(pstring_length_size(m.str_flags)? as i32);
					}
					o
				}
			},
			Kind::Regex => {
				if m.str_flags & REGEX_OFFSET_START != 0 {
					self.search.offset as i32
				} else {
					(self.search.offset + self.search.rm_len) as i32
				}
			},
			Kind::Search => {
				if m.str_flags & REGEX_OFFSET_START != 0 {
					self.search.offset as i32
				} else {
					(self.search.offset + usize::from(m.vallen)) as i32
				}
			},
			Kind::Clear | Kind::Default | Kind::Indirect | Kind::Offset | Kind::Use => offset,
			Kind::Guid => offset.wrapping_add(16),
			_ => 0,
		};
		(o as u32 as usize <= nbytes).then_some(o)
	}
}
