//! Class-related pragmas and lexical builtin failure exceptions.

use std::rc::Rc;

use super::super::{arg, boolean, define, isa, text};
use crate::perl::{
	interp::{Cx, Interp, PResult, Ret},
	value::{HKey, Hv, PStr, Ref, Sv, Value, new_av, new_hv, new_sv},
};

/// Register each pragma's supplementary methods.
pub(super) fn install(i: &mut Interp<'_>, module: &str) {
	match module {
		"fields" => define(i, module, &[("new", new_fields), ("phash", fields_phash)]),
		"overload" => define(i, module, &[("Method", overload_method), ("Overloaded", overloaded),
			("StrVal", strval), ("OverloadedStringify", overload_stringify),
			("constant", overload_constant), ("remove_constant", overload_remove_constant)]),
		"mro" => define(i, module, &[("set_mro", set_mro), ("get_mro", get_mro),
			("get_linear_isa", get_linear_isa), ("is_universal", is_universal), ("get_pkg_gen", get_pkg_gen),
			("get_isarev", get_isarev), ("method_changed_in", method_changed_in), ("invalidate_all_method_caches", invalidate_caches)]),
		"autodie" => {
			define(i, "autodie::exception", &[("stringify", exception_stringify), ("function", exception_function),
				("errno", exception_errno), ("context", exception_context), ("matches", exception_matches),
				("package", exception_package), ("file", exception_file), ("line", exception_line),
				("return", exception_return)]);
			i.set_overload("autodie::exception", "\"\"", Value::str("stringify"));
			i.set_overload("autodie::exception", "fallback", Value::Int(1));
			isa(i, "autodie::exception::system", &["autodie::exception"]);
		}
		_ => {}
	}
}

/// Load (unless opted out) and append each named parent to `@ISA`.
pub(super) fn parent(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let target = i.package();
	let no_require = text(&a, 1) == "-norequire";
	for n in 1 + usize::from(no_require)..a.len() {
		let base = text(&a, n);
		if !no_require { i.require_module(&base)?; }
		if base == target.as_ref() {
			i.warn(format!("Class '{target}' tried to inherit from itself"));
			continue;
		}
		i.av(&format!("{target}::ISA")).elems_mut().push(new_sv(Value::str(&base)));
	}
	Ok(Ret::empty())
}

/// Inherit from an already-defined or loadable package, including public fields.
pub(super) fn base(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let target = i.package();
	for n in 1..a.len() {
		let base = text(&a, n).replace('\'', "::");
		if base == target.as_ref() {
			i.warn(format!("Class '{target}' tried to inherit from itself\n"));
			continue;
		}
		let av = i.av(&format!("{target}::ISA"));
		if av.elems().iter().any(|s| s.get().to_pstr().to_string_lossy() == base) { continue; }
		if let Err(e) = i.require_module(&base) {
			let message = match &e { crate::perl::interp::Flow::Die(v) => v.to_pstr(), _ => return Err(e) };
			let file = format!("Can't locate {}.pm in @INC", base.replace("::", "/"));
			if !message.to_string_lossy().starts_with(&file) { return Err(e); }
		}
		if i.package_globs(&base).is_empty() {
			let inc: Vec<_> = i.av("main::INC").elems().iter().map(|s| s.get().to_pstr().to_string_lossy().into_owned()).collect();
			let loc = i.location();
			return Err(i.die_msg(format!("Base class package \"{base}\" is empty.\n    (Perhaps you need to 'use' the module which defines that package first,\n    or make that module available in @INC (@INC contains: {}).\n at {} line {}.\n", inc.join(" "), loc.file, loc.line)));
		}
		av.elems_mut().push(new_sv(Value::str(&base)));
		let base_fields = i.hv(&format!("{base}::FIELDS"));
		let target_fields = i.hv(&format!("{target}::FIELDS"));
		for (key, slot) in base_fields.entries().iter() {
			if key.to_pstr().bytes.first() == Some(&b'_') { continue; }
			target_fields.entries_mut().entry(key.clone()).or_insert_with(|| new_sv(slot.get()));
		}
		let inherited = i.av(&format!("fields::attr::{base}"));
		let mine = i.av(&format!("fields::attr::{target}"));
		if inherited.elems().len() > mine.elems().len() {
			*mine.elems_mut() = inherited.elems().clone();
		}
	}
	Ok(Ret::empty())
}

/// Declare the fields of a package, retaining inherited field indices.
pub(super) fn fields(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let pkg = i.package();
	let fields = i.hv(&format!("{pkg}::FIELDS"));
	let attrs = i.av(&format!("fields::attr::{pkg}"));
	if attrs.elems().is_empty() { attrs.elems_mut().push(new_sv(Value::Int(0))); }
	for n in 1..a.len() {
		let name = arg(&a, n).to_pstr();
		let key = HKey::new(&name);
		if fields.entries().contains_key(&key) { continue; }
		let offset = attrs.elems().len();
		let flag = if name.bytes.first() == Some(&b'_') { 0x12 } else { 0x11 };
		attrs.elems_mut().push(new_sv(Value::Int(flag)));
		fields.entries_mut().insert(key, new_sv(Value::Int(offset as i64)));
	}
	Ok(Ret::empty())
}

