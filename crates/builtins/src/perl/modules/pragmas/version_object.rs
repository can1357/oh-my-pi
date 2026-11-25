//! Numeric and dotted version objects, and Unicode character name lookup.

use std::{cmp::Ordering, rc::Rc};

use super::super::{alias, arg, boolean, define, text};
use crate::perl::{
	interp::{Cx, Interp, PResult, Ret},
	value::{HKey, PStr, Ref, Sv, Value, new_av, new_sv},
};

/// Register version object methods or the charnames lookup functions.
pub(super) fn install(i: &mut Interp<'_>, module: &str) {
	if module == "charnames" {
		define(i, module, &[("vianame", vianame), ("string_vianame", string_vianame), ("viacode", viacode)]);
		return;
	}
	define(i, module, &[("new", new), ("parse", new), ("declare", declare), ("qv", qv),
		("is_lax", is_lax), ("is_strict", is_strict), ("normal", normal), ("numify", numify),
		("stringify", stringify), ("is_alpha", is_alpha), ("is_qv", is_qv), ("vcmp", compare), ("vbool", vbool)]);
	for (op, method) in [("\"\"", "stringify"), ("0+", "numify"), ("<=>", "vcmp"), ("cmp", "vcmp"), ("bool", "vbool")] {
		i.set_overload("version", op, Value::str(method));
	}
	i.set_overload("version", "fallback", Value::Int(1));
}

/// Install `qv` or explicitly selected version helpers in the caller.
pub(super) fn import(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let pkg = i.package();
	let requested = if a.len() <= 1 { vec!["qv".to_owned()] } else { (1..a.len()).map(|n| text(&a, n)).collect() };
	for symbol in requested {
		if !matches!(symbol.as_str(), "qv" | "declare" | "is_lax" | "is_strict" | "VERSION") {
			return Err(i.die_msg(format!("\"{symbol}\" is not exported by the version module")));
		}
		let source = if symbol == "VERSION" { "UNIVERSAL::VERSION".to_owned() } else { format!("version::{symbol}") };
		alias(i, &source, &format!("{pkg}::{symbol}"), b'&');
	}
	Ok(Ret::empty())
}

struct Version {
	original: String,
	parts: Vec<u32>,
	dotted: bool,
	alpha: bool,
}
impl Version {
	/// Lax version parsing as `version->new` does it: leading/trailing whitespace ignored,
	/// decimal (`1.02`, `1.`, `.1`, `1.02_03`) or dotted-decimal (`v1.2`, `1.2.3`, `1.2.3_4`) forms.
	fn read(input: &str, forced: bool) -> Result<Self, &'static str> {
		let s = input.trim_matches(|c: char| c.is_ascii_whitespace());
		if s == "undef" { return Self::read("0", forced); }
		if s.is_empty() { return Err("version required"); }
		let b = s.as_bytes();
		let digits = |at: usize| b[at.min(b.len())..].iter().take_while(|c| c.is_ascii_digit()).count();
		if b[0] == b'-' { return Err("negative version number"); }
		let prefixed = b[0] == b'v';
		let mut at = usize::from(prefixed);
		let mut components: Vec<String> = Vec::new();
		let mut alpha = false;
		let integer = digits(at);
		if prefixed && integer == 0 { return Err("dotted-decimal versions require at least three parts"); }
		if !prefixed && integer == 0 && !(b[0] == b'.' && digits(1) > 0) { return Err("non-numeric data"); }
		components.push(s[at..at + integer].to_owned());
		at += integer;
		let mut dots = 0;
		loop {
			match b.get(at) {
				Some(b'.') => {
					let n = digits(at + 1);
					if n == 0 {
						let next = b.get(at + 1);
						if alpha { return Err("misplaced underscore"); }
						if dots == 0 && !prefixed && next.is_none_or(u8::is_ascii_whitespace) { at += 1; dots += 1; break; }
						if dots > 0 || prefixed { return Err(if next.is_none_or(u8::is_ascii_whitespace) { "trailing decimal" } else { "non-numeric data" }); }
						return Err("fractional part required");
					}
					if alpha { return Err("misplaced underscore"); }
					components.push(s[at + 1..at + 1 + n].to_owned());
					at += 1 + n;
					dots += 1;
				},
				Some(b'_') => {
					if alpha { return Err("multiple underscores"); }
					let n = digits(at + 1);
					if n == 0 { return Err("misplaced underscore"); }
					if dots == 0 { return Err(if prefixed { "non-numeric data" } else { "alpha without decimal" }); }
					alpha = true;
					if let Some(last) = components.last_mut() { last.push_str(&s[at + 1..at + 1 + n]); }
					at += 1 + n;
				},
				_ => break,
			}
		}
		if at < b.len() { return Err("non-numeric data"); }
		let dotted = forced || prefixed || dots > 1;
		let number = |text: &str| text.parse::<u32>().unwrap_or(u32::MAX);
		let mut parts = vec![if components[0].is_empty() { 0 } else { number(&components[0]) }];
		if dotted {
			parts.extend(components[1..].iter().map(|c| number(c)));
		} else if let Some(fraction) = components.get(1) {
			for chunk in fraction.as_bytes().chunks(3) {
				let text = std::str::from_utf8(chunk).unwrap_or("0");
				parts.push(number(text) * 10_u32.pow(3 - chunk.len() as u32));
			}
		}
		let original = if forced && !prefixed && dots == 1 { format!("v{s}") } else { s.to_owned() };
		Ok(Self { original, parts, dotted, alpha })
	}
	fn normal(&self) -> String {
		let mut z = format!("v{}", self.parts[0]);
		for index in 1..self.parts.len().max(3) { z.push_str(&format!(".{}", self.parts.get(index).copied().unwrap_or(0))); }
		z
	}
	fn numify(&self) -> String {
		let mut z = format!("{}.", self.parts[0]);
		let n = self.parts.len().max(if self.dotted { 3 } else { 2 });
		for index in 1..n { z.push_str(&format!("{:03}", self.parts.get(index).copied().unwrap_or(0))); }
		z
	}
}

