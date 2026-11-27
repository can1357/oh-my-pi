//! `Getopt::Long` and `Getopt::Std`: option specifications, argument streams and destinations.

use std::{collections::{BTreeMap, VecDeque}, rc::Rc};

use super::{arg, boolean, define, export, text, version};
use crate::perl::{
	interp::{Cx, Flow, Interp, PResult, Ret},
	regex::{ExecOpts, Regex, RxFlags},
	value::{Av, Dual, HKey, Hv, Num, PStr, Ref, Sv, Value, new_av, new_sv},
};

const LONG: &str = "Getopt::Long";
const PARSER: &str = "Getopt::Long::Parser";
const CALLBACK: &str = "Getopt::Long::CallBack";
const STATE: &str = "Getopt::Long::_omp_config";
const ABBREV: i64 = 1;
const COMPAT: i64 = 2;
const PERMUTE: i64 = 4;
const CASE: i64 = 8;
const CASE_SHORT: i64 = 16;
const BUNDLE: i64 = 32;
const OVERRIDE: i64 = 64;
const THROUGH: i64 = 128;
const AUTO_HELP: i64 = 256;
const AUTO_VERSION: i64 = 512;
const DEBUG: i64 = 1024;
const VALUES_BUNDLE: i64 = 2048;

/// Install the requested Getopt package and its default exports.
pub(super) fn load(interp: &mut Interp<'_>, module: &str) -> PResult<()> {
	if module == LONG {
		version(interp, module, "2.52");
		define(interp, PARSER, &[("new", parser_new), ("configure", parser_configure),
			("getoptions", parser_options), ("getoptionsfromarray", parser_array),
			("getoptionsfromstring", parser_string)]);
		define(interp, CALLBACK, &[("name", callback_name), ("given", callback_given)]);
		for (name, func) in [("GetOptions", get_options as crate::perl::interp::NativeFn),
			("GetOptionsFromArray", from_array), ("GetOptionsFromString", from_string),
			("Configure", configure), ("HelpMessage", help_message), ("VersionMessage", version_message)] {
			interp.define_native_proto(&format!("{LONG}::{name}"), func, "@");
		}
		let handler = interp.glob("Getopt::Long::CallBack::name").code.borrow().clone();
		if let Some(handler) = handler {
			interp.set_overload(CALLBACK, "\"\"", Value::Ref(Ref::Code(handler)));
			interp.set_overload(CALLBACK, "fallback", Value::Int(1));
		}
		for (name, n) in [("REQUIRE_ORDER", 0), ("PERMUTE", 1), ("RETURN_IN_ORDER", 2)] {
			interp.sv(&format!("{LONG}::{name}")).set(Value::Int(n));
		}
		let config = default_config(interp);
		interp.sv(STATE).set(config.value());
		export(interp, module, &["GetOptions", "$REQUIRE_ORDER", "$PERMUTE", "$RETURN_IN_ORDER"],
			&["HelpMessage", "VersionMessage", "Configure", "GetOptionsFromArray", "GetOptionsFromString"]);
		interp.define_native("Getopt::Long::import", long_import);
	} else {
		version(interp, module, "1.13");
		interp.define_native_proto("Getopt::Std::getopt", getopt, ";$$");
		interp.define_native_proto("Getopt::Std::getopts", getopts, "$;$");
		export(interp, module, &["getopt", "getopts"], &[]);
	}
	Ok(())
}

fn long_import(interp: &mut Interp<'_>, mut a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	for (i, sv) in a.iter().enumerate().skip(1) {
		if interp.read_sv(sv)?.to_pstr().bytes == b":config" {
			let mut config = a.split_off(i);
			config.remove(0);
			configure(interp, config, Cx::Void)?;
			break;
		}
	}
	super::exporter::import(interp, a, cx)
}

