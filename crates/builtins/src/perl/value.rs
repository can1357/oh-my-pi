//! Perl scalar representations and coercions (perldata, perlnumber, perlref, perlunicode).

use std::{
	borrow::Cow,
	cell::{Cell, OnceCell, Ref as CellRef, RefCell, RefMut},
	cmp::Ordering,
	fmt,
	hash::{Hash, Hasher},
	io::Write as _,
	rc::{Rc, Weak},
};

use indexmap::IndexMap;
use rustc_hash::FxBuildHasher;

pub(in crate::perl) use super::code::{CodeBody, Cv};

/// A string with Perl's separate byte/UTF-8 representation flag.
#[derive(Clone, Default, Debug)]
pub(in crate::perl) struct PStr {
	/// Native Latin-1 bytes or Perl-extended UTF-8, according to `utf8`.
	pub bytes: Vec<u8>,
	/// Whether `bytes` are encoded as Perl-extended UTF-8.
	pub utf8: bool,
}

impl PStr {
	/// Wrap bytes without validating or changing the specified encoding.
	pub fn new(bytes: Vec<u8>, utf8: bool) -> Self { Self { bytes, utf8 } }

	/// Encode Rust text, using the UTF-8 representation only when necessary.
	pub fn from_str(s: &str) -> Self { Self::new(s.as_bytes().to_vec(), !s.is_ascii()) }

	/// Copy an unflagged Latin-1 byte string.
	pub fn from_bytes(b: &[u8]) -> Self { Self::new(b.to_vec(), false) }

	/// Encode code points, keeping a byte representation when possible.
	pub fn from_codepoints(cps: impl IntoIterator<Item = u32>) -> Self {
		let cps = cps.into_iter();
		let mut s = Self::new(Vec::with_capacity(cps.size_hint().0), false);
		for cp in cps {
			s.push_char(cp);
		}
		s
	}

	/// Iterate characters, treating each malformed UTF-8 sequence as zero, as `unpack U*` does.
	pub fn chars(&self) -> impl Iterator<Item = u32> + '_ {
		let mut bytes = self.bytes.as_slice();
		std::iter::from_fn(move || {
			let &b = bytes.first()?;
			let (cp, width) = if self.utf8 { decode_utf8(bytes) } else { (Some(u32::from(b)), 1) };
			bytes = &bytes[width..];
			Some(cp.unwrap_or(0))
		})
	}

	/// Return the character count, rather than the byte count.
	pub fn char_len(&self) -> usize {
		if self.utf8 { self.chars().count() } else { self.bytes.len() }
	}

	/// Test whether the string has no characters.
	pub fn is_empty(&self) -> bool { self.bytes.is_empty() }

	/// Append another string, upgrading to UTF-8 if either string is flagged.
	pub fn push(&mut self, other: &PStr) {
		if other.utf8 {
			self.upgrade();
			self.bytes.extend_from_slice(&other.bytes);
		} else {
			self.push_bytes(&other.bytes);
		}
	}

	/// Append Latin-1 characters in the receiver's current encoding.
	pub fn push_bytes(&mut self, latin1: &[u8]) {
		if self.utf8 && !latin1.is_ascii() {
			self.bytes.reserve(latin1.len());
			for &b in latin1 {
				encode_utf8(u32::from(b), &mut self.bytes);
			}
		} else {
			self.bytes.extend_from_slice(latin1);
		}
	}

	/// Append one character, upgrading to UTF-8 when it does not fit in a byte.
	pub fn push_char(&mut self, cp: u32) {
		if !self.utf8 {
			if let Ok(b) = u8::try_from(cp) {
				self.bytes.push(b);
				return;
			}
			self.upgrade();
		}
		encode_utf8(cp, &mut self.bytes);
	}

	/// Convert Latin-1 storage to UTF-8 without changing the characters.
	pub fn upgrade(&mut self) {
		if !self.utf8 {
			// Expand from the end so a uniquely owned string can reuse its allocation.
			let extra = self.bytes.iter().filter(|b| !b.is_ascii()).count();
			if extra != 0 {
				let old_len = self.bytes.len();
				let mut out = old_len + extra;
				self.bytes.resize(out, 0);
				for i in (0..old_len).rev() {
					let b = self.bytes[i];
					out -= 1;
					self.bytes[out] = if b.is_ascii() { b } else { (b & 0x3f) | 0x80 };
					if !b.is_ascii() {
						out -= 1;
						self.bytes[out] = (b >> 6) | 0xc0;
					}
				}
			}
			self.utf8 = true;
		}
	}

	/// Obtain Latin-1 storage, if every character fits in a byte.
	pub fn downgraded(&self) -> Option<Vec<u8>> {
		if !self.utf8 || self.bytes.is_ascii() {
			Some(self.bytes.clone())
		} else {
			self.chars().map(|cp| u8::try_from(cp).ok()).collect()
		}
	}

	/// Convert a character index to a clamped offset in the original byte storage.
	pub fn char_to_byte(&self, char_idx: usize) -> usize {
		if !self.utf8 {
			return char_idx.min(self.bytes.len());
		}
		let mut at = 0;
		for _ in 0..char_idx {
			if at == self.bytes.len() { break; }
			at += decode_utf8(&self.bytes[at..]).1;
		}
		at
	}

	/// Convert a clamped byte offset to the index of the character at that offset.
	pub fn byte_to_char(&self, byte_idx: usize) -> usize {
		let end = byte_idx.min(self.bytes.len());
		if !self.utf8 { return end; }
		let (mut count, mut at) = (0, 0);
		while at < end {
			at += decode_utf8(&self.bytes[at..]).1;
			if at > end { break; }
			count += 1;
		}
		count
	}

	/// Render Unicode text for diagnostics, replacing malformed and non-Unicode characters.
	pub fn to_string_lossy(&self) -> Cow<'_, str> {
		if self.utf8 || self.bytes.is_ascii() {
			if let Ok(s) = std::str::from_utf8(&self.bytes) {
				return Cow::Borrowed(s);
			}
		}
		if !self.utf8 {
			return Cow::Owned(self.bytes.iter().copied().map(char::from).collect());
		}
		let mut bytes = self.bytes.as_slice();
		let mut s = String::with_capacity(bytes.len());
		while !bytes.is_empty() {
			let (cp, width) = decode_utf8(bytes);
			s.push(cp.and_then(char::from_u32).unwrap_or(char::REPLACEMENT_CHARACTER));
			bytes = &bytes[width..];
		}
		Cow::Owned(s)
	}
}

// On ASCII platforms Perl extends UTF-8's leading-one scheme through 0xfe;
// 0xff carries a fixed twelve continuation bytes for the largest code points.
fn decode_utf8(bytes: &[u8]) -> (Option<u32>, usize) {
	let Some(&head) = bytes.first() else { return (None, 0) };
	if head.is_ascii() { return (Some(u32::from(head)), 1); }
	let (width, mut cp, min) = match head {
		0x80..=0xbf => return (None, 1),
		0xc0..=0xdf => (2, u32::from(head & 0x1f), 0x80),
		0xe0..=0xef => (3, u32::from(head & 0x0f), 0x800),
		0xf0..=0xf7 => (4, u32::from(head & 0x07), 0x1_0000),
		0xf8..=0xfb => (5, u32::from(head & 0x03), 0x20_0000),
		0xfc..=0xfd => (6, u32::from(head & 0x01), 0x400_0000),
		0xfe => (7, 0, 0x8000_0000),
		0xff => (13, 0, u32::MAX),
		_ => return (None, 1),
	};
	let mut consumed = 1;
	let mut overflow = false;
	for &b in bytes.iter().skip(1).take(width - 1) {
		if b & 0xc0 != 0x80 { break; }
		overflow |= cp > u32::MAX >> 6;
		cp = (cp << 6) | u32::from(b & 0x3f);
		consumed += 1;
	}
	let valid = consumed == width && cp >= min && !overflow && head != 0xff;
	(valid.then_some(cp), consumed)
}

fn encode_utf8(cp: u32, buf: &mut Vec<u8>) {
	let (lead, tails) = match cp {
		0..=0x7f => { buf.push(cp as u8); return; }
		0x80..=0x7ff => (0xc0, 1),
		0x800..=0xffff => (0xe0, 2),
		0x1_0000..=0x1f_ffff => (0xf0, 3),
		0x20_0000..=0x3ff_ffff => (0xf8, 4),
		0x400_0000..=0x7fff_ffff => (0xfc, 5),
		_ => (0xfe, 6),
	};
	buf.push(lead | (u64::from(cp) >> (tails * 6)) as u8);
	for shift in (0..tails).rev() {
		buf.push(0x80 | ((cp >> (shift * 6)) as u8 & 0x3f));
	}
}

