//! Unicode character properties for `\p{...}` / `\P{...}`: perl's naming
//! rules (`perlunicode` "Unicode Character Properties" and "Wildcards in
//! Property Values", `perluniprops`) over the Unicode 13.0 tables in
//! `ucd_data`.
//!
//! Names match loosely (case, white space, `-` and `_` are ignored, an `Is`
//! prefix is optional). Values of Age, Present_In, Canonical_Combining_Class
//! and Numeric_Value may also be numbers, compared numerically: underscores
//! only between digits, rationals (`1/2`), and decimals accurate to three
//! significant digits for Numeric_Value.

use super::ucd_data::{LISTS, PROPERTIES, SET_STARTS, SINGLE};

/// How a property's values are spelled and compared.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(in crate::perl) enum Kind {
	/// Y/N (also Yes, T, True / No, F, False).
	Binary,
	/// Named values, matched loosely.
	Enum,
	/// Unicode versions: `V1_1` names or numbers (`1.1`).
	Age,
	/// Canonical_Combining_Class: names or integers.
	Ccc,
	/// Numeric_Value: rationals, compared numerically.
	Numeric,
}

/// One property perl accepts in the compound `\p{name=value}` form.
pub(in crate::perl) struct Property {
	/// Its names as the UCD spells them (short first).
	pub(super) names: &'static [&'static str],
	pub(super) kind: Kind,
	pub(super) values: &'static [PropValue],
}

/// One value of a property.
pub(in crate::perl) struct PropValue {
	/// Its spellings in the UCD (short first; numbers first for numeric kinds).
	pub(super) names: &'static [&'static str],
	/// Set number, `NEGATED` bit for a complement.
	pub(super) set: u16,
	/// The set matched under `/i` when it differs, else `NONE`.
	pub(super) caseless: u16,
	/// Why using it warns (category `deprecated`).
	pub(super) deprecated: Option<&'static str>,
}

/// Set-number flag: the complement of the stored set.
const NEGATED: u16 = 0x8000;
/// No alternative set.
const NONE: u16 = u16::MAX;
/// Highest Unicode code point.
const MAX: u32 = 0x10FFFF;

/// The code points a property matches.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(in crate::perl) struct Resolved {
	/// Sorted, disjoint, inclusive ranges.
	pub ranges: Vec<(u32, u32)>,
	/// Why using this property warns (category `deprecated`), if it does.
	pub deprecated: Option<&'static str>,
}

/// What the text inside `\p{...}` (without `^`) names.
pub(in crate::perl) enum Lookup<'a> {
	Found(Resolved),
	/// `property=/subpattern/`: resolve with [`wildcard`].
	Wildcard(&'static Property, &'a [u8]),
	NotFound,
}

/// Resolve a property name: compound `name=value` / `name:value`, or a single
/// form (`\p{L}`, `\p{Greek}`, `\p{InGreek}`, perl extensions).
pub(in crate::perl) fn lookup(text: &[u8], caseless: bool) -> Lookup<'_> {
	let text = trim(text);
	let text = text.strip_prefix(b"utf8::").unwrap_or(text);
	if text.windows(2).any(|w| w == b"::") { return Lookup::NotFound; }
	if let Some(sep) = text.iter().position(|&b| b == b'=' || b == b':') {
		return compound(trim(&text[..sep]), trim(&text[sep + 1..]), caseless);
	}
	single(text, caseless).map_or(Lookup::NotFound, Lookup::Found)
}

/// Whether `text` names a built-in property (wildcards count as built in).
pub(in crate::perl) fn known(text: &[u8]) -> bool {
	!matches!(lookup(text, false), Lookup::NotFound)
}

/// The union of the values of `property` with a name `matches` accepts, or
/// `None` when no value matches (perl's "No Unicode property value wildcard
/// matches" error). Names are tried as spelled and in loose form.
pub(in crate::perl) fn wildcard(property: &Property, mut matches: impl FnMut(&str) -> bool) -> Option<Resolved> {
	let mut hit = false;
	let mut ranges = Vec::new();
	for value in property.values {
		let accepted = value.names.iter().any(|name| {
			if matches(name) { return true; }
			if property.kind == Kind::Numeric { return false; }
			let squeezed = loose(name.as_bytes());
			squeezed != name.as_bytes() && std::str::from_utf8(&squeezed).is_ok_and(&mut matches)
		});
		if accepted {
			hit = true;
			ranges = union(&ranges, &set_ranges(value.set));
		}
	}
	hit.then_some(Resolved { ranges, deprecated: None })
}

fn trim(text: &[u8]) -> &[u8] { text.trim_ascii() }

/// Loose form: ASCII lowercase without white space, `-` or `_`.
fn loose(text: &[u8]) -> Vec<u8> {
	text.iter().filter(|b| !matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0B | 0x0C | b'_' | b'-'))
		.map(u8::to_ascii_lowercase).collect()
}

