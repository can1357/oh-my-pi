//! Perl's binary templates (`perlfunc` pack/unpack, `perlpacktut`, `perldiag`).
//!
//! `p` and `P` never expose real memory: pack records a copy of the string under
//! a synthetic address in [`Pointers`], and unpack resolves only addresses found
//! there (anything else unpacks as undef).

use std::{
	fmt::Write as _,
	sync::atomic::{AtomicBool, Ordering},
};

use super::{
	limits::check_len,
	sprintf::escaped,
	value::{Num, PStr, Stringify, Value, format_float},
};

/// Strings handed out by pack `p`/`P`, keyed by synthetic addresses that unpack `p`/`P` resolve.
#[derive(Default)]
pub(in crate::perl) struct Pointers {
	strings: std::collections::VecDeque<(u64, Vec<u8>)>,
	next: u64,
}

impl Pointers {
	/// First synthetic address; nonzero and word aligned.
	const BASE: u64 = 0x7f00_0000_1000;
	/// Oldest strings are forgotten past this many (perl gives no lifetime guarantee either).
	const LIMIT: usize = 4096;

	/// Equal strings share an address, as repeated packs of one scalar's buffer do in perl.
	fn address(&mut self, bytes: Vec<u8>) -> u64 {
		if let Some((address, _)) = self.strings.iter().rev().take(64).find(|(_, known)| *known == bytes) { return *address; }
		if self.next == 0 { self.next = Self::BASE; }
		let address = self.next;
		self.next = self.next.wrapping_add((bytes.len() as u64 + 16) & !7);
		self.strings.push_back((address, bytes));
		if self.strings.len() > Self::LIMIT { self.strings.pop_front(); }
		address
	}

	/// The recorded bytes from `address` on (an interior address yields the tail).
	fn resolve(&self, address: u64) -> Option<&[u8]> {
		self.strings.iter().rev().find_map(|(start, bytes)| {
			let offset = address.checked_sub(*start)?;
			(offset <= bytes.len() as u64).then(|| &bytes[offset as usize..])
		})
	}
}

const OVERFLOW: &str = "pack/unpack repeat count overflow";
/// Error text for a host cancellation observed mid-template; the caller turns it into `Flow::Cancelled`.
pub(super) const CANCELLED: &str = "pack/unpack cancelled";
/// Repetitions between cancellation polls.
const POLL_INTERVAL: usize = 4096;

/// Applies the shared buffer limit to a result list of `count` values.
fn check_values(count: usize) -> Result<(), String> {
	check_len(count.saturating_mul(std::mem::size_of::<Value>()), "list")
}
const MODIFIERS: &[u8] = b"sSiIlLqQjJfFdDpP(";
const BANG: &[u8] = b"sSiIlLxXnNvV@.";
const CODES: &[u8] = b"aAZbBhHcCWUsSlLqQjJfFdDiInNvVwpxX@.Pu%";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Operation {
	Pack,
	Unpack,
	/// Only names the operator in malformed-UTF-8 diagnostics for sprintf's vector flag.
	Sprintf,
}

impl Operation {
	fn name(self) -> &'static str {
		match self { Self::Pack => "pack", Self::Unpack => "unpack", Self::Sprintf => "sprintf" }
	}
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Order {
	Native,
	Little,
	Big,
}

impl Order {
	fn little(self) -> bool {
		match self { Self::Native => cfg!(target_endian = "little"), Self::Little => true, Self::Big => false }
	}

	fn symbol(self) -> char {
		match self { Self::Big => '>', _ => '<' }
	}
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Count {
	Default,
	Exact(usize),
	Star,
}

impl Count {
	fn or(self, default: usize, star: usize) -> usize {
		match self { Self::Default => default, Self::Exact(n) => n, Self::Star => star }
	}
}

struct Field {
	code: u8,
	count: Count,
	order: Order,
	bang: bool,
	slash: bool,
	group: Vec<Field>,
	lazy_group: Option<(usize, usize)>,
}

impl Field {
	fn order(&self, inherited: Order, op: Operation) -> Result<Order, String> {
		if self.order == Order::Native {
			Ok(inherited)
		} else if inherited == Order::Native || inherited == self.order {
			Ok(self.order)
		} else {
			Err(format!("Can't use '{}' in a group with different byte-order in {}", self.order.symbol(), op.name()))
		}
	}
}

struct Template<'a, 'cx> {
	bytes: &'a [u8],
	i: usize,
	op: Operation,
	cx: &'cx mut dyn Stringify,
	comma_warned: bool,
}

impl Template<'_, '_> {
	fn peek(&self) -> Option<u8> { self.bytes.get(self.i).copied() }

	fn warn(&mut self, message: String) {
		self.cx.warn(message);
	}

	fn skip(&mut self) {
		while let Some(b) = self.peek() {
			if b == b'#' {
				self.i += self.bytes[self.i..].iter().position(|&b| b == b'\n').unwrap_or(self.bytes.len() - self.i);
			} else if b == b',' {
				if !self.comma_warned {
					self.comma_warned = true;
					self.warn(format!("Invalid type ',' in {}", self.op.name()));
				}
				self.i += 1;
			} else if space(u32::from(b)) {
				self.i += 1;
			} else {
				break;
			}
		}
	}

	fn number(&mut self) -> Result<usize, String> {
		let mut n = 0usize;
		while let Some(b @ b'0'..=b'9') = self.peek() {
			n = n.checked_mul(10).and_then(|n| n.checked_add(usize::from(b - b'0'))).filter(|&n| n <= i64::MAX as usize)
				.ok_or_else(|| OVERFLOW.to_owned())?;
			self.i += 1;
		}
		Ok(n)
	}

	fn count(&mut self, depth: usize) -> Result<Count, String> {
		Ok(match self.peek() {
			Some(b'0'..=b'9') => Count::Exact(self.number()?),
			Some(b'*') => { self.i += 1; Count::Star },
			Some(b'[') => {
				self.i += 1;
				let size = if matches!(self.peek(), Some(b'0'..=b'9')) {
					let n = self.number()?;
					if self.peek() != Some(b']') {
						return Err(if self.bytes[self.i..].contains(&b']') {
							format!("Malformed integer in [] in {}", self.op.name())
						} else {
							"No group ending character ']' found in template".into()
						});
					}
					self.i += 1;
					n
				} else {
					let list = self.sequence(Some(b']'), depth + 1, true)?;
					bracket_length(&list, self.op)?
				};
				Count::Exact(size)
			},
			_ => Count::Default,
		})
	}

	fn sequence(&mut self, close: Option<u8>, depth: usize, in_bracket: bool) -> Result<Vec<Field>, String> {
		if depth > 100 { return Err("Too deeply nested ()-groups".into()); }
		let mut fields = Vec::new();
		while let Some(f) = self.next(close, depth, in_bracket, fields.is_empty(), false)? {
			fields.push(f);
		}
		Ok(fields)
	}

	fn next(&mut self, close: Option<u8>, depth: usize, in_bracket: bool, first: bool, lazy: bool) -> Result<Option<Field>, String> {
		self.skip();
		let Some(code) = self.peek() else {
			return if let Some(end) = close {
				Err(format!("No group ending character '{}' found in template", end as char))
			} else { Ok(None) };
		};
		self.i += 1;
		if Some(code) == close { return Ok(None); }
		if in_bracket && b"u@./".contains(&code) { return Err(within_brackets(code, self.op)); }
		if code == b'%' && self.op == Operation::Pack && !in_bracket { return Err("'%' may not be used in pack".into()); }
		if code == b'/' && self.op == Operation::Unpack && first {
			return Err("'/' must follow a numeric type in unpack".into());
		}
		let mut lazy_group = None;
		let group = if code == b'(' {
			if matches!(self.peek(), Some(b'0'..=b'9' | b'*' | b'[')) {
				return Err(format!("()-group starts with a count in {}", self.op.name()));
			}
			if lazy {
				let start = self.i;
				let end = self.group_end(depth)?;
				lazy_group = Some((start, end));
				Vec::new()
			} else {
				self.sequence(Some(b')'), depth + 1, in_bracket)?
			}
		} else if CODES.contains(&code) || code == b'/' && self.op == Operation::Unpack {
			Vec::new()
		} else {
			let type_ = if code == 0 { String::new() } else { (code as char).to_string() };
			return Err(format!("Invalid type '{type_}' in {}", self.op.name()));
		};
		let mut bang = false;
		let mut order = Order::Native;
		while let Some(m @ (b'!' | b'<' | b'>')) = self.peek() {
			self.i += 1;
			let allowed = if m == b'!' { BANG } else { MODIFIERS };
			if !allowed.contains(&code) {
				return Err(format!("'{}' allowed only after types {} in {}", m as char, String::from_utf8_lossy(allowed), self.op.name()));
			}
			let duplicate = if m == b'!' {
				std::mem::replace(&mut bang, true)
			} else {
				let new = if m == b'<' { Order::Little } else { Order::Big };
				let old = std::mem::replace(&mut order, new);
				if old != Order::Native && old != order {
					return Err(format!("Can't use both '<' and '>' after type '{}' in {}", code as char, self.op.name()));
				}
				old == new
			};
			if duplicate { self.warn(format!("Duplicate modifier '{}' after '{}' in {}", m as char, code as char, self.op.name())); }
		}
		let count = self.count(depth)?;
		if in_bracket && count == Count::Star { return Err(within_brackets(b'*', self.op)); }
		self.skip();
		let slash = self.peek() == Some(b'/');
		if slash {
			self.i += 1;
			if matches!(self.peek(), Some(b'*' | b'0'..=b'9')) {
				return Err(format!("'/' does not take a repeat count in {}", self.op.name()));
			}
			self.skip();
			if self.op == Operation::Pack && !in_bracket && (self.peek().is_none() || self.peek() == close) {
				return Err(format!("Code missing after '/' in {}", self.op.name()));
			}
		}
		Ok(Some(Field { code, count, order, bang, slash, group, lazy_group }))
	}