impl PartialEq for PStr {
	fn eq(&self, other: &Self) -> bool {
		(self.utf8 == other.utf8 && self.bytes == other.bytes)
			|| ((self.utf8 || other.utf8) && self.chars().eq(other.chars()))
	}
}
impl Eq for PStr {}
impl PartialOrd for PStr {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> { Some(self.cmp(other)) }
}
impl Ord for PStr {
	fn cmp(&self, other: &Self) -> Ordering {
		if !self.utf8 && !other.utf8 { self.bytes.cmp(&other.bytes) } else { self.chars().cmp(other.chars()) }
	}
}
impl Hash for PStr {
	fn hash<H: Hasher>(&self, state: &mut H) {
		if !self.utf8 {
			hash_latin1(&self.bytes, state);
		} else {
			for cp in self.chars() { state.write_u32(cp); }
			state.write_u32(0);
			state.write_u8(0xff);
		}
	}
}

// Hash::Util exposes this stream through hash_value(), including the terminator.
#[inline]
fn hash_latin1<H: Hasher>(bytes: &[u8], state: &mut H) {
	for &b in bytes { state.write_u32(u32::from(b)); }
	state.write_u32(0);
	state.write_u8(0xff);
}

/// A number stored as a signed integer (IV), unsigned integer (UV), or floating point (NV).
#[derive(Clone, Copy, Debug)]
pub(in crate::perl) enum Num {
	/// Signed integer.
	Int(i64),
	/// Unsigned integer.
	UInt(u64),
	/// IEEE double.
	Float(f64),
}

impl Num {
	/// Convert the number to a native double.
	pub fn to_f64(self) -> f64 {
		match self { Self::Int(i) => i as f64, Self::UInt(u) => u as f64, Self::Float(n) => n }
	}

	/// Preserve the numeric representation in a scalar, normalizing small UVs to IVs.
	pub fn into_value(self) -> Value {
		match self {
			Self::Int(i) => Value::Int(i),
			Self::UInt(u) => i64::try_from(u).map_or(Value::UInt(u), Value::Int),
			Self::Float(n) => Value::Num(n),
		}
	}

	/// Coerce to UV; negative IVs are reinterpreted in two's complement.
	pub fn to_u64(self) -> u64 {
		match self {
			Self::Int(i) => i as u64,
			Self::UInt(u) => u,
			Self::Float(n) if n < 0.0 => (n as i64) as u64,
			Self::Float(n) => n as u64,
		}
	}

	/// Coerce to IV for operators that interpret the low word as signed bits.
	pub fn wrapping_iv(self) -> i64 { self.to_u64() as i64 }
}

/// A Perl scalar value.
#[derive(Clone, Debug)]
pub(in crate::perl) enum Value {
	/// Undefined.
	Undef,
	/// Signed integer.
	Int(i64),
	/// Unsigned integer greater than `i64::MAX`.
	UInt(u64),
	/// Floating-point number.
	Num(f64),
	/// String with no numeric representation.
	Str(PStr),
	/// Reference to another value or container.
	Ref(Ref),
	/// Typeglob value, distinct from a reference to a typeglob.
	Glob(Gv),
	/// Distinct numeric and string facets of a scalar such as `$!`.
	Dual(Rc<Dual>),
}

/// A scalar with both a numeric and a string facet.
#[derive(Debug)]
pub(in crate::perl) struct Dual {
	/// The numeric facet.
	pub num: Num,
	/// The string facet (also used for truth testing).
	pub str: PStr,
}

impl Value {
	/// Create a scalar from Rust text.
	pub fn str(s: &str) -> Value { Self::Str(PStr::from_str(s)) }

	/// Create a scalar from unflagged Latin-1 bytes.
	pub fn bytes(b: &[u8]) -> Value { Self::Str(PStr::from_bytes(b)) }

	/// Test whether the scalar is undefined.
	pub fn is_undef(&self) -> bool { matches!(self, Self::Undef) }

	/// Borrow an existing string facet without formatting or copying it.
	pub fn as_pstr(&self) -> Option<&PStr> {
		match self { Self::Str(s) => Some(s), Self::Dual(d) => Some(&d.str), _ => None }
	}

	/// Test Perl truth, using the string facet for dualvars.
	pub fn truthy(&self) -> bool {
		fn str_truth(s: &PStr) -> bool { !s.is_empty() && s.bytes != b"0" }
		match self {
			Self::Undef => false,
			Self::Int(i) => *i != 0,
			Self::UInt(u) => *u != 0,
			Self::Num(n) => *n != 0.0,
			Self::Str(s) => str_truth(s),
			Self::Dual(d) => str_truth(&d.str),
			Self::Ref(_) | Self::Glob(_) => true,
		}
	}

	/// Convert to an IV, UV or NV, without invoking overloads or issuing warnings.
	pub fn to_num(&self) -> Num {
		match self {
			Self::Undef | Self::Glob(_) => Num::Float(0.0),
			Self::Int(i) => Num::Int(*i),
			Self::UInt(u) => Num::UInt(*u),
			Self::Num(n) => Num::Float(*n),
			Self::Str(s) => parse_number(&s.bytes).0,
			Self::Ref(r) => {
				let addr = r.addr() as u64;
				i64::try_from(addr).map_or(Num::UInt(addr), Num::Int)
			}
			Self::Dual(d) => d.num,
		}
	}

	/// Convert to a native double.
	pub fn to_f64(&self) -> f64 { self.to_num().to_f64() }

	/// Convert to a signed integer, truncating toward zero and saturating to IV bounds.
	pub fn to_i64(&self) -> i64 {
		match self.integer_coercion() {
			Num::Int(i) => i,
			Num::UInt(u) => u.min(i64::MAX as u64) as i64,
			Num::Float(n) => n as i64,
		}
	}

	/// Convert to an unsigned integer, preserving the bits of negative IVs.
	pub fn to_u64(&self) -> u64 { self.integer_coercion().to_u64() }

	/// Retrieve the most precise representation for a consumer that truncates to an integer.
	pub(super) fn integer_coercion(&self) -> Num {
		if let Self::Str(s) = self {
			// An IV/UV-only consumer can use decimal digits before the dot directly,
			// avoiding NV rounding even when a fractional part is present.
			if let Some(token) = numeric_prefix(&s.bytes) {
				if token.complete(&s.bytes) {
					if let NumberForm::Decimal { digits, dot: true, exponent: false } = token.form {
						let bytes = &s.bytes[token.start..digits];
						if let Some(n) = signed_decimal(bytes, token.negative) { return n; }
					}
				}
				return token.to_num(&s.bytes);
			}
			return Num::Int(0);
		}
		self.to_num()
	}

	/// Stringify a scalar using its string facet or the standard unoverloaded reference format.
	pub fn to_pstr(&self) -> PStr {
		match self {
			Self::Undef => PStr::default(),
			Self::Int(i) => PStr::new(i.to_string().into_bytes(), false),
			Self::UInt(u) => PStr::new(u.to_string().into_bytes(), false),
			Self::Num(n) => format_float(*n),
			Self::Str(s) => s.clone(),
			Self::Dual(d) => d.str.clone(),
			Self::Glob(g) => {
				let mut text = String::with_capacity(g.pkg.len() + g.name.len() + 3);
				text.push('*');
				text.push_str(&g.pkg);
				text.push_str("::");
				text.push_str(&g.name);
				let utf8 = !text.is_ascii();
				PStr::new(text.into_bytes(), utf8)
			}
			Self::Ref(Ref::Regexp(r)) => r.regex.stringify(),
			Self::Ref(r) => {
				let kind = r.kind_name();
				let pkg = r.blessed();
				let mut out = Vec::with_capacity(pkg.as_ref().map_or(0, |p| p.len() + 1) + kind.len() + 4 + 2 * size_of::<usize>());
				let mut utf8 = false;
				if let Some(pkg) = pkg {
					utf8 = !pkg.is_ascii();
					out.extend_from_slice(pkg.as_bytes());
					out.push(b'=');
				}
				let _ = write!(out, "{kind}(0x{:x})", r.addr());
				PStr::new(out, utf8)
			}
		}
	}