fn parse_pstr(s: &PStr, forced: bool) -> Result<Version, &'static str> {
	let text = s.to_string_lossy();
	let direct = Version::read(&text, forced);
	// Version literals reach native code as their character sequence. Preserve the
	// common low component v-strings without interpreting ordinary invalid text.
	if direct.is_err() && s.chars().any(|ch| ch < 0x20 && !matches!(ch, 9..=13)) {
		use std::fmt::Write as _;
		let mut dotted = String::from("v");
		for (n, ch) in s.chars().enumerate() {
			if n != 0 { dotted.push('.'); }
			let _ = write!(dotted, "{ch}");
		}
		Version::read(&dotted, true)
	} else { direct }
}
fn unpack(v: &Value) -> Result<Version, &'static str> {
	if let Value::Ref(Ref::Array(a)) = v && a.blessed.borrow().is_some() {
		let parts = a.elems();
		let s = arg(&parts, 0).to_pstr();
		return Version::read(&s.to_string_lossy(), arg(&parts, 1).truthy());
	}
	if v.is_undef() { return Version::read("0", false); }
	parse_pstr(&v.to_pstr(), false)
}
/// Return the components stored in a `version` object for vector conversions.
pub(in crate::perl) fn version_vector(i: &mut Interp<'_>, value: &Value) -> PResult<Option<PStr>> {
	let Value::Ref(Ref::Array(a)) = value else { return Ok(None); };
	let Some(class) = a.blessed.borrow().clone() else { return Ok(None); };
	if class.as_ref() != "version" && !i.linear_isa(&class, "dfs").is_ok_and(|path| path.iter().any(|pkg| pkg.as_ref() == "version")) {
		return Ok(None);
	}
	let parsed = unpack(value).map_err(|e| i.die_msg(format!("Invalid version format ({e})")))?;
	if parsed.alpha {
		i.warn_category("printf", "vector argument not supported with alpha versions");
		return Ok(Some(PStr::default()));
	}
	let text = parsed.original.strip_prefix('v').unwrap_or(&parsed.original);
	let points = text.split('.').filter(|part| !part.is_empty()).map(|part| part.parse::<u32>().unwrap_or(u32::MAX));
	Ok(Some(PStr::from_codepoints(points)))
}
fn make(i: &mut Interp<'_>, class: &str, v: Value, force: bool) -> PResult<Ret> {
	let version = if matches!(&v, Value::Ref(Ref::Array(a)) if a.blessed.borrow().as_deref() == Some("version")) {
		unpack(&v)
	} else if v.is_undef() { Version::read("0", force) } else { parse_pstr(&i.stringify(&v)?, force) };
	let version = version.map_err(|e| i.die_msg(format!("Invalid version format ({e})")))?;
	let r = Ref::Array(new_av(vec![Value::str(&version.original), Value::Int(i64::from(version.dotted))]));
	r.bless(Rc::from(class));
	Ok(Ret::One(Value::Ref(r)))
}
fn new(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { make(i, &text(&a, 0), arg(&a, 1), false) }
fn declare(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if a.len() <= 1 { return make(i, "version", arg(&a, 0), true); }
	make(i, &text(&a, 0), arg(&a, 1), true)
}
fn qv(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { make(i, "version", arg(&a, 0), true) }
fn is_lax(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let value = arg(&a, 0);
	Ok(boolean(!value.is_undef() && lax(value.to_pstr().bytes.as_slice())))
}
fn is_strict(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let value = arg(&a, 0);
	Ok(boolean(!value.is_undef() && strict(value.to_pstr().bytes.as_slice())))
}
fn digit_run(s: &[u8], at: usize) -> usize { s.get(at..).map_or(0, |rest| rest.iter().take_while(|c| c.is_ascii_digit()).count()) }
/// Consumes `_DIGITS` when present; None when an underscore is not followed by digits.
fn alpha_part(s: &[u8], at: usize) -> Option<usize> {
	if s.get(at) != Some(&b'_') { return Some(at); }
	let n = digit_run(s, at + 1);
	(n > 0).then_some(at + 1 + n)
}
/// Consumes `(.DIGITS)*` greedily, returning the end and the count.
fn dotted_parts(s: &[u8], mut at: usize) -> (usize, usize) {
	let mut count = 0;
	while s.get(at) == Some(&b'.') && digit_run(s, at + 1) > 0 {
		at += 1 + digit_run(s, at + 1);
		count += 1;
	}
	(at, count)
}
/// version::regex's LAX: `undef`, a lax decimal, or a lax dotted-decimal version.
fn lax(s: &[u8]) -> bool {
	if s == b"undef" { return true; }
	let ends = |end: Option<usize>| end == Some(s.len());
	let integer = digit_run(s, 0);
	// LAX_DECIMAL: INT (.DIGITS | .)? ALPHA?  or  .DIGITS ALPHA?
	if integer > 0 {
		let mut at = integer;
		if s.get(at) == Some(&b'.') { at += 1 + digit_run(s, at + 1); }
		if ends(alpha_part(s, at)) { return true; }
	} else if s.first() == Some(&b'.') && digit_run(s, 1) > 0 && ends(alpha_part(s, 1 + digit_run(s, 1))) {
		return true;
	}
	// LAX_DOTTED: v INT ((.DIGITS)+ ALPHA?)?  or  INT? (.DIGITS){2,} ALPHA?
	if s.first() == Some(&b'v') {
		let integer = digit_run(s, 1);
		if integer == 0 { return false; }
		let (at, count) = dotted_parts(s, 1 + integer);
		return if count == 0 { at == s.len() } else { ends(alpha_part(s, at)) };
	}
	let (at, count) = dotted_parts(s, integer);
	count >= 2 && ends(alpha_part(s, at))
}
/// version::regex's STRICT: `0|[1-9]DIGITS*` with an optional fraction, or `v` and at least three 1-3 digit parts.
fn strict(s: &[u8]) -> bool {
	let strict_integer = |at: usize| {
		let n = digit_run(s, at);
		(n == 1 || (n > 1 && s[at] != b'0')).then_some(at + n)
	};
	if s.first() == Some(&b'v') {
		let Some(mut at) = strict_integer(1) else { return false };
		let mut count = 0;
		while s.get(at) == Some(&b'.') {
			let n = digit_run(s, at + 1);
			if !(1..=3).contains(&n) { return false; }
			at += 1 + n;
			count += 1;
		}
		return count >= 2 && at == s.len();
	}
	let Some(at) = strict_integer(0) else { return false };
	if at == s.len() { return true; }
	s[at] == b'.' && digit_run(s, at + 1) > 0 && at + 1 + digit_run(s, at + 1) == s.len()
}
fn get(i: &mut Interp<'_>, a: &[Sv]) -> PResult<Version> { unpack(&arg(a, 0)).map_err(|e| i.die_msg(format!("Invalid version format ({e})"))) }
fn stringify(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(Value::str(&get(i, &a)?.original))) }
fn normal(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(Value::str(&get(i, &a)?.normal()))) }
fn numify(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(Value::str(&get(i, &a)?.numify()))) }
fn is_alpha(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(boolean(get(i, &a)?.alpha)) }
fn is_qv(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(boolean(get(i, &a)?.dotted)) }
fn vbool(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(boolean(get(i, &a)?.parts.iter().any(|&n| n != 0))) }
fn compare(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let x = get(i, &a)?;
	let y = unpack(&arg(&a, 1)).map_err(|e| i.die_msg(format!("Invalid version format ({e})")))?;
	let n = x.parts.len().max(y.parts.len());
	let cmp = x.parts.iter().copied().chain(std::iter::repeat(0)).take(n).cmp(y.parts.iter().copied().chain(std::iter::repeat(0)).take(n));
	let cmp = match cmp { Ordering::Less => -1, Ordering::Equal => 0, Ordering::Greater => 1 };
	Ok(Ret::One(Value::Int(if arg(&a, 2).truthy() { -cmp } else { cmp })))
}