	fn group_end(&mut self, depth: usize) -> Result<usize, String> {
		let mut level = 1;
		while let Some(code) = self.peek() {
			if level + depth > 100 { return Err("Too deeply nested ()-groups".into()); }
			self.i += 1;
			match code {
				b'(' => level += 1,
				b')' => {
					level -= 1;
					if level == 0 { return Ok(self.i - 1); }
				}
				b'#' => {
					let rest = &self.bytes[self.i..];
					self.i += memchr::memchr(b'\n', rest).unwrap_or(rest.len());
				}
				_ => {}
			}
		}
		Err("No group ending character ')' found in template".into())
	}
}

fn within_brackets(code: u8, op: Operation) -> String {
	format!("Within []-length '{}' not allowed in {}", code as char, op.name())
}

fn space(cp: u32) -> bool { matches!(cp, 9..=13 | 32) }

fn unicode_space(cp: u32) -> bool {
	space(cp) || matches!(cp, 0x85 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000)
}

fn numeric_width(code: u8, bang: bool) -> usize {
	match code {
		b's' | b'S' | b'n' | b'v' => 2,
		b'l' | b'L' if bang => std::mem::size_of::<std::ffi::c_long>(),
		b'i' | b'I' | b'l' | b'L' | b'N' | b'V' | b'f' => 4,
		b'j' | b'J' | b'q' | b'Q' | b'd' | b'F' => 8,
		b'D' => LONG_DOUBLE,
		b'p' | b'P' => std::mem::size_of::<usize>(),
		_ => 1,
	}
}

fn bit_stride(code: u8) -> usize { if matches!(code, b'b' | b'B') { 8 } else { 2 } }

fn aligned_offset(position: usize, align: usize, forward: bool) -> usize {
	if align <= 1 { return 0; }
	let extra = position % align;
	if forward && extra != 0 { align - extra } else { extra }
}

// If there are no alignment directives, a group is a simple translation with a
// minimum prefix position. This avoids executing arbitrary repeat counts in [].
#[derive(Clone, Copy)]
struct Layout {
	delta: i128,
	minimum: i128,
}

impl Layout {
	const EMPTY: Self = Self { delta: 0, minimum: 0 };

	fn then(self, next: Self) -> Self {
		Self { delta: self.delta.saturating_add(next.delta), minimum: self.minimum.min(self.delta.saturating_add(next.minimum)) }
	}