fn new_fields(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let class = match arg(&a, 0) {
		Value::Ref(r) => r.blessed().unwrap_or_else(|| i.package()),
		v => Rc::from(v.to_pstr().to_string_lossy().as_ref()),
	};
	let h = new_hv();
	let fields = i.hv(&format!("{class}::FIELDS"));
	let keys: Vec<_> = fields.entries().keys().map(HKey::to_pstr).collect();
	restrict(i, &h, keys)?;
	let r = Ref::Hash(h);
	r.bless(class);
	Ok(Ret::One(Value::Ref(r)))
}

fn fields_phash(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let hash = new_hv();
	if let Value::Ref(Ref::Array(keys)) = arg(&a, 0) {
		let Value::Ref(Ref::Array(values)) = arg(&a, 1) else { return Err(i.die_msg("Expected array reference")); };
		for (index, key) in keys.elems().iter().enumerate() {
			let val = values.elems().get(index).map_or(Value::Undef, |v| v.get());
			hash.entries_mut().insert(HKey::new(&key.get().to_pstr()), new_sv(val));
		}
	} else {
		for pair in a.chunks(2) { hash.entries_mut().insert(HKey::new(&arg(pair, 0).to_pstr()), new_sv(arg(pair, 1))); }
	}
	let keys: Vec<_> = hash.entries().keys().map(HKey::to_pstr).collect();
	restrict(i, &hash, keys)?;
	Ok(Ret::One(Value::Ref(Ref::Hash(hash))))
}

fn restrict(i: &mut Interp<'_>, hash: &Hv, keys: Vec<PStr>) -> PResult<()> {
	i.require_module("Hash::Util")?;
	let lock = i.find_method("Hash::Util", "lock_ref_keys").ok_or_else(|| i.die_msg("Undefined subroutine &Hash::Util::lock_ref_keys called"))?;
	let args = std::iter::once(Value::Ref(Ref::Hash(hash.clone())))
		.chain(keys.into_iter().map(Value::Str)).map(new_sv).collect();
	i.call_sub(&lock, args, Cx::Void)?;
	Ok(())
}

const OPERATORS: &[&str] = &["fallback", "nomethod", "=", "++", "--", "+", "-", "*", "/", "%", "**", "<<", ">>",
	"x", ".", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", "x=", ".=", "&", "|", "^", "&=", "|=", "^=", "&.",
	"|.", "^.", "&.=", "|.=", "^.=", "~", "~.", "<", "<=", ">", ">=", "==", "!=", "<=>", "lt", "le", "gt", "ge", "eq",
	"ne", "cmp", "neg", "!", "abs", "atan2", "cos", "sin", "exp", "log", "sqrt", "int", "bool", "0+", "\"\"", "${}",
	"@{}", "%{}", "&{}", "*{}", "<>", "-X", "qr", "~~"];

/// Register operator handlers for the caller's package.
pub(super) fn overload(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let package = i.package();
	for pair in a[1.min(a.len())..].chunks(2) {
		let key = text(pair, 0);
		if OPERATORS.contains(&key.as_str()) { i.set_overload(&package, &key, arg(pair, 1)); }
		else { i.warn(format!("overload arg '{key}' is invalid")); }
	}
	Ok(Ret::empty())
}

/// Remove the caller's named operator handlers.
pub(super) fn no_overload(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let package = i.package();
	for n in 1..a.len() { i.set_overload(&package, &text(&a, n), Value::Undef); }
	Ok(Ret::empty())
}

fn overload_constant(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	for pair in a.chunks(2) {
		let kind = text(pair, 0);
		let code = arg(pair, 1);
		if !matches!(kind.as_str(), "integer" | "float" | "binary" | "q" | "qr") {
			i.warn_category("overload", format!("'{kind}' is not an overloadable type"));
		} else if !matches!(code, Value::Ref(Ref::Code(_))) {
			i.warn_category("overload", format!("'{kind}' needs a code reference"));
		} else { i.compiling_hints().constant_overloads.insert(kind, code); }
	}
	Ok(Ret::empty())
}
fn overload_remove_constant(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	for pair in a.chunks(2) { i.compiling_hints().constant_overloads.remove(&text(pair, 0)); }
	Ok(Ret::empty())
}