	/// Test whether Scalar::Util would consider this scalar a number.
	pub fn looks_like_number(&self) -> bool {
		match self {
			Self::Int(_) | Self::UInt(_) | Self::Num(_) => true,
			Self::Str(_) => self.is_numeric_string(),
			Self::Dual(d) => numeric_prefix(&d.str.bytes).is_some_and(|n| n.complete(&d.str.bytes)),
			Self::Undef | Self::Ref(_) | Self::Glob(_) => false,
		}
	}

	/// For strings, test whether the entire representation is a valid number.
	pub fn is_numeric_string(&self) -> bool {
		matches!(self, Self::Str(s) if numeric_prefix(&s.bytes).is_some_and(|n| n.complete(&s.bytes)))
	}
}

/// Render an NV with Perl's 15 significant digits, including Perl's `Inf`, `NaN` and zero spellings.
pub(in crate::perl) fn format_float(f: f64) -> PStr {
	if f.is_nan() { return PStr::from_bytes(b"NaN"); }
	if f.is_infinite() { return PStr::from_bytes(if f.is_sign_negative() { b"-Inf" } else { b"Inf" }); }
	if f == 0.0 { return PStr::from_bytes(b"0"); }

	// Scientific formatting rounds all 15 significant digits before the exponent
	// determines whether %g uses fixed or scientific notation. It fits on the stack.
	let mut buffer = [0; 32];
	let mut tail = buffer.as_mut_slice();
	let _ = write!(tail, "{:.14e}", f.abs());
	let len = 32 - tail.len();
	let mut mantissa = [0; 15];
	let mut n = 0;
	let mut at = 0;
	for (i, &b) in buffer[..len].iter().enumerate() {
		match b {
			b'.' => {},
			b'e' => { at = i + 1; break; }
			_ => { mantissa[n] = b; n += 1; }
		}
	}
	let exp = &buffer[at..len];
	let (negative_exp, exp_digits) = match exp.strip_prefix(b"-") { Some(d) => (true, d), None => (false, exp) };
	let mut exp = exp_digits.iter().fold(0i32, |n, &b| n * 10 + i32::from(b - b'0'));
	if negative_exp { exp = -exp; }
	while n > 1 && mantissa[n - 1] == b'0' { n -= 1; }
	let digits = &mantissa[..n];
	let mut out = Vec::with_capacity(n + 8);
	if f.is_sign_negative() { out.push(b'-'); }
	if !(-4..15).contains(&exp) {
		out.push(digits[0]);
		if n > 1 {
			out.push(b'.');
			out.extend_from_slice(&digits[1..]);
		}
		let _ = write!(out, "e{}{:02}", if negative_exp { '-' } else { '+' }, exp.unsigned_abs());
	} else if exp < 0 {
		out.extend_from_slice(b"0.");
		out.resize(out.len() + (exp.unsigned_abs() as usize - 1), b'0');
		out.extend_from_slice(digits);
	} else {
		let point = (exp + 1) as usize;
		let integral = point.min(n);
		out.extend_from_slice(&digits[..integral]);
		if n > point {
			out.push(b'.');
			out.extend_from_slice(&digits[point..]);
		} else {
			out.resize(out.len() + point - n, b'0');
		}
	}
	PStr::new(out, false)
}

/// Parse a numeric prefix, returning zero bytes consumed when no number was found.
pub(in crate::perl) fn parse_number(bytes: &[u8]) -> (Num, usize) {
	numeric_prefix(bytes).map_or((Num::Float(0.0), 0), |token| (token.to_num(bytes), token.end))
}

#[derive(Clone, Copy)]
enum NumberForm {
	Decimal { digits: usize, dot: bool, exponent: bool },
	Inf,
	Nan,
	ZeroButTrue,
}

#[derive(Clone, Copy)]
struct NumberToken {
	form: NumberForm,
	start: usize,
	end: usize,
	negative: bool,
	loose: bool,
}

impl NumberToken {
	fn complete(self, bytes: &[u8]) -> bool {
		!self.loose && bytes[self.end..].iter().copied().all(numeric_space)
	}

	fn to_num(self, bytes: &[u8]) -> Num {
		match self.form {
			NumberForm::ZeroButTrue => Num::Int(0),
			NumberForm::Inf => Num::Float(if self.negative { f64::NEG_INFINITY } else { f64::INFINITY }),
			NumberForm::Nan => Num::Float(f64::NAN),
			NumberForm::Decimal { digits, dot, exponent } => {
				let clean = self.complete(bytes);
				if clean && !dot && !exponent {
					if let Some(n) = signed_decimal(&bytes[self.start..digits], self.negative) { return n; }
				}
				let value = std::str::from_utf8(&bytes[self.start..self.end]).ok().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
				let n = if self.negative { -value } else { value };
				if clean && exponent && !(n == 0.0 && n.is_sign_negative()) && n.fract() == 0.0 {
					if (i64::MIN as f64..-(i64::MIN as f64)).contains(&n) { return Num::Int(n as i64); }
					if (-(i64::MIN as f64)..U64_LIMIT).contains(&n) { return Num::UInt(n as u64); }
				}
				Num::Float(n)
			}
		}
	}
}

/// First double not representable as a UV.
pub(super) const U64_LIMIT: f64 = 18_446_744_073_709_551_616.0;

fn signed_decimal(digits: &[u8], negative: bool) -> Option<Num> {
	let mag = digits.iter().try_fold(0u64, |n, &b| n.checked_mul(10)?.checked_add(u64::from(b - b'0')))?;
	if negative {
		let neg = -i128::from(mag);
		Some(Num::Int(i64::try_from(neg).ok()?))
	} else {
		Some(i64::try_from(mag).map_or(Num::UInt(mag), Num::Int))
	}
}

// Perl's yes/no numeric grammar uses ASCII spaces; the fallback conversion
// of a string that fails it also recognizes Latin-1 NBSP and an extra sign.
fn numeric_space(b: u8) -> bool { matches!(b, b' ' | b'\t'..=b'\r') }

fn numeric_prefix(bytes: &[u8]) -> Option<NumberToken> {
	if bytes == b"0 but true" {
		return Some(NumberToken { form: NumberForm::ZeroButTrue, start: 0, end: bytes.len(), negative: false, loose: false });
	}
	let mut i = 0;
	let mut loose = false;
	let mut negative = false;
	while let Some(&b) = bytes.get(i).filter(|&&b| numeric_space(b) || b == 0xa0) {
		loose |= b == 0xa0;
		i += 1;
	}
	if let Some(&b) = bytes.get(i).filter(|&&b| matches!(b, b'+' | b'-')) {
		negative = b == b'-';
		i += 1;
		while bytes.get(i).is_some_and(|&b| numeric_space(b) || b == 0xa0) { loose = true; i += 1; }
		if let Some(&b) = bytes.get(i).filter(|&&b| matches!(b, b'+' | b'-')) {
			negative ^= b == b'-';
			i += 1;
			loose = true;
		}
	}
	let start = i;
	let rest = &bytes[start..];
	if let Some((form, len)) = special_prefix(rest) {
		return Some(NumberToken { form, start, end: start + len, negative, loose });
	}
	let digit = |b: &u8| b.is_ascii_digit();
	while bytes.get(i).is_some_and(digit) { i += 1; }
	let digits = i;
	let dot = bytes.get(i) == Some(&b'.');
	if dot {
		i += 1;
		while bytes.get(i).is_some_and(digit) { i += 1; }
		if digits == start && i == digits + 1 { return None; }
	} else if digits == start {
		return None;
	}
	let mut exponent = false;
	if matches!(bytes.get(i), Some(b'e' | b'E')) {
		let mut end = i + 1;
		if matches!(bytes.get(end), Some(b'+' | b'-')) { end += 1; }
		let first_digit = end;
		while bytes.get(end).is_some_and(digit) { end += 1; }
		if end != first_digit { i = end; exponent = true; }
	}
	Some(NumberToken { form: NumberForm::Decimal { digits, dot, exponent }, start, end: i, negative, loose })
}

fn starts_ascii_case(haystack: &[u8], needle: &[u8]) -> bool {
	haystack.get(..needle.len()).is_some_and(|s| s.eq_ignore_ascii_case(needle))
}