	fn repeat(self, count: usize) -> Self {
		if count == 0 { return Self::EMPTY; }
		Self {
			delta: self.delta.saturating_mul(count as i128),
			minimum: self.minimum.saturating_add(self.delta.min(0).saturating_mul((count - 1) as i128)),
		}
	}
}

fn bracket_delta(f: &Field) -> i128 {
	let n = f.count.or(1, 0);
	match f.code {
		b'%' => 0,
		b'b' | b'B' | b'h' | b'H' => n.div_ceil(bit_stride(f.code)) as i128,
		b'X' => -(n as i128),
		b'P' => numeric_width(f.code, f.bang) as i128,
		_ => n as i128 * numeric_width(f.code, f.bang) as i128,
	}
}

fn layout(fields: &[Field]) -> Option<Layout> {
	let mut out = Layout::EMPTY;
	for f in fields {
		let piece = match f.code {
			b'(' => layout(&f.group)?.repeat(f.count.or(1, 0)),
			b'x' | b'X' if f.bang => return None,
			_ => {
				let delta = bracket_delta(f);
				Layout { delta, minimum: delta.min(0) }
			},
		};
		out = out.then(piece);
	}
	Some(out)
}

// Every alignment is periodic in the current offset. Once repetition reaches
// a translation by a multiple of that period, the remaining repetitions can
// be skipped arithmetically. This also handles huge bracket counts with x!.
fn alignment_period(fields: &[Field]) -> Option<usize> {
	fn gcd(mut a: usize, mut b: usize) -> usize {
		while b != 0 { (a, b) = (b, a % b); }
		a
	}
	let mut period = 1;
	for f in fields {
		let n = match f.code {
			b'(' => alignment_period(&f.group)?,
			b'x' | b'X' if f.bang => f.count.or(1, 0).max(1),
			_ => continue,
		};
		period = (period / gcd(period, n)).checked_mul(n)?;
	}
	Some(period)
}

fn bracket_length(fields: &[Field], op: Operation) -> Result<usize, String> {
	fn offset(new: i128, op: Operation) -> Result<usize, String> {
		if new < 0 { return Err(outside(b'X', op)); }
		usize::try_from(new).ok().filter(|&n| n <= i64::MAX as usize).ok_or_else(|| OVERFLOW.to_owned())
	}
	fn measure(fields: &[Field], mut pos: usize, op: Operation) -> Result<usize, String> {
		for f in fields {
			let n = f.count.or(1, 0);
			let delta = match f.code {
				b'(' if n == 0 => 0,
				b'(' => {
					if let Some(fixed) = layout(&f.group) {
						let fixed = fixed.repeat(n);
						if (pos as i128).saturating_add(fixed.minimum) < 0 { return Err(outside(b'X', op)); }
						fixed.delta
					} else {
						let period = alignment_period(&f.group);
						for left in (0..n).rev() {
							let new = measure(&f.group, pos, op)?;
							if new == pos { break; }
							if left > 1 && period.is_some_and(|period| pos % period == new % period) {
								let step = new as i128 - pos as i128;
								let last = offset(new as i128 + step * (left - 1) as i128, op)?;
								pos = measure(&f.group, last, op)?;
								break;
							}
							pos = new;
						}
						continue;
					}
				},
				b'x' if f.bang => aligned_offset(pos, n, true) as i128,
				b'X' if f.bang => -(aligned_offset(pos, n, false) as i128),
				_ => bracket_delta(f),
			};
			pos = offset((pos as i128).saturating_add(delta), op)?;
		}
		Ok(pos)
	}
	measure(fields, 0, op)
}

fn outside(code: u8, op: Operation) -> String {
	format!("'{}' outside of string in {}", code as char, op.name())
}

/// Encodes a Perl code point, including the extension beyond Unicode, into caller-provided storage.
pub(super) fn encode_utf8(cp: u64, bytes: &mut [u8; 13]) -> &[u8] {
	let (n, lead) = match cp {
		0..=0x7f => { bytes[0] = cp as u8; return &bytes[..1]; },
		0x80..=0x7ff => (2, 0xc0),
		0x800..=0xffff => (3, 0xe0),
		0x10000..=0x1fffff => (4, 0xf0),
		0x200000..=0x3ffffff => (5, 0xf8),
		0x4000000..=0x7fffffff => (6, 0xfc),
		0x80000000..=0xfffffffff => (7, 0xfe),
		_ => (13, 0xff),
	};
	let mut value = cp;
	for byte in bytes[1..n].iter_mut().rev() {
		*byte = 0x80 | (value as u8 & 63);
		value >>= 6;
	}
	bytes[0] = lead | value as u8;
	&bytes[..n]
}

fn utf8_width(head: u8) -> usize {
	match head {
		0..=0xbf => 1,
		0xc0..=0xdf => 2,
		0xe0..=0xef => 3,
		0xf0..=0xf7 => 4,
		0xf8..=0xfb => 5,
		0xfc..=0xfd => 6,
		0xfe => 7,
		0xff => 13,
	}
}

const UTF8_MIN: [u64; 14] = [
	0, 0, 0x80, 0x800, 0x10000, 0x200000, 0x4000000, 0x80000000, 0, 0, 0, 0, 0, 0x1000000000,
];

#[derive(Clone, Copy)]
enum Utf8Error {
	Continuation,
	Short(usize),
	Interrupted(usize, usize),
	Overlong(u64),
	OverlongPrefix(usize, usize),
	Overflow,
}

fn decode_utf8(bytes: &[u8]) -> (u64, usize, Option<Utf8Error>) {
	let Some(&head) = bytes.first() else { return (0, 0, None) };
	let (len, mut value) = match head {
		0..=0x7f => return (u64::from(head), 1, None),
		0x80..=0xbf => return (0, 1, Some(Utf8Error::Continuation)),
		0xc0..=0xdf => (2, u64::from(head & 31)),
		0xe0..=0xef => (3, u64::from(head & 15)),
		0xf0..=0xf7 => (4, u64::from(head & 7)),
		0xf8..=0xfb => (5, u64::from(head & 3)),
		0xfc..=0xfd => (6, u64::from(head & 1)),
		0xfe => (7, 0),
		0xff => (13, 0),
	};
	let mut overflow = false;
	for (i, &b) in bytes.iter().enumerate().take(len).skip(1) {
		if b & 0xc0 != 0x80 { return (0, i, Some(Utf8Error::Interrupted(len, i))); }
		overflow |= value > (i64::MAX as u64 >> 6);
		value = (value << 6) | u64::from(b & 63);
	}
	if bytes.len() < len { return (0, bytes.len(), Some(Utf8Error::Short(len))); }
	if overflow { return (0, len, Some(Utf8Error::Overflow)); }
	if value < UTF8_MIN[len] { return (0, len, Some(Utf8Error::Overlong(value))); }
	(value, len, None)
}

fn malformed(bytes: &[u8], error: Utf8Error, op: Operation) -> String {
	let mut text = String::from("Malformed UTF-8 character: ");
	let shown = match error {
		Utf8Error::Continuation => 1,
		Utf8Error::Interrupted(len, end) => len.min(end + 1),
		Utf8Error::Short(len) => len,
		Utf8Error::Overlong(_) | Utf8Error::Overflow => utf8_width(bytes[0]),
		Utf8Error::OverlongPrefix(_, shown) => shown,
	};
	for &byte in bytes.iter().take(shown) { let _ = write!(text, "\\x{byte:02x}"); }
	let start = bytes[0];
	match error {
		Utf8Error::Continuation => { let _ = write!(text, " (unexpected continuation byte 0x{start:02x}, with no preceding start byte)"); },
		Utf8Error::Short(len) => {
			let available = bytes.len();
			let plural = if available == 1 { "" } else { "s" };
			let _ = write!(text, " (too short; {available} byte{plural} available, need {len})");
		},
		Utf8Error::Interrupted(len, end) => {
			let b = bytes[end];
			let where_ = if end == 1 { "immediately after".to_owned() } else { format!("{end} bytes after") };
			let _ = write!(text, " (unexpected non-continuation byte 0x{b:02x}, {where_} start byte 0x{start:02x}; need {len} bytes, got {end})");
		},
		Utf8Error::Overlong(cp) => {
			let _ = write!(text, " (overlong; instead use ");
			let mut encoded = [0; 13];
			for b in encode_utf8(cp, &mut encoded) { let _ = write!(text, "\\x{b:02x}"); }
			let _ = write!(text, " to represent U+{cp:02X})");
		},
		Utf8Error::OverlongPrefix(prefix, _) => {
			text.push_str(" (any UTF-8 sequence that starts with \"");
			for &b in bytes.iter().take(prefix) { let _ = write!(text, "\\x{b:02x}"); }
			text.push_str("\" is overlong which can and should be represented with a different, shorter sequence)");
		}
		Utf8Error::Overflow => text.push_str(" (overflows)"),
	}
	let _ = write!(text, " in {}", op.name());
	text
}

/// One character of a UTF-8 string for sprintf's `%vd`: the code point (0 when
/// malformed), the bytes consumed, and perl's "Malformed UTF-8 character" diagnostic.
pub(super) fn sprintf_char(bytes: &[u8]) -> (u64, usize, Option<String>) {
	let (cp, n, error) = decode_utf8(bytes);
	match error {
		Some(error) => (0, n.max(1), Some(malformed(bytes, error, Operation::Sprintf))),
		None => (cp, n.max(1), None),
	}
}

/// The template's first code letter, past whitespace and comments.
fn first_symbol(template: &[u8]) -> Option<u8> {
	let mut i = 0;
	while let Some(&b) = template.get(i) {
		if b == b'#' {
			i += template[i..].iter().position(|&b| b == b'\n')?;
		} else if !space(u32::from(b)) {
			return Some(b);
		}
		i += 1;
	}
	None
}

fn unpack_unicode(bytes: &[u8], cx: &mut dyn Stringify) -> (u64, usize) {
	let (cp, consumed, error) = decode_utf8(bytes);
	if let Some(error) = error {
		if let Utf8Error::Interrupted(len, _) = error && bytes.len() < len {
			cx.warn(malformed(bytes, Utf8Error::Short(len), Operation::Unpack));
		}
		cx.warn(malformed(bytes, error, Operation::Unpack));
		if matches!(error, Utf8Error::Short(_) | Utf8Error::Interrupted(_, _)) {
			let lead = bytes[0];
			let width = utf8_width(lead);
			let min = u128::from(UTF8_MIN[width]);
			let mut partial = u128::from(if lead >= 0xfe { 0 } else { lead & (0xff >> width.saturating_add(1)) });
			for i in 1..=consumed {
				let tail_bits = (width - i) * 6;
				if ((partial + 1) << tail_bits) <= min {
					let shown = if matches!(error, Utf8Error::Interrupted(..)) { consumed + 1 } else { consumed };
					cx.warn(malformed(bytes, Utf8Error::OverlongPrefix(i, shown), Operation::Unpack));
					break;
				}
				if i < consumed { partial = (partial << 6) | u128::from(bytes[i] & 63); }
			}
		}
	}
	(cp, consumed)
}

fn unit(bytes: &[u8], pos: usize, utf8: bool) -> (u64, usize) {
	if utf8 {
		let (cp, n, _) = decode_utf8(&bytes[pos..]);
		(cp, pos + n)
	} else if let Some(&b) = bytes.get(pos) {
		(u64::from(b), pos + 1)
	} else {
		(0, pos)
	}
}

fn advance(bytes: &[u8], mut pos: usize, count: usize, utf8: bool) -> (usize, usize) {
	if !utf8 {
		let taken = count.min(bytes.len().saturating_sub(pos));
		return (pos + taken, count - taken);
	}
	let mut left = count;
	while left != 0 && pos < bytes.len() {
		pos = unit(bytes, pos, true).1;
		left -= 1;
	}
	(pos, left)
}

fn retreat(bytes: &[u8], mut pos: usize, n: usize, utf8: bool) -> Option<usize> {
	if !utf8 { return pos.checked_sub(n); }
	for _ in 0..n {
		pos = pos.checked_sub(1)?;
		while pos > 0 && bytes.get(pos).is_some_and(|b| b & 0xc0 == 0x80) { pos -= 1; }
	}
	Some(pos)
}

fn distance(bytes: &[u8], from: usize, to: usize, utf8: bool) -> i64 {
	if to < from { return -distance(bytes, to, from, utf8); }
	if !utf8 { return (to - from) as i64; }
	let mut pos = from;
	let mut chars = 0;
	while pos < to {
		let (_, n, error) = decode_utf8(&bytes[pos..to]);
		if matches!(error, Some(Utf8Error::Short(_))) { break; }
		pos += n;
		chars += 1;
	}
	chars
}

fn promote_offsets(bytes: &[u8], pos: &mut usize, bases: &mut [usize]) {
	for offset in std::iter::once(pos).chain(bases) {
		*offset += bytes[..(*offset).min(bytes.len())].iter().filter(|&&b| b >= 128).count();
	}
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
	Characters,
	Raw,
	Utf8Octets,
}

fn base_for(bases: &[usize], count: Count, pos: usize) -> usize {
	match count {
		Count::Star => 0,
		Count::Exact(0) => pos,
		_ => bases.iter().rev().nth(count.or(1, 0) - 1).copied().unwrap_or(0),
	}
}

/// Converts a Perl numeric scalar to the bits used for integer directives.
pub(super) fn int_bits(n: Num) -> u64 {
	match n {
		Num::Int(n) => n as u64,
		Num::UInt(n) => n,
		Num::Float(n) if n < 0.0 => n as i64 as u64,
		Num::Float(n) => n as u64,
	}
}

fn unsigned(n: u64) -> Value { if n > i64::MAX as u64 { Value::UInt(n) } else { Value::Int(n as i64) } }

fn write_word(n: u64, word: &mut [u8], little: bool) {
	let buf = if little { n.to_le_bytes() } else { n.to_be_bytes() };
	if little { word.copy_from_slice(&buf[..word.len()]); }
	else { word.copy_from_slice(&buf[8 - word.len()..]); }
}

fn read_word(bytes: &[u8], little: bool) -> u64 {
	let mut word = [0; 8];
	if little {
		word[..bytes.len()].copy_from_slice(bytes);
		u64::from_le_bytes(word)
	} else {
		word[8 - bytes.len()..].copy_from_slice(bytes);
		u64::from_be_bytes(word)
	}
}

fn word_order(code: u8, order: Order) -> bool {
	match code { b'n' | b'N' => false, b'v' | b'V' => true, _ => order.little() }
}

const X87: bool = cfg!(any(target_arch = "x86", target_arch = "x86_64"));
/// Byte width of the native C `long double` used by pack and Config.
pub(in crate::perl) const LONG_DOUBLE: usize = if cfg!(target_os = "windows") { 8 }
	else if cfg!(all(target_arch = "x86", not(target_vendor = "apple"))) { 12 }
	else if cfg!(any(target_arch = "arm", all(target_arch = "aarch64", target_vendor = "apple"))) { 8 }
	else { 16 };

// The interpreter's NV is binary64. Widen exactly into the host long-double
// representation; x87 padding is zero and endian modifiers reverse the field.
fn pack_double(value: f64, buf: &mut [u8], little: bool) {
	let bits = value.to_bits();
	if buf.len() == 8 { write_word(bits, buf, little); return; }
	let sign = (bits >> 63) as u16;
	let biased = (bits >> 52) as u16 & 2047;
	let frac = bits & ((1 << 52) - 1);
	let (exp, sig) = match (biased, frac) {
		(0, 0) => (0, 0),
		(0, _) => {
			let shift = frac.leading_zeros() - 11;
			(16383 - 1022 - shift as u16, frac << shift)
		},
		(2047, _) => (32767, (1 << 52) | frac),
		_ => (biased + (16383 - 1023), (1 << 52) | frac),
	};
	let head = (sign << 15) | exp;
	if X87 {
		buf[..8].copy_from_slice(&(sig << 11).to_le_bytes());
		buf[8..10].copy_from_slice(&head.to_le_bytes());
	} else {
		let bits = (u128::from(head) << 112) | (u128::from(sig & ((1 << 52) - 1)) << 60);
		buf.copy_from_slice(&bits.to_le_bytes());
	}
	if !little { buf.reverse(); }
}

fn unpack_double(buf: &mut [u8], little: bool) -> f64 {
	if buf.len() == 8 { return f64::from_bits(read_word(buf, little)); }
	if !little { buf.reverse(); }
	let (head, sig, frac_bits) = if X87 {
		(read_word(&buf[8..10], true) as u16, u128::from(read_word(&buf[..8], true)), 63i32)
	} else {
		let mut data = [0; 16];
		data.copy_from_slice(buf);
		let bits = u128::from_le_bytes(data);
		let head = (bits >> 112) as u16;
		let frac = bits & ((1 << 112) - 1);
		(head, frac | if head & 32767 == 0 { 0 } else { 1 << 112 }, 112)
	};
	let sign = u64::from(head >> 15) << 63;
	let exp = head & 32767;
	let bits = if exp == 32767 {
		let fraction = sig & ((1 << frac_bits) - 1);
		(2047 << 52) | if fraction == 0 { 0 } else { 1 << 51 }
	} else if sig == 0 {
		0
	} else {
		let top = 127 - sig.leading_zeros() as i32;
		let exponent = i32::from(exp.max(1)) - 16383 - frac_bits + top;
		if exponent < -1022 {
			round_right(sig, top - exponent - 1074) as u64
		} else if exponent > 1023 {
			2047 << 52
		} else {
			(((exponent + 1022) as u64) << 52) + round_right(sig, top - 52) as u64
		}
	};
	f64::from_bits(sign | bits)
}

fn round_right(value: u128, shift: i32) -> u128 {
	if shift <= 0 { return value << (-shift); }
	if shift >= 128 { return 0; }
	let head = value >> shift;
	let half = 1 << (shift - 1);
	let tail = value & ((1 << shift) - 1);
	head + u128::from(tail > half || (tail == half && head & 1 != 0))
}

const LIMB: u64 = 1_000_000_000;

// Big BER values are decimal strings on Perl's stack. Use base-10^9 limbs
// only after crossing the UV limit; normal encodings fit on the stack.
fn decimal_mul_add(digits: &mut Vec<u32>, factor: u64, digit: u64) {
	let mut carry = digit;
	for part in digits.iter_mut() {
		carry += u64::from(*part) * factor;
		*part = (carry % LIMB) as u32;
		carry /= LIMB;
	}
	if carry != 0 { digits.push(carry as u32); }
}

fn ber_bytes(value: u64, storage: &mut [u8; 10]) -> &[u8] {
	let mut n = value;
	let mut i = storage.len() - 1;
	storage[i] = n as u8 & 127;
	n >>= 7;
	while n != 0 {
		i -= 1;
		storage[i] = n as u8 | 128;
		n >>= 7;
	}
	&storage[i..]
}

fn big_ber_bytes(decimal: &[u8]) -> Vec<u8> {
	let mut limbs = Vec::with_capacity(decimal.len().div_ceil(9));
	for chunk in decimal.rchunks(9) {
		limbs.push(chunk.iter().fold(0, |n, b| n * 10 + u32::from(b - b'0')));
	}
	let mut bytes = Vec::with_capacity(limbs.len() * 5);
	loop {
		let mut carry = 0;
		for digit in limbs.iter_mut().rev() {
			carry = carry * LIMB + u64::from(*digit);
			*digit = (carry >> 7) as u32;
			carry &= 127;
		}
		bytes.push(carry as u8 | if bytes.is_empty() { 0 } else { 128 });
		while limbs.last() == Some(&0) { limbs.pop(); }
		if limbs.is_empty() { break; }
	}
	bytes.reverse();
	bytes
}

fn decimal_integer(s: &[u8]) -> Option<&[u8]> {
	let s = s.trim_ascii();
	let s = s.strip_prefix(b"+").unwrap_or(s);
	let end = s.iter().position(|b| !b.is_ascii_digit()).unwrap_or(s.len());
	if end == 0 { return None; }
	let tail = &s[end..];
	if !tail.is_empty() && !tail.strip_prefix(b".").is_some_and(|b| b.iter().all(u8::is_ascii_digit)) { return None; }
	Some(&s[..end])
}

fn big_ber_value(mut limbs: Vec<u32>) -> Value {
	let mut text = limbs.pop().unwrap_or(0).to_string();
	for part in limbs.into_iter().rev() { let _ = write!(text, "{part:09}"); }
	Value::Str(PStr::new(text.into_bytes(), false))
}

struct Packer<'a, 'cx, 'p> {
	out: PStr,
	args: &'a [Value],
	temporaries: &'a [bool],
	arg: usize,
	bases: Vec<usize>,
	cx: &'cx mut dyn Stringify,
	pointers: &'p mut Pointers,
	cancel: &'a AtomicBool,
	ticks: usize,
}