fn overload_class(v: Value) -> Option<Rc<str>> {
	match v { Value::Ref(r) => r.blessed(), v => Some(Rc::from(v.to_pstr().to_string_lossy().as_ref())) }
}
fn method_for(i: &mut Interp<'_>, class: &str, op: &str) -> Option<Value> {
	match i.overload_handler(class, op)? {
		v @ Value::Ref(Ref::Code(_)) => Some(v),
		v if v.truthy() => i.find_method(class, &v.to_pstr().to_string_lossy()).map(|code| Value::Ref(Ref::Code(code))),
		_ => None,
	}
}
fn overload_method(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let value = overload_class(arg(&a, 0)).and_then(|class| method_for(i, &class, &text(&a, 1)));
	Ok(Ret::One(value.unwrap_or(Value::Undef)))
}
fn overloaded(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if let Some(class) = overload_class(arg(&a, 0)) && i.has_overload(&class) {
		return Ok(Ret::One(Value::Ref(Ref::Glob(i.glob(&format!("{class}::()"))))));
	}
	Ok(Ret::empty())
}
fn strval(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(Value::Str(arg(&a, 0).to_pstr()))) }
fn overload_stringify(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let value = overload_class(arg(&a, 0)).and_then(|class| ["\"\"", "0+", "bool"].into_iter().find_map(|op| method_for(i, &class, op)));
	Ok(Ret::One(value.unwrap_or(Value::Undef)))
}

/// Set the method resolution order for the compiling package.
pub(super) fn mro(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let package = i.package();
	let order = text(&a, 1);
	if order.is_empty() { Ok(Ret::empty()) } else { set_order(i, &package, &order) }
}
fn set_mro(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { set_order(i, &text(&a, 0), &text(&a, 1)) }
fn set_order(i: &mut Interp<'_>, class: &str, order: &str) -> PResult<Ret> {
	if !matches!(order, "c3" | "dfs") { return Err(i.die_msg(format!("Invalid mro name: '{order}'"))); }
	if !i.has_package(class) { i.hv(&format!("{class}::")); }
	i.hv("mro::MRO").entries_mut().insert(key(class), new_sv(Value::str(order)));
	Ok(Ret::empty())
}
fn key(name: &str) -> HKey { HKey::new(&PStr::from_str(name)) }
fn named_order(i: &mut Interp<'_>, class: &str) -> Value {
	i.hv("mro::MRO").entries().get(&key(class)).map_or_else(|| Value::str("dfs"), |s| s.get())
}
fn get_mro(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(named_order(i, &text(&a, 0)))) }
fn get_linear_isa(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let class = text(&a, 0);
	let order = arg(&a, 1);
	let order = if order.is_undef() { named_order(i, &class) } else { order };
	let path = i.linear_isa(&class, &order.to_pstr().to_string_lossy()).map_err(|err| i.die_msg(err))?;
	Ok(Ret::One(Value::Ref(Ref::Array(new_av(path.into_iter().map(|class| Value::str(&class)).collect())))))
}
fn is_universal(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let class = text(&a, 0);
	let order = named_order(i, "UNIVERSAL").to_pstr();
	let path = i.linear_isa("UNIVERSAL", &order.to_string_lossy()).map_err(|err| i.die_msg(err))?;
	Ok(boolean(path.iter().any(|p| p.as_ref() == class)))
}
fn get_pkg_gen(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(crate::perl::value::Num::UInt(i.package_generation(&text(&a, 0))).into_value()))
}
fn get_isarev(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let class = text(&a, 0);
	let mut subclasses = Vec::new();
	for pkg in i.package_names() {
		if pkg.as_ref() == class { continue; }
		let order = i.linear_isa(&pkg, "dfs").map_err(|err| i.die_msg(err))?;
		if order.iter().skip(1).any(|p| p.as_ref() == class) { subclasses.push(Value::str(&pkg)); }
	}
	Ok(Ret::One(Value::Ref(Ref::Array(new_av(subclasses)))))
}
fn method_changed_in(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let class = text(&a, 0);
	if !i.mark_package_changed(&class) { return Err(i.die_msg(format!("No such class: '{class}'!"))); }
	Ok(Ret::empty())
}
fn invalidate_caches(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if !a.is_empty() { return Err(i.die_msg("Usage: mro::invalidate_all_method_caches()")); }
	// Methods are resolved against current stash contents on every lookup.
	Ok(Ret::empty())
}

const IO: &[&str] = &["binmode", "close", "closedir", "fcntl", "fileno", "flock", "ioctl", "open",
	"opendir", "pipe", "read", "readlink", "seek", "sysopen", "sysread", "sysseek", "syswrite", "tell", "truncate"];