fn special_prefix(rest: &[u8]) -> Option<(NumberForm, usize)> {
	// Windows-style forms: "1.#INF", "1#INF", "1.#IND00" (grok_infnan).
	let (s, windows) = rest.strip_prefix(b"1.#").map(|s| (s, 3))
		.or_else(|| rest.strip_prefix(b"1#").map(|s| (s, 2)))
		.unwrap_or((rest, 0));
	if starts_ascii_case(s, b"infinity") { return Some((NumberForm::Inf, windows + 8)); }
	if starts_ascii_case(s, b"inf") {
		let padding = if windows == 0 { 0 } else { s[3..].iter().take_while(|&&b| b == b'0').count() };
		return Some((NumberForm::Inf, windows + 3 + padding));
	}
	if windows != 0 && starts_ascii_case(s, b"ind") {
		let padding = s[3..].iter().take_while(|&&b| b == b'0').count();
		return Some((NumberForm::Nan, windows + 3 + padding));
	}
	let q_or_s = |b: &u8| matches!(b.to_ascii_lowercase(), b'q' | b's');
	let mut n = usize::from(s.first().is_some_and(q_or_s));
	if !starts_ascii_case(&s[n..], b"nan") { return None; }
	n += 3;
	if s.get(n).is_some_and(q_or_s) { n += 1; }
	if let Some(payload) = s[n..].strip_prefix(b"(") {
		if let Some(close) = payload.iter().position(|&b| b == b')') {
			if nan_payload(&payload[..close]) { n += close + 2; }
		}
	}
	Some((NumberForm::Nan, windows + n))
}

fn nan_payload(payload: &[u8]) -> bool {
	let (digits, radix) = if starts_ascii_case(payload, b"0x") {
		(&payload[2..], 16)
	} else if starts_ascii_case(payload, b"0b") {
		(&payload[2..], 2)
	} else {
		(payload, 10)
	};
	let mut digit_before = false;
	for &b in digits {
		let valid = match radix { 16 => b.is_ascii_hexdigit(), 2 => matches!(b, b'0' | b'1'), _ => b.is_ascii_digit() };
		if !(valid || (radix != 10 && b == b'_' && digit_before)) { return false; }
		digit_before = valid;
	}
	digit_before
}

/// The referent that a scalar reference shares with other aliases.
#[derive(Clone)]
pub(in crate::perl) enum Ref {
	/// Scalar cell, including one containing another reference.
	Scalar(Sv),
	/// Array.
	Array(Av),
	/// Hash.
	Hash(Hv),
	/// Subroutine.
	Code(Cv),
	/// Typeglob.
	Glob(Gv),
	/// Compiled regular expression.
	Regexp(Rx),
	/// I/O handle.
	Io(super::io::Io),
}

impl fmt::Debug for Ref {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		// Do not format the referent recursively: references can form cycles.
		write!(f, "{}(0x{:x})", self.kind_name(), self.addr())
	}
}

impl Ref {
	/// Obtain an address that remains constant for this referent's lifetime.
	pub fn addr(&self) -> usize {
		match self {
			Self::Scalar(s) => Rc::as_ptr(s) as usize,
			Self::Array(a) => Rc::as_ptr(a) as usize,
			Self::Hash(h) => Rc::as_ptr(h) as usize,
			Self::Code(c) => Rc::as_ptr(c) as usize,
			Self::Glob(g) => Rc::as_ptr(g) as usize,
			Self::Regexp(r) => Rc::as_ptr(r) as usize,
			Self::Io(i) => Rc::as_ptr(i) as usize,
		}
	}

	/// Return the class of the referent, if it has been blessed.
	pub fn blessed(&self) -> Option<Rc<str>> {
		match self {
			Self::Scalar(s) => s.metadata.get().and_then(|m| m.blessed.borrow().clone()),
			Self::Array(a) => a.blessed.borrow().clone(),
			Self::Hash(h) => h.blessed.borrow().clone(),
			Self::Code(c) => c.blessed.borrow().clone(),
			Self::Glob(g) => g.blessed.borrow().clone(),
			Self::Regexp(r) => r.blessed.borrow().clone(),
			Self::Io(i) => i.borrow().blessed.borrow().clone(),
		}
	}

	/// Set the class on the referent itself, affecting all aliases.
	pub fn bless(&self, pkg: Rc<str>) {
		let pkg = Some(pkg);
		match self {
			Self::Scalar(s) => s.blessed.replace(pkg),
			Self::Array(a) => a.blessed.replace(pkg),
			Self::Hash(h) => h.blessed.replace(pkg),
			Self::Code(c) => c.blessed.replace(pkg),
			Self::Glob(g) => g.blessed.replace(pkg),
			Self::Regexp(r) => r.blessed.replace(pkg),
			Self::Io(i) => i.borrow().blessed.replace(pkg),
		};
	}

	/// Return the unblessed type name of the referent.
	pub fn kind_name(&self) -> &'static str {
		match self {
			Self::Scalar(s) if s.lvalue().is_some() => "LVALUE",
			Self::Scalar(s) => match s.value.try_borrow().ok().as_deref() {
				Some(Value::Ref(_)) => "REF",
				Some(Value::Glob(_)) => "GLOB",
				_ => "SCALAR",
			},
			Self::Array(_) => "ARRAY",
			Self::Hash(_) => "HASH",
			Self::Code(_) => "CODE",
			Self::Glob(_) => "GLOB",
			Self::Regexp(_) => "Regexp",
			Self::Io(_) => "IO",
		}
	}
}

enum WeakRef {
	Scalar(Weak<ScalarBody>), Array(Weak<ArrayBody>), Hash(Weak<HashBody>), Code(Weak<CodeBody>),
	Glob(Weak<GlobBody>), Regexp(Weak<RegexpBody>), Io(Weak<RefCell<super::io::Handle>>),
}

impl WeakRef {
	fn new(value: &Ref) -> Self {
		match value {
			Ref::Scalar(v) => Self::Scalar(Rc::downgrade(v)), Ref::Array(v) => Self::Array(Rc::downgrade(v)),
			Ref::Hash(v) => Self::Hash(Rc::downgrade(v)), Ref::Code(v) => Self::Code(Rc::downgrade(v)),
			Ref::Glob(v) => Self::Glob(Rc::downgrade(v)), Ref::Regexp(v) => Self::Regexp(Rc::downgrade(v)),
			Ref::Io(v) => Self::Io(Rc::downgrade(v)),
		}
	}

	fn upgrade(&self) -> Option<Ref> {
		match self {
			Self::Scalar(v) => v.upgrade().map(Ref::Scalar), Self::Array(v) => v.upgrade().map(Ref::Array),
			Self::Hash(v) => v.upgrade().map(Ref::Hash), Self::Code(v) => v.upgrade().map(Ref::Code),
			Self::Glob(v) => v.upgrade().map(Ref::Glob), Self::Regexp(v) => v.upgrade().map(Ref::Regexp),
			Self::Io(v) => v.upgrade().map(Ref::Io),
		}
	}
}

/// Shared identity of a scalar variable.
pub(in crate::perl) type Sv = Rc<ScalarBody>;

/// Mutable storage and metadata shared by all aliases to a scalar variable.
pub(in crate::perl) struct ScalarBody {
	value: RefCell<Value>,
	metadata: OnceCell<Box<ScalarMetadata>>,
	revision: Cell<u64>,
	flags: Cell<u8>,
}

/// Rare state, allocated together the first time a scalar needs it.
#[derive(Default)]
pub(in crate::perl) struct ScalarMetadata {
	weak: RefCell<Option<WeakRef>>,
	lvalue: Option<super::interp::Lvalue>,
	tie: RefCell<Option<Value>>,
	/// Class of a blessed scalar reference.
	pub blessed: RefCell<Option<Rc<str>>>,
	/// Current `m//g` position, as a byte offset.
	pub pos: Cell<Option<usize>>,
}

impl std::ops::Deref for ScalarBody {
	type Target = ScalarMetadata;

	fn deref(&self) -> &Self::Target { self.metadata.get_or_init(Default::default) }
}

const WEAK: u8 = 1;
const LVALUE: u8 = 2;
const TIED: u8 = 4;
const REGISTERED: u8 = 8;
const TRACKED: u8 = 16;
const LITERAL_READONLY: u8 = 32;
const MODULE_READONLY: u8 = 64;
const WATCHED: u8 = 128;

impl ScalarBody {
	fn new(value: Value, flags: u8) -> Self {
		Self { value: RefCell::new(value), metadata: OnceCell::new(), revision: Cell::new(0), flags: Cell::new(flags) }
	}

	fn has(&self, flags: u8) -> bool { self.flags.get() & flags != 0 }

	#[inline]
	fn changed(&self) {
		if self.has(WATCHED) { self.revision.set(self.revision.get().wrapping_add(1)); }
	}

	/// Counter changed whenever the scalar's raw storage or magic changes.
	pub fn revision(&self) -> u64 {
		// Only cells actually used for a snapshot/offset need a change counter.
		self.flags.set(self.flags.get() | WATCHED);
		self.revision.get()
	}