impl<'a> Packer<'a, '_, '_> {
	fn remaining(&self) -> usize { self.args.len() - self.arg }

	/// Counts one repetition; every POLL_INTERVAL checks host cancellation and the output size.
	fn tick(&mut self) -> Result<(), String> {
		self.ticks = self.ticks.wrapping_add(1);
		if self.ticks.is_multiple_of(POLL_INTERVAL) {
			if self.cancel.load(Ordering::Relaxed) { return Err(CANCELLED.into()); }
			check_len(self.out.bytes.len(), "string")?;
		}
		Ok(())
	}

	fn take<'v>(&mut self, injected: Option<&'v Value>, warn_undef: bool) -> Option<&'v Value> where 'a: 'v {
		if injected.is_some() { return injected; }
		let value = self.args.get(self.arg)?;
		self.arg += 1;
		if warn_undef && value.is_undef() { self.cx.warn("Use of uninitialized value in pack".into()); }
		Some(value)
	}

	fn numify(&mut self, value: Option<&Value>) -> Num {
		let Some(value) = value else { return Num::Int(0) };
		if let Value::Str(s) = value && !value.is_numeric_string() {
			self.cx.warn(format!("Argument \"{}\" isn't numeric in pack", escaped(s)));
		}
		self.cx.numify(value)
	}

	fn promote(&mut self) {
		if !self.out.utf8 {
			let mut len = self.out.bytes.len();
			promote_offsets(&self.out.bytes, &mut len, &mut self.bases);
			self.out.upgrade();
		}
	}

	fn append(&mut self, bytes: &[u8], mode: Mode) {
		if mode == Mode::Raw { self.out.bytes.extend_from_slice(bytes); }
		else { self.out.push_bytes(bytes); }
	}

	fn byte(&mut self, b: u8, mode: Mode) {
		if mode == Mode::Raw || !self.out.utf8 || b < 128 { self.out.bytes.push(b); }
		else { self.out.push_char(u32::from(b)); }
	}

	fn fill(&mut self, n: usize, byte: u8) -> Result<(), String> {
		check_len(self.out.bytes.len().saturating_add(n), "string")?;
		self.out.bytes.try_reserve(n).map_err(|_| OVERFLOW.to_owned())?;
		self.out.bytes.resize(self.out.bytes.len() + n, byte);
		Ok(())
	}

	fn position(&mut self, base: usize, offset: i64, chars: bool, code: u8) -> Result<(), String> {
		let bytes = &self.out.bytes;
		let target = if offset >= 0 {
			let (at, extra) = advance(bytes, base, offset as usize, chars);
			at.checked_add(extra).ok_or_else(|| OVERFLOW.to_owned())?
		} else {
			retreat(bytes, base, offset.unsigned_abs() as usize, chars).ok_or_else(|| outside(code, Operation::Pack))?
		};
		if target <= bytes.len() {
			self.out.bytes.truncate(target);
			// Groups that started past the cut now start at it.
			for start in &mut self.bases { *start = (*start).min(target); }
		} else { self.fill(target - bytes.len(), 0)?; }
		Ok(())
	}

	fn sequence(&mut self, fields: &[Field], mut mode: Mode, inherited: Order) -> Result<(), String> {
		let mut forced = None;
		let mut prepared = None;
		for (i, f) in fields.iter().enumerate() {
			let count = forced.take().map_or(f.count, Count::Exact);
			let current = prepared.take();
			let mut injection = None;
			if f.slash {
				let next = &fields[i + 1];
				let len = if b"aAZ".contains(&next.code) {
					if let Count::Exact(n) = next.count {
						n
					} else {
						let s = self.args.get(self.arg).map_or_else(PStr::default, |v| self.cx.stringify(v));
						let n = s.char_len() + usize::from(next.code == b'Z');
						if f.code != b'(' { prepared = Some(s); }
						n
					}
				} else {
					self.remaining().min(next.count.or(usize::MAX, usize::MAX))
				};
				forced = Some(len);
				if f.code != b'(' { injection = Some(Value::Int(len as i64)); }
			}
			let order = f.order(inherited, Operation::Pack)?;
			let current = if injection.is_none() { current } else { None };
			self.field(f, count, &mut mode, order, injection.as_ref(), current)?;
		}
		Ok(())
	}

	fn field(&mut self, f: &Field, count: Count, mode: &mut Mode, order: Order, injected: Option<&Value>, prepared: Option<PStr>) -> Result<(), String> {
		let code = f.code;
		match code {
			b'(' => {
				if f.group.is_empty() { return Ok(()); }
				for _ in 0..count.or(1, self.remaining()) {
					if count == Count::Star && self.remaining() == 0 { break; }
					let before = (self.out.bytes.len(), self.out.utf8, self.arg);
					self.bases.push(before.0);
					self.sequence(&f.group, *mode, order)?;
					self.bases.pop();
					// A pass that emitted nothing and took no argument changes no state, so the rest would too.
					if (self.out.bytes.len(), self.out.utf8, self.arg) == before { break; }
					self.tick()?;
				}
			},
			b'C' if count.or(1, self.remaining()) == 0 => *mode = Mode::Characters,
			b'U' if count.or(1, self.remaining()) == 0 => { self.promote(); *mode = Mode::Raw; },
			b'@' | b'.' | b'x' | b'X' => {
				let pos = self.out.bytes.len();
				let chars = self.out.utf8 && *mode != Mode::Raw && (!f.bang || matches!(code, b'x' | b'X'));
				let n = count.or(1, 0);
				let (base, offset) = match code {
					b'.' => {
						let value = self.take(injected, true);
						(base_for(&self.bases, count, pos), int_bits(self.numify(value)) as i64)
					},
					b'@' => (self.bases.last().copied().unwrap_or(0), n as i64),
					_ => {
						let step = if f.bang {
							let units = distance(&self.out.bytes, 0, pos, chars) as usize;
							aligned_offset(units, n, code == b'x')
						} else { n };
						(pos, if code == b'x' { step as i64 } else { -(step as i64) })
					},
				};
				self.position(base, offset, chars, code)?;
			},
			b'a' | b'A' | b'Z' | b'b' | b'B' | b'h' | b'H' | b'u' => {
				let value = self.take(injected, true);
				let s = prepared.unwrap_or_else(|| value.map_or_else(PStr::default, |v| self.cx.stringify(v)));
				match code {
					b'u' => self.uuencode(&s, count.or(45, 45)),
					b'b' | b'B' | b'h' | b'H' => self.bit_string(&s, count, code, *mode)?,
					_ => self.string(&s, count, code, *mode)?,
				}
			},
			_ => {
				let n = if code == b'P' { 1 } else { count.or(1, self.remaining()) };
				let size = n.checked_mul(numeric_width(code, f.bang)).ok_or_else(|| OVERFLOW.to_owned())?;
				check_len(self.out.bytes.len().saturating_add(size), "string")?;
				self.out.bytes.try_reserve(size).map_err(|_| OVERFLOW.to_owned())?;
				let pointer = matches!(code, b'p' | b'P');
				for _ in 0..n {
					self.tick()?;
					let index = self.arg;
					let value = self.take(injected, !pointer);
					if pointer {
						let address = match value {
							Some(v) if !v.is_undef() => {
								if injected.is_none() && self.temporaries.get(index).copied().unwrap_or(false) {
									self.cx.warn("Attempt to pack pointer to temporary value".into());
								}
								let bytes = self.cx.stringify(v).bytes;
								self.pointers.address(bytes)
							},
							_ => 0,
						};
						self.word(Num::UInt(address), code, f.bang, order, *mode)?;
						continue;
					}
					let number = self.numify(value);
					match code {
						b'w' => self.ber(number, value, *mode)?,
						b'c' | b'C' | b'W' | b'U' => self.character(number, code, *mode)?,
						_ => self.word(number, code, f.bang, order, *mode)?,
					}
				}
			},
		}
		Ok(())
	}

	fn string(&mut self, s: &PStr, count: Count, code: u8, mode: Mode) -> Result<(), String> {
		let size = match count {
			Count::Star => s.char_len() + usize::from(code == b'Z'),
			_ => count.or(1, 0),
		};
		let limit = size.saturating_sub(usize::from(code == b'Z'));
		let (end, unused) = advance(&s.bytes, 0, limit, s.utf8);
		if s.utf8 && mode == Mode::Raw {
			let mut wide = false;
			for c in s.chars().take(limit) {
				wide |= c > 255;
				self.out.bytes.push(c as u8);
			}
			if wide { self.cx.warn(format!("Character(s) in '{}' format wrapped in pack", code as char)); }
		} else if s.utf8 {
			self.promote();
			self.out.bytes.extend_from_slice(&s.bytes[..end]);
		} else {
			self.append(&s.bytes[..end], mode);
		}
		self.fill(size - (limit - unused), if code == b'A' { b' ' } else { 0 })
	}

	fn bit_string(&mut self, s: &PStr, count: Count, code: u8, mode: Mode) -> Result<(), String> {
		let stride = bit_stride(code);
		let bits = 8 / stride;
		let size = if count == Count::Star { s.char_len() } else { count.or(1, 0) };
		let mut packed = 0;
		let mut read = 0;
		for cp in s.chars().take(size) {
			let index = read % stride;
			let slot = if matches!(code, b'B' | b'H') { stride - 1 - index } else { index };
			let nibble = match cp {
				_ if bits == 1 => cp as u8 & 1,
				65..=90 | 97..=122 => ((cp as u8) + 9) & 15,
				_ => cp as u8 & 15,
			};
			packed |= nibble << (slot * bits);
			read += 1;
			if read % stride == 0 {
				self.byte(packed, mode);
				packed = 0;
			}
		}
		if read % stride != 0 { self.byte(packed, mode); }
		self.fill(size.div_ceil(stride) - read.div_ceil(stride), 0)
	}

	fn uuencode(&mut self, s: &PStr, width: usize) {
		let width = if width <= 2 { 45 } else if width > 65 {
			self.cx.warn("Field too wide in 'u' format in pack".into());
			63
		} else { width / 3 * 3 };
		let mut chars = s.chars();
		let mut wide = false;
		let mut line = [0u8; 63];
		loop {
			let mut len = 0;
			for (slot, cp) in line[..width].iter_mut().zip(chars.by_ref()) {
				wide |= cp > 255;
				*slot = cp as u8;
				len += 1;
			}
			if len == 0 { break; }
			self.out.bytes.push(32 + len as u8);
			for part in line[..len].chunks(3) {
				let a = part[0];
				let b = *part.get(1).unwrap_or(&0);
				let c = *part.get(2).unwrap_or(&0);
				for digit in [a >> 2, (a & 3) << 4 | b >> 4, (b & 15) << 2 | c >> 6, c & 63] {
					self.out.bytes.push(if digit == 0 { b'`' } else { digit + 32 });
				}
			}
			self.out.bytes.push(b'\n');
		}
		if wide { self.cx.warn("Character(s) in 'u' format wrapped in pack".into()); }
	}

	fn character(&mut self, n: Num, code: u8, mode: Mode) -> Result<(), String> {
		let cp = finite_int(n, code)?;
		let mut storage = [0; 13];
		match code {
			b'U' => {
				check_cp(cp)?;
				self.append(encode_utf8(cp, &mut storage), mode);
			},
			b'W' if mode != Mode::Raw => {
				check_cp(cp)?;
				if cp > 255 { self.promote(); }
				if self.out.utf8 { self.out.bytes.extend_from_slice(encode_utf8(cp, &mut storage)); }
				else { self.out.bytes.push(cp as u8); }
			},
			_ => {
				let wrapped = match code {
					b'c' => ((cp as i64) < -128 || (cp as i64) > 127) || matches!(n, Num::UInt(_)),
					_ => cp > 255,
				};
				if wrapped { self.cx.warn(format!("Character in '{}' format wrapped in pack", code as char)); }
				self.byte(cp as u8, mode);
			},
		}
		Ok(())
	}

	fn word(&mut self, n: Num, code: u8, bang: bool, order: Order, mode: Mode) -> Result<(), String> {
		let width = numeric_width(code, bang);
		let little = word_order(code, order);
		let mut storage = [0; 16];
		let buf = &mut storage[..width];
		match code {
			b'D' => pack_double(n.to_f64(), buf, little),
			b'f' => write_word(u64::from((n.to_f64() as f32).to_bits()), buf, little),
			b'd' | b'F' => write_word(n.to_f64().to_bits(), buf, little),
			_ => write_word(finite_int(n, code)?, buf, little),
		}
		self.append(buf, mode);
		Ok(())
	}

	fn ber(&mut self, n: Num, value: Option<&Value>, mode: Mode) -> Result<(), String> {
		let number = match n {
			Num::UInt(n) => n,
			Num::Int(n) if n >= 0 => n as u64,
			Num::Float(n) if !n.is_finite() => return Err(format!("Cannot compress {} in pack", format_float(n).to_string_lossy())),
			Num::Float(n) if (0.0..u64::MAX as f64).contains(&n) => n as u64,
			Num::Float(n) if n >= 0.0 => {
				if let Some(Value::Str(s)) = value {
					let Some(digits) = decimal_integer(&s.bytes) else { return Err("Can only compress unsigned integers in pack".into()) };
					self.append(&big_ber_bytes(digits), mode);
					return Ok(());
				}
				// Base-128 digits of the floored float, most significant first.
				let mut rest = n.floor();
				let mut digits = Vec::new();
				loop {
					let next = (rest / 128.0).floor();
					digits.push((rest - next * 128.0) as u8 | 0x80);
					rest = next;
					if rest <= 0.0 { break; }
				}
				digits[0] &= 0x7f;
				digits.reverse();
				self.append(&digits, mode);
				return Ok(());
			},
			_ => return Err("Cannot compress negative numbers in pack".into()),
		};
		let mut buf = [0; 10];
		self.append(ber_bytes(number, &mut buf), mode);
		Ok(())
	}
}