const FILESYSTEM: &[&str] = &["chdir", "chmod", "chown", "link", "mkdir", "rename", "rmdir", "symlink", "unlink", "utime"];
const SOCKET: &[&str] = &["accept", "bind", "connect", "getsockopt", "listen", "recv", "send", "setsockopt", "shutdown", "socket", "socketpair"];
const PROCESS: &[&str] = &["exec", "fork", "kill", "system"];
fn in_tag(name: &str, tag: &str) -> bool {
	match tag {
		":default" | ":all" => [IO, FILESYSTEM, SOCKET].iter().any(|group| group.contains(&name)) || (tag == ":all" && PROCESS.contains(&name)),
		":io" => [IO, SOCKET].iter().any(|group| group.contains(&name)),
		":filesys" => FILESYSTEM.contains(&name) || name == "readlink",
		":file" => matches!(name, "open" | "sysopen" | "close" | "read" | "seek" | "tell" | "truncate"),
		":socket" => SOCKET.contains(&name), ":system" => PROCESS.contains(&name),
		_ => tag.trim_start_matches("CORE::") == name,
	}
}
fn configure_autodie(i: &mut Interp<'_>, a: &[Sv], on: bool) -> PResult<Ret> {
	let defaults = [":default".to_owned()];
	let opts: Vec<_> = (1..a.len()).map(|n| text(a, n)).collect();
	let opts = if opts.is_empty() { defaults.as_slice() } else { opts.as_slice() };
	let mut enabled = i.compiling_hints().autodie.clone();
	for opt in opts {
		if opt == ":void" { continue; }
		let mut seen = false;
		for &name in [IO, FILESYSTEM, SOCKET, PROCESS].into_iter().flatten() {
			if !in_tag(name, opt) { continue; }
			seen = true;
			if on {
				if !enabled.iter().any(|n| n == name) { enabled.push(name.to_owned()); }
			} else { enabled.retain(|n| n != name); }
		}
		if !seen { return Err(i.die_msg(format!("'{opt}' is not a recognised autodie function or tag"))); }
	}
	i.compiling_hints().autodie = enabled;
	Ok(Ret::empty())
}
/// Enable lexical exceptions for the requested functions or tags.
pub(super) fn autodie(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { configure_autodie(i, &a, true) }
/// Disable lexical exceptions for the requested functions or tags.
pub(super) fn no_autodie(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { configure_autodie(i, &a, false) }
/// Convert a failed builtin result into an `autodie::exception`.
pub(super) fn autodie_result(i: &mut Interp<'_>, name: &str, result: PResult<Ret>) -> PResult<Ret> {
	let result = result?;
	let name = name.trim_start_matches("CORE::");
	if !i.hints().autodie.iter().any(|n| n == name) { return Ok(result); }
	let (context, value) = match &result {
		Ret::One(v) => ("scalar", v.clone()),
		Ret::Many(v) => ("list", v.last().cloned().unwrap_or(Value::Undef)),
	};
	let failed = match name {
		"read" | "sysread" | "syswrite" | "sysseek" | "fork" | "fileno" | "tell" | "recv" | "send" | "readlink" => value.is_undef() || matches!(value, Value::Int(n) if n < 0),
		"system" => value.to_i64() != 0,
		_ => !value.truthy(),
	};
	if !failed { return Ok(result); }
	let h = new_hv();
	let errno = i.sv("main::!").get();
	let loc = i.location();
	let package = i.package();
	let message = format!("Can't {name}: '{}' at {} line {}\n", errno.to_pstr().to_string_lossy(), loc.file, loc.line);
	for (keyname, v) in [("message", Value::str(&message)), ("errno", errno), ("context", Value::str(context)),
		("function", Value::str(&format!("CORE::{name}"))), ("return", value), ("package", Value::str(&package)),
		("file", Value::str(&loc.file)), ("line", Value::Int(loc.line.into()))]
	{ h.entries_mut().insert(key(keyname), new_sv(v)); }
	let exception = Ref::Hash(h);
	exception.bless(Rc::from(if name == "system" { "autodie::exception::system" } else { "autodie::exception" }));
	Err(i.die_value(Value::Ref(exception)))
}
fn field(h: &Hv, name: &str) -> Value { h.entries().get(&key(name)).map_or(Value::Undef, |s| s.get()) }
macro_rules! accessors {
	($($function:ident: $key:literal),* $(,)?) => { $(
		fn $function(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
			Ok(Ret::One(if let Value::Ref(Ref::Hash(h)) = arg(&a, 0) { field(&h, $key) } else { Value::Undef }))
		}
	)* };
}
accessors! { exception_stringify: "message", exception_function: "function", exception_errno: "errno",
	exception_context: "context", exception_package: "package", exception_file: "file", exception_line: "line", exception_return: "return" }
fn exception_matches(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Value::Ref(Ref::Hash(h)) = arg(&a, 0) else { return Ok(boolean(false)); };
	let function = field(&h, "function").to_pstr();
	Ok(boolean(in_tag(function.to_string_lossy().trim_start_matches("CORE::"), &text(&a, 1))))
}
