//! Encode's byte/character conversions and encoding object API (Encode POD).

use std::{fmt::Write as _, rc::Rc};

use crate::perl::{
	interp::{Cx, Interp, NativeFn, PResult, Ret},
	value::{HKey, PStr, Ref, Sv, Value, new_av, new_sv},
};

use super::byte_view;
use super::super::{arg, boolean, constant, define, export, export_tag, text, version};

#[path = "singlebyte.rs"]
mod singlebyte;

const DIE: i64 = 1;
const WARN: i64 = 2;
const RETURN: i64 = 4;
const LEAVE: i64 = 8;
const QQ: i64 = 256;
const HTML: i64 = 512;
const XML: i64 = 1024;
const PARTIAL: i64 = 2048;
const REPLACE: u32 = 0xfffd;

/// Install the Encode interface, check constants and object base class.
pub(super) fn load(i: &mut Interp<'_>, module: &str) -> PResult<()> {
	for (name, f, proto) in [
		("encode", encode as NativeFn, "$$;$"), ("decode", decode, "$$;$"),
		("encode_utf8", encode_utf8, "$"), ("decode_utf8", decode_utf8, "$;$"),
		("str2bytes", encode, "$$;$"), ("bytes2str", decode, "$$;$"), ("from_to", from_to, "$$$;$"),
		("find_encoding", find_encoding, "$;$"), ("find_mime_encoding", find_mime, "$;$"),
		("clone_encoding", clone_encoding, "$"), ("resolve_alias", resolve_alias, "$"),
		("is_utf8", is_utf8, "$;$"), ("_utf8_on", utf8_on, "$"), ("_utf8_off", utf8_off, "$"),
	] { i.define_native_proto(&format!("{module}::{name}"), f, proto); }
	define(i, module, &[("encodings", encodings), ("define_encoding", define_encoding), ("perlio_ok", perlio_ok)]);
	define(i, "Encode::Encoding", &[
		("name", object_name), ("mime_name", object_mime), ("encode", object_encode), ("decode", object_decode),
		("renew", renew), ("renewed", renewed), ("needs_lines", needs_lines), ("perlio_ok", object_perlio),
		("cat_decode", cat_decode),
	]);
	for class in ["Encode::utf8", "Encode::XS", "Encode::Unicode"] {
		i.av(&format!("{class}::ISA")).elems_mut().push(new_sv(Value::str("Encode::Encoding")));
	}
	for (name, value) in [
		("DIE_ON_ERR", DIE), ("WARN_ON_ERR", WARN), ("RETURN_ON_ERR", RETURN), ("LEAVE_SRC", LEAVE),
		("PERLQQ", QQ), ("HTMLCREF", HTML), ("XMLCREF", XML), ("STOP_AT_PARTIAL", PARTIAL),
		("FB_DEFAULT", 0), ("FB_CROAK", DIE), ("FB_QUIET", RETURN), ("FB_WARN", WARN | RETURN),
		("FB_PERLQQ", QQ | LEAVE), ("FB_HTMLCREF", HTML | LEAVE), ("FB_XMLCREF", XML | LEAVE),
	] { constant(i, &format!("{module}::{name}"), Value::Int(value)); }
	export(i, module, &[
		"decode", "decode_utf8", "encode", "encode_utf8", "str2bytes", "bytes2str", "encodings",
		"find_encoding", "find_mime_encoding", "clone_encoding",
	], &[
		"_utf8_off", "_utf8_on", "define_encoding", "from_to", "is_16bit", "is_8bit", "is_utf8",
		"perlio_ok", "resolve_alias", "utf8_downgrade", "utf8_upgrade", "DIE_ON_ERR", "WARN_ON_ERR",
		"RETURN_ON_ERR", "LEAVE_SRC", "PERLQQ", "HTMLCREF", "XMLCREF", "STOP_AT_PARTIAL",
		"FB_DEFAULT", "FB_CROAK", "FB_QUIET", "FB_WARN", "FB_PERLQQ", "FB_HTMLCREF", "FB_XMLCREF",
	]);
	let tags = i.hv("Encode::EXPORT_TAGS");
	let defaults = i.av("Encode::EXPORT");
	let optional = i.av("Encode::EXPORT_OK");
	let names: Vec<_> = defaults.elems().iter().chain(optional.elems().iter()).map(Rc::clone).collect();
	let all = new_av(Vec::new());
	all.replace_elems(names);
	tags.entries_mut().insert(key("all"), new_sv(Value::Ref(Ref::Array(all))));
	tags.entries_mut().insert(key("default"), new_sv(Value::Ref(Ref::Array(defaults))));
	export_tag(i, module, "fallbacks", &["FB_DEFAULT", "FB_CROAK", "FB_QUIET", "FB_WARN", "FB_PERLQQ", "FB_HTMLCREF", "FB_XMLCREF"]);
	export_tag(i, module, "fallback_all", &["FB_DEFAULT", "FB_CROAK", "FB_QUIET", "FB_WARN", "FB_PERLQQ", "FB_HTMLCREF", "FB_XMLCREF",
		"DIE_ON_ERR", "WARN_ON_ERR", "RETURN_ON_ERR", "LEAVE_SRC", "PERLQQ", "HTMLCREF", "XMLCREF", "STOP_AT_PARTIAL"]);
	version(i, module, "3.0801");
	Ok(())
}