fn caller(interp: &Interp<'_>) -> Rc<str> { interp.package() }

fn hash_key(s: &str) -> HKey { HKey::new(&PStr::from_str(s)) }

fn set_hash(interp: &mut Interp<'_>, h: &Hv, key: HKey, val: Value) -> PResult<()> {
	let slot = {
		let mut entries = h.entries_mut();
		if let Some(slot) = entries.get(&key) { slot.clone() }
		else {
			entries.insert(key, new_sv(val));
			return Ok(());
		}
	};
	interp.write_sv(&slot, val)
}

fn default_config(interp: &mut Interp<'_>) -> Config {
	let flags = if interp.hv("main::ENV").entries().contains_key(&hash_key("POSIXLY_CORRECT")) {
		CASE
	} else {
		ABBREV | COMPAT | PERMUTE | CASE
	};
	Config { flags, prefix: None, long_prefix: None }
}

fn global_config(interp: &mut Interp<'_>) -> Config { Config::read(&interp.sv(STATE).get()) }

fn config_error(interp: &mut Interp<'_>, msg: String) -> Flow { interp.die_msg(format!("{msg}\n")) }

struct Config {
	flags: i64,
	prefix: Option<PStr>,
	long_prefix: Option<PStr>,
}

impl Config {
	fn value(&self) -> Value {
		let flags = self.flags;
		let yes = |bit| Value::Int(i64::from(flags & bit != 0));
		let prefix = self.prefix.as_ref().map_or_else(|| Value::str(if flags & COMPAT != 0 { "(--|-|\\+)" } else { "(--|-)" }), |s| Value::Str(s.clone()));
		let long_prefix = self.long_prefix.as_ref().map_or_else(|| Value::str("(--)"), |s| Value::Str(s.clone()));
		Value::Ref(Ref::Array(new_av(vec![yes(DEBUG), Value::Int(0), Value::str("2"), Value::str("52"), Value::Undef,
			yes(ABBREV), yes(COMPAT), yes(PERMUTE), Value::Int(if flags & VALUES_BUNDLE != 0 { 3 } else if flags & OVERRIDE != 0 { 2 } else { i64::from(flags & BUNDLE != 0) }),
			Value::Int(if flags & CASE_SHORT != 0 { 2 } else { i64::from(flags & CASE != 0) }), yes(THROUGH), Value::Int(0), prefix,
			if flags & AUTO_HELP != 0 { Value::Int(1) } else { Value::Undef },
			if flags & AUTO_VERSION != 0 { Value::Int(1) } else { Value::Undef }, long_prefix, Value::Int(0)])))
	}

	fn read(v: &Value) -> Self {
		let Value::Ref(Ref::Array(saved)) = v else { return Self { flags: 0, prefix: None, long_prefix: None }; };
		let saved = saved.elems();
		let n = |idx| arg(&saved, idx).to_i64();
		let default_prefix = if n(6) != 0 { b"(--|-|\\+)".as_slice() } else { b"(--|-)".as_slice() };
		let strings = |i, default: &[u8]| {
			let val = arg(&saved, i);
			if val.is_undef() { return None; }
			let s = val.to_pstr();
			(s.bytes != default).then_some(s)
		};
		let bit = |i, flag| if n(i) == 0 { 0 } else { flag };
		let flags = bit(0, DEBUG) | bit(5, ABBREV) | bit(6, COMPAT) | bit(7, PERMUTE) | bit(8, BUNDLE)
			| (if n(8) == 2 { OVERRIDE } else { 0 }) | (if n(8) == 3 { VALUES_BUNDLE } else { 0 })
			| bit(9, CASE) | (if n(9) == 2 { CASE_SHORT } else { 0 })
			| bit(10, THROUGH) | bit(13, AUTO_HELP) | bit(14, AUTO_VERSION);
		Self { flags, prefix: strings(12, default_prefix), long_prefix: strings(15, b"(--)") }
	}
}

fn update_config<'a>(interp: &mut Interp<'_>, mut config: Config, args: impl IntoIterator<Item = &'a Sv>) -> PResult<Config> {
	for sv in args {
		let arg = interp.read_sv(sv)?;
		if matches!(arg, Value::Ref(Ref::Array(_))) {
			config = Config::read(&arg);
			continue;
		}
		let string = arg.to_pstr();
		let original = string.to_string_lossy();
		let lower = original.to_ascii_lowercase();
		if let Some((key, raw)) = original.split_once('=') {
			let value = match key.to_ascii_lowercase().replace('_', "").as_str() {
				"prefix" => {
					let mut quoted = String::new();
					for ch in raw.chars() {
						if "\\^$.|?*+()[]{}".contains(ch) { quoted.push('\\'); }
						quoted.push(ch);
					}
					let pattern = PStr::from_str(&quoted);
					prefix_rx(interp, &pattern)?;
					config.prefix = Some(pattern);
					continue;
				}
				"prefixpattern" => &mut config.prefix,
				"longprefixpattern" => &mut config.long_prefix,
				_ => return Err(config_error(interp, format!("Getopt::Long: unknown or erroneous config parameter \"{original}\""))),
			};
			let pattern = PStr::from_str(raw);
			prefix_rx(interp, &pattern)?;
			*value = Some(pattern);
			continue;
		}
		let (name, on) = lower.strip_prefix("no_").or_else(|| lower.strip_prefix("no"))
			.map_or((lower.as_str(), true), |name| (name, false));
		let name = name.replace('_', "");
		let flags = &mut config.flags;
		let bit = match name.as_str() {
			"default" if on => { config = default_config(interp); continue; }
			"gnugetopt" if on => { *flags = (*flags | ABBREV | PERMUTE | BUNDLE) & !(COMPAT | OVERRIDE | VALUES_BUNDLE); continue; }
			"autoabbrev" => ABBREV,
			"getoptcompat" => COMPAT,
			"permute" => PERMUTE,
			"requireorder" => {
				if on { *flags &= !PERMUTE; } else { *flags |= PERMUTE; }
				continue;
			}
			"ignorecase" => { *flags &= !CASE_SHORT; CASE }
			"ignorecasealways" => CASE | CASE_SHORT,
			"bundling" => { *flags &= !(OVERRIDE | VALUES_BUNDLE); BUNDLE }
			"bundlingoverride" => { *flags &= !VALUES_BUNDLE; BUNDLE | OVERRIDE }
			"bundlingvalues" => { *flags &= !OVERRIDE; BUNDLE | VALUES_BUNDLE }
			"passthrough" => THROUGH,
			"autohelp" => AUTO_HELP,
			"autoversion" => AUTO_VERSION,
			"debug" => DEBUG,
			_ => return Err(config_error(interp, format!("Getopt::Long: unknown or erroneous config parameter \"{original}\""))),
		};
		if on { *flags |= bit; } else { *flags &= !bit; }
	}
	Ok(config)
}

fn configure(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let state = interp.sv(STATE);
	let old = state.get();
	let new = update_config(interp, Config::read(&old), &a)?;
	state.set(new.value());
	Ok(Ret::One(old))
}

fn parser_new(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let mut cfg = default_config(interp);
	for pair in a.get(1..).unwrap_or_default().chunks(2) {
		match (text(pair, 0).as_str(), arg(pair, 1)) {
			("config", Value::Ref(Ref::Array(settings))) => {
				let settings = settings.elems().clone();
				cfg = update_config(interp, cfg, &settings)?;
			}
			(name, _) => return Err(config_error(interp, format!("Getopt::Long::Parser::new: unknown attribute \"{name}\""))),
		}
	}
	let r = Ref::Scalar(new_sv(cfg.value()));
	r.bless(Rc::from(text(&a, 0)));
	Ok(Ret::One(Value::Ref(r)))
}

fn parser_configure(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Value::Ref(Ref::Scalar(state)) = arg(&a, 0) else { return Ok(Ret::One(Value::Undef)); };
	let old = interp.read_sv(&state)?;
	let new = update_config(interp, Config::read(&old), a.iter().skip(1))?;
	interp.write_sv(&state, new.value())?;
	Ok(Ret::One(old))
}

fn parser_config(a: &[Sv]) -> Config {
	let v = arg(a, 0);
	if let Value::Ref(Ref::Scalar(s)) = v { Config::read(&s.get()) }
	else { Config { flags: 0, prefix: None, long_prefix: None } }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind { Flag, Negate, Count, String, Integer, Extended, Float }
#[derive(Clone, Copy, PartialEq, Eq)]
enum Shape { Scalar, Array, Hash }
struct Spec {
	name: String,
	kind: Kind,
	shape: Shape,
	optional: Option<Value>,
	increment_default: bool,
	min: usize,
	max: usize,
	target: Option<Ref>,
}

fn option_spec(src: &str, target: Option<Ref>) -> Result<(Spec, Vec<&str>), &'static str> {
	let split = src.find(['!', '+', ':', '=']).unwrap_or(src.len());
	let names = src[..split].split('|').collect::<Vec<_>>();
	if names.iter().any(|s| s.is_empty() || !s.chars().all(|c| c.is_alphanumeric() || "_-?".contains(c))) {
		return Err("Error in option spec");
	}
	let mut spec = Spec { name: names[0].to_owned(), kind: Kind::Flag, shape: Shape::Scalar, optional: None, increment_default: false, min: 1, max: 1, target };
	let suffix = &src[split..];
	match suffix {
		"" => return Ok((spec, names)),
		"!" => { spec.kind = Kind::Negate; return Ok((spec, names)); }
		"+" => { spec.kind = Kind::Count; return Ok((spec, names)); }
		_ => {}
	}
	let optional = suffix.starts_with(':');
	if !optional && !suffix.starts_with('=') { return Err("Error in option spec"); }
	let mut tail = &suffix[1..];
	if optional && tail == "+" {
		spec.kind = Kind::Integer;
		spec.optional = Some(Value::Int(0));
		spec.increment_default = true;
		return Ok((spec, names));
	}
	if optional && !tail.is_empty() && tail.parse::<i64>().is_ok() {
		spec.kind = Kind::Integer;
		spec.optional = Some(Value::str(tail));
		return Ok((spec, names));
	}
	spec.kind = match tail.as_bytes().first() {
		Some(b's') => Kind::String, Some(b'i') => Kind::Integer,
		Some(b'o') => Kind::Extended, Some(b'f') => Kind::Float,
		_ => return Err("Error in option spec"),
	};
	tail = &tail[1..];
	if optional { spec.optional = Some(if spec.kind == Kind::String { Value::str("") } else { Value::Int(0) }); }
	if let Some(rem) = tail.strip_prefix('@') { spec.shape = Shape::Array; tail = rem; }
	if let Some(rem) = tail.strip_prefix('%') { spec.shape = Shape::Hash; tail = rem; }
	if !tail.is_empty() {
		let range = tail.strip_prefix('{').and_then(|s| s.strip_suffix('}')).ok_or("Error in option spec")?;
		if let Some((min, max)) = range.split_once(',') {
			spec.min = if min.is_empty() { 0 } else { min.parse().map_err(|_| "Error in option spec")? };
			spec.max = if max.is_empty() { usize::MAX } else { max.parse().map_err(|_| "Error in option spec")? };
		} else {
			spec.min = range.parse().map_err(|_| "Error in option spec")?;
			spec.max = spec.min;
		}
		if spec.max == 0 { return Err("{0} is useless in option spec"); }
		if spec.max < spec.min { return Err("Max less than min in option spec"); }
	}
	if matches!(spec.target, Some(Ref::Hash(_))) { spec.shape = Shape::Hash; }
	if matches!(spec.target, Some(Ref::Array(_))) { spec.shape = Shape::Array; }
	Ok((spec, names))
}

struct Specs {
	options: Vec<Spec>,
	aliases: BTreeMap<String, (usize, bool)>,
	short: BTreeMap<String, (usize, bool)>,
	positional: Option<crate::perl::value::Cv>,
	link: Option<Hv>,
}

fn normalize(name: &str, ignore_case: bool) -> String {
	if ignore_case { name.to_lowercase() } else { name.to_owned() }
}

fn specs(interp: &mut Interp<'_>, a: &[Sv], flags: i64) -> PResult<Specs> {
	let mut index = 0;
	let link = if let Value::Ref(Ref::Hash(h)) = arg(a, 0) { index += 1; Some(h) } else { None };
	let mut specs = Specs { options: Vec::new(), aliases: BTreeMap::new(), short: BTreeMap::new(), positional: None, link };
	while index < a.len() {
		let src = text(a, index);
		index += 1;
		let target = match arg(a, index) {
			Value::Ref(r) => { index += 1; Some(r) }
			_ => None,
		};
		if src == "<>" {
			if let Some(Ref::Code(cv)) = target { specs.positional = Some(cv); continue; }
			return Err(config_error(interp, "Option <> requires a reference to a subroutine".into()));
		}
		if target.as_ref().is_some_and(|r| !matches!(r, Ref::Scalar(_) | Ref::Array(_) | Ref::Hash(_) | Ref::Code(_))) {
			return Err(config_error(interp, format!("Invalid option linkage for \"{src}\"")));
		}
		let (spec, names) = option_spec(&src, target).map_err(|msg| config_error(interp, format!("{msg}: \"{src}\"")))?;
		let id = specs.options.len();
		for name in names {
			let long = normalize(name, flags & CASE != 0);
			if name.chars().count() == 1 {
				specs.short.insert(normalize(name, flags & CASE_SHORT != 0), (id, false));
			}
			if !(flags & BUNDLE != 0 && flags & CASE_SHORT == 0 && name.chars().count() == 1) {
				specs.aliases.insert(long.clone(), (id, false));
			}
			if spec.kind == Kind::Negate {
				for prefix in ["no", "no-"] { specs.aliases.insert(format!("{prefix}{long}"), (id, true)); }
			}
		}
		specs.options.push(spec);
	}
	Ok(specs)
}

fn opt_prefix(s: &PStr, flags: i64, prefix: Option<&Regex>) -> Option<usize> {
	if let Some(prefix) = prefix {
		return prefix.exec(s, 0, ExecOpts::default()).ok()?.and_then(|m| m.spans[0]).map(|(_, end)| end).filter(|&end| end != 0 && end < s.bytes.len());
	}
	let s = s.bytes.as_slice();
	match s {
		[b'-', b'-', _, ..] => Some(2),
		[b'-', _, ..] => Some(1),
		[b'+', _, ..] if flags & COMPAT != 0 => Some(1),
		_ => None,
	}
}

fn prefix_rx(interp: &mut Interp<'_>, pattern: &PStr) -> PResult<Regex> {
	let mut anchored = PStr::from_bytes(b"\\A(?:");
	anchored.push(pattern);
	anchored.push_bytes(b")");
	Regex::new(&anchored, RxFlags::default()).map_err(|e| interp.die_msg(e))
}

fn slice(s: &PStr, from: usize, to: usize) -> PStr { PStr::new(s.bytes[from..to].to_vec(), s.utf8) }

fn alias(specs: &Specs, name: &str, given: &str, flags: i64) -> Result<((usize, bool), String), String> {
	if flags & BUNDLE != 0 && let Some(&hit) = specs.short.get(&normalize(given, flags & CASE_SHORT != 0)) {
		return Ok((hit, normalize(given, flags & CASE_SHORT != 0)));
	}
	if let Some(&hit) = specs.aliases.get(name) { return Ok((hit, name.to_owned())); }
	if flags & ABBREV != 0 {
		let matches = specs.aliases.range(name.to_owned()..).take_while(|(key, _)| key.starts_with(name));
		let mut found = BTreeMap::new();
		for (key, &id) in matches { found.entry(id).or_insert(key.as_str()); }
		if found.len() == 1 && let Some((&id, key)) = found.first_key_value() { return Ok((id, (*key).to_owned())); }
		if !found.is_empty() {
			let mut names = found.into_values().collect::<Vec<_>>();
			names.sort_unstable();
			return Err(format!("Option {name} is ambiguous ({})", names.join(", ")));
		}
	}
	Err(format!("Unknown option: {name}"))
}

fn number(kind: Kind, v: &PStr) -> Option<Value> {
	let s = std::str::from_utf8(&v.bytes).ok()?;
	if s.is_empty() { return Some(Value::Int(0)); }
	let mut clean = None;
	if s.contains('_') {
		if s.as_bytes().windows(3).any(|w| w[1] == b'_' && !(w[0].is_ascii_hexdigit() && w[2].is_ascii_hexdigit())) || s.starts_with('_') || s.ends_with('_') { return None; }
		clean = Some(s.replace('_', ""));
	}
	let s = clean.as_deref().unwrap_or(s);
	if kind == Kind::Float {
		let n: f64 = s.parse().ok()?;
		return s.bytes().any(|b| b.is_ascii_digit()).then(|| Value::Dual(Rc::new(Dual { num: Num::Float(n), str: PStr::from_str(s) })));
	}
	let negative = s.starts_with('-');
	let digits = s.strip_prefix(['+', '-']).unwrap_or(s);
	let (radix, digits) = if kind == Kind::Extended {
		if let Some(d) = digits.strip_prefix("0x").or_else(|| digits.strip_prefix("0X")) { (16, d) }
		else if let Some(d) = digits.strip_prefix("0b").or_else(|| digits.strip_prefix("0B")) { (2, d) }
		else if digits.starts_with('0') && digits.len() > 1 { (8, digits) }
		else { (10, digits) }
	} else { (10, digits) };
	if digits.is_empty() || digits.starts_with(['+', '-']) { return None; }
	let n = u64::from_str_radix(digits, radix).ok()?;
	Some(if negative { if n <= 1_u64 << 63 { Value::Int((n as i64).wrapping_neg()) } else { Value::Num(-(n as f64)) } }
		else { i64::try_from(n).map_or(Value::UInt(n), Value::Int) })
}

fn number_prefix(kind: Kind, input: &[u8]) -> usize {
	let sign = |at| usize::from(matches!(input.get(at), Some(b'+' | b'-')));
	let scan = |mut i, radix| {
		let mut digits = 0;
		while input.get(i).is_some_and(|&c| char::from(c).is_digit(radix)) {
			digits += 1;
			i += 1;
			if input.get(i) == Some(&b'_') && input.get(i + 1).is_some_and(|&c| char::from(c).is_digit(radix)) { i += 1; }
		}
		(i, digits)
	};
	let start = sign(0);
	if kind == Kind::Extended {
		let tail = &input[start..];
		let (pre, radix) = if tail.starts_with(b"0x") || tail.starts_with(b"0X") { (2, 16) }
		else if tail.starts_with(b"0b") || tail.starts_with(b"0B") { (2, 2) }
		else if tail.starts_with(b"0") { (0, 8) } else { (0, 10) };
		let (end, n) = scan(start + pre, radix);
		return if n != 0 { end } else if pre != 0 { start + 1 } else { 0 };
	}
	let (mut end, mut n) = scan(start, 10);
	if kind == Kind::Float && input.get(end) == Some(&b'.') {
		let (after, extra) = scan(end + 1, 10);
		end = after;
		n += extra;
	}
	if n == 0 { return 0; }
	if kind == Kind::Float && matches!(input.get(end), Some(b'e' | b'E')) {
		let exponent_start = end + 1 + sign(end + 1);
		let (after, n) = scan(exponent_start, 10);
		if n != 0 { end = after; }
	}
	end
}

fn diagnostic(interp: &mut Interp<'_>, msg: impl Into<String>) { interp.warn(format!("{}\n", msg.into())); }

fn callback_name(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(callback_part(&a, 0))) }
fn callback_given(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(callback_part(&a, 1))) }
fn callback_part(a: &[Sv], index: usize) -> Value {
	if let Value::Ref(Ref::Array(parts)) = arg(a, 0) {
		return arg(&parts.elems(), index);
	}
	Value::Undef
}

fn dispatch(interp: &mut Interp<'_>, av: &Av, stream: &mut VecDeque<Sv>, cv: &crate::perl::value::Cv, args: Vec<Sv>) -> PResult<bool> {
	av.replace_elems(std::mem::take(stream).into());
	let result = interp.call_sub(cv, args, Cx::Void);
	*stream = av.replace_elems(Vec::new()).into();
	match result {
		Ok(_) => Ok(true),
		Err(Flow::Die(value)) => {
			let p = value.to_pstr();
			if p.bytes.starts_with(b"!FINISH") { return Err(Flow::Die(value)); }
			interp.warn(p.to_string_lossy().into_owned());
			Ok(false)
		}
		Err(flow) => Err(flow),
	}
}

struct Sink<'a> { spec: &'a Spec, link: Option<&'a Hv>, package: &'a str, given: &'a str }
impl Sink<'_> {
	fn store(&self, interp: &mut Interp<'_>, av: &Av, stream: &mut VecDeque<Sv>, key: Option<PStr>, mut value: Value, count: bool) -> PResult<bool> {
		let spec = self.spec;
		if let Some(Ref::Code(cv)) = &spec.target {
			let data = Ref::Array(new_av(vec![Value::str(&spec.name), Value::str(self.given)]));
			data.bless(Rc::from(CALLBACK));
			let mut args = vec![new_sv(Value::Ref(data))];
			if let Some(key) = key { args.push(new_sv(Value::Str(key))); }
			args.push(new_sv(value));
			return dispatch(interp, av, stream, cv, args);
		}
		let target = match &spec.target {
			Some(target) => target.clone(),
			None if let Some(h) = self.link => {
				let cell = h.entries_mut().entry(hash_key(&spec.name)).or_insert_with(|| new_sv(Value::Undef)).clone();
				if spec.shape == Shape::Scalar { Ref::Scalar(cell) }
				else { match (spec.shape, interp.read_sv(&cell)?) {
					(Shape::Array, Value::Ref(Ref::Array(a))) => Ref::Array(a),
					(Shape::Hash, Value::Ref(Ref::Hash(h))) => Ref::Hash(h),
					(shape, _) => {
						let target = if shape == Shape::Array { Ref::Array(new_av(Vec::new())) }
						else { Ref::Hash(crate::perl::value::new_hv()) };
						interp.write_sv(&cell, Value::Ref(target.clone()))?;
						target
					}
				} }
			}
			None => {
				let name = format!("{}::opt_{}", self.package, spec.name.replace('-', "_"));
				match spec.shape { Shape::Scalar => Ref::Scalar(interp.sv(&name)), Shape::Array => Ref::Array(interp.av(&name)), Shape::Hash => Ref::Hash(interp.hv(&name)) }
			}
		};
		match target {
			Ref::Scalar(s) => {
				if count { value = Value::Int(interp.read_sv(&s)?.to_i64().saturating_add(1)); }
				interp.write_sv(&s, value)?;
			}
			Ref::Array(a) => a.elems_mut().push(new_sv(value)),
			Ref::Hash(h) => if let Some(key) = key { set_hash(interp, &h, HKey::new(&key), value)?; },
			_ => return Err(config_error(interp, format!("Invalid option linkage for \"{}\"", spec.name))),
		}
		Ok(true)
	}
}