	/// Borrow the value only when raw storage represents an ordinary interpreter read.
	/// Drop the guard before calling Perl or modifying any alias to the cell.
	#[inline]
	pub(super) fn plain_value(&self) -> Option<CellRef<'_, Value>> {
		if self.has(WEAK | LVALUE | TIED | REGISTERED | LITERAL_READONLY) { None } else { self.value.try_borrow().ok() }
	}

	/// Read the stored scalar, upgrading a live weak reference or returning undef.
	/// Use `Interp::read_sv` when the operation can invoke Perl magic.
	#[inline]
	pub fn get(&self) -> Value {
		if self.has(WEAK) { return self.get_weak(); }
		match &*self.value.borrow() {
			Value::Int(n) => Value::Int(*n),
			Value::UInt(n) => Value::UInt(*n),
			Value::Num(n) => Value::Num(*n),
			Value::Undef => Value::Undef,
			other => other.clone(),
		}
	}

	#[cold]
	fn get_weak(&self) -> Value {
		self.weak.borrow().as_ref().and_then(WeakRef::upgrade).map_or(Value::Undef, Value::Ref)
	}

	#[inline]
	fn take_weak(&self) -> Option<WeakRef> {
		if !self.has(WEAK) { return None; }
		self.flags.set(self.flags.get() & !WEAK);
		self.weak.take()
	}

	/// Write a raw value without invoking Perl magic.
	#[inline]
	pub fn set(&self, value: Value) {
		if self.has(WEAK | WATCHED) {
			self.changed();
			self.take_weak();
		}
		*self.value.borrow_mut() = value;
	}

	/// An arithmetic update to an already plain scalar; no displaced Value on same-kind writes.
	#[inline]
	pub(super) fn set_number(&self, n: Num) {
		if self.has(WEAK | WATCHED) { self.set(n.into_value()); return; }
		let mut v = self.value.borrow_mut();
		match (&mut *v, n) {
			(Value::Int(dst), Num::Int(i)) => *dst = i,
			(Value::UInt(dst), Num::UInt(u)) if u > i64::MAX as u64 => *dst = u,
			(Value::Num(dst), Num::Float(f)) => *dst = f,
			(dst, n) => *dst = n.into_value(),
		}
	}

	/// Replace a raw value and return the previous value (with weak reference upgraded).
	#[inline]
	pub fn replace(&self, value: Value) -> Value {
		self.changed();
		let old = self.value.replace(value);
		match self.take_weak() {
			Some(weak) => weak.upgrade().map_or(Value::Undef, Value::Ref),
			None => old,
		}
	}

	/// Turn this reference into a weak reference; undef is unaffected.
	pub fn weaken(&self) -> Result<(), &'static str> {
		if self.has(WEAK) { return Ok(()); }
		let mut value = self.value.borrow_mut();
		match &*value {
			Value::Undef => Ok(()),
			Value::Ref(reference) => {
				self.changed();
				self.weak.replace(Some(WeakRef::new(reference)));
				self.flags.set(self.flags.get() | WEAK);
				*value = Value::Undef;
				Ok(())
			}
			_ => Err("Can't weaken a nonreference"),
		}
	}

	/// Turn a live weak reference back into a strong one.
	pub fn unweaken(&self) -> Result<(), &'static str> {
		if let Some(weak) = self.take_weak() {
			self.changed();
			self.value.replace(weak.upgrade().map_or(Value::Undef, Value::Ref));
			return Ok(());
		}
		match &*self.value.borrow() {
			Value::Undef | Value::Ref(_) => Ok(()),
			_ => Err("Can't unweaken a nonreference"),
		}
	}

	/// Whether the scalar still contains a live weak reference.
	pub fn is_weak(&self) -> bool {
		self.has(WEAK) && self.weak.borrow().as_ref().and_then(WeakRef::upgrade).is_some()
	}

	/// Borrow raw storage without copying; unlike `plain_value`, this does not check magic.
	pub fn try_value(&self) -> Result<CellRef<'_, Value>, std::cell::BorrowError> { self.value.try_borrow() }

	/// Borrow raw storage mutably, promoting any weak value to its normal scalar value.
	#[inline]
	pub fn try_value_mut(&self) -> Result<RefMut<'_, Value>, std::cell::BorrowMutError> {
		let mut raw = self.value.try_borrow_mut()?;
		if self.has(WEAK | WATCHED) {
			self.changed();
			if let Some(weak) = self.take_weak() { *raw = weak.upgrade().map_or(Value::Undef, Value::Ref); }
		}
		Ok(raw)
	}

	pub(super) fn lvalue(&self) -> Option<&super::interp::Lvalue> {
		if self.has(LVALUE) { self.lvalue.as_ref() } else { None }
	}

	/// Marked cells cannot be recycled as fresh scalar storage.
	pub(super) fn registered(&self) -> bool { self.has(REGISTERED | LITERAL_READONLY | MODULE_READONLY) }
	pub(super) fn literal_readonly(&self) -> bool { self.has(LITERAL_READONLY) }
	pub(super) fn module_readonly(&self) -> bool { self.has(MODULE_READONLY) }
	pub(super) fn readonly(&self) -> bool { self.has(MODULE_READONLY | LITERAL_READONLY) }
	pub(super) fn set_module_readonly(&self, on: bool) {
		self.flags.set(if on { self.flags.get() | MODULE_READONLY } else { self.flags.get() & !MODULE_READONLY });
	}
	pub(super) fn mark_literal(&self) { self.flags.set(self.flags.get() | LITERAL_READONLY); }
	/// Mark the cell as present in an interpreter side table.
	pub(super) fn register(&self) { self.flags.set(self.flags.get() | REGISTERED); }

	pub(super) fn is_magical(&self) -> bool { self.has(WEAK | LVALUE | TIED) }
	pub(super) fn tie(&self) -> Option<Value> {
		if self.has(TIED) { self.tie.borrow().clone() } else { None }
	}
	pub(super) fn replace_tie(&self, tie: Option<Value>) -> Option<Value> {
		self.changed();
		if tie.is_some() { self.flags.set(self.flags.get() | TIED); }
		else if self.has(TIED) { self.flags.set(self.flags.get() & !TIED); }
		else { return None; }
		self.tie.replace(tie)
	}
	/// Whether reads go through the interpreter (lvalue proxy or tie); `get` handles weak references itself.
	pub(super) fn has_read_magic(&self) -> bool { self.has(LVALUE | TIED) }

	pub(super) fn is_blessed(&self) -> bool {
		self.metadata.get().is_some_and(|m| m.blessed.borrow().is_some())
	}

	pub(super) fn pos(&self) -> Option<usize> { self.metadata.get().and_then(|m| m.pos.get()) }

	pub(super) fn set_pos(&self, pos: Option<usize>) {
		if let Some(m) = self.metadata.get() { m.pos.set(pos); }
		else if pos.is_some() { self.pos.set(pos); }
	}
}

// Freeing a value graph recursively (Rc → RefCell<Value> → Vec<Sv> → …) uses one native frame per level, so a
// deep linked list (`$x = [$x] for 1..1e6`) would overflow the stack. Every container level holds its values in
// scalar cells, so dropping a cell hands any referent it solely owns to a thread-local queue instead; the
// outermost drop drains the queue, keeping the native depth constant.
thread_local! {
	static RELEASE_QUEUE: RefCell<Vec<Value>> = const { RefCell::new(Vec::new()) };
	static RELEASING: Cell<bool> = const { Cell::new(false) };
}

/// Whether dropping `v` frees a container (and so may recurse into its contents).
fn frees_container(v: &Value) -> bool {
	match v {
		Value::Ref(Ref::Scalar(x)) => Rc::strong_count(x) == 1,
		Value::Ref(Ref::Array(x)) => Rc::strong_count(x) == 1,
		Value::Ref(Ref::Hash(x)) => Rc::strong_count(x) == 1,
		Value::Ref(Ref::Code(x)) => Rc::strong_count(x) == 1,
		Value::Ref(Ref::Glob(x)) | Value::Glob(x) => Rc::strong_count(x) == 1,
		_ => false,
	}
}

/// Drop a value without native recursion proportional to the depth of the graph it owns (see `RELEASE_QUEUE`).
pub(in crate::perl) fn release(v: Value) {
	if frees_container(&v) { release_container(v); }
}

