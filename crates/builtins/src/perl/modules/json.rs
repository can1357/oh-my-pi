//! Original JSON::PP encoder/decoder and object API (JSON::PP POD).

use std::{collections::HashSet, fmt::Write as _, io::Write as _, rc::Rc};

use crate::perl::{
	interp::{Cx, Interp, PResult, Ret},
	limits::check_len,
	value::{HKey, Hv, PStr, Ref, Sv, Value, new_av, new_hv, new_sv, parse_number},
};

use super::{arg, constant, define, export, version};

const BOOL: &str = "JSON::PP::Boolean";
const DEPTH_LIMIT: usize = 512;
const DEPTH: &str = "json text or perl structure exceeds maximum nesting level (max_depth set too low?)";
const MALFORMED: &str = "malformed JSON string, neither array, object, number, string or atom";
const STRING_END: &str = "unexpected end of string while parsing JSON string";

/// Install JSON::PP's function exports, object methods and Boolean overloads.
pub(super) fn load(i: &mut Interp<'_>, module: &str) -> PResult<()> {
	define(i, module, &[
		("new", new), ("encode_json", encode_json), ("decode_json", decode_json),
		("from_json", from_json), ("to_json", to_json), ("is_bool", is_bool),
		("encode", encode), ("decode", decode), ("decode_prefix", decode_prefix),
		("pretty", pretty), ("indent_length", indent_length), ("get_indent_length", get_indent_length),
		("max_depth", max_depth), ("get_max_depth", get_max_depth), ("max_size", max_size), ("get_max_size", get_max_size),
		("sort_by", sort_by), ("filter_json_object", filter_object),
		("filter_json_single_key_object", filter_single), ("boolean_values", boolean_values),
		("get_boolean_values", get_boolean_values), ("incr_parse", incr_parse), ("incr_text", incr_text),
		("incr_reset", incr_reset), ("incr_skip", incr_skip),
	]);
	for (name, n) in [("true", 1), ("false", 0)] {
		let value = Ref::Scalar(new_sv(Value::Int(n)));
		value.bless(Rc::from(BOOL));
		let value = Value::Ref(value);
		let name = format!("{module}::{name}");
		i.sv(&name).set(value.clone());
		constant(i, &name, value);
	}
	i.define_native("JSON::PP::Boolean::_value", bool_value);
	if let Some(cv) = i.glob("JSON::PP::Boolean::_value").code.borrow().clone() {
		let handler = Value::Ref(Ref::Code(cv));
		for op in ["0+", "bool", "\"\""] { i.set_overload(BOOL, op, handler.clone()); }
	}
	macro_rules! flags {
		($(($name:ident, $get:ident, $flag:ident)),* $(,)?) => {{
			$(
				fn $name(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { set_flag(i, &a, Flag::$flag) }
				fn $get(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { get_flag(i, &a, Flag::$flag) }
			)*
			define(i, module, &[$((stringify!($name), $name), (stringify!($get), $get),)*]);
		}};
	}
	flags!(
		(ascii, get_ascii, Ascii), (latin1, get_latin1, Latin1), (utf8, get_utf8, Utf8),
		(indent, get_indent, Indent), (space_before, get_space_before, Before), (space_after, get_space_after, After),
		(canonical, get_canonical, Canonical), (relaxed, get_relaxed, Relaxed), (loose, get_loose, Loose),
		(allow_nonref, get_allow_nonref, Nonref), (allow_unknown, get_allow_unknown, Unknown),
		(allow_blessed, get_allow_blessed, Blessed), (convert_blessed, get_convert_blessed, Convert),
		(allow_tags, get_allow_tags, Tags), (allow_singlequote, get_allow_singlequote, Single),
		(allow_barekey, get_allow_barekey, Bare), (escape_slash, get_escape_slash, Slash),
		(allow_bignum, get_allow_bignum, Bignum), (shrink, get_shrink, Shrink),
	);
	version(i, module, "4.06");
	export(i, module, &["encode_json", "decode_json", "from_json", "to_json"], &[]);
	Ok(())
}

#[derive(Clone, Copy)]
enum Flag { Ascii, Latin1, Utf8, Indent, Before, After, Canonical, Relaxed, Loose, Nonref, Unknown, Blessed, Convert, Tags, Single, Bare, Slash, Bignum, Shrink }
impl Flag {
	fn mask(self) -> i64 { 1 << self as usize }
}

struct Options {
	bits: i64,
	depth: usize,
	size: usize,
	indent: usize,
	sort: Value,
	filter: Value,
	single: Option<Hv>,
	booleans: Option<(Value, Value)>,
}
impl Options {
	fn plain() -> Self {
		Self { bits: Flag::Nonref.mask() | Flag::Utf8.mask(), depth: DEPTH_LIMIT, size: 0,
			indent: 3, sort: Value::Undef, filter: Value::Undef, single: None, booleans: None }
	}
	fn from_object(h: &Hv) -> Self {
		let raw = get(h, "booleans");
		let booleans = if let Value::Ref(Ref::Array(a)) = raw {
			let cells = a.elems();
			Some((arg(&cells, 0), arg(&cells, 1)))
		} else { None };
		Self { bits: get(h, "flags").to_i64(), depth: size_value(get(h, "depth")).min(DEPTH_LIMIT),
			size: size_value(get(h, "size")),
			// The object hash is user data; keep `indent` within indent_length()'s 0..=15 range.
			indent: size_value(get(h, "indent")).min(15),
			sort: get(h, "sort"), filter: get(h, "filter"),
			single: if let Value::Ref(Ref::Hash(h)) = get(h, "single") { Some(h) } else { None }, booleans }
	}
	fn has(&self, flag: Flag) -> bool { self.bits & flag.mask() != 0 }
}

fn get(h: &Hv, key: &str) -> Value { get_key(h, &HKey::new(&PStr::from_str(key))) }
fn get_key(h: &Hv, key: &HKey) -> Value {
	h.entries().get(key).map_or(Value::Undef, |s| s.get())
}
fn put(h: &Hv, key: &str, value: Value) { h.entries_mut().insert(HKey::new(&PStr::from_str(key)), new_sv(value)); }
fn remove(h: &Hv, key: &str) -> Value {
	h.entries_mut().shift_remove(&HKey::new(&PStr::from_str(key))).map_or(Value::Undef, |s| s.replace(Value::Undef))
}
fn size_value(v: Value) -> usize { usize::try_from(v.to_i64()).unwrap_or(0) }
fn object(i: &mut Interp<'_>, args: &[Sv]) -> PResult<(Value, Hv)> {
	let v = arg(args, 0);
	let Value::Ref(Ref::Hash(h)) = &v else { return Err(i.die_msg("Not a HASH reference")); };
	Ok((v.clone(), Rc::clone(h)))
}
fn new(_: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let h = new_hv();
	put(&h, "flags", Value::Int(Flag::Nonref.mask()));
	put(&h, "depth", Value::Int(512));
	put(&h, "size", Value::Int(0));
	put(&h, "indent", Value::Int(3));
	let v = Ref::Hash(h);
	let class = match arg(&args, 0) {
		Value::Ref(r) => r.blessed().unwrap_or_else(|| Rc::from("JSON::PP")),
		v => Rc::from(v.to_pstr().to_string_lossy().as_ref()),
	};
	v.bless(class);
	Ok(Ret::One(Value::Ref(v)))
}
fn test_arg(i: &mut Interp<'_>, args: &[Sv]) -> PResult<bool> {
	Ok(match args.get(1) { Some(sv) => i.read_sv(sv)?.truthy(), None => true })
}
fn set_flags(h: &Hv, mask: i64, on: bool) {
	let bits = get(h, "flags").to_i64();
	put(h, "flags", Value::Int(if on { bits | mask } else { bits & !mask }));
}
fn set_flag(i: &mut Interp<'_>, args: &[Sv], flag: Flag) -> PResult<Ret> {
	let (v, h) = object(i, args)?;
	set_flags(&h, flag.mask(), test_arg(i, args)?);
	Ok(Ret::One(v))
}
fn get_flag(i: &mut Interp<'_>, args: &[Sv], flag: Flag) -> PResult<Ret> {
	let (_, h) = object(i, args)?;
	Ok(Ret::One(if get(&h, "flags").to_i64() & flag.mask() != 0 { Value::Int(1) } else { Value::str("") }))
}
fn pretty(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (v, h) = object(i, &args)?;
	set_flags(&h, Flag::Indent.mask() | Flag::Before.mask() | Flag::After.mask(), test_arg(i, &args)?);
	Ok(Ret::One(v))
}
fn option(i: &mut Interp<'_>, args: &[Sv], key: &str, default: Value) -> PResult<Ret> {
	let (v, h) = object(i, args)?;
	put(&h, key, match args.get(1) { Some(s) => i.read_sv(s)?, None => default });
	Ok(Ret::One(v))
}
fn get_option(i: &mut Interp<'_>, args: &[Sv], key: &str) -> PResult<Ret> { Ok(Ret::One(get(&object(i, args)?.1, key))) }
fn max_depth(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { option(i, &a, "depth", Value::Int(0x8000_0000)) }
fn get_max_depth(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { get_option(i, &a, "depth") }
fn max_size(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { option(i, &a, "size", Value::Int(0)) }
fn get_max_size(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { get_option(i, &a, "size") }
fn indent_length(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (v, h) = object(i, &args)?;
	let n = arg(&args, 1).to_i64();
	if (0..=15).contains(&n) { put(&h, "indent", Value::Int(n)); }
	else { i.warn("The acceptable range of indent_length() is 0 to 15."); }
	Ok(Ret::One(v))
}
fn get_indent_length(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { get_option(i, &a, "indent") }
fn sort_by(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { option(i, &a, "sort", Value::Int(1)) }
fn filter_object(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { option(i, &a, "filter", Value::Undef) }
fn filter_single(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (v, h) = object(i, &args)?;
	let f = match get(&h, "single") {
		Value::Ref(Ref::Hash(h)) => h,
		_ => { let f = new_hv(); put(&h, "single", Value::Ref(Ref::Hash(Rc::clone(&f)))); f }
	};
	let key = HKey::new(&arg(&args, 1).to_pstr());
	let cv = arg(&args, 2);
	if cv.is_undef() { f.entries_mut().shift_remove(&key); }
	else { f.entries_mut().insert(key, new_sv(cv)); }
	Ok(Ret::One(v))
}
fn boolean_values(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (v, h) = object(i, &args)?;
	let pair = if args.len() < 2 { Value::Undef } else { Value::Ref(Ref::Array(new_av(vec![arg(&args, 1), arg(&args, 2)]))) };
	put(&h, "booleans", pair);
	Ok(Ret::One(v))
}
fn get_boolean_values(i: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let (_, h) = object(i, &args)?;
	let values = if let Value::Ref(Ref::Array(a)) = get(&h, "booleans") {
		let a = a.elems();
		vec![arg(&a, 0), arg(&a, 1)]
	} else { Vec::new() };
	Ok(if cx == Cx::List { Ret::Many(values) } else { Ret::One(values.into_iter().last().unwrap_or(Value::Undef)) })
}
fn bool_value(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(if let Value::Ref(Ref::Scalar(s)) = arg(&args, 0) { i.read_sv(&s)? } else { Value::Undef }))
}
fn is_bool(_: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(if matches!(arg(&args, 0), Value::Ref(r) if r.blessed().as_deref() == Some(BOOL)) { Value::Int(1) } else { Value::Undef }))
}
fn to_json(i: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> { Err(i.die_msg("JSON::PP::to_json has been renamed to encode_json.")) }
fn from_json(i: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> { Err(i.die_msg("JSON::PP::from_json has been renamed to decode_json.")) }
fn encode_json(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { encode_value(i, arg(&args, 0), Options::plain()) }
fn encode(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (_, h) = object(i, &args)?;
	encode_value(i, arg(&args, 1), Options::from_object(&h))
}
fn encode_value(i: &mut Interp<'_>, value: Value, opts: Options) -> PResult<Ret> {
	if !opts.has(Flag::Nonref) && !matches!(value, Value::Ref(Ref::Array(_) | Ref::Hash(_))) {
		return Err(i.die_msg("hash- or arrayref expected (not a simple scalar, use allow_nonref to allow this)"));
	}
	let mut w = Encoder { opts, out: PStr::default(), active: HashSet::new() };
	w.value(i, &value, 0)?;
	if w.opts.has(Flag::Indent) { w.out.bytes.push(b'\n'); }
	if w.opts.has(Flag::Utf8) {
		w.out.upgrade();
		w.out.utf8 = false;
	} else if !w.opts.has(Flag::Ascii) && !w.opts.has(Flag::Latin1) && !w.opts.has(Flag::Shrink) { w.out.upgrade(); }
	if w.opts.has(Flag::Shrink) && w.out.utf8 {
		if let Some(bytes) = w.out.downgraded() { w.out = PStr::new(bytes, false); }
	}
	Ok(Ret::One(Value::Str(w.out)))
}

struct Encoder { opts: Options, out: PStr, active: HashSet<usize> }
impl Encoder {
	fn ascii(&mut self, s: &[u8]) { self.out.bytes.extend_from_slice(s); }
	/// Newline plus `indent * depth` spaces under `pretty`; the width is checked against the shared buffer limit.
	fn line(&mut self, i: &mut Interp<'_>, depth: usize) -> PResult<()> {
		if self.opts.has(Flag::Indent) {
			let len = self.opts.indent.checked_mul(depth).and_then(|pad| pad.checked_add(self.out.bytes.len() + 1))
				.ok_or_else(|| "Out of memory during string extend".to_owned())
				.and_then(|len| check_len(len, "string").map(|()| len))
				.map_err(|e| i.die_msg(e))?;
			self.out.bytes.push(b'\n');
			self.out.bytes.resize(len, b' ');
		}
		Ok(())
	}
	fn string(&mut self, text: &PStr) {
		let bound = if self.opts.has(Flag::Ascii) { 0x7f } else if self.opts.has(Flag::Latin1) { 0xff } else { u32::MAX };
		self.ascii(b"\"");
		for cp in text.chars() {
			match cp {
				0x22 => self.ascii(b"\\\""), 0x5c => self.ascii(b"\\\\"),
				0x2f if self.opts.has(Flag::Slash) => self.ascii(b"\\/"),
				0x08 => self.ascii(b"\\b"), 0x0c => self.ascii(b"\\f"),
				0x0a => self.ascii(b"\\n"), 0x0d => self.ascii(b"\\r"), 0x09 => self.ascii(b"\\t"),
				0..=0x1f => { let _ = write!(self.out.bytes, "\\u{cp:04x}"); }
				_ if cp > bound => {
					if cp <= 0xffff { let _ = write!(self.out.bytes, "\\u{cp:04x}"); }
					else {
						let h = 0xd800 + ((cp - 0x1_0000) >> 10);
						let l = 0xdc00 + ((cp - 0x1_0000) & 0x3ff);
						let _ = write!(self.out.bytes, "\\u{h:04x}\\u{l:04x}");
					}
				}
				_ => self.out.push_char(cp),
			}
		}
		self.ascii(b"\"");
	}
	fn value(&mut self, i: &mut Interp<'_>, v: &Value, depth: usize) -> PResult<()> {
		match v {
			Value::Undef => self.ascii(b"null"),
			Value::Int(_) | Value::UInt(_) | Value::Num(_) => self.ascii(&v.to_pstr().bytes),
			Value::Str(s) => self.string(s),
			Value::Dual(d) => {
				let n = d.num.into_value().to_pstr();
				if n == d.str { self.ascii(&n.bytes); } else { self.string(&d.str); }
			}
			Value::Ref(reference) => self.reference(i, reference, depth)?,
			_ if self.opts.has(Flag::Unknown) => self.ascii(b"null"),
			_ => return Err(i.die_msg("encountered non-reference, but allow_nonref is not enabled")),
		}
		Ok(())
	}
	fn reference(&mut self, i: &mut Interp<'_>, r: &Ref, depth: usize) -> PResult<()> {
		if let Some(class) = r.blessed() {
			if class.as_ref() == BOOL {
				let on = matches!(r, Ref::Scalar(s) if i.read_sv(s)?.truthy());
				self.ascii(if on { b"true" } else { b"false" });
				return Ok(());
			}
			let v = Value::Ref(r.clone());
			if self.opts.has(Flag::Tags) && let Some(cv) = i.find_method(&class, "FREEZE") {
				let args = vec![new_sv(v), new_sv(Value::str("JSON"))];
				let data = i.call_sub(&cv, args, Cx::List)?.list();
				self.ascii(b"(");
				self.string(&PStr::from_str(&class));
				self.ascii(b")[");
				for (n, v) in data.iter().enumerate() {
					if n != 0 { self.ascii(b","); }
					self.out.push(&v.to_pstr());
				}
				self.ascii(b"]");
				return Ok(());
			}
			if self.opts.has(Flag::Convert) && let Some(cv) = i.find_method(&class, "TO_JSON") {
				if depth >= self.opts.depth || !self.active.insert(r.addr()) { return Err(i.die_msg("TO_JSON method returned same object as was passed instead of a new one")); }
				let replacement = i.call_sub(&cv, vec![new_sv(v)], Cx::Scalar)?.scalar();
				let result = self.value(i, &replacement, depth + 1);
				self.active.remove(&r.addr());
				return result;
			}
			if self.opts.has(Flag::Blessed) { self.ascii(b"null"); return Ok(()); }
			return Err(i.die_msg(format!("encountered object '{}', but neither allow_blessed, convert_blessed nor allow_tags settings are enabled (or TO_JSON/FREEZE method missing)", v.to_pstr().to_string_lossy())));
		}
		if let Ref::Scalar(s) = r {
			let value = i.read_sv(s)?;
			if !matches!(value, Value::Undef | Value::Ref(_) | Value::Glob(_)) {
				let text = value.to_pstr();
				match text.chars().next().filter(|_| text.char_len() == 1) {
					Some(48) => { self.ascii(b"false"); return Ok(()); }
					Some(49) => { self.ascii(b"true"); return Ok(()); }
					_ => {},
				}
			}
		}
		if !matches!(r, Ref::Array(_) | Ref::Hash(_)) {
			if self.opts.has(Flag::Unknown) { self.ascii(b"null"); return Ok(()); }
			return Err(i.die_msg("cannot encode reference to scalar"));
		}
		if depth >= self.opts.depth || !self.active.insert(r.addr()) { return Err(i.die_msg(DEPTH)); }
		let result = match r {
			Ref::Array(array) => {
				let items = array.elems().clone();
				self.ascii(b"[");
				for (idx, cell) in items.iter().enumerate() {
					if idx != 0 { self.ascii(b","); }
					self.line(i, depth + 1)?;
					let v = i.read_sv(cell)?;
					self.value(i, &v, depth + 1)?;
				}
				if !items.is_empty() { self.line(i, depth)?; }
				self.ascii(b"]");
				Ok(())
			}
			Ref::Hash(hash) => self.hash(i, hash, depth),
			_ => Ok(()),
		};
		self.active.remove(&r.addr());
		result
	}
	fn hash(&mut self, i: &mut Interp<'_>, hash: &Hv, depth: usize) -> PResult<()> {
		let mut items: Vec<_> = hash.entries().iter().map(|(k, v)| (k.to_pstr(), Rc::clone(v))).collect();
		let comparator = match &self.opts.sort {
			Value::Ref(Ref::Code(cv)) => Some(Rc::clone(cv)),
			Value::Str(name) if !name.is_empty() => {
				let qualified = i.qualify(&name.to_string_lossy());
				i.glob(&qualified).code.borrow().clone()
			}
			_ => None,
		};
		let order = if let Some(cv) = comparator {
			let a = i.sv("JSON::PP::a");
			let b = i.sv("JSON::PP::b");
			let weak_a = a.is_weak();
			let weak_b = b.is_weak();
			let old_a = a.replace(Value::Undef);
			let old_b = b.replace(Value::Undef);
			let result = sort_indices(items.len(), |left, right| {
				a.set(Value::Str(items[left].0.clone()));
				b.set(Value::Str(items[right].0.clone()));
				Ok(i.call_sub(&cv, Vec::new(), Cx::Scalar)?.scalar().to_i64() <= 0)
			});
			a.set(old_a);
			b.set(old_b);
			if weak_a { a.weaken().map_err(|e| i.die_msg(e))?; }
			if weak_b { b.weaken().map_err(|e| i.die_msg(e))?; }
			Some(result?)
		} else {
			if self.opts.has(Flag::Canonical) || self.opts.sort.truthy() {
				items.sort_unstable_by(|(a, _), (b, _)| a.cmp(b));
			}
			None
		};
		self.ascii(b"{");
		for idx in 0..items.len() {
			let (key, cell) = &items[order.as_ref().map_or(idx, |order| order[idx])];
			if idx != 0 { self.ascii(b","); }
			self.line(i, depth + 1)?;
			self.string(key);
			if self.opts.has(Flag::Before) { self.ascii(b" "); }
			self.ascii(b":");
			if self.opts.has(Flag::After) { self.ascii(b" "); }
			let v = i.read_sv(cell)?;
			self.value(i, &v, depth + 1)?;
		}
		if !items.is_empty() { self.line(i, depth)?; }
		self.ascii(b"}");
		Ok(())
	}
}

// Perl sort callbacks may throw or be inconsistent, unlike Rust's slice sort comparators.
fn sort_indices(n: usize, mut precedes: impl FnMut(usize, usize) -> PResult<bool>) -> PResult<Vec<usize>> {
	let mut input: Vec<_> = (0..n).collect();
	if n < 2 { return Ok(input); }
	let mut out = vec![0; n];
	let mut span = 1usize;
	while span < n {
		for from in (0..n).step_by(span.saturating_mul(2)) {
			let mid = from.saturating_add(span).min(n);
			let to = mid.saturating_add(span).min(n);
			let (mut left, mut right) = (from, mid);
			for slot in &mut out[from..to] {
				if left < mid && (right == to || precedes(input[left], input[right])?) {
					*slot = input[left];
					left += 1;
				} else {
					*slot = input[right];
					right += 1;
				}
			}
		}
		std::mem::swap(&mut input, &mut out);
		span = span.saturating_mul(2);
	}
	Ok(input)
}

fn decode_json(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	decode_value(i, arg(&args, 0), Options::plain(), false, Cx::Scalar)
}
fn decode(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { decode_method(i, a, cx, false) }
fn decode_prefix(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { decode_method(i, a, cx, true) }
fn decode_method(i: &mut Interp<'_>, args: Vec<Sv>, cx: Cx, prefix: bool) -> PResult<Ret> {
	let (_, h) = object(i, &args)?;
	decode_value(i, arg(&args, 1), Options::from_object(&h), prefix, cx)
}
fn decode_value(i: &mut Interp<'_>, v: Value, opts: Options, prefix: bool, cx: Cx) -> PResult<Ret> {
	let s = i.stringify(&v)?;
	let data = prepare(i, s, &opts)?;
	let mut p = Parser { data: &data, opts: &opts, at: 0 };
	let val = p.document(i)?;
	let offset = p.offset();
	if !prefix {
		p.ws();
		if p.bump().is_some() { return Err(p.err(i, "garbage after JSON object")); }
	}
	Ok(if prefix {
		let offset = Value::Int(offset as i64);
		if cx == Cx::List { Ret::Many(vec![val, offset]) } else { Ret::One(offset) }
	} else { Ret::One(val) })
}
fn prepare(i: &mut Interp<'_>, mut s: PStr, opts: &Options) -> PResult<PStr> {
	if opts.has(Flag::Utf8) && s.utf8 {
		let bytes = s.downgraded().ok_or_else(|| i.die_msg("Wide character in subroutine entry"))?;
		s = PStr::new(bytes, false);
	}
	if opts.size != 0 && s.bytes.len() > opts.size {
		return Err(i.die_msg(format!("attempted decode of JSON text of {} bytes size, but max_size is set to {}", s.bytes.len(), opts.size)));
	}
	Ok(s)
}

struct Parser<'a> { data: &'a PStr, opts: &'a Options, at: usize }
impl Parser<'_> {
	fn tail(&self) -> &[u8] { &self.data.bytes[self.at..] }
	fn peek(&self) -> Option<u8> { self.tail().first().copied() }
	fn bump(&mut self) -> Option<u8> { let b = self.peek()?; self.at += 1; Some(b) }
	fn eat(&mut self, byte: u8) -> bool { if self.peek() == Some(byte) { self.at += 1; true } else { false } }
	fn offset(&self) -> usize { self.data.byte_to_char(self.at) }
	fn err(&self, i: &mut Interp<'_>, text: &str) -> crate::perl::interp::Flow {
		let mut excerpt = String::new();
		if self.tail().is_empty() { excerpt.push_str("(end of string)"); }
		else {
			let bytes = self.tail();
			let slice = PStr::new(bytes[..bytes.len().min(80)].to_vec(), self.data.utf8);
			let mut chars = slice.chars();
			for cp in chars.by_ref().take(20) {
				match cp {
					10 => excerpt.push_str("\\n"), 13 => excerpt.push_str("\\r"), 9 => excerpt.push_str("\\t"),
					92 => excerpt.push_str("\\\\"),
					0x20..=0x7e => if let Some(ch) = char::from_u32(cp) { excerpt.push(ch); },
					_ => { let _ = write!(excerpt, "\\x{{{cp:x}}}"); }
				}
			}
			if chars.next().is_some() { excerpt.push_str("..."); }
		}
		i.die_msg(format!("{text}, at character offset {} (before \"{excerpt}\")", self.offset()))
	}
	fn ws(&mut self) {
		loop {
			while matches!(self.peek(), Some(b' ' | b'\r' | b'\n' | b'\t')) { self.at += 1; }
			if !(self.opts.has(Flag::Relaxed) && self.eat(b'#')) { break; }
			while let Some(b) = self.bump() { if b == b'\n' { break; } }
		}
	}
	fn document(&mut self, i: &mut Interp<'_>) -> PResult<Value> {
		self.ws();
		let ref_syntax = matches!(self.peek(), Some(b'[' | b'{')) || (self.opts.has(Flag::Tags) && self.peek() == Some(b'('));
		let value = self.value(i, 0)?;
		if !self.opts.has(Flag::Nonref) && !ref_syntax {
			return Err(i.die_msg("JSON text must be an object or array (but found number, string, true, false or null, use allow_nonref to allow this)"));
		}
		Ok(value)
	}
	fn value(&mut self, i: &mut Interp<'_>, depth: usize) -> PResult<Value> {
		self.ws();
		match self.peek() {
			Some(b'"') => self.string(i, b'"').map(Value::Str),
			Some(b'\'') if self.opts.has(Flag::Single) => self.string(i, b'\'').map(Value::Str),
			Some(b'{') => self.hash(i, depth),
			Some(b'[') => self.array(i, depth).map(|v| Value::Ref(Ref::Array(new_av(v)))),
			Some(b'(') if self.opts.has(Flag::Tags) => self.tag(i, depth),
			Some(b'-' | b'0'..=b'9') => self.number(i),
			Some(b't') if self.tail().starts_with(b"true") => { self.at += 4; Ok(self.truth(i, true)) }
			Some(b'f') if self.tail().starts_with(b"false") => { self.at += 5; Ok(self.truth(i, false)) }
			Some(b'n') if self.tail().starts_with(b"null") => { self.at += 4; Ok(Value::Undef) }
			_ => Err(self.err(i, MALFORMED)),
		}
	}
	fn truth(&self, i: &mut Interp<'_>, on: bool) -> Value {
		if let Some((no, yes)) = &self.opts.booleans { if on { yes.clone() } else { no.clone() } }
		else { i.sv(if on { "JSON::PP::true" } else { "JSON::PP::false" }).get() }
	}
	fn number(&mut self, i: &mut Interp<'_>) -> PResult<Value> {
		let start = self.at;
		if self.eat(b'-') && !self.peek().is_some_and(|b| b.is_ascii_digit()) {
			return Err(self.err(i, "malformed number (no digits after initial minus)"));
		}
		if self.eat(b'0') {
			if self.peek().is_some_and(|b| b.is_ascii_digit()) { return Err(self.err(i, "malformed number (leading zero must not be followed by another digit)")); }
		} else { self.digits(); }
		if self.eat(b'.') && !self.digits() { return Err(self.err(i, "malformed number (no digits after decimal point)")); }
		if self.eat(b'e') || self.eat(b'E') {
			if !self.eat(b'+') { self.eat(b'-'); }
			if !self.digits() { return Err(self.err(i, "malformed number (no digits after exp sign)")); }
		}
		Ok(parse_number(&self.data.bytes[start..self.at]).0.into_value())
	}
	fn digits(&mut self) -> bool {
		let start = self.at;
		while self.peek().is_some_and(|b| b.is_ascii_digit()) { self.at += 1; }
		start != self.at
	}
	fn array(&mut self, i: &mut Interp<'_>, depth: usize) -> PResult<Vec<Value>> {
		self.at += 1;
		if depth >= self.opts.depth { return Err(self.err(i, DEPTH)); }
		let mut values = Vec::new();
		self.ws();
		if self.eat(b']') { return Ok(values); }
		loop {
			values.push(self.value(i, depth + 1)?);
			self.ws();
			if self.eat(b']') { return Ok(values); }
			if !self.eat(b',') { return Err(self.err(i, ", or ] expected while parsing array")); }
			if self.opts.has(Flag::Relaxed) { self.ws(); if self.eat(b']') { return Ok(values); } }
		}
	}
	fn hash(&mut self, i: &mut Interp<'_>, depth: usize) -> PResult<Value> {
		self.at += 1;
		if depth >= self.opts.depth { return Err(self.err(i, DEPTH)); }
		let hash = new_hv();
		self.ws();
		if !self.eat(b'}') {
			loop {
				let key = match self.peek() {
					Some(b'"') => self.string(i, b'"')?,
					Some(b'\'') if self.opts.has(Flag::Single) => self.string(i, b'\'')?,
					_ if self.opts.has(Flag::Bare) => {
						let start = self.at;
						while self.peek().is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_') { self.at += 1; }
						if self.at == start { return Err(self.err(i, STRING_END)); }
						PStr::from_bytes(&self.data.bytes[start..self.at])
					}
					_ => { self.bump(); return Err(self.err(i, STRING_END)); }
				};
				self.ws();
				if !self.eat(b':') { return Err(self.err(i, "':' expected")); }
				let value = self.value(i, depth + 1)?;
				hash.entries_mut().insert(HKey::new(&key), new_sv(value));
				self.ws();
				if self.eat(b'}') { break; }
				if !self.eat(b',') { return Err(self.err(i, ", or } expected while parsing object/hash")); }
				self.ws();
				if self.opts.has(Flag::Relaxed) && self.eat(b'}') { break; }
			}
		}
		let item = self.opts.single.as_ref().and_then(|filters| {
			let entries = hash.entries();
			if entries.len() != 1 { return None; }
			let (key, value) = entries.first()?;
			if let Value::Ref(Ref::Code(cv)) = get_key(filters, key) { Some((cv, Rc::clone(value))) } else { None }
		});
		if let Some((cv, value)) = item {
			let mut result = i.call_sub(&cv, vec![value], Cx::List)?.list();
			if result.len() == 1 { return Ok(result.pop().unwrap_or(Value::Undef)); }
		}
		let value = Value::Ref(Ref::Hash(hash));
		if let Value::Ref(Ref::Code(cv)) = &self.opts.filter {
			let mut result = i.call_sub(cv, vec![new_sv(value.clone())], Cx::List)?.list();
			if result.len() == 1 { return Ok(result.pop().unwrap_or(Value::Undef)); }
		}
		Ok(value)
	}
	fn tag(&mut self, i: &mut Interp<'_>, depth: usize) -> PResult<Value> {
		self.at += 1;
		self.ws();
		if self.peek() != Some(b'"') { return Err(self.err(i, "cannot decode perl-object (class name expected)")); }
		let class = self.string(i, b'"')?;
		self.ws();
		if !self.eat(b')') { return Err(self.err(i, "cannot decode perl-object (expected closing parenthesis)")); }
		self.ws();
		if self.peek() != Some(b'[') { return Err(self.err(i, "cannot decode perl-object (expected array)")); }
		let items = self.array(i, depth)?;
		let cv = i.find_method(&class.to_string_lossy(), "THAW").ok_or_else(|| self.err(i, "cannot decode perl-object (package does not have a THAW method)"))?;
		let args = [Value::Str(class), Value::str("JSON")].into_iter().chain(items).map(new_sv).collect();
		i.call_sub(&cv, args, Cx::Scalar).map(Ret::scalar)
	}
	fn string(&mut self, i: &mut Interp<'_>, delim: u8) -> PResult<PStr> {
		self.at += 1;
		let mut text = PStr::default();
		loop {
			let Some(b) = self.peek() else { return Err(self.err(i, STRING_END)); };
			if b == delim { self.at += 1; return Ok(text); }
			match b {
				b'\\' => {
					self.at += 1;
					match self.bump() {
						Some(b'u') => {
							let mut cp = self.hex4(i)?;
							if (0xd800..=0xdbff).contains(&cp) {
								if !self.eat(b'\\') || !self.eat(b'u') { self.bump(); return Err(self.err(i, "missing low surrogate character in surrogate pair")); }
								let low = self.hex4(i)?;
								if !(0xdc00..=0xdfff).contains(&low) { return Err(self.err(i, "surrogate pair expected")); }
								cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
							} else if (0xdc00..=0xdfff).contains(&cp) {
								return Err(self.err(i, "missing high surrogate character in surrogate pair"));
							}
							if cp > 0x7f { text.upgrade(); }
							text.push_char(cp);
						}
						Some(b'b') => text.bytes.push(8), Some(b'f') => text.bytes.push(12),
						Some(b'n') => text.bytes.push(b'\n'), Some(b'r') => text.bytes.push(b'\r'), Some(b't') => text.bytes.push(b'\t'),
						Some(c @ (b'"' | b'\\' | b'/')) => text.bytes.push(c),
						Some(c) if c == delim || self.opts.has(Flag::Loose) => text.push_char(u32::from(c)),
						Some(_) => { self.at -= 2; return Err(self.err(i, "illegal backslash escape sequence in string")); }
						None => return Err(self.err(i, STRING_END)),
					}
				}
				0..=0x1f if !self.opts.has(Flag::Loose) => return Err(self.err(i, "invalid character encountered while parsing JSON string")),
				0..=0x7f => { self.at += 1; text.bytes.push(b); }
				_ if self.opts.has(Flag::Utf8) || self.data.utf8 => {
					let tail = self.tail();
					let valid = xutf::valid_prefix(&tail[..tail.len().min(char::MAX_LEN_UTF8)]);
					let Some(ch) = valid.chars().next() else { return Err(self.err(i, "malformed UTF-8 character in JSON string")); };
					let width = ch.len_utf8();
					text.upgrade();
					text.bytes.extend_from_slice(&valid.as_bytes()[..width]);
					self.at += width;
				}
				_ => { self.at += 1; text.upgrade(); text.push_char(u32::from(b)); }
			}
		}
	}
	fn hex4(&mut self, i: &mut Interp<'_>) -> PResult<u32> {
		let mut cp = 0;
		for _ in 0..4 {
			let Some(n) = self.bump().and_then(|b| char::from(b).to_digit(16)) else { return Err(self.err(i, STRING_END)); };
			cp = cp * 16 + n;
		}
		Ok(cp)
	}
}

fn incr_text(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (_, h) = object(i, &args)?;
	Ok(Ret::One(Value::Str(get(&h, "incr").to_pstr())))
}
fn incr_reset(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (_, h) = object(i, &args)?;
	remove(&h, "incr");
	remove(&h, "skip");
	Ok(Ret::One(Value::Undef))
}
fn incr_skip(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (_, h) = object(i, &args)?;
	let skip = size_value(remove(&h, "skip"));
	let mut text = remove(&h, "incr").to_pstr();
	text.bytes.drain(..skip.min(text.bytes.len()));
	put(&h, "incr", Value::Str(text));
	Ok(Ret::One(Value::Undef))
}
fn incr_parse(i: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let (_, h) = object(i, &args)?;
	let opts = Options::from_object(&h);
	let mut data = remove(&h, "incr").to_pstr();
	if args.len() > 1 { data.push(&i.stringify(&arg(&args, 1))?); }
	let data = prepare(i, data, &opts)?;
	if cx == Cx::Void { put(&h, "incr", Value::Str(data)); return Ok(Ret::empty()); }
	let mut p = Parser { data: &data, opts: &opts, at: 0 };
	let mut values = Vec::new();
	loop {
		p.ws();
		let start = p.at;
		if p.tail().is_empty() || !complete_prefix(p.tail(), &opts) { break; }
		match p.document(i) {
			Ok(v) => values.push(v),
			Err(e) => {
				put(&h, "incr", Value::Str(PStr::new(data.bytes[start..].to_vec(), data.utf8)));
				put(&h, "skip", Value::Int((p.at.saturating_sub(start).max(1)) as i64));
				return Err(e);
			}
		}
		if cx != Cx::List { break; }
	}
	let at = p.at;
	let mut data = data;
	data.bytes.drain(..at);
	put(&h, "incr", Value::Str(data));
	Ok(if cx == Cx::List { Ret::Many(values) } else { Ret::One(values.pop().unwrap_or(Value::Undef)) })
}

// Distinguish an incomplete buffer from malformed input before invoking filters or THAW.
fn complete_prefix(bytes: &[u8], opts: &Options) -> bool {
	let Some(&first) = bytes.first() else { return false; };
	let structured = matches!(first, b'[' | b'{') || (first == b'(' && opts.has(Flag::Tags));
	if !structured && !matches!(first, b'"' | b'\'') {
		return ![&b"true"[..], &b"false"[..], &b"null"[..]].into_iter().any(|atom| bytes.len() < atom.len() && atom.starts_with(bytes));
	}
	let mut nesting: usize = 0;
	let mut quoted = None;
	let mut escape = false;
	let mut comment = false;
	for &c in bytes {
		if let Some(delim) = quoted {
			if escape { escape = false; }
			else if c == b'\\' { escape = true; }
			else if c == delim { quoted = None; if !structured { return true; } }
		} else if comment { if c == b'\n' { comment = false; } }
		else {
			match c {
				b'"' => quoted = Some(c),
				b'\'' if opts.has(Flag::Single) => quoted = Some(c),
				b'#' if opts.has(Flag::Relaxed) => comment = true,
				b'[' | b'{' => nesting += 1,
				b']' | b'}' => { nesting = nesting.saturating_sub(1); if nesting == 0 { return true; } }
				_ => {},
			}
		}
	}
	false
}