fn parse_value(interp: &mut Interp<'_>, spec: &Spec, raw: PStr, given: &str, through: bool) -> Option<(Option<PStr>, Value)> {
	let (key, input) = if spec.shape == Shape::Hash {
		if let Some(eq) = raw.bytes.iter().position(|&b| b == b'=') {
			(Some(slice(&raw, 0, eq)), slice(&raw, eq + 1, raw.bytes.len()))
		} else if let Some(value) = &spec.optional {
			return Some((Some(raw), value.clone()));
		} else {
			if !through { diagnostic(interp, format!("Option {given}, key \"{}\", requires a value", raw.to_string_lossy())); }
			return None;
		}
	} else { (None, raw) };
	let value = if spec.kind == Kind::String { Value::Str(input) }
	else if let Some(value) = number(spec.kind, &input) { value }
	else {
		if !through {
			let expected = if spec.kind == Kind::Float { "real number" } else { "number" };
			diagnostic(interp, format!("Value \"{}\" invalid for option {given} ({expected} expected)", input.to_string_lossy()));
		}
		return None;
	};
	Some((key, value))
}

fn long_parse(interp: &mut Interp<'_>, av: &Av, a: &[Sv], config: Config) -> PResult<Ret> {
	let flags = config.flags;
	let specs = specs(interp, a, flags)?;
	let intro = config.prefix.as_ref().map(|p| prefix_rx(interp, p)).transpose()?;
	let long_intro = config.long_prefix.as_ref().map(|p| prefix_rx(interp, p)).transpose()?;
	let package = caller(interp);
	let through = flags & THROUGH != 0;
	let mut stream: VecDeque<Sv> = av.replace_elems(Vec::new()).into();
	let mut rest = Vec::new();
	let result = (|| {
		let mut ok = true;
		while let Some(cell) = stream.pop_front() {
			let token = interp.read_sv(&cell)?.to_pstr();
			if token.bytes == b"--" {
				if through { rest.push(cell); }
				break;
			}
			let Some(prefix) = opt_prefix(&token, flags, intro.as_ref()) else {
				if flags & PERMUTE == 0 { rest.push(cell); break; }
				if let Some(cv) = &specs.positional { ok &= dispatch(interp, av, &mut stream, cv, vec![cell])?; }
				else { rest.push(cell); }
				continue;
			};
			let long = if let Some(rx) = &long_intro {
				rx.exec(&token, 0, ExecOpts::default()).ok().flatten().and_then(|m| m.spans[0]).is_some_and(|(_, end)| end == prefix)
			} else { &token.bytes[..prefix] == b"--" };
			let mut bundle = flags & BUNDLE != 0 && !long;
			let eq = token.bytes[prefix..].iter().position(|&b| b == b'=').map(|n| n + prefix);
			let split_equals = long || flags & COMPAT != 0;
			let name_end = if split_equals { eq.unwrap_or(token.bytes.len()) } else { token.bytes.len() };
			let name_s = slice(&token, prefix, name_end);
			let original = name_s.to_string_lossy();
			let name = normalize(&original, flags & CASE != 0);
			if bundle && flags & OVERRIDE != 0 && specs.aliases.contains_key(&name) { bundle = false; }
			let mut offset = prefix;
			let mut pass = None;
			loop {
				let start = offset;
				let (lookup, given, inline) = if bundle {
					let lead = token.bytes[offset];
					let next = if token.utf8 { (lead.leading_ones() as usize).max(1) } else { 1 };
					offset = (offset + next).min(token.bytes.len());
					let short = slice(&token, start, offset);
					let given = normalize(&short.to_string_lossy(), flags & CASE_SHORT != 0);
					(specs.short.get(&given).copied().map(|hit| (hit, given.clone())).ok_or_else(|| format!("Unknown option: {given}")), given, None)
				} else {
					let inline = (name_end < token.bytes.len()).then(|| slice(&token, name_end + 1, token.bytes.len()));
					(alias(&specs, &name, &original, flags), name.clone(), inline)
				};
				match lookup {
					Err(msg) => {
						if through { pass = Some(start); break; }
						if given == "help" && flags & AUTO_HELP != 0 { return help_message(interp, Vec::new(), Cx::Void); }
						if given == "version" && flags & AUTO_VERSION != 0 { return version_message(interp, Vec::new(), Cx::Void); }
						diagnostic(interp, msg);
						ok = false;
					}
					Ok(((id, negated), resolved)) => {
						let spec = &specs.options[id];
						let callback_given = if negated { resolved.strip_prefix("no-").or_else(|| resolved.strip_prefix("no")).unwrap_or(&resolved) } else { &resolved };
						let sink = Sink { spec, link: specs.link.as_ref(), package: &package, given: callback_given };
						if matches!(spec.kind, Kind::Flag | Kind::Negate | Kind::Count) {
							if inline.is_some() || (bundle && flags & VALUES_BUNDLE != 0 && offset < token.bytes.len()) {
								if bundle { offset = token.bytes.len(); }
								if through { pass = Some(start); break; }
								diagnostic(interp, format!("Option {given} does not take an argument"));
								ok = false;
							} else {
								ok &= sink.store(interp, av, &mut stream, None, Value::Int(i64::from(!negated)), spec.kind == Kind::Count)?;
							}
						} else {
							let inline = inline.or_else(|| {
								if !bundle || offset == token.bytes.len() { return None; }
								let start = offset;
								let remaining = &token.bytes[start..];
								let n = if flags & VALUES_BUNDLE != 0 || spec.kind == Kind::String || spec.shape == Shape::Hash {
									remaining.len()
								} else { number_prefix(spec.kind, remaining) };
								if n == 0 && spec.optional.is_some() { return None; }
								offset += if n == 0 { remaining.len() } else { n };
								Some(slice(&token, start, offset))
							});
							let mut consumed = Vec::new();
							let mut count = 0;
							let mut accepted = true;
							for n in 0..spec.max {
								let required = n < spec.min && (spec.optional.is_none() || spec.shape == Shape::Hash);
								let from_inline = n == 0 && inline.is_some();
								let candidate = if from_inline { inline.clone() }
								else {
									stream.front().map(|s| interp.read_sv(s).map(|v| v.to_pstr())).transpose()?.filter(|s| {
										required || !(n == 0 && bundle && offset < token.bytes.len()) && s.bytes != b"--" &&
											(if spec.kind == Kind::String || spec.shape == Shape::Hash {
												opt_prefix(s, flags, intro.as_ref()).is_none()
											} else { number(spec.kind, s).is_some() })
									})
								};
								let Some(raw) = candidate else { break; };
								if from_inline && raw.is_empty() {
									if required { break; }
									let default = spec.optional.clone().unwrap_or(Value::Undef);
									accepted &= sink.store(interp, av, &mut stream, None, default, spec.increment_default)?;
									count += 1;
									break;
								}
								if !from_inline && let Some(value) = stream.pop_front() && through { consumed.push(value); }
								if let Some((key, val)) = parse_value(interp, spec, raw, &given, through) {
									accepted &= sink.store(interp, av, &mut stream, key, val, false)?;
									count += 1;
								} else { accepted = false; break; }
							}
							if accepted && count == 0 && let Some(default) = &spec.optional {
								accepted &= sink.store(interp, av, &mut stream, None, default.clone(), spec.increment_default)?;
							} else if accepted && count < spec.min {
								accepted = false;
								if !through {
									if count == 0 { diagnostic(interp, format!("Option {given} requires an argument")); }
									else { diagnostic(interp, format!("Insufficient arguments for option {given}")); }
								}
							}
							if !accepted {
								if through {
									push_unrecognized(&mut rest, &token, &cell, prefix, start, bundle);
									rest.extend(consumed);
									break;
								}
								ok = false;
							}
						}
					}
				}
				if !bundle || offset >= token.bytes.len() { break; }
			}
			if let Some(start) = pass { push_unrecognized(&mut rest, &token, &cell, prefix, start, bundle); }
		}
		Ok(boolean(ok))
	})();
	rest.extend(stream);
	av.replace_elems(rest);
	match result {
		Err(Flow::Die(v)) if v.to_pstr().bytes.starts_with(b"!FINISH") => Ok(boolean(true)),
		result => result,
	}
}