fn release_container(v: Value) {
	// During thread teardown the queue may already be gone: fall back to an ordinary drop.
	let Ok(draining) = RELEASING.try_with(Cell::get) else { return };
	if RELEASE_QUEUE.try_with(|queue| queue.borrow_mut().push(v)).is_err() || draining { return; }
	struct Reset;
	impl Drop for Reset { fn drop(&mut self) { let _ = RELEASING.try_with(|flag| flag.set(false)); } }
	RELEASING.with(|flag| flag.set(true));
	let _reset = Reset;
	while let Some(next) = RELEASE_QUEUE.with(|queue| queue.borrow_mut().pop()) { drop(next); }
}

// Reference cycles (`$x->{self} = $x`, `$f = sub { $f->() }`) keep their containers alive after the
// interpreter is gone, and the shell lives on. Every cell that has held a reference, and every Perl sub, is
// listed (weakly) in a tracker for the running interpreter; when it is dropped, `end_cycle_tracking` clears
// those still alive, which breaks every cycle (each one passes through such a cell or a sub's captures).
struct CycleTracker {
	id: u64,
	cells: Vec<Weak<ScalarBody>>,
	code: Vec<Weak<CodeBody>>,
	/// Compact (drop dead entries) when a list reaches this length.
	limit: usize,
}

thread_local! {
	static CYCLE_TRACKERS: RefCell<Vec<CycleTracker>> = const { RefCell::new(Vec::new()) };
	static NEXT_TRACKER: Cell<u64> = const { Cell::new(0) };
}

const TRACKER_MIN_LIMIT: usize = 4096;

fn holds_reference(v: &Value) -> bool { matches!(v, Value::Ref(_) | Value::Glob(_)) }

impl CycleTracker {
	fn compact(&mut self) {
		self.cells.retain(|w| w.strong_count() != 0);
		self.code.retain(|w| w.strong_count() != 0);
		self.limit = (2 * self.cells.len().max(self.code.len())).max(TRACKER_MIN_LIMIT);
	}
}

/// Start listing cycle candidates for a new interpreter on this thread; returns its tracker id.
pub(in crate::perl) fn begin_cycle_tracking() -> u64 {
	let id = NEXT_TRACKER.with(|n| { let id = n.get(); n.set(id + 1); id });
	CYCLE_TRACKERS.with(|t| t.borrow_mut().push(CycleTracker { id, cells: Vec::new(), code: Vec::new(), limit: TRACKER_MIN_LIMIT }));
	id
}

/// Break the reference cycles among the values tracked since `begin_cycle_tracking(id)`, freeing them.
pub(in crate::perl) fn end_cycle_tracking(id: u64) {
	let Ok(Some(tracker)) = CYCLE_TRACKERS.try_with(|t| {
		let mut trackers = t.borrow_mut();
		let at = trackers.iter().rposition(|tracker| tracker.id == id)?;
		Some(trackers.remove(at))
	}) else { return };
	for code in tracker.code.iter().filter_map(Weak::upgrade) {
		let body = code.body.replace(super::code::CodeImpl::Undefined);
		drop(code);
		drop(body);
	}
	for cell in tracker.cells.iter().filter_map(Weak::upgrade) {
		let value = std::mem::replace(&mut *cell.value.borrow_mut(), Value::Undef);
		let tie = if cell.has(TIED) {
			cell.flags.set(cell.flags.get() & !TIED);
			cell.tie.take()
		} else { None };
		drop(cell);
		release(value);
		if let Some(tie) = tie { release(tie); }
	}
}

/// List a Perl sub as a cycle candidate (its captures can refer back to it).
pub(in crate::perl) fn track_code(cv: &Cv) {
	let _ = CYCLE_TRACKERS.try_with(|t| {
		if let Some(tracker) = t.borrow_mut().last_mut() {
			if tracker.code.len() >= tracker.limit { tracker.compact(); }
			tracker.code.push(Rc::downgrade(cv));
		}
	});
}

/// List a cell that now holds `value` as a cycle candidate (once per cell; only references can form cycles).
/// Cells created by `new_sv` and written by the interpreter's assignments are listed automatically.
#[inline]
pub(in crate::perl) fn track_cell(sv: &Sv, value: &Value) {
	if !holds_reference(value) || sv.has(TRACKED) { return; }
	sv.flags.set(sv.flags.get() | TRACKED);
	track_reference(sv);
}

fn track_reference(sv: &Sv) {
	let _ = CYCLE_TRACKERS.try_with(|t| {
		if let Some(tracker) = t.borrow_mut().last_mut() {
			if tracker.cells.len() >= tracker.limit { tracker.compact(); }
			tracker.cells.push(Rc::downgrade(sv));
		}
	});
}

impl Drop for ScalarBody {
	fn drop(&mut self) {
		// Release in storage order: value and tie can share the same last two
		// references to a container, so the second release must see the first.
		if self.has(TIED) {
			release(std::mem::replace(self.value.get_mut(), Value::Undef));
			if let Some(tie) = self.tie.take() { release(tie); }
		} else {
			let value = self.value.get_mut();
			if frees_container(value) {
				release_container(std::mem::replace(value, Value::Undef));
			}
		}
	}
}

/// Shared identity of an array.
pub(in crate::perl) type Av = Rc<ArrayBody>;

/// Mutable storage and metadata shared by all aliases to an array.
pub(in crate::perl) struct ArrayBody {
	/// Element cells, addressed independently from their current values.
	elems: RefCell<Vec<Sv>>,
	tie: RefCell<Option<Value>>,
	/// Class of a blessed array reference.
	pub blessed: RefCell<Option<Rc<str>>>,
}

impl ArrayBody {
	/// Borrow the underlying array slots (no tied callbacks).
	pub fn elems(&self) -> CellRef<'_, Vec<Sv>> { self.elems.borrow() }
	/// Borrow the underlying array slots mutably (no tied callbacks).
	pub fn elems_mut(&self) -> RefMut<'_, Vec<Sv>> { self.elems.borrow_mut() }
	/// Replace the underlying array slots without invoking callbacks.
	pub fn replace_elems(&self, items: Vec<Sv>) -> Vec<Sv> { self.elems.replace(items) }

	pub(super) fn tie(&self) -> Option<Value> { self.tie.borrow().clone() }
	pub(super) fn replace_tie(&self, tie: Option<Value>) -> Option<Value> { self.tie.replace(tie) }
}

/// Insertion-ordered storage for Perl hash entries.
pub(in crate::perl) type HashEntries = IndexMap<HKey, Sv, FxBuildHasher>;

/// Shared identity of a hash.
pub(in crate::perl) type Hv = Rc<HashBody>;

/// Mutable storage and metadata shared by all aliases to a hash.
pub(in crate::perl) struct HashBody {
	/// Mapping from canonical keys to element cells.
	map: RefCell<HashEntries>,
	/// A run of consecutive unsigned decimal keys stored at consecutive IndexMap indices.
	/// Invalidated before handing arbitrary mutable access to anyone.
	unsigned_run: Cell<(u64, u32, u32)>,
	tie: RefCell<Option<Value>>,
	/// Next index in the `each` iterator.
	pub iter: Cell<usize>,
	/// Class of a blessed hash reference.
	pub blessed: RefCell<Option<Rc<str>>>,
}

impl HashBody {
	/// Borrow the underlying hash entries (no tied callbacks).
	pub fn entries(&self) -> CellRef<'_, HashEntries> { self.map.borrow() }
	/// Borrow the underlying hash entries mutably (no tied callbacks).
	pub fn entries_mut(&self) -> RefMut<'_, HashEntries> {
		self.unsigned_run.set((0, 0, 0));
		self.map.borrow_mut()
	}
	/// Replace the underlying hash entries without invoking callbacks.
	pub fn replace_entries(&self, entries: HashEntries) -> HashEntries {
		self.unsigned_run.set((0, 0, 0));
		self.map.replace(entries)
	}

	/// Access an unsigned IV/UV key in a plain, unrestricted hash. Keep the real
	/// keys/IndexMap order for keys(), delete(), each(), and string-key lookups.
	#[inline]
	pub(super) fn unsigned_cell(&self, n: u64, create: bool) -> Option<Sv> {
		let (first, start, len) = self.unsigned_run.get();
		let offset = n.wrapping_sub(first);
		if offset < u64::from(len) {
			return self.map.borrow().get_index(start as usize + offset as usize).map(|(_, sv)| sv.clone());
		}
		self.unsigned_cell_miss(n, create)
	}

	fn unsigned_cell_miss(&self, n: u64, create: bool) -> Option<Sv> {
		let mut buf = [0; 20];
		let bytes = decimal_key(n, false, &mut buf);
		let mut entries = self.map.borrow_mut();
		let (i, sv) = if let Some((i, _, sv)) = entries.get_full(&HKeyRef(bytes)) {
			(i, sv.clone())
		} else if create {
			let sv = new_sv(Value::Undef);
			let (i, _) = entries.insert_full(HKey(PStr::from_bytes(bytes)), sv.clone());
			(i, sv)
		} else { return None; };
		let (first, start, len) = self.unsigned_run.get();
		if let Ok(i) = u32::try_from(i) {
			if len != 0 && len < u32::MAX && n.checked_sub(first) == Some(u64::from(len)) && i.checked_sub(start) == Some(len) {
				self.unsigned_run.set((first, start, len + 1));
			} else if len != 0 && len < u32::MAX && first.checked_sub(n) == Some(1) && start.checked_sub(i) == Some(1) {
				self.unsigned_run.set((n, i, len + 1));
			} else if len <= 1 {
				self.unsigned_run.set((n, i, 1));
			}
		}
		Some(sv)
	}

	pub(super) fn tie(&self) -> Option<Value> { self.tie.borrow().clone() }
	pub(super) fn replace_tie(&self, tie: Option<Value>) -> Option<Value> { self.tie.replace(tie) }
}