fn finite_int(n: Num, code: u8) -> Result<u64, String> {
	if let Num::Float(n) = n && !n.is_finite() {
		Err(format!("Cannot pack {} with '{}'", format_float(n).to_string_lossy(), code as char))
	} else { Ok(int_bits(n)) }
}

fn check_cp(cp: u64) -> Result<(), String> {
	if cp > i64::MAX as u64 {
		Err(format!("Use of code point 0x{cp:X} is not allowed; the permissible max is 0x7FFFFFFFFFFFFFFF"))
	} else { Ok(()) }
}

/// Packs a Perl argument list according to a binary template; emits Perl warnings through `cx`.
/// `temporaries[i]` marks argument `i` as an expression result, which `p` warns about.
/// `cancel` is the host's cancellation flag, polled during long repetitions (error [`CANCELLED`]).
pub(super) fn pack(template: &PStr, args: &[Value], temporaries: &[bool], cx: &mut dyn Stringify, pointers: &mut Pointers, cancel: &AtomicBool) -> Result<PStr, String> {
	let fields = Template { bytes: &template.bytes, i: 0, op: Operation::Pack, cx: &mut *cx, comma_warned: false }.sequence(None, 0, false)?;
	let starts_unicode = fields.first().is_some_and(|f| f.code == b'U');
	let out = PStr::new(Vec::new(), starts_unicode);
	let mut packer = Packer { out, args, temporaries, arg: 0, bases: Vec::new(), cx, pointers, cancel, ticks: 0 };
	packer.sequence(&fields, if starts_unicode { Mode::Raw } else { Mode::Characters }, Order::Native)?;
	if packer.out.utf8 {
		let mut pos = 0;
		while pos < packer.out.bytes.len() {
			let bytes = &packer.out.bytes[pos..];
			let (_, n, error) = decode_utf8(bytes);
			if let Some(error) = error {
				packer.cx.warn(malformed(bytes, error, Operation::Pack));
				return Err("Malformed UTF-8 character (fatal)".into());
			}
			pos += n;
		}
	}
	Ok(packer.out)
}

struct Checksum {
	bits: usize,
	integer: u64,
	float: Option<f64>,
}

impl Checksum {
	fn new(bits: usize) -> Self {
		Self { bits, integer: 0, float: (bits > 64).then_some(0.0) }
	}

	fn add(&mut self, n: Num) {
		if let Some(sum) = &mut self.float { *sum += n.to_f64(); }
		else if let Num::Float(f) = n { self.float = Some(self.integer as f64 + f); }
		else { self.integer = self.integer.wrapping_add(int_bits(n)); }
	}

	fn finish(self) -> Value {
		if let Some(sum) = self.float {
			let modulo = if self.bits < 1024 { 2f64.powi(self.bits as i32) } else { f64::INFINITY };
			let sum = if modulo.is_finite() { sum.rem_euclid(modulo) % modulo } else { sum };
			Value::Num(sum)
		} else {
			let mask = if self.bits >= 64 { u64::MAX } else { (1 << self.bits) - 1 };
			unsigned(self.integer & mask)
		}
	}
}

struct UnpackSequence {
	mode: Mode,
	forced: Option<usize>,
	checksum: Option<usize>,
}

impl UnpackSequence {
	fn new(mode: Mode) -> Self { Self { mode, forced: None, checksum: None } }

	fn end(self) -> Result<(), String> {
		if self.forced.is_some() { Err("Code missing after '/' in unpack".into()) } else { Ok(()) }
	}
}