fn push_unrecognized(rest: &mut Vec<Sv>, token: &PStr, original: &Sv, prefix: usize, start: usize, bundle: bool) {
	if bundle && start != prefix {
		let mut bytes = Vec::with_capacity(prefix + token.bytes.len() - start);
		bytes.extend_from_slice(&token.bytes[..prefix]);
		bytes.extend_from_slice(&token.bytes[start..]);
		rest.push(new_sv(Value::Str(PStr::new(bytes, token.utf8))));
	} else { rest.push(original.clone()); }
}

fn get_options(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let flags = global_config(interp);
	let av = interp.av("main::ARGV");
	long_parse(interp, &av, &a, flags)
}
fn parser_options(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let av = interp.av("main::ARGV");
	long_parse(interp, &av, a.get(1..).unwrap_or_default(), parser_config(&a))
}
fn long_array(interp: &mut Interp<'_>, a: &[Sv], flags: Config) -> PResult<Ret> {
	let Value::Ref(Ref::Array(av)) = arg(a, 0) else {
		return Err(config_error(interp, "GetOptionsFromArray: 1st parameter is not an array reference".into()));
	};
	long_parse(interp, &av, &a[1..], flags)
}
fn from_array(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let flags = global_config(interp);
	long_array(interp, &a, flags)
}
fn parser_array(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	long_array(interp, a.get(1..).unwrap_or_default(), parser_config(&a))
}