/// Shared identity of a typeglob.
pub(in crate::perl) type Gv = Rc<GlobBody>;

/// A glob is visible in its package even when none of its slots have been used.
pub(in crate::perl) struct GlobSlot<T> {
	cell: OnceCell<RefCell<T>>,
	init: Cell<Option<Box<dyn FnOnce() -> T>>>,
}

impl<T> GlobSlot<T> {
	fn new(init: impl FnOnce() -> T + 'static) -> Self {
		Self { cell: OnceCell::new(), init: Cell::new(Some(Box::new(init))) }
	}

	pub(super) fn initialized(&self) -> bool { self.cell.get().is_some() }

	/// Supply an initial value before this slot has been exposed to Perl.
	pub(super) fn defer(&self, init: impl FnOnce() -> T + 'static) {
		debug_assert!(!self.initialized());
		self.init.set(Some(Box::new(init)));
	}
}

impl<T> std::ops::Deref for GlobSlot<T> {
	type Target = RefCell<T>;
	#[inline]
	fn deref(&self) -> &Self::Target {
		self.cell.get_or_init(|| RefCell::new(self.init.take().expect("uninitialized glob slot")()))
	}
}

/// Slots for each sigil associated with one package symbol.
pub(in crate::perl) struct GlobBody {
	/// Package containing the symbol.
	pub pkg: Rc<str>,
	/// Unqualified symbol name.
	pub name: Rc<str>,
	/// Scalar slot, initially undefined.
	pub scalar: GlobSlot<Sv>,
	/// Array slot, initially empty.
	pub array: GlobSlot<Av>,
	/// Hash slot, initially empty.
	pub hash: GlobSlot<Hv>,
	/// Code slot, if declared.
	pub code: GlobSlot<Option<Cv>>,
	/// I/O slot, if initialized.
	pub io: RefCell<Option<super::io::Io>>,
	/// Class of a blessed glob reference.
	pub blessed: RefCell<Option<Rc<str>>>,
}

// Glob values can be debug-printed without requiring Debug on code or I/O slots.
impl fmt::Debug for GlobBody {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "*{}::{}", self.pkg, self.name) }
}

/// Shared identity of a regexp reference.
pub(in crate::perl) type Rx = Rc<RegexpBody>;

/// A compiled regexp and the class associated with its referent.
pub(in crate::perl) struct RegexpBody {
	/// Compiled regular expression.
	pub regex: Rc<super::regex::Regex>,
	/// Class of this reference, initially `Regexp`.
	pub blessed: RefCell<Option<Rc<str>>>,
}

/// Hash key stored in the shortest canonical representation.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(in crate::perl) struct HKey(PStr);

impl HKey {
	/// Construct an owned key from a borrowed string.
	pub fn new(s: &PStr) -> Self { Self::from_pstr(s.clone()) }

	/// Downgrade the owned key in its original buffer. A wide or malformed
	/// string containing a wide character must retain its original bytes.
	pub fn from_pstr(mut s: PStr) -> Self {
		if s.utf8 {
			if s.bytes.is_ascii() {
				s.utf8 = false;
			} else if s.chars().all(|cp| cp <= 0xff) {
				let (mut src, mut dst) = (0, 0);
				while src < s.bytes.len() {
					let (cp, width) = decode_utf8(&s.bytes[src..]);
					s.bytes[dst] = cp.unwrap_or(0) as u8;
					src += width;
					dst += 1;
				}
				s.bytes.truncate(dst);
				s.utf8 = false;
			}
		}
		Self(s)
	}

	/// Borrow the canonical key string without cloning its bytes.
	pub fn as_pstr(&self) -> &PStr { &self.0 }

	/// Copy the canonical representation as a string scalar.
	pub fn to_pstr(&self) -> PStr { self.0.clone() }
}

// PStr equality and hashing use characters; the borrowed form need not
// have been downgraded for an IndexMap lookup to find the canonical key.
impl std::borrow::Borrow<PStr> for HKey {
	fn borrow(&self) -> &PStr { self.as_pstr() }
}

/// Format an IV/UV exactly as Perl's decimal scalar string, without allocating a temporary key.
pub(super) fn decimal_key(mut n: u64, negative: bool, buf: &mut [u8; 20]) -> &[u8] {
	let mut i = buf.len();
	loop {
		i -= 1;
		buf[i] = b'0' + (n % 10) as u8;
		n /= 10;
		if n == 0 { break; }
	}
	if negative { i -= 1; buf[i] = b'-'; }
	&buf[i..]
}

/// A byte-slice probe for a hash lookup without allocating a PStr.
pub(in crate::perl) struct HKeyRef<'a>(&'a [u8]);

impl<'a> HKeyRef<'a> {
	/// Return a probe if these bytes already represent the Latin-1 key.
	pub fn new(bytes: &'a [u8], utf8: bool) -> Option<Self> {
		(!utf8 || bytes.is_ascii()).then_some(Self(bytes))
	}
}

impl Hash for HKeyRef<'_> {
	fn hash<H: Hasher>(&self, state: &mut H) { hash_latin1(self.0, state); }
}

impl indexmap::Equivalent<HKey> for HKeyRef<'_> {
	fn equivalent(&self, key: &HKey) -> bool { !key.0.utf8 && self.0 == key.0.bytes.as_slice() }
}

/// Allocate an independent scalar cell with no blessing or match position.
#[inline]
pub(in crate::perl) fn new_sv(v: Value) -> Sv {
	let track = holds_reference(&v);
	let sv = Rc::new(ScalarBody::new(v, if track { TRACKED } else { 0 }));
	if track { track_reference(&sv); }
	sv
}

/// Create a proxy cell whose reads and writes are defined by the interpreter.
pub(super) fn new_lvalue(lvalue: super::interp::Lvalue) -> Sv {
	let mut cell = ScalarBody::new(Value::Undef, LVALUE);
	cell.metadata = OnceCell::from(Box::new(ScalarMetadata { lvalue: Some(lvalue), ..Default::default() }));
	Rc::new(cell)
}

/// Allocate an array, giving each element an independent scalar cell.
pub(in crate::perl) fn new_av(items: Vec<Value>) -> Av {
	Rc::new(ArrayBody { elems: RefCell::new(items.into_iter().map(new_sv).collect()), tie: RefCell::new(None), blessed: RefCell::new(None) })
}

/// Allocate an empty hash.
pub(in crate::perl) fn new_hv() -> Hv {
	Rc::new(HashBody { map: RefCell::new(IndexMap::default()), unsigned_run: Cell::new((0, 0, 0)), tie: RefCell::new(None), iter: Cell::new(0), blessed: RefCell::new(None) })
}

/// Allocate a typeglob with fresh scalar, array and hash slots.
pub(in crate::perl) fn new_gv(pkg: Rc<str>, name: Rc<str>) -> Gv {
	Rc::new(GlobBody {
		pkg, name,
		scalar: GlobSlot::new(|| new_sv(Value::Undef)), array: GlobSlot::new(|| new_av(Vec::new())), hash: GlobSlot::new(new_hv),
		code: GlobSlot::new(|| None), io: RefCell::new(None), blessed: RefCell::new(None),
	})
}