#[derive(Clone, Copy)]
enum Kind { Utf8(bool), Unicode { units: u8, endian: Endian, ucs2: bool }, Ascii, Ctrl, Latin1, Null, Single(&'static [u16; 128]) }
#[derive(Clone, Copy, PartialEq, Eq)]
enum Endian { Big, Little, Bom }
#[derive(Clone, Copy)]
struct Encoding { name: &'static str, mime: Option<&'static str>, kind: Kind }
impl Encoding {
	const fn new(name: &'static str, mime: Option<&'static str>, kind: Kind) -> Self { Self { name, mime, kind } }
	const fn unicode(name: &'static str, mime: bool, units: u8, endian: Endian, ucs2: bool) -> Self {
		Self::new(name, if mime { Some(name) } else { None }, Kind::Unicode { units, endian, ucs2 })
	}
	fn class(self) -> &'static str {
		match self.kind { Kind::Utf8(_) => "Encode::utf8", Kind::Unicode { .. } => "Encode::Unicode", _ => "Encode::XS" }
	}
}
const UTF8: Encoding = Encoding::new("utf8", Some("UTF-8"), Kind::Utf8(false));
const STRICT: Encoding = Encoding::new("utf-8-strict", Some("UTF-8"), Kind::Utf8(true));
const ASCII: Encoding = Encoding::new("ascii", Some("US-ASCII"), Kind::Ascii);
const CTRL: Encoding = Encoding::new("ascii-ctrl", None, Kind::Ctrl);
const LATIN: Encoding = Encoding::new("iso-8859-1", Some("ISO-8859-1"), Kind::Latin1);
const NULL: Encoding = Encoding::new("null", None, Kind::Null);
const UNICODE: &[Encoding] = &[
	Encoding::unicode("UTF-16", true, 2, Endian::Bom, false), Encoding::unicode("UTF-16BE", true, 2, Endian::Big, false),
	Encoding::unicode("UTF-16LE", true, 2, Endian::Little, false), Encoding::unicode("UTF-32", true, 4, Endian::Bom, false),
	Encoding::unicode("UTF-32BE", true, 4, Endian::Big, false), Encoding::unicode("UTF-32LE", true, 4, Endian::Little, false),
	Encoding::unicode("UCS-2BE", false, 2, Endian::Big, true), Encoding::unicode("UCS-2LE", false, 2, Endian::Little, true),
];
fn key(s: &str) -> HKey { HKey::new(&PStr::from_str(s)) }
fn normalized(s: &str) -> impl Iterator<Item = u8> + '_ {
	s.bytes().filter(u8::is_ascii_alphanumeric).map(|b| b.to_ascii_lowercase())
}
fn lookup(name: &str, mime: bool) -> Option<Encoding> {
	let name = name.trim();
	let lo = name.to_ascii_lowercase().replace('_', "-");
	if mime {
		return [STRICT, ASCII, LATIN].into_iter().chain(UNICODE.iter().copied())
			.chain(singlebyte::TABLES.iter().map(|(name, mime, table)| Encoding::new(name, *mime, Kind::Single(table))))
			.find(|e| e.mime.is_some_and(|m| name.eq_ignore_ascii_case(m)));
	}
	match lo.as_str() {
		"utf8" => return Some(UTF8), "utf-8" | "utf-8-strict" | "utf8-strict" | "cp65001" => return Some(STRICT),
		"ascii" | "us-ascii" | "usascii" | "ansi-x3.4-1968" | "iso-ir-6" | "646" | "cp367" | "ascii7" => return Some(ASCII),
		"ascii-ctrl" => return Some(CTRL), "null" => return Some(NULL),
		"latin1" | "latin-1" | "l1" | "iso-ir-100" | "cp819" | "ibm819" => return Some(LATIN),
		_ => {},
	}
	if normalized(&lo).eq(normalized(LATIN.name)) { return Some(LATIN); }
	let mut alias = match lo.as_str() {
		"ucs-2" | "ucs2" => "UCS-2BE", "ucs-4" | "ucs4" => "UTF-32", "ucs-4be" | "ucs4be" => "UTF-32BE",
		"ucs-4le" | "ucs4le" => "UTF-32LE", "macintosh" | "mac" | "macroman" => "MacRoman",
		"latin2" | "latin-2" | "l2" => "iso-8859-2", "latin3" | "latin-3" | "l3" => "iso-8859-3",
		"latin4" | "latin-4" | "l4" => "iso-8859-4", "latin5" | "latin-5" | "l5" => "iso-8859-9",
		"latin6" | "latin-6" | "l6" => "iso-8859-10", "latin7" | "latin-7" | "l7" => "iso-8859-13",
		"latin8" | "latin-8" | "l8" => "iso-8859-14", "latin9" | "latin-9" | "l9" => "iso-8859-15",
		"latin10" | "latin-10" | "l10" => "iso-8859-16", _ => &lo,
	};
	let numbers;
	if let Some(n) = alias.strip_prefix("ibm").or_else(|| alias.strip_prefix("win").filter(|x| x.as_bytes().first().is_some_and(u8::is_ascii_digit))) {
		numbers = format!("cp{n}"); alias = &numbers;
	}
	UNICODE.iter().copied().find(|e| normalized(alias).eq(normalized(e.name))).or_else(|| {
		singlebyte::TABLES.iter().find_map(|(name, mime, table)| {
			(normalized(alias).eq(normalized(name)) || mime.is_some_and(|m| normalized(alias).eq(normalized(m))))
				.then(|| Encoding::new(name, *mime, Kind::Single(table)))
		})
	})
}
fn builtin_object(e: Encoding, state: bool) -> Value {
	let r = Ref::Array(new_av(vec![Value::str(e.name), Value::Int(i64::from(state))]));
	r.bless(Rc::from(e.class()));
	Value::Ref(r)
}
fn get_builtin(v: &Value) -> Option<(Encoding, bool)> {
	let Value::Ref(Ref::Array(a)) = v else { return None; };
	let class = a.blessed.borrow();
	if !matches!(class.as_deref(), Some("Encode::XS" | "Encode::utf8" | "Encode::Unicode")) { return None; }
	let data = a.elems();
	Some((lookup(&text(&data, 0), false)?, arg(&data, 1).truthy()))
}
fn get_encoding(i: &mut Interp<'_>, input: &Value, mime: bool) -> PResult<Option<Value>> {
	if matches!(input, Value::Ref(r) if r.blessed().is_some()) { return Ok(Some(input.clone())); }
	let name = i.stringify(input)?;
	let name = name.to_string_lossy();
	let registered = i.hv("Encode::Encoding");
	for candidate in [key(&name), key(&name.to_ascii_lowercase())] {
		if let Some(v) = registered.entries().get(&candidate) { return Ok(Some(v.get())); }
	}
	if let Some(e) = lookup(&name, mime) {
		let cache = i.hv("Encode::_builtin");
		let name = key(e.name);
		let mut cache = cache.entries_mut();
		return Ok(Some(cache.entry(name).or_insert_with(|| new_sv(builtin_object(e, false))).get()));
	}
	Ok(None)
}
fn find_encoding(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(get_encoding(i, &arg(&a, 0), false)?.unwrap_or(Value::Undef)))
}
fn find_mime(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(get_encoding(i, &arg(&a, 0), true)?.unwrap_or(Value::Undef)))
}
fn resolve_alias(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Some(v) = get_encoding(i, &arg(&a, 0), false)? else { return Ok(Ret::One(Value::Undef)); };
	if let Some((e, _)) = get_builtin(&v) { Ok(Ret::One(Value::str(e.name))) }
	else { i.call_method(v, "name", Vec::new(), Cx::Scalar) }
}
fn define_encoding(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let v = arg(&args, 0);
	let name = i.call_method(v.clone(), "name", Vec::new(), Cx::Scalar)?.scalar().to_pstr();
	let h = i.hv("Encode::Encoding");
	for name in std::iter::once(name).chain(args.iter().skip(1).map(|s| s.get().to_pstr())) {
		let name = name.to_string_lossy();
		let mut map = h.entries_mut();
		map.insert(key(&name), new_sv(v.clone()));
		map.insert(key(&name.to_ascii_lowercase()), new_sv(v.clone()));
	}
	Ok(Ret::One(v))
}
fn encodings(i: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	if cx != Cx::List { return Ok(Ret::One(Value::Undef)); }
	let mut names = if args.is_empty() { vec!["ascii", "ascii-ctrl", "cp1252", "iso-8859-1", "null", "utf-8-strict", "utf8"] }
	else { Vec::new() };
	let all = args.iter().any(|arg| arg.get().to_pstr().bytes == b":all");
	if all {
		names.extend(["ascii", "ascii-ctrl", "iso-8859-1", "null", "utf-8-strict", "utf8"]);
		names.extend(UNICODE.iter().map(|e| e.name));
		names.extend(singlebyte::TABLES.iter().map(|e| e.0));
	} else if args.iter().any(|arg| arg.get().to_pstr().bytes == b"Encode::Unicode") {
		names.extend(UNICODE.iter().map(|e| e.name));
	}
	let mut result: Vec<_> = names.into_iter().map(PStr::from_str).collect();
	if all || args.is_empty() {
		let h = i.hv("Encode::Encoding");
		result.extend(h.entries().keys().map(HKey::to_pstr));
	}
	result.sort_unstable();
	result.dedup();
	Ok(Ret::Many(result.into_iter().map(Value::Str).collect()))
}
fn object_name(_: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(get_builtin(&arg(&args, 0)).map_or(Value::Undef, |(e, _)| Value::str(e.name))))
}
fn object_mime(_: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(get_builtin(&arg(&args, 0)).and_then(|(e, _)| e.mime).map_or(Value::Undef, Value::str)))
}
fn renew(_: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let v = arg(&args, 0);
	Ok(Ret::One(if let Some((e, _)) = get_builtin(&v) && !matches!(e.class(), "Encode::XS") { builtin_object(e, true) } else { v }))
}
fn renewed(_: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(Value::Int(i64::from(get_builtin(&arg(&args, 0)).is_some_and(|(_, state)| state)))))
}
fn needs_lines(_: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(if matches!(get_builtin(&arg(&args, 0)), Some((Encoding { kind: Kind::Utf8(_) | Kind::Unicode { .. }, .. }, _))) { Value::Int(0) } else { Value::str("") }))
}
fn clone_encoding(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Some(v) = get_encoding(i, &arg(&args, 0), false)? else { return Ok(Ret::One(Value::Undef)); };
	i.call_method(v, "renew", Vec::new(), Cx::Scalar)
}
fn object_perlio(_: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(Value::Int(1))) }
fn perlio_ok(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Some(v) = get_encoding(i, &arg(&args, 0), false)? else { return Ok(Ret::One(Value::Undef)); };
	i.call_method(v, "perlio_ok", Vec::new(), Cx::Scalar)
}
fn set_flag(i: &mut Interp<'_>, args: &[Sv], on: bool) -> PResult<Ret> {
	let Some(cell) = args.first() else { return Ok(Ret::One(Value::Undef)); };
	let mut s = match i.read_sv(cell)? {
		Value::Undef => return Ok(Ret::One(Value::Undef)),
		Value::Str(s) => s,
		value => value.to_pstr(),
	};
	let old = s.utf8;
	s.utf8 = on;
	i.write_sv(cell, Value::Str(s))?;
	Ok(boolean(old))
}
fn utf8_on(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { set_flag(i, &a, true) }
fn utf8_off(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { set_flag(i, &a, false) }
fn is_utf8(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let s = arg(&a, 0).to_pstr();
	Ok(boolean(s.utf8 && (!arg(&a, 1).truthy() || std::str::from_utf8(&s.bytes).is_ok())))
}

#[derive(Clone, Copy)]
enum Direction { Encode, Decode }
impl Direction {
	fn name(self) -> &'static str { match self { Self::Encode => "encode", Self::Decode => "decode" } }
}
struct Check { flags: i64, cb: Option<crate::perl::value::Cv> }
impl Check {
	fn from(v: Value) -> Self {
		if let Value::Ref(Ref::Code(cv)) = v { Self { flags: LEAVE, cb: Some(cv) } }
		else { Self { flags: v.to_i64(), cb: None } }
	}
	fn update(&self) -> bool { self.flags != 0 && self.flags & LEAVE == 0 && self.cb.is_none() }
}
fn encode(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { convert(i, &a, Direction::Encode) }
fn decode(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { convert(i, &a, Direction::Decode) }
fn object_encode(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { convert(i, &a, Direction::Encode) }
fn object_decode(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { convert(i, &a, Direction::Decode) }
fn convert(i: &mut Interp<'_>, args: &[Sv], direction: Direction) -> PResult<Ret> {
	let name = arg(args, 0);
	let Some(object) = get_encoding(i, &name, false)? else { return Err(i.die_msg(format!("Unknown encoding '{}'", name.to_pstr().to_string_lossy()))); };
	if let Some((e, _)) = get_builtin(&object) { convert_arg(i, e, args, 1, direction) }
	else if let Value::Ref(r) = &object && let Some(c) = r.blessed() && let Some(cv) = i.find_method(&c, direction.name()) {
		let input = std::iter::once(new_sv(object)).chain(args.iter().skip(1).cloned()).collect();
		i.call_sub(&cv, input, Cx::Scalar)
	} else { Err(i.die_msg("Not an Encode::Encoding object")) }
}
fn encode_utf8(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { convert_arg(i, UTF8, &a, 0, Direction::Encode) }
fn decode_utf8(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { convert_arg(i, UTF8, &a, 0, Direction::Decode) }
fn convert_arg(i: &mut Interp<'_>, e: Encoding, args: &[Sv], idx: usize, dir: Direction) -> PResult<Ret> {
	let value = args.get(idx).map_or(Ok(Value::Undef), |cell| i.read_sv(cell))?;
	if value.is_undef() { return Ok(Ret::One(Value::Undef)); }
	let input = i.stringify(&value)?;
	let check = Check::from(arg(args, idx + 1));
	let (out, used) = conversion(i, e, &input, &check, dir)?;
	if check.update() && let Some(cell) = args.get(idx) {
		let rest = match dir {
			Direction::Decode => {
				let view = byte_view(&input).ok_or_else(|| i.die_msg("Wide character in subroutine entry"))?;
				PStr::from_bytes(&view[used..])
			}
			Direction::Encode => PStr::new(input.bytes[input.char_to_byte(used)..].to_vec(), input.utf8),
		};
		i.write_sv(cell, Value::Str(rest))?;
	}
	Ok(Ret::One(Value::Str(out)))
}
fn from_to(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Some(input) = args.first() else { return Ok(Ret::One(Value::Undef)); };
	let v = i.read_sv(input)?;
	if v.is_undef() { return Ok(Ret::One(Value::Undef)); }
	let plain = new_sv(v);
	let decode_args = [args.get(1).cloned().unwrap_or_else(|| new_sv(Value::Undef)), plain];
	let decoded = convert(i, &decode_args, Direction::Decode)?.scalar();
	let encode_args = [args.get(2).cloned().unwrap_or_else(|| new_sv(Value::Undef)), new_sv(decoded), new_sv(arg(&args, 3))];
	let out = convert(i, &encode_args, Direction::Encode)?.scalar();
	let len = match &out { Value::Str(s) => s.bytes.len(), v => v.to_pstr().bytes.len() };
	i.write_sv(input, out)?;
	Ok(Ret::One(Value::Int(len as i64)))
}
fn cat_decode(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Some((e, _)) = get_builtin(&arg(&args, 0)) else { return Err(i.die_msg("Not an Encode::Encoding object")); };
	let input = arg(&args, 2).to_pstr();
	let raw = byte_view(&input).ok_or_else(|| i.die_msg("Wide character in subroutine entry"))?;
	let start = usize::try_from(arg(&args, 3).to_i64()).unwrap_or(0).min(raw.len());
	let term = arg(&args, 4).to_pstr();
	let bytes = &raw[start..];
	let end = if term.bytes.is_empty() { None } else { memchr::memmem::find(bytes, &term.bytes).map(|n| n + term.bytes.len()) };
	let upto = end.unwrap_or(bytes.len());
	let (decoded, used) = conversion(i, e, &PStr::from_bytes(&bytes[..upto]), &Check::from(arg(&args, 5)), Direction::Decode)?;
	if let Some(out) = args.get(1) {
		let mut s = match i.read_sv(out)? { Value::Str(s) => s, v => v.to_pstr() };
		s.push(&decoded);
		i.write_sv(out, Value::Str(s))?;
	}
	if let Some(pos) = args.get(3) { i.write_sv(pos, Value::Int((start + used) as i64))?; }
	Ok(boolean(end.is_some_and(|n| used == n)))
}

fn conversion(i: &mut Interp<'_>, e: Encoding, text: &PStr, flags: &Check, dir: Direction) -> PResult<(PStr, usize)> {
	match dir {
		Direction::Encode => encode_bytes(i, e, text, flags),
		Direction::Decode => {
			let bytes = byte_view(text).ok_or_else(|| i.die_msg("Wide character in subroutine entry"))?;
			decode_bytes(i, e, &bytes, flags)
		}
	}
}
fn strict_cp(cp: u32) -> bool {
	cp <= 0x10ffff && !(0xd800..=0xdfff).contains(&cp) && !(0xfdd0..=0xfdef).contains(&cp) && cp & 0xffff < 0xfffe
}
fn encode_bytes(i: &mut Interp<'_>, e: Encoding, s: &PStr, check: &Check) -> PResult<(PStr, usize)> {
	if let Kind::Utf8(strict) = e.kind && (!strict || s.chars().all(strict_cp)) {
		let mut output = s.clone();
		let len = output.char_len();
		output.upgrade();
		output.utf8 = false;
		return Ok((output, len));
	}
	let mut out = Vec::with_capacity(s.bytes.len());
	let mut idx = 0;
	if let Kind::Unicode { units, endian: Endian::Bom, .. } = e.kind { put_word(&mut out, 0xfeff, units, Endian::Big); }
	for cp in s.chars() {
		let success = match e.kind {
			Kind::Utf8(strict) if !strict || strict_cp(cp) => { put_utf8(&mut out, cp); true }
			Kind::Unicode { units, endian, ucs2 } if strict_cp(cp) && (!ucs2 || cp <= 0xffff) => {
				if units == 2 && cp >= 0x10000 {
					put_word(&mut out, 0xd800 | ((cp - 0x10000) >> 10), units, endian);
					put_word(&mut out, 0xdc00 | ((cp - 0x10000) & 0x3ff), units, endian);
				} else { put_word(&mut out, cp, units, endian); }
				true
			}
			Kind::Ascii if cp < 128 => { out.push(cp as u8); true }
			Kind::Ctrl if cp < 32 => { out.push(cp as u8); true }
			Kind::Latin1 if cp <= 255 => { out.push(cp as u8); true }
			Kind::Single(_) if cp < 128 => { out.push(cp as u8); true }
			Kind::Single(table) if cp < 0xffff => {
				if let Some(index) = table.iter().position(|&c| u32::from(c) == cp) { out.push(128 + index as u8); true } else { false }
			}
			_ => false,
		};
		if !success && !encode_error(i, e, cp, check, &mut out)? { break; }
		idx += 1;
	}
	Ok((PStr::new(out, false), idx))
}
fn put_word(out: &mut Vec<u8>, cp: u32, units: u8, endian: Endian) {
	let bytes = if endian == Endian::Little { cp.to_le_bytes() } else { cp.to_be_bytes() };
	match (units, endian) { (4, _) => out.extend_from_slice(&bytes), (2, Endian::Little) => out.extend_from_slice(&bytes[..2]), _ => out.extend_from_slice(&bytes[2..]) }
}
fn put_utf8(out: &mut Vec<u8>, cp: u32) {
	if cp <= 127 { out.push(cp as u8); return; }
	let (lead, tails) = match cp {
		0..=0x7ff => (0xc0, 1), 0x800..=0xffff => (0xe0, 2), 0x10000..=0x1fffff => (0xf0, 3),
		0x200000..=0x3ffffff => (0xf8, 4), 0x4000000..=0x7fffffff => (0xfc, 5), _ => (0xfe, 6),
	};
	let cp = u64::from(cp);
	out.push(lead | (cp >> (tails * 6)) as u8);
	for n in (0..tails).rev() { out.push(0x80 | ((cp >> (n * 6)) & 0x3f) as u8); }
}
fn get_utf8(bytes: &[u8], strict: bool) -> (Option<u32>, usize, bool) {
	let b = bytes[0];
	let (mut cp, width, min) = match b {
		0..=0x7f => return (Some(u32::from(b)), 1, false),
		0xc0..=0xdf => (u64::from(b & 31), 2, 0x80), 0xe0..=0xef => (u64::from(b & 15), 3, 0x800),
		0xf0..=0xf7 => (u64::from(b & 7), 4, 0x10000), 0xf8..=0xfb => (u64::from(b & 3), 5, 0x200000),
		0xfc..=0xfd => (u64::from(b & 1), 6, 0x4000000), 0xfe => (0, 7, 0x80000000),
		_ => return (None, 1, false),
	};
	let mut used = 1;
	for &b in bytes.iter().skip(1).take(width - 1) {
		if b & 0xc0 != 0x80 { return (None, used, false); }
		cp = (cp << 6) | u64::from(b & 63);
		used += 1;
	}
	if used < width { return (None, used, true); }
	let cp = u32::try_from(cp).ok().filter(|&n| n >= min && (!strict || strict_cp(n)));
	(cp, used, false)
}
fn decode_bytes(i: &mut Interp<'_>, e: Encoding, bytes: &[u8], check: &Check) -> PResult<(PStr, usize)> {
	let mut out = PStr::new(Vec::with_capacity(bytes.len()), true);
	let mut at = 0;
	match e.kind {
		Kind::Unicode { units, mut endian, ucs2 } => {
			let size = usize::from(units);
			if endian == Endian::Bom {
				match read_word(bytes, units, Endian::Big) {
					Some(0xfeff) => { endian = Endian::Big; at = size; }
					Some(0xfffe) if units == 2 => { endian = Endian::Little; at = size; }
					Some(0xfffe0000) if units == 4 => { endian = Endian::Little; at = size; }
					_ => endian = Endian::Big,
				}
			}
			while let Some(mut cp) = read_word(&bytes[at..], units, endian) {
				let mut used = size;
				if units == 2 && !ucs2 && (0xd800..=0xdbff).contains(&cp) {
					if let Some(low @ 0xdc00..=0xdfff) = read_word(&bytes[at + size..], units, endian) {
						cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
						used += size;
					} else if at + size == bytes.len() && check.flags & (PARTIAL | RETURN) != 0 { break; }
				}
				if strict_cp(cp) { out.push_char(cp); }
				else if !decode_error(i, e, &bytes[at..at + used], check, &mut out)? { break; }
				at += used;
			}
		}
		_ => while at < bytes.len() {
			let b = bytes[at];
			let (cp, used, partial) = match e.kind {
				Kind::Utf8(strict) => get_utf8(&bytes[at..], strict),
				Kind::Ascii => ((b < 128).then_some(u32::from(b)), 1, false),
				Kind::Ctrl => ((b < 32).then_some(u32::from(b)), 1, false),
				Kind::Latin1 => (Some(u32::from(b)), 1, false), Kind::Null => (None, 1, false),
				Kind::Single(table) => {
					let cp = if b < 128 { u32::from(b) } else { u32::from(table[usize::from(b - 128)]) };
					((cp != 0xffff).then_some(cp), 1, false)
				}
				Kind::Unicode { .. } => break,
			};
			if let Some(cp) = cp { out.push_char(cp); }
			else if partial && check.flags & PARTIAL != 0 || !decode_error(i, e, &bytes[at..at + used], check, &mut out)? { break; }
			at += used;
		},
	}
	Ok((out, at))
}
fn read_word(bytes: &[u8], units: u8, endian: Endian) -> Option<u32> {
	if units == 4 {
		let bytes = *bytes.first_chunk::<4>()?;
		Some(if endian == Endian::Little { u32::from_le_bytes(bytes) } else { u32::from_be_bytes(bytes) })
	} else {
		let bytes = *bytes.first_chunk::<2>()?;
		Some(u32::from(if endian == Endian::Little { u16::from_le_bytes(bytes) } else { u16::from_be_bytes(bytes) }))
	}
}
fn encoding_error(i: &mut Interp<'_>, flags: &Check, message: impl FnOnce() -> String) -> PResult<bool> {
	if flags.flags & DIE != 0 { return Err(i.die_msg(message())); }
	if flags.flags & WARN != 0 { i.warn(message()); }
	Ok(flags.flags & RETURN == 0)
}
fn encode_error(i: &mut Interp<'_>, e: Encoding, cp: u32, flags: &Check, out: &mut Vec<u8>) -> PResult<bool> {
	let name = e.mime.unwrap_or(e.name);
	if !encoding_error(i, flags, || format!("\"\\x{{{cp:04x}}}\" does not map to {}", if matches!(e.kind, Kind::Utf8(_)) { name } else { e.name }))? { return Ok(false); }
	if let Some(cb) = &flags.cb {
		let s = i.call_sub(cb, vec![new_sv(Value::Int(i64::from(cp)))], Cx::Scalar)?.scalar().to_pstr();
		let rep = byte_view(&s).ok_or_else(|| i.die_msg("Wide character in subroutine entry"))?;
		out.extend_from_slice(&rep);
	} else if flags.flags & (QQ | HTML | XML) != 0 {
		use std::io::Write as _;
		if flags.flags & QQ != 0 { let _ = write!(out, "\\x{{{cp:04x}}}"); }
		else if flags.flags & HTML != 0 { let _ = write!(out, "&#{cp};"); }
		else { let _ = write!(out, "&#x{cp:x};"); }
	} else {
		match e.kind {
			Kind::Utf8(_) => put_utf8(out, REPLACE),
			Kind::Unicode { units, endian, .. } => put_word(out, REPLACE, units, endian),
			_ => out.push(b'?'),
		}
	}
	Ok(true)
}
fn decode_error(i: &mut Interp<'_>, e: Encoding, bytes: &[u8], flags: &Check, out: &mut PStr) -> PResult<bool> {
	let name = if matches!(e.kind, Kind::Utf8(true)) { "UTF-8" } else { e.name };
	if !encoding_error(i, flags, || {
		let mut invalid = String::new();
		for &b in bytes { let _ = write!(invalid, "\\x{b:02X}"); }
		format!("{name} \"{invalid}\" does not map to Unicode")
	})? { return Ok(false); }
	if let Some(cb) = &flags.cb {
		let args = bytes.iter().map(|&b| new_sv(Value::Int(i64::from(b)))).collect();
		let rep = i.call_sub(cb, args, Cx::Scalar)?.scalar().to_pstr();
		out.push(&rep);
	} else if flags.flags & (QQ | HTML | XML) != 0 {
		use std::io::Write as _;
		for &b in bytes {
			if matches!(e.kind, Kind::Utf8(_)) && flags.flags & QQ == 0 {
				if flags.flags & HTML != 0 { let _ = write!(out.bytes, "&#{b};"); }
				else { let _ = write!(out.bytes, "&#x{b:02X};"); }
			} else { let _ = write!(out.bytes, "\\x{b:02X}"); }
		}
	} else { out.push_char(REPLACE); }
	Ok(true)
}