struct Unpacker<'a, 'cx, 'p> {
	data: &'a PStr,
	cx: &'cx mut dyn Stringify,
	pointers: &'p Pointers,
	promoted: Option<Vec<u8>>,
	pos: usize,
	bases: Vec<usize>,
	out: Vec<Value>,
	scalar: bool,
	comma_warned: bool,
	cancel: &'a AtomicBool,
	ticks: usize,
}

impl Unpacker<'_, '_, '_> {
	fn bytes(&self) -> &[u8] { self.promoted.as_deref().unwrap_or(&self.data.bytes) }

	/// Counts one repetition; every POLL_INTERVAL checks host cancellation and the result size.
	fn tick(&mut self) -> Result<(), String> {
		self.ticks = self.ticks.wrapping_add(1);
		if self.ticks.is_multiple_of(POLL_INTERVAL) {
			if self.cancel.load(Ordering::Relaxed) { return Err(CANCELLED.into()); }
			check_values(self.out.len())?;
		}
		Ok(())
	}

	fn chars(&self, mode: Mode) -> bool { mode != Mode::Raw && (self.data.utf8 || self.promoted.is_some()) }

	fn promote(&mut self) {
		if !self.data.utf8 && self.promoted.is_none() && !self.data.bytes.is_ascii() {
			promote_offsets(&self.data.bytes, &mut self.pos, &mut self.bases);
			let mut promoted = PStr::new(Vec::with_capacity(self.data.bytes.len()), true);
			promoted.push_bytes(&self.data.bytes);
			self.promoted = Some(promoted.bytes);
		}
	}

	fn take_unit(&mut self, mode: Mode) -> Option<u64> {
		if self.pos >= self.bytes().len() { return None; }
		let (value, next) = unit(self.bytes(), self.pos, self.chars(mode));
		self.pos = next;
		Some(value)
	}

	fn take_unicode(&mut self, mode: Mode) -> Option<u64> {
		if self.pos >= self.bytes().len() { return None; }
		// Over a byte buffer (U0 mode, or a string never upgraded) U decodes the
		// buffer's UTF-8; in character mode it decodes characters taken as octets.
		if !self.chars(mode) {
			let source = self.promoted.as_deref().unwrap_or(&self.data.bytes);
			let (cp, len) = unpack_unicode(&source[self.pos..], self.cx);
			self.pos += len;
			return Some(cp);
		}
		let mut offsets = [self.pos; 14];
		let mut octets = [0; 13];
		let mut n = 0;
		let bytes = self.bytes();
		while n < octets.len() && offsets[n] < bytes.len() {
			let (value, next) = unit(bytes, offsets[n], true);
			// A character above 0xFF is not an octet: perl stops unpacking 'U' here.
			if value > 0xff { return None; }
			octets[n] = value as u8;
			offsets[n + 1] = next;
			n += 1;
			if n == utf8_width(octets[0]) { break; }
		}
		let (cp, consumed) = unpack_unicode(&octets[..n], self.cx);
		self.pos = offsets[consumed];
		Some(cp)
	}

	fn take_bytes(&mut self, buf: &mut [u8], mode: Mode) -> bool {
		let bytes = self.bytes();
		if !self.chars(mode) {
			let Some(input) = bytes.get(self.pos..self.pos + buf.len()) else { return false };
			buf.copy_from_slice(input);
			self.pos += buf.len();
			return true;
		}
		let mut at = self.pos;
		for dest in buf {
			if at == bytes.len() { return false; }
			let (cp, next) = unit(bytes, at, true);
			at = next;
			*dest = cp as u8;
		}
		self.pos = at;
		true
	}

	fn emit(&mut self, value: Num, sum: Option<&mut Checksum>) {
		if let Some(sum) = sum { sum.add(value); } else { self.out.push(value.into_value()); }
	}

	fn sequence(&mut self, fields: &[Field], mode: Mode, inherited: Order) -> Result<(), String> {
		let mut state = UnpackSequence::new(mode);
		for f in fields {
			if self.one(f, &mut state, inherited, None, 0)? { return Ok(()); }
		}
		state.end()
	}

	fn sequence_lazy(&mut self, bytes: &[u8], mode: Mode, inherited: Order, depth: usize) -> Result<(), String> {
		let mut state = UnpackSequence::new(mode);
		let mut offset = 0;
		loop {
			let mut template = Template { bytes, i: offset, op: Operation::Unpack, cx: &mut *self.cx, comma_warned: self.comma_warned };
			let Some(f) = template.next(None, depth, false, offset == 0, true)? else { break };
			offset = template.i;
			self.comma_warned = template.comma_warned;
			if self.one(&f, &mut state, inherited, Some(bytes), depth)? {
				// perl stops only after parsing the following symbol, so its modifier and
				// count errors still surface; an unknown type letter is only rejected later.
				let mut template = Template { bytes, i: offset, op: Operation::Unpack, cx: &mut *self.cx, comma_warned: self.comma_warned };
				match template.next(None, depth, false, false, true) {
					Err(e) if !e.starts_with("Invalid type") => return Err(e),
					_ => return Ok(()),
				}
			}
		}
		state.end()
	}

	fn one(&mut self, f: &Field, state: &mut UnpackSequence, inherited: Order, template: Option<&[u8]>, depth: usize) -> Result<bool, String> {
		let from_slash = state.forced.is_some();
		if from_slash && matches!(f.count, Count::Exact(_)) { return Err("Count after length/code in unpack".into()); }
		let count = state.forced.take().map_or(f.count, Count::Exact);
		if f.code == b'%' {
			let bits = count.or(16, self.bytes().len());
			state.checksum = (bits != 0).then_some(bits);
			return Ok(false);
		}
		let before = self.pos;
		let order = f.order(inherited, Operation::Unpack)?;
		let mut sum = state.checksum.take().map(Checksum::new);
		let lazy_group = f.lazy_group.and_then(|(start, end)| template?.get(start..end));
		self.field(f, count, &mut state.mode, order, from_slash, sum.as_mut(), lazy_group, depth)?;
		if let Some(sum) = sum { self.out.push(sum.finish()); }
		if f.slash && f.code != b'(' {
			if self.out.is_empty() { return Ok(true); }
			if before == self.bytes().len() { return Err("length/code after end of string in unpack".into()); }
			let Some(value) = self.out.pop() else { return Err("'/' must follow a numeric type in unpack".into()) };
			let n = value.to_i64();
			if n < 0 { return Err("Negative '/' count in unpack".into()); }
			state.forced = Some(n as usize);
			if self.scalar { self.out.clear(); }
			return Ok(false);
		}
		Ok(self.scalar && !self.out.is_empty())
	}

	fn field(&mut self, f: &Field, count: Count, mode: &mut Mode, order: Order, from_slash: bool, mut sum: Option<&mut Checksum>, lazy_group: Option<&[u8]>, depth: usize) -> Result<(), String> {
		let code = f.code;
		let n = count.or(1, self.bytes().len());
		match code {
			b'/' => return Err("'/' must follow a numeric type in unpack".into()),
			b'(' => {
				if f.group.is_empty() && lazy_group.is_none_or(|s| s.is_empty()) { return Ok(()); }
				let mut done = 0;
				while done < n {
					if (count == Count::Star || from_slash) && self.pos == self.bytes().len() { break; }
					let before = self.pos;
					let produced = self.out.len();
					self.bases.push(before);
					if let Some(source) = lazy_group { self.sequence_lazy(source, *mode, order, depth + 1)?; }
					else { self.sequence(&f.group, *mode, order)?; }
					self.bases.pop();
					done += 1;
					if self.scalar && (!self.out.is_empty() || self.pos == before) { break; }
					if self.pos == before {
						// A pass that consumed no input leaves the position where it was, so every
						// remaining pass yields the same values: repeat them instead of rerunning.
						let fresh = self.out.len() - produced;
						let left = n - done;
						if fresh != 0 && left != 0 {
							let total = fresh.checked_mul(left).and_then(|more| more.checked_add(self.out.len()));
							check_values(total.unwrap_or(usize::MAX))?;
							let values = self.out[produced..].to_vec();
							for _ in 0..left {
								self.tick()?;
								self.out.extend_from_slice(&values);
							}
						}
						break;
					}
					self.tick()?;
				}
			},
			b'C' if count == Count::Exact(0) && !from_slash => *mode = Mode::Utf8Octets,
			b'U' if count == Count::Exact(0) && !from_slash => { self.promote(); *mode = Mode::Raw; },
			b'@' | b'.' | b'x' | b'X' => self.position(code, count, f.bang, *mode)?,
			b'a' | b'A' | b'Z' => self.string(code, n, count == Count::Star, *mode, sum)?,
			b'b' | b'B' | b'h' | b'H' => self.bit_string(code, n, count == Count::Star, *mode, sum),
			b'u' => {
				if self.pos == self.bytes().len() { self.out.push(Value::Undef); }
				else {
					let bytes = if sum.is_some() { None } else { Some(Vec::new()) };
					self.uudecode(bytes);
				}
			},
			b'w' => {
				let n = if self.scalar && !f.slash { n.min(1) } else { n };
				for _ in 0..n {
					if self.pos == self.bytes().len() { break; }
					let value = self.ber(*mode)?;
					self.out.push(value);
				}
			},
			b'c' | b'C' | b'W' | b'U' => {
				let n = if self.scalar && sum.is_none() && !f.slash { n.min(1) } else { n };
				for _ in 0..n {
					let v = if code == b'U' { self.take_unicode(*mode) } else { self.take_unit(*mode) };
					let Some(v) = v else { break };
					let mut v = v as i64;
					if code == b'c' && v > 127 { v -= 256; }
					self.emit(Num::Int(v), sum.as_deref_mut());
				}
			},
			b'p' | b'P' => {
				if code == b'P' && count == Count::Star { return Err("'P' must have an explicit size in unpack".into()); }
				let mut pointer = [0; std::mem::size_of::<usize>()];
				let length = n;
				let n = if self.scalar && !f.slash { n.min(1) } else { n };
				for _ in 0..if code == b'P' { 1 } else { n } {
					if !self.take_bytes(&mut pointer, *mode) { break; }
					let address = read_word(&pointer, word_order(code, order));
					let value = self.pointers.resolve(address).map(|bytes| {
						let bytes = if code == b'P' {
							check_len(length, "string")?;
							let mut fixed = bytes[..bytes.len().min(length)].to_vec();
							fixed.resize(length, 0);
							fixed
						} else {
							bytes[..bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len())].to_vec()
						};
						Ok::<_, String>(Value::Str(PStr::new(bytes, false)))
					}).transpose()?.unwrap_or(Value::Undef);
					self.out.push(value);
				}
			},
			_ => {
				let width = numeric_width(code, f.bang);
				let little = word_order(code, order);
				let mut storage = [0; 16];
				let buf = &mut storage[..width];
				let n = if self.scalar && sum.is_none() && !f.slash { n.min(1) } else { n };
				for _ in 0..n {
					if !self.take_bytes(buf, *mode) { break; }
					let value = match code {
						b'D' => Num::Float(unpack_double(buf, little)),
						b'd' | b'F' => Num::Float(f64::from_bits(read_word(buf, little))),
						b'f' => Num::Float(f64::from(f32::from_bits(read_word(buf, little) as u32))),
						_ => {
							let value = read_word(buf, little);
							let signed = b"silqj".contains(&code) || f.bang && b"nNvV".contains(&code);
							if signed {
								let shift = 64 - 8 * width;
								Num::Int(((value << shift) as i64) >> shift)
							} else if value <= i64::MAX as u64 { Num::Int(value as i64) }
							else { Num::UInt(value) }
						},
					};
					self.emit(value, sum.as_deref_mut());
				}
			},
		}
		Ok(())
	}

	fn position(&mut self, code: u8, count: Count, bang: bool, mode: Mode) -> Result<(), String> {
		let chars = self.chars(mode) && (!bang || matches!(code, b'x' | b'X'));
		let bytes = self.bytes();
		let n = count.or(1, bytes.len());
		let pos = self.pos;
		self.pos = match code {
			b'.' => {
				let base = base_for(&self.bases, count, pos);
				let offset = distance(bytes, base, pos, chars);
				self.out.push(Value::Int(offset));
				pos
			},
			b'@' | b'x' => {
				let base = if code == b'x' { pos } else { self.bases.last().copied().unwrap_or(0) };
				let n = if code == b'x' && bang { aligned_offset(distance(bytes, 0, pos, chars) as usize, n, true) } else { n };
				let (target, left) = advance(bytes, base, n, chars);
				if left != 0 { return Err(outside(code, Operation::Unpack)); }
				target
			},
			_ => {
				let n = if bang { aligned_offset(distance(bytes, 0, pos, chars) as usize, n, false) } else { n };
				retreat(bytes, pos, n, chars).ok_or_else(|| outside(code, Operation::Unpack))?
			},
		};
		Ok(())
	}

	fn string(&mut self, code: u8, n: usize, star: bool, mode: Mode, sum: Option<&mut Checksum>) -> Result<(), String> {
		let start = self.pos;
		let chars = self.chars(mode);
		let bytes = self.bytes();
		let end = if star { bytes.len() } else { advance(bytes, start, n, chars).0 };
		if let Some(sum) = sum {
			let mut at = start;
			while at < end {
				let (cp, next) = unit(&bytes[..end], at, chars);
				sum.add(Num::Int(cp as i64));
				at = next;
			}
			self.pos = end;
			return Ok(());
		}
		let with_utf8_flag = self.data.utf8 && mode != Mode::Raw;
		let (stop, new_pos) = match code {
			b'Z' => {
				let nul = bytes[start..end].iter().position(|&b| b == 0);
				let stop = nul.map_or(end, |i| start + i);
				(stop, if star && nul.is_some() { stop + 1 } else { end })
			},
			b'A' if chars => {
				let mut stop = start;
				let mut at = start;
				while at < end {
					let (cp, next) = unit(&bytes[..end], at, true);
					let whitespace = u32::try_from(cp).is_ok_and(|c| if with_utf8_flag { unicode_space(c) } else { space(c) });
					if cp != 0 && !whitespace { stop = next; }
					at = next;
				}
				(stop, end)
			},
			b'A' => (bytes[start..end].iter().rposition(|&b| b != 0 && !space(u32::from(b))).map_or(start, |i| start + i + 1), end),
			_ => (end, end),
		};
		let slice = &bytes[start..stop];
		let string = if chars && !with_utf8_flag {
			let mut bytes = Vec::with_capacity(slice.len());
			let mut at = 0;
			while at < slice.len() {
				let (cp, n, error) = decode_utf8(&slice[at..]);
				if error.is_some() || cp > 255 { return Err("Wide character in unpack".into()); }
				bytes.push(cp as u8);
				at += n;
			}
			PStr::new(bytes, false)
		} else if with_utf8_flag && std::str::from_utf8(slice).is_err() {
			// A byte-positioned @! may land inside a character. Coerce damaged
			// units to NUL without losing valid extended Perl code points.
			let mut bytes = Vec::with_capacity(slice.len());
			let mut at = 0;
			while at < slice.len() {
				let (_, n, error) = decode_utf8(&slice[at..]);
				if error.is_some() { bytes.push(0); }
				else { bytes.extend_from_slice(&slice[at..at + n]); }
				at += n;
			}
			PStr::new(bytes, true)
		} else { PStr::new(slice.to_vec(), with_utf8_flag) };
		self.pos = new_pos;
		self.out.push(Value::Str(string));
		Ok(())
	}

	fn bit_string(&mut self, code: u8, count: usize, star: bool, mode: Mode, mut sum: Option<&mut Checksum>) {
		let stride = bit_stride(code);
		let bits = 8 / stride;
		let count = if star { count.saturating_mul(stride) } else { count };
		let mut remaining = count;
		let mut text = if sum.is_none() { Some(Vec::with_capacity(count.min(self.bytes().len().saturating_sub(self.pos).saturating_mul(stride)))) } else { None };
		while remaining != 0 {
			let Some(n) = self.take_unit(mode) else { break };
			let n = n as u8;
			let used = remaining.min(stride);
			if let Some(text) = &mut text {
				for i in 0..used {
					let slot = if matches!(code, b'B' | b'H') { stride - 1 - i } else { i };
					let v = n >> (slot * bits) & ((1 << bits) - 1);
					text.push(b"0123456789abcdef"[usize::from(v)]);
				}
			} else if bits == 1 && let Some(sum) = &mut sum {
				let trimmed = if code == b'B' { n >> (8 - used) } else { n & (u8::MAX >> (8 - used)) };
				sum.add(Num::Int(i64::from(trimmed.count_ones())));
			}
			remaining -= used;
		}
		if let Some(text) = text { self.out.push(Value::Str(PStr::new(text, false))); }
	}

	fn uudecode(&mut self, mut output: Option<Vec<u8>>) {
		let bytes = self.bytes();
		let mut pos = self.pos;
		while let Some(&first @ (b'!'..=b'`')) = bytes.get(pos) {
			pos += 1;
			let n = usize::from(first.wrapping_sub(32) & 63);
			let line = bytes[pos..].iter().position(|&b| b == b'\n' || b == b'\r').map_or(bytes.len(), |i| pos + i);
			if let Some(out) = &mut output {
				let mut digits = bytes[pos..line].iter().copied();
				let mut digit = || digits.next().filter(|b| (32..=96).contains(b)).map_or(0, |b| (b - 32) & 63);
				let mut add = n;
				while add != 0 {
					let (a, b, c, d) = (digit(), digit(), digit(), digit());
					let part = [a << 2 | b >> 4, b << 4 | c >> 2, c << 6 | d];
					out.extend_from_slice(&part[..add.min(3)]);
					add = add.saturating_sub(3);
				}
			}
			pos = line;
			if bytes.get(pos) == Some(&b'\r') { pos += 1; }
			if bytes.get(pos) == Some(&b'\n') { pos += 1; }
		}
		self.pos = pos;
		if let Some(out) = output { self.out.push(Value::Str(PStr::new(out, false))); }
	}

	fn ber(&mut self, mode: Mode) -> Result<Value, String> {
		let mut number = 0u64;
		let mut big = None;
		loop {
			let Some(cp) = self.take_unit(mode) else { return Err("Unterminated compressed integer in unpack".into()) };
			let b = cp as u8;
			let lo = u64::from(b & 127);
			if let Some(limbs) = &mut big { decimal_mul_add(limbs, 128, lo); }
			else if number <= u64::MAX >> 7 { number = (number << 7) | lo; }
			else {
				let mut limbs = Vec::with_capacity(4);
				while number != 0 {
					limbs.push((number % LIMB) as u32);
					number /= LIMB;
				}
				decimal_mul_add(&mut limbs, 128, lo);
				big = Some(limbs);
			}
			if b & 128 == 0 { return Ok(big.map_or_else(|| unsigned(number), big_ber_value)); }
		}
	}
}