fn words(input: &PStr) -> Vec<Value> {
	let mut out = Vec::new();
	let mut word = Vec::new();
	let mut quote = None;
	let mut active = false;
	let mut chars = input.bytes.iter().copied();
	while let Some(ch) = chars.next() {
		match (quote, ch) {
			(None, b) if b.is_ascii_whitespace() => {
				if active { out.push(Value::Str(PStr::new(std::mem::take(&mut word), input.utf8))); active = false; }
			}
			(None, b'\'' | b'"') => { quote = Some(ch); active = true; }
			(Some(q), b) if q == b => quote = None,
			(q, b'\\') if q != Some(b'\'') => {
				let Some(next) = chars.next() else { return Vec::new(); };
				word.push(next);
				active = true;
			}
			(_, ch) => { word.push(ch); active = true; }
		}
	}
	if quote.is_some() { return Vec::new(); }
	if active { out.push(Value::Str(PStr::new(word, input.utf8))); }
	out
}

fn long_string(interp: &mut Interp<'_>, a: &[Sv], flags: Config, cx: Cx) -> PResult<Ret> {
	let av = new_av(words(&arg(a, 0).to_pstr()));
	let result = long_parse(interp, &av, a.get(1..).unwrap_or_default(), flags)?.scalar();
	if cx == Cx::List { Ok(Ret::Many(vec![result, Value::Ref(Ref::Array(av))])) }
	else {
		let rest = av.elems();
		if !rest.is_empty() {
			let excess = rest.iter().map(|s| s.get().to_pstr().to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
			diagnostic(interp, format!("GetOptionsFromString: Excess data \"{excess}\" in string \"{}\"", text(a, 0)));
		}
		Ok(if result.truthy() && rest.is_empty() { Ret::One(Value::Int(1)) } else { Ret::One(Value::Int(0)) })
	}
}
fn from_string(interp: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let flags = global_config(interp);
	long_string(interp, &a, flags, cx)
}
fn parser_string(interp: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	long_string(interp, a.get(1..).unwrap_or_default(), parser_config(&a), cx)
}

fn print_to(interp: &mut Interp<'_>, handle: &str, message: &str) {
	if let Some(io) = interp.handle(handle, false) { let _ = io.borrow_mut().write(&PStr::from_str(message)); }
}

fn program_version(interp: &mut Interp<'_>, package: &str) -> (String, String) {
	let program = interp.sv("main::0").get().to_pstr().to_string_lossy().into_owned();
	let version = interp.sv(&format!("{package}::VERSION")).get();
	let version = if version.is_undef() { "[unknown]".into() } else { version.to_pstr().to_string_lossy().into_owned() };
	(program, version)
}

fn version_message(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let package = caller(interp);
	let (name, version) = program_version(interp, &package);
	let message = if let Some(sv) = a.first() { interp.read_sv(sv)?.to_pstr().to_string_lossy().into_owned() } else { String::new() };
	let message = if message.starts_with('-') { "" } else { &message };
	print_to(interp, "main::STDOUT", &format!("{message}{name} version {version}\n(Getopt::Long::GetOptions version 2.52; Perl version 5.34.1)\n"));
	message_return(&a)
}
fn help_message(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let package = caller(interp);
	let (program, _) = program_version(interp, &package);
	let input = message_option(&a, "-input");
	let name = if input.is_undef() { program } else { input.to_pstr().to_string_lossy().into_owned() };
	let path = interp.resolve_path(name.as_bytes());
	let bytes = match interp.host().fs().read(path) {
		Ok(bytes) => bytes,
		Err(e) => {
			let errno = e.raw_os_error();
			let text = e.to_string();
			let text = text.split_once(" (os error ").map_or(text.as_str(), |(t, _)| t);
			interp.set_errno(&e);
			print_to(interp, "main::STDERR", &format!("Can't open {name}: {text}\n"));
			return Err(Flow::Exit(errno.unwrap_or(2)));
		}
	};
	let verbose = message_option(&a, "-verbose").to_i64();
	let option = message_option(&a, "-message");
	let message = if option.is_undef() && !text(&a, 0).starts_with('-') { text(&a, 0) } else { option.to_pstr().to_string_lossy().into_owned() };
	let mut output = String::new();
	if !message.is_empty() {
		output.push_str(&message);
		if !message.ends_with('\n') { output.push('\n'); }
	}
	let input = String::from_utf8_lossy(&bytes);
	let mut section = false;
	let mut blank = false;
	for line in input.lines() {
		if let Some(heading) = line.strip_prefix("=head1 ") {
			let heading = heading.trim();
			section = matches!(heading, "SYNOPSIS" | "USAGE") || verbose >= 1 && matches!(heading, "OPTIONS" | "ARGUMENTS") || verbose >= 2;
			blank = false;
			if section {
				let mut chars = heading.chars();
				let title = if matches!(heading, "SYNOPSIS" | "USAGE") { String::from("Usage") } else {
					chars.next().map_or_else(String::new, |c| format!("{c}{}", chars.as_str().to_ascii_lowercase()))
				};
				output.push_str(&title);
				output.push_str(":\n");
			}
		} else if line == "=cut" { section = false; }
		else if section && !line.starts_with('=') {
			if line.trim().is_empty() {
				if blank && !output.ends_with("\n\n") { output.push('\n'); }
			} else {
				output.push_str("    ");
				output.push_str(line);
				output.push('\n');
				blank = true;
			}
		}
	}
	if section && blank && !output.ends_with("\n\n") { output.push('\n'); }
	print_to(interp, "main::STDOUT", &output);
	message_return(&a)
}

fn message_option(a: &[Sv], key: &str) -> Value {
	a.chunks_exact(2).find_map(|pairs| (text(pairs, 0) == key).then(|| arg(pairs, 1))).unwrap_or(Value::Undef)
}
fn message_return(a: &[Sv]) -> PResult<Ret> {
	let status = message_option(a, "-exitval");
	if status.to_pstr().bytes == b"NOEXIT" { Ok(Ret::empty()) }
	else { Err(Flow::Exit(status.to_i64() as i32)) }
}

fn std_parse(interp: &mut Interp<'_>, a: &[Sv], checked: bool) -> PResult<Ret> {
	let spec = text(a, 0);
	let mut options = BTreeMap::new();
	let mut symbols = spec.chars().peekable();
	while let Some(name) = symbols.next() {
		let has_value = !checked || symbols.next_if_eq(&':').is_some();
		options.insert(name, has_value);
	}
	let package = caller(interp);
	let av = interp.av("main::ARGV");
	let hash = match arg(a, 1) {
		Value::Ref(Ref::Hash(h)) => Some(h),
		Value::Ref(_) => return Err(interp.die_msg("Not a HASH reference")),
		v if v.truthy() => return Ok(Ret::One(Value::Undef)),
		_ => None,
	};
	let get_value = |interp: &mut Interp<'_>, name: char, value: Value| {
		if let Some(hash) = &hash { set_hash(interp, hash, hash_key(&name.to_string()), value) }
		else {
			let slot = interp.sv(&format!("{package}::opt_{name}"));
			interp.write_sv(&slot, value)
		}
	};
	let mut stream: VecDeque<_> = av.replace_elems(Vec::new()).into();
	let result = (|| -> PResult<bool> {
		let mut ok = true;
		while let Some(cell) = stream.pop_front() {
			let token = interp.read_sv(&cell)?.to_pstr();
			if token.bytes == b"--" { break; }
			if matches!(token.bytes.as_slice(), b"--help" | b"--version") {
				let standard = interp.sv("Getopt::Std::STANDARD_HELP_VERSION").get().truthy();
				let (program, version) = program_version(interp, &package);
				let kind = if checked { "getopts" } else { "getopt" };
				let mut message = format!("{program} version {version} calling Getopt::Std::{kind} (version 1.13{}),\nrunning under Perl version 5.34.1.\n", if standard { "" } else { " [paranoid]" });
				if token.bytes == b"--help" {
					message.push_str(&format!("\nUsage: {program} [-OPTIONS [-MORE_OPTIONS]] [PROGRAM_ARG1 ...]\n\nThe following single-character options are accepted:\n"));
					for (has_value, label) in [(false, "Boolean (without arguments)"), (true, "With arguments")] {
						let names = options.iter().filter(|&(_, &needed)| needed == has_value).map(|(c, _)| format!("-{c}")).collect::<Vec<_>>();
						if !names.is_empty() { message.push_str(&format!("\t{label}: {}\n", names.join(" "))); }
					}
					message.push_str("\nOptions may be merged together.  -- stops processing of options.\n");
				}
				if !standard { message.push_str("  [Now continuing due to backward compatibility and excessive paranoia.\n   See 'perldoc Getopt::Std' about $Getopt::Std::STANDARD_HELP_VERSION.]\n"); }
				print_to(interp, "main::STDOUT", &message);
				if standard { return Err(Flow::Exit(0)); }
				continue;
			}
			if !token.bytes.starts_with(b"-") || token.bytes.len() <= 1 { stream.push_front(cell); break; }
			for (i, cp) in token.chars().skip(1).enumerate() {
				let name = char::from_u32(cp).unwrap_or(char::REPLACEMENT_CHARACTER);
				match options.get(&name).copied() {
					Some(true) => {
						let offset = token.char_to_byte(i + 2);
						let value = if offset < token.bytes.len() { Value::Str(slice(&token, offset, token.bytes.len())) }
						else if let Some(value) = stream.pop_front() { interp.read_sv(&value)? }
						else { ok = false; Value::Undef };
						get_value(interp, name, value)?;
						break;
					}
					Some(false) | None if !checked || options.contains_key(&name) => get_value(interp, name, Value::Int(1))?,
					_ => { diagnostic(interp, format!("Unknown option: {name}")); ok = false; }
				}
			}
		}
		Ok(ok)
	})();
	av.replace_elems(stream.into());
	if checked { Ok(boolean(result?)) }
	else { result.map(|_| Ret::One(hash.map_or_else(|| Value::str(""), |h| Value::Ref(Ref::Hash(h))))) }
}
fn getopt(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { std_parse(interp, &a, false) }
fn getopts(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { std_parse(interp, &a, true) }
