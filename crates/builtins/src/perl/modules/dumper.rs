//! Native Data::Dumper formatting and object API (Data::Dumper POD).

use std::{collections::HashMap, io::Write as _, rc::Rc};

use crate::perl::{
	interp::{Cx, Interp, PResult, Ret},
	limits::check_len,
	regex::Charset,
	value::{HKey, Hv, PStr, Ref, Sv, Value, new_av, new_hv, new_sv},
};

use super::{arg, define, export, list, version};

const MAX_RECURSE: usize = 512;

/// Install Data::Dumper defaults, native methods and exports.
pub(super) fn load(i: &mut Interp<'_>, module: &str) -> PResult<()> {
	define(i, module, &[
		("new", new), ("Dumper", dumper), ("DumperX", dumper), ("Dump", dump), ("Dumpxs", dump),
		("Values", values), ("Names", names), ("Seen", seen), ("Reset", reset),
	]);
	macro_rules! options {
		($($name:ident => $value:expr),* $(,)?) => {{
			$(
				i.sv(concat!("Data::Dumper::", stringify!($name))).set($value);
				#[allow(non_snake_case)]
				fn $name(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { option(i, &args, stringify!($name)) }
			)*
			define(i, module, &[$((stringify!($name), $name),)*]);
		}};
	}
	options!(Indent => Value::Int(2), Purity => Value::Int(0), Pad => Value::str(""),
		Varname => Value::str("VAR"), Useqq => Value::Int(0), Terse => Value::Int(0),
		Freezer => Value::str(""), Toaster => Value::str(""), Deepcopy => Value::Int(0),
		Quotekeys => Value::Int(1), Bless => Value::str("bless"), Pair => Value::str(" => "),
		Maxdepth => Value::Int(0), Useperl => Value::Int(0), Sortkeys => Value::Int(0),
		Deparse => Value::Int(0), Sparseseen => Value::Int(0), Trailingcomma => Value::Int(0),
		Maxrecurse => Value::Int(1000));
	version(i, module, "2.179");
	export(i, module, &["Dumper"], &["DumperX"]);
	Ok(())
}

const SETTINGS: &[&str] = &[
	"Indent", "Purity", "Pad", "Varname", "Useqq", "Terse", "Freezer", "Toaster", "Deepcopy",
	"Quotekeys", "Bless", "Pair", "Maxdepth", "Useperl", "Sortkeys", "Deparse", "Sparseseen",
	"Trailingcomma", "Maxrecurse",
];

fn key(s: &str) -> HKey { HKey::new(&PStr::from_str(s)) }
fn get(h: &Hv, name: &str) -> Value { h.entries().get(&key(name)).map_or(Value::Undef, |s| s.get()) }
fn put(h: &Hv, name: &str, v: Value) { h.entries_mut().insert(key(name), new_sv(v)); }
fn object(i: &mut Interp<'_>, args: &[Sv]) -> PResult<(Value, Hv)> {
	let v = arg(args, 0);
	let Value::Ref(Ref::Hash(h)) = &v else { return Err(i.die_msg("Not a HASH reference")); };
	Ok((v.clone(), Rc::clone(h)))
}
fn as_array(v: &Value) -> Option<Vec<Sv>> {
	if let Value::Ref(Ref::Array(a)) = v { Some(a.elems().clone()) } else { None }
}
fn make(i: &mut Interp<'_>, class: &str, values: Value, names: Value) -> Value {
	let h = new_hv();
	for &name in SETTINGS {
		put(&h, name, i.sv(&format!("Data::Dumper::{name}")).get());
	}
	put(&h, "values", values);
	put(&h, "names", names);
	let r = Ref::Hash(h);
	r.bless(Rc::from(class));
	Value::Ref(r)
}
fn new(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let class = arg(&args, 0);
	let class = match class {
		Value::Ref(r) => r.blessed().unwrap_or_else(|| Rc::from("Data::Dumper")),
		v => Rc::from(v.to_pstr().to_string_lossy().as_ref()),
	};
	let v = arg(&args, 1);
	if !matches!(v, Value::Ref(Ref::Array(_))) { return Err(i.die_msg("Usage: PACKAGE->new(ARRAYREF, [ARRAYREF])")); }
	Ok(Ret::One(make(i, &class, v, arg(&args, 2))))
}
fn option(i: &mut Interp<'_>, a: &[Sv], name: &str) -> PResult<Ret> {
	let (v, h) = object(i, a)?;
	if a.len() > 1 { put(&h, name, arg(a, 1)); Ok(Ret::One(v)) } else { Ok(Ret::One(get(&h, name))) }
}
fn array_option(i: &mut Interp<'_>, a: &[Sv], cx: Cx, name: &str) -> PResult<Ret> {
	let (v, h) = object(i, a)?;
	if a.len() > 1 {
		let next = arg(a, 1);
		if !matches!(next, Value::Ref(Ref::Array(_))) { return Err(i.die_msg("Not an ARRAY reference")); }
		put(&h, name, next);
		Ok(Ret::One(v))
	} else {
		let cells = as_array(&get(&h, name)).unwrap_or_default();
		let values = cells.iter().map(|s| i.read_sv(s)).collect::<PResult<Vec<_>>>()?;
		Ok(list(values, cx))
	}
}
fn values(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { array_option(i, &a, cx, "values") }
fn names(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { array_option(i, &a, cx, "names") }
fn reset(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (v, h) = object(i, &a)?;
	h.entries_mut().shift_remove(&key("seen"));
	Ok(Ret::One(v))
}

struct Seen { expr: PStr, value: Ref, cell: bool, named: bool }
fn saved(h: &Hv) -> HashMap<usize, Seen> {
	let mut seen = HashMap::new();
	if let Some(data) = as_array(&get(h, "seen")) {
		for record in data.chunks_exact(4) {
			if let Value::Ref(r) = arg(record, 1) {
				seen.insert(r.addr(), Seen { expr: arg(record, 0).to_pstr(), value: r,
					cell: arg(record, 2).truthy(), named: arg(record, 3).truthy() });
			}
		}
	}
	seen
}
fn save(h: &Hv, seen: HashMap<usize, Seen>) {
	let data = seen.into_values().flat_map(|s| [Value::Str(s.expr), Value::Ref(s.value),
		Value::Int(i64::from(s.cell)), Value::Int(i64::from(s.named))]).collect();
	put(h, "seen", Value::Ref(Ref::Array(new_av(data))));
}
fn seen(i: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let (v, h) = object(i, &args)?;
	let mut seen = saved(&h);
	if args.len() > 1 {
		let Value::Ref(Ref::Hash(extra)) = arg(&args, 1) else { return Err(i.die_msg("Not a HASH reference")); };
		let entries: Vec<_> = extra.entries().iter().map(|(name, value)| (name.to_pstr(), Rc::clone(value))).collect();
		for (name, value) in entries {
			let value = i.read_sv(&value)?;
			if let Value::Ref(r) = &value {
				let (_, expr, _) = root_name(name, &value);
				seen.insert(r.addr(), Seen { expr, value: r.clone(), cell: false, named: true });
			}
		}
		save(&h, seen);
		Ok(Ret::One(v))
	} else {
		Ok(list(seen.into_values().flat_map(|s| [Value::Str(s.expr), Value::Ref(s.value)]).collect(), cx))
	}
}

struct Options {
	indent: usize, purity: bool, terse: bool, deepcopy: bool, useqq: bool, quotekeys: bool,
	trailing: bool, sparse: bool, maxdepth: usize, maxrecurse: usize, pad: PStr, pair: PStr, varname: PStr,
	bless: PStr, freezer: PStr, toaster: PStr, sortkeys: Value, useperl: bool,
}
impl Options {
	fn new(mut get: impl FnMut(&str) -> Value) -> Self {
		let indent = usize::try_from(get("Indent").to_i64()).unwrap_or(0).min(3);
		let maxdepth = usize::try_from(get("Maxdepth").to_i64()).unwrap_or(0);
		let maxrecurse = usize::try_from(get("Maxrecurse").to_i64()).unwrap_or(0);
		Self { indent, maxdepth, maxrecurse, purity: get("Purity").truthy(), terse: get("Terse").truthy(),
			deepcopy: get("Deepcopy").truthy(), useqq: get("Useqq").truthy(), quotekeys: get("Quotekeys").truthy(),
			trailing: get("Trailingcomma").truthy(), sparse: get("Sparseseen").truthy(),
			pad: get("Pad").to_pstr(), pair: get("Pair").to_pstr(), varname: get("Varname").to_pstr(),
			bless: get("Bless").to_pstr(), freezer: get("Freezer").to_pstr(), toaster: get("Toaster").to_pstr(),
			sortkeys: get("Sortkeys"), useperl: get("Useperl").truthy() }
	}
	fn base(&self, col: usize) -> usize { if self.indent >= 2 { col } else { 0 } }
}
fn dumper(i: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let opts = Options::new(|name| i.sv(&format!("Data::Dumper::{name}")).get());
	run(i, opts, None, args, Vec::new(), cx)
}
fn dump(i: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let h = if matches!(arg(&args, 0), Value::Ref(Ref::Hash(_))) { object(i, &args)?.1 }
	else {
		let v = new(i, args, Cx::Scalar)?.scalar();
		let Value::Ref(Ref::Hash(h)) = v else { return Ok(Ret::empty()); };
		h
	};
	let values = as_array(&get(&h, "values")).unwrap_or_default();
	let names = as_array(&get(&h, "names")).unwrap_or_default();
	let opts = Options::new(|name| get(&h, name));
	run(i, opts, Some(&h), values, names, cx)
}
fn root_name(mut name: PStr, value: &Value) -> (PStr, PStr, bool) {
	let star = name.bytes.first() == Some(&b'*');
	if matches!(name.bytes.first(), Some(b'$' | b'*')) { name.bytes.remove(0); }
	let sigil = match (star, value) {
		(true, Value::Ref(Ref::Array(_))) => b'@',
		(true, Value::Ref(Ref::Hash(_))) => b'%',
		_ => b'$',
	};
	let direct = sigil != b'$';
	let mut assign = PStr::from_bytes(&[sigil]);
	assign.push(&name);
	let mut expr = PStr::default();
	if direct { expr.bytes.push(b'\\'); }
	expr.push(&assign);
	(assign, expr, direct)
}
fn run(i: &mut Interp<'_>, opts: Options, object: Option<&Hv>, values: Vec<Sv>, names: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let mut out = Vec::new();
	let mut joined = PStr::default();
	let mut w = Writer { opts, seen: object.map_or_else(HashMap::new, saved), patches: Vec::new() };
	for (n, cell) in values.iter().enumerate() {
		let v = i.read_sv(cell)?;
		let name = match names.get(n) { Some(cell) => i.read_sv(cell)?, None => Value::Undef };
		let name = if name.is_undef() {
			let mut name = w.opts.varname.clone();
			let _ = write!(name.bytes, "{}", n + 1);
			name
		} else { name.to_pstr() };
		let (assign, reference, direct) = root_name(name, &v);
		let name = Path { expr: reference, direct, nested: false };
		let mut rendered = PStr::default();
		let prefix = assign.char_len() + 3;
		let start = if w.opts.terse { 0 } else { w.opts.base(prefix) };
		w.render(i, &mut rendered, &v, &name, None, start, 0, true)?;
		let needs_assignment = !w.opts.terse || !w.patches.is_empty();
		let mut text = w.opts.pad.clone();
		if needs_assignment { text.push(&assign); text.push_bytes(b" = "); }
		text.push(&rendered);
		if needs_assignment { text.bytes.push(b';'); }
		if w.opts.indent != 0 { text.bytes.push(b'\n'); }
		for (path, value) in w.patches.drain(..) {
			text.push(&w.opts.pad);
			text.push(&path);
			text.push_bytes(b" = ");
			text.push(&value);
			text.bytes.push(b';');
			if w.opts.indent != 0 { text.bytes.push(b'\n'); }
		}
		if cx == Cx::List { out.push(Value::Str(text)); }
		else { joined.push(&text); }
	}
	if let Some(h) = object { save(h, w.seen); }
	Ok(if cx == Cx::List { Ret::Many(out) } else { Ret::One(Value::Str(joined)) })
}

struct Path { expr: PStr, direct: bool, nested: bool }
impl Path {
	fn child(&self, subscript: &PStr) -> Self {
		let mut expr;
		if self.direct {
			expr = PStr::from_bytes(b"$");
			expr.push(&PStr::new(self.expr.bytes[2..].to_vec(), self.expr.utf8));
		} else {
			expr = self.expr.clone();
			if !self.nested { expr.push_bytes(b"->"); }
		}
		expr.push(subscript);
		Self { expr, direct: false, nested: true }
	}
	fn scalar(&self) -> Self {
		let expr = deref(&self.expr);
		Self { expr, direct: false, nested: false }
	}
}
fn deref(expr: &PStr) -> PStr {
	let mut path = PStr::from_bytes(b"${");
	path.push(expr);
	path.bytes.push(b'}');
	path
}
fn ref_expr(expr: &PStr) -> PStr {
	let mut path = PStr::from_bytes(b"\\");
	path.push(expr);
	path
}

struct Writer { opts: Options, seen: HashMap<usize, Seen>, patches: Vec<(PStr, PStr)> }
impl Writer {
	/// Starts an output line: newline, `$Pad`, and `col` spaces of indentation (checked against the shared buffer limit).
	fn line(&self, i: &mut Interp<'_>, out: &mut PStr, col: usize) -> PResult<()> {
		let pad = if self.opts.indent != 0 { col } else { 0 };
		check_len(out.bytes.len().saturating_add(1).saturating_add(self.opts.pad.bytes.len()).saturating_add(pad), "string")
			.map_err(|e| i.die_msg(e))?;
		if self.opts.indent != 0 { out.bytes.push(b'\n'); }
		out.push(&self.opts.pad);
		out.bytes.resize(out.bytes.len() + pad, b' ');
		Ok(())
	}
	fn quote(&self, text: &PStr, key: bool) -> PStr {
		if key && !self.opts.quotekeys && bareword(text) { return text.clone(); }
		quote(text, self.opts.useqq)
	}
	fn render(&mut self, i: &mut Interp<'_>, out: &mut PStr, v: &Value, path: &Path, cell: Option<&Sv>, col: usize, depth: usize, root: bool) -> PResult<()> {
		let limit = if self.opts.maxrecurse == 0 { MAX_RECURSE } else { self.opts.maxrecurse.min(MAX_RECURSE) };
		if depth > limit { return Err(i.die_msg(format!("Recursion limit of {limit} exceeded"))); }
		if !root && !self.opts.sparse && let Some(cell) = cell {
			let address = Rc::as_ptr(cell) as usize;
			if let Some(entry) = self.seen.get(&address) && !entry.cell {
				out.push(&deref(&entry.expr));
				return Ok(());
			}
			self.seen.entry(address).or_insert_with(|| Seen { expr: ref_expr(&path.expr), value: Ref::Scalar(Rc::clone(cell)), cell: true, named: false });
		}
		match v {
			Value::Undef => out.push_bytes(b"undef"),
			Value::Int(_) | Value::UInt(_) => {
				let s = v.to_pstr();
				if s.bytes.len() <= 10 && (!self.opts.useperl || i32::try_from(v.to_i64()).is_ok()) { out.push(&s); }
				else { out.push(&quote(&s, self.opts.useqq && self.opts.useperl)); }
			}
			Value::Num(n) => {
				let s = v.to_pstr();
				if (self.opts.useperl || self.opts.useqq) && n.is_finite() && n.abs() < f64::from(u32::MAX)
					&& s.bytes.iter().all(|c| c.is_ascii_digit() || *c == b'-') {
					out.push(&s);
				} else { out.push(&self.quote(&s, false)); }
			}
			Value::Str(s) => out.push(&self.quote(s, false)),
			Value::Dual(d) => out.push(&self.quote(&d.str, false)),
			Value::Glob(_) => out.push(&v.to_pstr()),
			Value::Ref(r) => self.reference(i, out, r, path, col, depth, root)?,
		}
		Ok(())
	}
	fn reference(&mut self, i: &mut Interp<'_>, out: &mut PStr, r: &Ref, path: &Path, mut col: usize, depth: usize, root: bool) -> PResult<()> {
		let addr = r.addr();
		if let Some(previous) = self.seen.get(&addr) {
			if self.opts.purity && !root && !previous.cell && !previous.named {
				placeholder(out, r);
				self.patches.push((path.expr.clone(), previous.expr.clone()));
			} else { out.push(&previous.expr); }
			return Ok(());
		}
		self.seen.insert(addr, Seen { expr: path.expr.clone(), value: r.clone(), cell: false, named: false });
		if !self.opts.purity && self.opts.maxdepth != 0 && depth >= self.opts.maxdepth {
			out.push(&quote(&Value::Ref(r.clone()).to_pstr(), false));
			if self.opts.deepcopy { self.seen.remove(&addr); }
			return Ok(());
		}
		let mut blessed = r.blessed();
		if matches!(r, Ref::Regexp(_)) && blessed.as_deref() == Some("Regexp") { blessed = None; }
		if let Some(class) = &blessed {
			if !self.opts.freezer.is_empty() && let Some(f) = i.find_method(class, &self.opts.freezer.to_string_lossy()) {
				i.call_sub(&f, vec![new_sv(Value::Ref(r.clone()))], Cx::Void)?;
			}
			out.push(&self.opts.bless);
			out.push_bytes(b"( ");
			if self.opts.indent >= 2 { col += self.opts.bless.char_len() + 2; }
		}
		match r {
			Ref::Array(a) => {
				let array = a.elems().clone();
				let (open, close) = if path.direct { (b'(', b')') } else { (b'[', b']') };
				out.bytes.push(open);
				for (n, cell) in array.iter().enumerate() {
					if n != 0 { out.bytes.push(b','); }
					self.line(i, out, col + 2)?;
					if self.opts.indent == 3 {
						let _ = write!(out.bytes, "#{n}");
						self.line(i, out, col + 2)?;
					}
					let sub = PStr::from_str(&format!("[{n}]"));
					let value = i.read_sv(cell)?;
					self.render(i, out, &value, &path.child(&sub), Some(cell), col + 2, depth + 1, false)?;
				}
				self.close(i, out, close, col, !array.is_empty())?;
			}
			Ref::Hash(hash) => self.hash(i, out, hash, path, col, depth)?,
			Ref::Scalar(cell) => {
				let v = i.read_sv(cell)?;
				if blessed.is_some() && !matches!(v, Value::Ref(_)) {
					out.push_bytes(b"do{\\(my $o = ");
					self.render(i, out, &v, &path.scalar(), None, col + 12, depth + 1, false)?;
					out.push_bytes(b")}");
				} else {
					out.bytes.push(b'\\');
					self.render(i, out, &v, &path.scalar(), None, col + usize::from(self.opts.indent >= 2), depth + 1, false)?;
				}
			}
			Ref::Regexp(re) => regexp(out, re),
			Ref::Code(_) => out.push_bytes(b"sub { \"DUMMY\" }"),
			Ref::Glob(_) => {
				out.bytes.push(b'\\');
				out.push(&Value::Ref(r.clone()).to_pstr());
			}
			Ref::Io(_) => out.push(&quote(&Value::Ref(r.clone()).to_pstr(), false)),
		}
		if let Some(class) = blessed {
			out.push_bytes(b", ");
			out.push(&quote(&PStr::from_str(&class), false));
			out.push_bytes(b" )");
			if !self.opts.toaster.is_empty() {
				out.push_bytes(b"->");
				out.push(&self.opts.toaster);
				out.push_bytes(b"()");
			}
		}
		if self.opts.deepcopy { self.seen.remove(&addr); }
		Ok(())
	}
	fn close(&self, i: &mut Interp<'_>, out: &mut PStr, close: u8, col: usize, had_items: bool) -> PResult<()> {
		if had_items {
			if self.opts.trailing && self.opts.indent != 0 { out.bytes.push(b','); }
			self.line(i, out, col)?;
		}
		out.bytes.push(close);
		Ok(())
	}
	fn hash(&mut self, i: &mut Interp<'_>, out: &mut PStr, h: &Hv, path: &Path, col: usize, depth: usize) -> PResult<()> {
		let mut items: Vec<_> = if let Value::Ref(Ref::Code(cv)) = &self.opts.sortkeys {
			let keys = i.call_sub(cv, vec![new_sv(Value::Ref(Ref::Hash(Rc::clone(h))))], Cx::Scalar)?.scalar();
			if let Some(keys) = as_array(&keys) {
				keys.into_iter().map(|cell| {
					let text = i.read_sv(&cell)?.to_pstr();
					let value = h.entries().get(&HKey::new(&text)).cloned().unwrap_or_else(|| new_sv(Value::Undef));
					Ok((text, value))
				}).collect::<PResult<Vec<_>>>()?
			} else { i.warn("Sortkeys subroutine did not return an ARRAYREF"); Vec::new() }
		} else {
			h.entries().iter().map(|(key, value)| (key.to_pstr(), Rc::clone(value))).collect()
		};
		if self.opts.sortkeys.truthy() && !matches!(self.opts.sortkeys, Value::Ref(Ref::Code(_))) {
			items.sort_unstable_by(|(a, _), (b, _)| a.cmp(b));
		}
		let (open, close) = if path.direct { (b'(', b')') } else { (b'{', b'}') };
		out.bytes.push(open);
		for (n, (key, cell)) in items.iter().enumerate() {
			if n != 0 { out.bytes.push(b','); }
			self.line(i, out, col + 2)?;
			let quoted = self.quote(key, true);
			out.push(&quoted);
			out.push(&self.opts.pair);
			let mut sub = PStr::from_bytes(b"{");
			sub.push(&quoted);
			sub.bytes.push(b'}');
			let next_col = col + 2 + if self.opts.indent >= 2 { quoted.char_len() + self.opts.pair.char_len() } else { 0 };
			let value = i.read_sv(cell)?;
			self.render(i, out, &value, &path.child(&sub), Some(cell), next_col, depth + 1, false)?;
		}
		self.close(i, out, close, col, !items.is_empty())?;
		Ok(())
	}
}
fn placeholder(out: &mut PStr, r: &Ref) {
	match r {
		Ref::Array(_) => out.push_bytes(b"[]"),
		Ref::Hash(_) => out.push_bytes(b"{}"),
		Ref::Scalar(_) => out.push_bytes(b"do{my $o}"),
		_ => out.push_bytes(b"undef"),
	}
}
fn bareword(s: &PStr) -> bool {
	let mut chars = s.bytes.iter();
	chars.next().is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_') && chars.all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}
fn quote(text: &PStr, useqq: bool) -> PStr {
	let wide = text.utf8 && !text.bytes.is_ascii();
	let double = useqq || wide;
	let delim = if double { b'"' } else { b'\'' };
	let mut out = PStr::new(Vec::with_capacity(text.bytes.len() + 2), false);
	out.bytes.push(delim);
	let mut cps = text.chars().peekable();
	while let Some(cp) = cps.next() {
		if cp == u32::from(delim) || cp == 92 || (double && matches!(cp, 36 | 64)) {
			out.bytes.extend_from_slice(&[b'\\', cp as u8]);
		} else if wide && cp >= 0x80 {
			let _ = write!(out.bytes, "\\x{{{cp:x}}}");
		} else if useqq && !(0x20..=0x7e).contains(&cp) {
			let short = match cp { 7 => Some(b'a'), 8 => Some(b'b'), 9 => Some(b't'), 10 => Some(b'n'),
				12 => Some(b'f'), 13 => Some(b'r'), 27 => Some(b'e'), _ => None };
			if let Some(short) = short { out.bytes.extend_from_slice(&[b'\\', short]); }
			else if cps.peek().is_some_and(|n| (48..=57).contains(n)) { let _ = write!(out.bytes, "\\{cp:03o}"); }
			else { let _ = write!(out.bytes, "\\{cp:o}"); }
		} else { out.push_char(cp); }
	}
	out.bytes.push(delim);
	out
}
fn regexp(out: &mut PStr, re: &crate::perl::value::Rx) {
	let s = re.regex.source();
	out.push_bytes(b"qr/");
	let mut escaped = false;
	for cp in s.chars() {
		if cp >= 0x80 && s.utf8 { let _ = write!(out.bytes, "\\x{{{cp:x}}}"); }
		else {
			if cp == 47 && !escaped { out.bytes.push(b'\\'); }
			out.push_char(cp);
		}
		escaped = cp == 92 && !escaped;
	}
	out.bytes.push(b'/');
	let f = re.regex.flags();
	out.push_bytes(match f.charset { Charset::Depends => b"", Charset::Unicode => b"u", Charset::Ascii => b"a", Charset::AsciiStrict => b"aa", Charset::Locale => b"l" });
	for (enabled, flag) in [(f.m, b'm'), (f.s, b's'), (f.i, b'i'), (f.x, b'x'), (f.xx, b'x'), (f.n, b'n'), (f.p, b'p')] {
		if enabled { out.bytes.push(flag); }
	}
}