/// Result context determines how much of the binary template is consumed.
#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum UnpackCx {
	/// Decode all fields.
	List,
	/// Stop as soon as the template produces one result.
	Scalar,
}

/// Unpacks a Perl string into the list described by the binary template.
/// `cancel` is the host's cancellation flag, polled during long repetitions (error [`CANCELLED`]).
pub(super) fn unpack(template: &PStr, data: &PStr, context: UnpackCx, cx: &mut dyn Stringify, pointers: &Pointers, cancel: &AtomicBool) -> Result<Vec<Value>, String> {
	let scalar = context == UnpackCx::Scalar;
	let fields = if scalar { None } else {
		Some(Template { bytes: &template.bytes, i: 0, op: Operation::Unpack, cx: &mut *cx, comma_warned: false }.sequence(None, 0, false)?)
	};
	let mut unpacker = Unpacker { data, cx, pointers, promoted: None, pos: 0, bases: Vec::new(), out: Vec::new(), scalar, comma_warned: false, cancel, ticks: 0 };
	// A template starting with U reads the (upgraded) string's UTF-8 buffer, as after U0.
	let mode = if first_symbol(&template.bytes) == Some(b'U') {
		unpacker.promote();
		Mode::Raw
	} else {
		Mode::Characters
	};
	if let Some(fields) = fields {
		unpacker.sequence(&fields, mode, Order::Native)?;
	} else {
		unpacker.sequence_lazy(&template.bytes, mode, Order::Native, 0)?;
		unpacker.out.truncate(1);
	}
	Ok(unpacker.out)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::perl::value::Plain;

	static NO_CANCEL: AtomicBool = AtomicBool::new(false);

	#[test]
	fn huge_counts_stop_or_fail_promptly() {
		let a = [Value::str("a")];
		let packed = |t: &str| pack(&PStr::from_str(t), &a, &[], &mut Plain, &mut Pointers::default(), &NO_CANCEL);
		assert_eq!(packed("(a0)999999999999").unwrap().bytes, b"");
		for t in ["x999999999999", "a999999999999", "A20000000000", "N999999999999", "x[(a)999999999999]"] {
			assert!(packed(t).is_err(), "{t}");
		}
		let data = PStr::from_bytes(b"a");
		let unpacked = |t: &str| unpack(&PStr::from_str(t), &data, UnpackCx::List, &mut Plain, &Pointers::default(), &NO_CANCEL);
		assert_eq!(unpacked("(a0)3").unwrap().len(), 3);
		assert!(unpacked("(a0)999999999999").is_err());
		let cancelled = AtomicBool::new(true);
		let result = pack(&PStr::from_str("N100000"), &[], &[], &mut Plain, &mut Pointers::default(), &cancelled);
		assert_eq!(result.unwrap_err(), CANCELLED);
	}

	fn encode(t: &str, values: &[Value]) -> PStr { pack(&PStr::from_str(t), values, &[], &mut Plain, &mut Pointers::default(), &NO_CANCEL).unwrap() }
	fn decode(t: &str, data: &PStr) -> Vec<Value> { unpack(&PStr::from_str(t), data, UnpackCx::List, &mut Plain, &Pointers::default(), &NO_CANCEL).unwrap() }

	#[test]
	fn scalar_unpack_stops_before_invalid_trailing_fields() {
		let data = PStr::from_bytes(b"a");
		for template in [b"Cy".as_slice(), b"(Cy)", b"Cx100", b"(C100)x100"] {
			let template = PStr::from_bytes(template);
			assert_eq!(ints(unpack(&template, &data, UnpackCx::Scalar, &mut Plain, &Pointers::default(), &NO_CANCEL).unwrap()), [97]);
			assert!(unpack(&template, &data, UnpackCx::List, &mut Plain, &Pointers::default(), &NO_CANCEL).is_err());
		}
		assert!(unpack(&PStr::from_bytes(b"x100C"), &data, UnpackCx::Scalar, &mut Plain, &Pointers::default(), &NO_CANCEL).is_err());
		let result = unpack(&PStr::from_bytes(b"C2/a*"), &PStr::from_bytes(b"\x02\x01ab"), UnpackCx::Scalar, &mut Plain, &Pointers::default(), &NO_CANCEL).unwrap();
		assert_eq!(result[0].to_pstr().bytes, b"a");
	}
	fn ints(values: Vec<Value>) -> Vec<i64> { values.into_iter().map(|v| v.to_i64()).collect() }

	#[test]
	fn nested_orders_bracket_counts_and_alignment() {
		let values = [Value::Int(0x1234), Value::Int(-2), Value::Int(0x12345678), Value::Int(9)];
		let data = encode("(n s L)> x![l!] C", &values);
		assert_eq!(data.bytes, b"\x124\xff\xfe\x124\x56\x78\t");
		assert_eq!(ints(decode("(n s L)> x![l!] C", &data)), [0x1234, -2, 0x12345678, 9]);
		assert_eq!(encode("x[C s x!4 (CX)300000]", &[]).bytes, [0; 4]);
		assert_eq!(ints(decode("C[(Cx!4)2147483647]", &PStr::from_bytes(b"AB"))), [65, 66]);
		assert!(pack(&PStr::from_str("(s>)<"), &values, &[], &mut Plain, &mut Pointers::default(), &NO_CANCEL).is_err());
	}

	#[test]
	fn lengths_and_positions() {
		let data = encode("n/a* w/Z*", &[Value::str("hello,"), Value::str("world")]);
		assert_eq!(data.bytes, b"\0\x06hello,\x06world\0");
		assert_eq!(decode("n/a w/Z", &data).into_iter().map(|v| v.to_pstr()).collect::<Vec<_>>(), [PStr::from_str("hello,"), PStr::from_str("world")]);
		assert_eq!(decode("(@1A @0A @2)*", &PStr::from_bytes(b"abcd")).into_iter().map(|v| v.to_pstr().bytes[0]).collect::<Vec<_>>(), b"badc");
		assert_eq!(ints(decode("(Cx . .0 .*)2", &PStr::from_bytes(b"abAB"))), [97, 2, 0, 2, 65, 2, 0, 4]);
	}

	#[test]
	fn unicode_byte_and_character_modes() {
		let values = [Value::Int(233), Value::Int(256), Value::Int(8364)];
		let raw = encode("C0U*", &values);
		let text = encode("U*", &values);
		assert!(!raw.utf8 && text.utf8);
		assert_eq!(raw.bytes, text.bytes);
		assert_eq!(ints(decode("C0U*", &raw)), [233, 256, 8364]);
		assert_eq!(ints(decode("W*", &text)), [233, 256, 8364]);
		assert_eq!(decode("U0a*", &text)[0].to_pstr().bytes, raw.bytes);
		assert_eq!(encode("U0 C2 C0 C", &[Value::Int(195), Value::Int(169), Value::Int(233)]).bytes, b"\xc3\xa9\xc3\xa9");
	}

	#[test]
	fn ber_uuencode_checksum_and_pointer_nulls() {
		let large = "340282366920938463463374607431768211455";
		let data = encode("w*", &[Value::Int(1), Value::Int(128), Value::Int(129), Value::str(large)]);
		assert!(data.bytes.starts_with(b"\x01\x81\0\x81\x01"));
		assert_eq!(decode("w*", &data)[3].to_pstr(), PStr::from_str(large));
		let data = encode("u", &[Value::str("hello")]);
		assert_eq!(data.bytes, b"%:&5L;&\\`\n");
		assert_eq!(decode("u", &data)[0].to_pstr(), PStr::from_str("hello"));
		assert_eq!(ints(decode("%8c*", &PStr::from_bytes(b"\xff"))), [255]);
		assert_eq!(ints(decode("%32b3 C", &PStr::from_bytes(b"\xff\x08"))), [3, 8]);
		let null = encode("p", &[Value::Undef]);
		assert!(decode("p", &null)[0].is_undef());
	}

	#[test]
	fn malformed_unpack_utf8_warns_and_retains_the_following_character() {
		#[derive(Default)]
		struct Warnings(Vec<String>);
		impl Stringify for Warnings {
			fn stringify(&mut self, v: &Value) -> PStr { v.to_pstr() }
			fn numify(&mut self, v: &Value) -> Num { v.to_num() }
			fn warn(&mut self, message: String) { self.0.push(message); }
		}
		let mut warnings = Warnings::default();
		let format = PStr::from_str("C0U*");
		let bytes = PStr::from_bytes(b"\xe0\x80A");
		assert_eq!(ints(unpack(&format, &bytes, UnpackCx::List, &mut warnings, &Pointers::default(), &NO_CANCEL).unwrap()), [0, 65]);
		assert_eq!(warnings.0, [
			"Malformed UTF-8 character: \\xe0\\x80\\x41 (unexpected non-continuation byte 0x41, 2 bytes after start byte 0xe0; need 3 bytes, got 2) in unpack",
			"Malformed UTF-8 character: \\xe0\\x80\\x41 (any UTF-8 sequence that starts with \"\\xe0\\x80\" is overlong which can and should be represented with a different, shorter sequence) in unpack",
		]);
	}

	#[test]
	fn pointers_resolve_only_their_own_synthetic_addresses() {
		let mut pointers = Pointers::default();
		let p = pack(&PStr::from_str("p"), &[Value::str("foo")], &[], &mut Plain, &mut pointers, &NO_CANCEL).unwrap();
		let big_p = pack(&PStr::from_str("P"), &[Value::str("foo")], &[], &mut Plain, &mut pointers, &NO_CANCEL).unwrap();
		assert_eq!(p.bytes, big_p.bytes);
		let read = |t: &str, data: &PStr, pointers: &Pointers| unpack(&PStr::from_str(t), data, UnpackCx::List, &mut Plain, pointers, &NO_CANCEL).unwrap();
		assert_eq!(read("p", &p, &pointers)[0].to_pstr().bytes, b"foo");
		assert_eq!(read("P2", &p, &pointers)[0].to_pstr().bytes, b"fo");
		let null = pack(&PStr::from_str("p"), &[Value::Undef], &[], &mut Plain, &mut pointers, &NO_CANCEL).unwrap();
		assert!(null.bytes.iter().all(|&b| b == 0));
		assert!(read("p", &null, &pointers)[0].is_undef());
		assert!(read("p", &p, &Pointers::default())[0].is_undef());
	}

	#[test]
	fn unicode_reads_octets_in_character_mode_and_buffer_after_u0() {
		let bytes = PStr::from_bytes(b"b\xe1\xbf\xbc");
		assert_eq!(ints(decode("aU", &bytes)[1..].to_vec()), [8188]);
		assert_eq!(ints(decode("U*", &bytes)), [98, 225, 191, 188]);
		assert_eq!(ints(decode("U0aU", &bytes)[1..].to_vec()), [225]);
	}

	#[test]
	fn unterminated_ber_and_invalid_template_errors() {
		assert_eq!(unpack(&PStr::from_str("w*"), &PStr::from_bytes(b"\x81"), UnpackCx::List, &mut Plain, &Pointers::default(), &NO_CANCEL).unwrap_err(), "Unterminated compressed integer in unpack");
		assert_eq!(pack(&PStr::from_str("C[1x]"), &[], &[], &mut Plain, &mut Pointers::default(), &NO_CANCEL).unwrap_err(), "Malformed integer in [] in pack");
		assert_eq!(unpack(&PStr::from_str("c/a"), &PStr::from_bytes(b"\xff"), UnpackCx::List, &mut Plain, &Pointers::default(), &NO_CANCEL).unwrap_err(), "Negative '/' count in unpack");
	}
}