/// Install dynamically queried Unicode name aliases.
pub(super) fn charnames_import(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	for n in 1..a.len() {
		if text(&a, n) != ":alias" { continue; }
		if let Value::Ref(Ref::Hash(aliases)) = arg(&a, n + 1) {
			let saved = i.hv("charnames::aliases");
			for (name, sv) in aliases.entries().iter() {
				let value = sv.get();
				let cp = match &value {
					Value::Int(_) | Value::UInt(_) => u32::try_from(value.to_u64()).ok(),
					_ => lookup(i, &value.to_pstr().to_string_lossy()),
				}.ok_or_else(|| i.die_msg(format!("Unknown charname '{}'", value.to_pstr().to_string_lossy())))?;
				saved.entries_mut().insert(name.clone(), new_sv(Value::Int(cp.into())));
			}
		}
	}
	Ok(Ret::empty())
}
fn lookup(i: &mut Interp<'_>, name: &str) -> Option<u32> {
	if let Some(hex) = name.strip_prefix("U+") { return u32::from_str_radix(hex, 16).ok(); }
	let aliases = i.hv("charnames::aliases");
	if let Some(v) = aliases.entries().get(&HKey::new(&PStr::from_str(name))) { return Some(v.get().to_u64() as u32); }
	if let Some(cp) = match name {
		"NULL" | "NUL" => Some(0), "BELL" => Some(0x1f514), "BEL" | "ALERT" => Some(7), "BS" | "BACKSPACE" => Some(8),
		"HT" | "TAB" | "CHARACTER TABULATION" => Some(9), "LF" | "NL" | "LINE FEED" => Some(10),
		"VT" | "LINE TABULATION" => Some(11), "FF" | "FORM FEED" => Some(12), "CR" | "CARRIAGE RETURN" => Some(13),
		"ESC" | "ESCAPE" => Some(27), "DEL" | "DELETE" => Some(127), _ => None,
	} { return Some(cp); }
	if let Some((script, short)) = name.split_once(':') {
		let case = if short.starts_with(char::is_uppercase) { "CAPITAL" } else { "SMALL" };
		let expanded = format!("{} {case} LETTER {}", script.to_ascii_uppercase(), short.to_ascii_uppercase());
		return unicode_names2::character(&expanded).map(u32::from);
	}
	if name.bytes().any(|b| b.is_ascii_lowercase()) { return None; }
	unicode_names2::character(name).map(u32::from)
}
fn vianame(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let name = text(&a, 0);
	Ok(Ret::One(lookup(i, &name).map_or(Value::Undef, |cp| {
		if name.starts_with("U+") { Value::Str(PStr::from_codepoints([cp])) } else { Value::Int(cp.into()) }
	})))
}
fn string_vianame(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let cp = lookup(i, &text(&a, 0));
	Ok(Ret::One(cp.map_or(Value::Undef, |cp| Value::Str(PStr::from_codepoints([cp])))))
}
fn viacode(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let s = text(&a, 0);
	let cp = if let Some(s) = s.strip_prefix("U+").or_else(|| s.strip_prefix("0x")) { u32::from_str_radix(s, 16).ok() } else { s.parse().ok() };
	let Some(cp) = cp else { i.warn(format!("unexpected arg \"{s}\" to charnames::viacode()")); return Ok(Ret::empty()); };
	let name = match cp {
		0 => Some("NULL"), 7 => Some("ALERT"), 8 => Some("BACKSPACE"), 9 => Some("CHARACTER TABULATION"),
		10 => Some("LINE FEED"), 11 => Some("LINE TABULATION"), 12 => Some("FORM FEED"), 13 => Some("CARRIAGE RETURN"),
		27 => Some("ESCAPE"), 127 => Some("DELETE"), _ => None,
	};
	let name = name.map(str::to_owned).or_else(|| char::from_u32(cp).and_then(unicode_names2::name).map(|n| n.to_string()));
	Ok(Ret::One(name.map_or(Value::Undef, |s| Value::str(&s))))
}