/// `name` spelled with a significant trailing `_` (`L_`), compared exactly.
fn significant_underscore(name: &str) -> bool { name.len() > 1 && name.ends_with('_') }

/// Names only matched exactly (up to case): `L&`, `L_`.
fn strict_name(name: &str) -> bool { significant_underscore(name) || name.contains('&') }

fn single(text: &[u8], caseless: bool) -> Option<Resolved> {
	let mut key = loose(text);
	// Perl's internal identifier properties.
	let internal = match key.as_slice() {
		b"perlidstart" => Some("xids"),
		b"perlidcont" => Some("xidc"),
		_ => None,
	};
	if text.first() == Some(&b'_') && let Some(base) = internal {
		let found = single_entry(base.as_bytes())?;
		let mut ranges = set_ranges(found.1);
		if base == "xids" { ranges = union(&ranges, &[(u32::from(b'_'), u32::from(b'_'))]); }
		return Some(Resolved { ranges, deprecated: None });
	}
	// `L_` (and `IsL_`) is Cased_Letter: its underscore is significant.
	if text.ends_with(b"_") && matches!(key.as_slice(), b"l" | b"isl") { key = b"l&".to_vec(); }
	let entry = single_entry(&key).or_else(|| key.strip_prefix(b"is").and_then(single_entry))?;
	let (_, set, alternative, deprecated) = *entry;
	let set = if caseless && alternative != NONE { alternative } else { set };
	Some(Resolved { ranges: set_ranges(set), deprecated })
}

fn single_entry(key: &[u8]) -> Option<&'static (&'static str, u16, u16, Option<&'static str>)> {
	SINGLE.binary_search_by(|entry| entry.0.as_bytes().cmp(key)).ok().and_then(|i| SINGLE.get(i))
}

fn find_property(key: &[u8]) -> Option<&'static Property> {
	PROPERTIES.iter().find(|p| p.names.iter().any(|n| loose(n.as_bytes()) == key))
}

fn compound<'a>(name: &[u8], value: &'a [u8], caseless: bool) -> Lookup<'a> {
	let key = loose(name);
	let (property, prefixed) = match find_property(&key) {
		Some(p) => (p, false),
		None => match key.strip_prefix(b"is").and_then(find_property) {
			Some(p) => (p, true),
			None => return Lookup::NotFound,
		},
	};
	if let Some(pattern) = wildcard_body(value) {
		return if prefixed { Lookup::NotFound } else { Lookup::Wildcard(property, pattern) };
	}
	match find_value(property, value) {
		Some(v) => {
			let set = if caseless && v.caseless != NONE { v.caseless } else { v.set };
			Lookup::Found(Resolved { ranges: set_ranges(set), deprecated: v.deprecated })
		}
		None => Lookup::NotFound,
	}
}

/// The subpattern of a `/.../` wildcard value: ASCII punctuation delimiters
/// (not braces, nor `-`, `_`, `+`, `\`), mirrored for `(`, `[`, `<`.
fn wildcard_body(value: &[u8]) -> Option<&[u8]> {
	let (&open, rest) = value.split_first()?;
	if !open.is_ascii_punctuation() || matches!(open, b'{' | b'}' | b'-' | b'_' | b'+' | b'\\') { return None; }
	let close = match open { b'(' => b')', b'[' => b']', b'<' => b'>', c => c };
	rest.strip_suffix(&[close])
}