/// Allocate a compiled regexp referent blessed into `Regexp`, as for `qr//`.
pub(in crate::perl) fn new_rx(regex: Rc<super::regex::Regex>) -> Rx {
	Rc::new(RegexpBody { regex, blessed: RefCell::new(Some(Rc::from("Regexp"))) })
}

/// Scalar conversion hooks for context-dependent overloads and warnings.
pub(in crate::perl) trait Stringify {
	/// Convert to a string, potentially invoking an overload.
	fn stringify(&mut self, v: &Value) -> PStr;
	/// Convert to a number, potentially invoking an overload.
	fn numify(&mut self, v: &Value) -> Num;
	/// Receive a warning before the caller adds file and line information.
	fn warn(&mut self, msg: String);
	/// Whether this conversion runs under `use bytes`.
	fn bytes(&self) -> bool { false }
	/// Return the component sequence for a special object used in a vector conversion.
	fn vector(&mut self, _v: &Value) -> Option<PStr> { None }
	/// Load the current value of a live formatter argument, if available.
	fn arg(&mut self, _index: usize) -> Option<Value> { None }
	/// Store a `printf` or `sprintf` `%n` count in the indicated argument.
	fn store_count(&mut self, _index: usize, _count: usize) {}
}

/// Plain conversions, without overload dispatch or warnings.
pub(in crate::perl) struct Plain;
impl Stringify for Plain {
	fn stringify(&mut self, v: &Value) -> PStr { v.to_pstr() }
	fn numify(&mut self, v: &Value) -> Num { v.to_num() }
	fn warn(&mut self, _: String) {}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn tracker_breaks_reference_cycles() {
		let id = begin_cycle_tracking();
		// $x = {}; $x->{self} = $x
		let h = new_hv();
		h.entries_mut().insert(HKey::new(&PStr::from_str("self")), new_sv(Value::Ref(Ref::Hash(h.clone()))));
		let hash = Rc::downgrade(&h);
		drop(h);
		// $a = \$b; $b = \$a
		let (a, b) = (new_sv(Value::Undef), new_sv(Value::Undef));
		a.set(Value::Ref(Ref::Scalar(b.clone())));
		track_cell(&a, &a.get());
		b.set(Value::Ref(Ref::Scalar(a.clone())));
		track_cell(&b, &b.get());
		let scalar = Rc::downgrade(&a);
		drop((a, b));
		assert!(hash.upgrade().is_some() && scalar.upgrade().is_some());
		end_cycle_tracking(id);
		assert!(hash.upgrade().is_none());
		assert!(scalar.upgrade().is_none());
	}

	#[test]
	fn frees_deep_value_graphs_iteratively() {
		let freed = std::thread::Builder::new().stack_size(512 * 1024).spawn(|| {
			const DEPTH: usize = 1_000_000;
			// $x = [$x]
			let mut v = Value::Int(0);
			for _ in 0..DEPTH { v = Value::Ref(Ref::Array(new_av(vec![v]))); }
			drop(v);
			// $p->{x} = {}; $p = $p->{x}
			let root = new_hv();
			let mut p = root.clone();
			for _ in 0..DEPTH {
				let next = new_hv();
				p.entries_mut().insert(HKey::new(&PStr::from_str("x")), new_sv(Value::Ref(Ref::Hash(next.clone()))));
				p = next;
			}
			drop(p);
			drop(root);
			// $x = \$x (scalar-reference chain)
			let mut s = new_sv(Value::Undef);
			for _ in 0..DEPTH { s = new_sv(Value::Ref(Ref::Scalar(s))); }
			drop(s);
			true
		}).expect("spawn").join();
		assert!(matches!(freed, Ok(true)));
	}

	#[test]
	fn perl_utf8_offsets_and_hash_keys() {
		let mut s = PStr::from_bytes(b"a\xe9\xffz");
		let latin1 = s.clone();
		s.upgrade();
		assert_eq!(s.bytes, b"a\xc3\xa9\xc3\xbfz");
		assert_eq!(s, latin1);
		assert_eq!(HKey::new(&s), HKey::new(&latin1));
		assert!(!HKey::new(&s).to_pstr().utf8);
		assert_eq!(s.char_to_byte(2), 3);
		assert_eq!(s.byte_to_char(2), 1);
		assert_eq!(s.byte_to_char(3), 2);
		assert_eq!(s.char_to_byte(99), 6);
		let cps = [0xd800, 0x11_0000, 0x20_0000, 0x400_0000, 0x8000_0000, u32::MAX];
		assert_eq!(PStr::from_codepoints(cps).chars().collect::<Vec<_>>(), cps);
		assert_eq!(PStr::new(vec![0xc0, 0xaf, 0xe2, 0x82, b'x', 0x80], true).chars().collect::<Vec<_>>(), [0, 0, u32::from(b'x'), 0]);
	}

	#[test]
	fn converts_numeric_prefixes_and_whole_numbers_separately() {
		assert!(matches!(parse_number(b" +12 xyz"), (Num::Float(12.0), 4)));
		assert!(matches!(parse_number(b"0xdead"), (Num::Float(0.0), 1)));
		assert!(matches!(parse_number(b"\x0b-9223372036854775808\r"), (Num::Int(i64::MIN), 21)));
		assert!(matches!(parse_number(b"18446744073709551615"), (Num::UInt(u64::MAX), 20)));
		assert!(matches!(parse_number(b"18446744073709551616"), (Num::Float(U64_LIMIT), 20)));
		assert!(matches!(parse_number(b"0 but true"), (Num::Int(0), 10)));
		assert!(matches!(parse_number(b"+inFiniTy x"), (Num::Float(f64::INFINITY), 9)));
		assert!(parse_number(b"-qNaNs(0x12_34)").0.to_f64().is_nan());
		assert!(Value::str("-qNaNs(0x12_34)").looks_like_number());
		assert!(Value::str("1.#INF00").looks_like_number());
		assert!(!Value::str("NaN(payload)").looks_like_number());
		assert!(!Value::str("0 but true\n").looks_like_number());
		assert!(!Value::str("12x").looks_like_number());
		assert!(Value::str("\t -1.5e-3\r ").looks_like_number());
		assert!(matches!(parse_number(b"xyz"), (Num::Float(0.0), 0)));
		assert!(matches!(parse_number(b"1e-999"), (Num::Int(0), 6)));
		assert!(parse_number(b"-0.0").0.to_f64().is_sign_negative());
		assert_eq!(Value::str("9007199254740993.9").to_i64(), 9_007_199_254_740_993);
		assert_eq!(Value::str("18446744073709551614.1").to_u64(), u64::MAX - 1);
		assert_eq!(Value::Num(f64::INFINITY).to_i64(), i64::MAX);
		assert_eq!(Value::Num(f64::NEG_INFINITY).to_u64(), i64::MIN as u64);
	}

	#[test]
	fn formats_perl_nv() {
		for (n, expected) in [
			(0.0, "0"), (-0.0, "0"), (f64::INFINITY, "Inf"), (f64::NEG_INFINITY, "-Inf"),
			(f64::NAN, "NaN"), (0.1, "0.1"), (0.00009999999999999996, "0.0001"),
			(1e-5, "1e-05"), (9.999999999999996e14, "1e+15"), (42.0, "42"),
			(1e20, "1e+20"), (f64::from_bits(1), "4.94065645841247e-324"),
			(f64::MAX, "1.79769313486232e+308"), (1.234567891234565, "1.23456789123457"),
		] {
			assert_eq!(format_float(n), PStr::from_str(expected));
		}
	}

	#[test]
	fn dualvar_truth_and_blessed_referent_identity() {
		let d = Value::Dual(Rc::new(Dual { num: Num::Int(123), str: PStr::from_str("0") }));
		assert!(!d.truthy());
		assert_eq!(d.to_i64(), 123);
		assert!(d.looks_like_number());
		assert!(!Value::Dual(Rc::new(Dual { num: Num::Int(1), str: PStr::from_str("foo") })).looks_like_number());
		assert!(Value::str("0.0").truthy());
		assert!(Value::str("0 but true").truthy());
		assert!(!Value::bytes(b"0").truthy());
		let h = Ref::Hash(new_hv());
		let v = Value::Ref(h.clone());
		assert_eq!(v.to_pstr().to_string_lossy(), format!("HASH(0x{:x})", h.addr()));
		h.bless(Rc::from("Pkg"));
		assert_eq!(v.to_pstr().to_string_lossy(), format!("Pkg=HASH(0x{:x})", h.addr()));
		assert_eq!(v.to_u64(), h.addr() as u64);
		assert_eq!(Ref::Scalar(new_sv(v)).kind_name(), "REF");
	}
}