fn find_value(property: &'static Property, value: &[u8]) -> Option<&'static PropValue> {
	let numeric = matches!(property.kind, Kind::Age | Kind::Ccc | Kind::Numeric);
	if numeric && let Some(n) = number(value) {
		return property.values.iter().find(|v| v.names.iter().any(|name| {
			number(name.as_bytes()).is_some_and(|m| n.same(&m, property.kind))
		}));
	}
	// `L&` / `L_` compare exactly (loosely, `L_` would be `L`).
	let exact = property.values.iter().find(|v| v.names.iter().any(|name| {
		strict_name(name) && value.eq_ignore_ascii_case(name.as_bytes())
	}));
	if exact.is_some() { return exact; }
	let key = loose(value);
	if key.is_empty() { return None; }
	property.values.iter().find(|v| v.names.iter().any(|name| {
		!strict_name(name) && !(numeric && number(name.as_bytes()).is_some()) && loose(name.as_bytes()) == key
	}))
}

/// A number written as a property value.
#[derive(Debug, Clone, Copy)]
struct Number {
	/// Exact value when written as an integer or `a/b`: (numerator, denominator), reduced.
	exact: Option<(i128, i128)>,
	value: f64,
}

impl Number {
	fn same(&self, other: &Number, kind: Kind) -> bool {
		if let (Some(a), Some(b)) = (self.exact, other.exact) { return a == b; }
		match kind {
			// Perl accepts decimals accurate to three significant digits.
			Kind::Numeric => format!("{:.2e}", self.value) == format!("{:.2e}", other.value),
			_ => self.value == other.value,
		}
	}
}

/// Parse `[+-]digits[.digits][e[+-]digits]` or `[+-]digits/digits`;
/// underscores only between digits, white space only next to non-word characters.
fn number(text: &[u8]) -> Option<Number> {
	let word = |b: Option<&u8>| b.is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_');
	let mut s = Vec::with_capacity(text.len());
	for (i, &b) in text.iter().enumerate() {
		if b.is_ascii_whitespace() {
			let before = if i == 0 { None } else { text.get(i - 1) };
			if word(before) && word(text.get(i + 1)) { return None; }
			continue;
		}
		s.push(b);
	}
	let mut i = 0;
	let negative = match s.first() {
		Some(b'-') => { i = 1; true }
		Some(b'+') => { i = 1; false }
		_ => false,
	};
	let digits = |s: &[u8], i: &mut usize| -> Option<String> {
		let mut out = String::new();
		while let Some(&b) = s.get(*i) {
			if b.is_ascii_digit() { out.push(char::from(b)); }
			else if b == b'_' && !out.is_empty() && s.get(*i + 1).is_some_and(u8::is_ascii_digit) {}
			else { break; }
			*i += 1;
		}
		(!out.is_empty()).then_some(out)
	};
	let int = digits(&s, &mut i)?;
	let mut float = int.clone();
	let mut exact = true;
	let mut denominator = None;
	if s.get(i) == Some(&b'/') {
		i += 1;
		denominator = Some(digits(&s, &mut i)?);
	} else {
		if s.get(i) == Some(&b'.') {
			i += 1;
			float.push('.');
			float.push_str(&digits(&s, &mut i)?);
			exact = false;
		}
		if matches!(s.get(i), Some(b'e' | b'E')) {
			i += 1;
			float.push('e');
			if let Some(&sign @ (b'+' | b'-')) = s.get(i) {
				float.push(char::from(sign));
				i += 1;
			}
			float.push_str(&digits(&s, &mut i)?);
			exact = false;
		}
	}
	if i != s.len() { return None; }
	let sign = if negative { -1.0 } else { 1.0 };
	if let Some(den) = denominator {
		let num: i128 = int.parse().ok()?;
		let den: i128 = den.parse().ok()?;
		if den == 0 { return None; }
		let g = gcd(num, den);
		let num = if negative { -num } else { num };
		return Some(Number { exact: Some((num / g, den / g)), value: sign * (int.parse::<f64>().ok()? / den as f64) });
	}
	let value = sign * float.parse::<f64>().ok()?;
	let exact = if exact { int.parse::<i128>().ok().map(|n| (if negative { -n } else { n }, 1)) } else { None };
	Some(Number { exact, value })
}

fn gcd(mut a: i128, mut b: i128) -> i128 {
	a = a.abs();
	b = b.abs();
	while b != 0 { (a, b) = (b, a % b); }
	a.max(1)
}

/// A stored set (or its complement) as inclusive ranges.
fn set_ranges(set: u16) -> Vec<(u32, u32)> {
	let index = usize::from(set & !NEGATED);
	let list = match (SET_STARTS.get(index), SET_STARTS.get(index + 1)) {
		(Some(&a), Some(&b)) => LISTS.get(a as usize..b as usize).unwrap_or_default(),
		_ => &[],
	};
	let mut out = Vec::with_capacity(list.len() / 2 + 1);
	if set & NEGATED == 0 {
		for pair in list.chunks(2) {
			let end = pair.get(1).map_or(MAX, |&e| e - 1);
			out.push((pair[0], end));
		}
	} else {
		let mut next = 0;
		for pair in list.chunks(2) {
			if pair[0] > next { out.push((next, pair[0] - 1)); }
			next = pair.get(1).copied().unwrap_or(MAX + 1);
		}
		if next <= MAX { out.push((next, MAX)); }
	}
	out
}

/// Union of two sorted, disjoint range lists.
pub(in crate::perl) fn union(a: &[(u32, u32)], b: &[(u32, u32)]) -> Vec<(u32, u32)> {
	let mut all: Vec<(u32, u32)> = a.iter().chain(b).copied().collect();
	all.sort_unstable();
	let mut out: Vec<(u32, u32)> = Vec::with_capacity(all.len());
	for (lo, hi) in all {
		match out.last_mut() {
			Some(last) if lo <= last.1.saturating_add(1) => last.1 = last.1.max(hi),
			_ => out.push((lo, hi)),
		}
	}
	out
}
