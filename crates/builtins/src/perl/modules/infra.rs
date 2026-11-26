//! Core XS-facing APIs implemented in-process. Native module loading never loads a host shared object.

use std::rc::Rc;

use super::{arg, boolean, define, export, provides, text, version};
use crate::perl::{
	interp::{Cx, Interp, PResult, Ret},
	io::Io,
	rx,
	value::{PStr, Ref, Sv, Value, new_sv},
};

const NAMED: &str = "Tie::Hash::NamedCapture";

/// These entry points are installed by Perl itself, before any `require`.
pub(super) fn install_core(i: &mut Interp<'_>) {
	define(i, "DynaLoader", &[("boot_DynaLoader", boot)]);
	define(i, "PerlIO", &[("get_layers", get_layers)]);
	define(i, "PerlIO::Layer", &[("find", find_layer)]);
	define(i, NAMED, &[("TIEHASH", named_new), ("FETCH", named_fetch), ("STORE", named_store),
		("DELETE", named_delete), ("CLEAR", named_clear), ("EXISTS", named_exists),
		("FIRSTKEY", named_first), ("NEXTKEY", named_next), ("SCALAR", named_scalar)]);
}

/// Register the requested infrastructure module and its Perl-visible version.
pub(super) fn load(i: &mut Interp<'_>, module: &str) -> PResult<()> {
	match module {
		"DynaLoader" => {
			version(i, module, "1.50");
			define(i, module, &[("bootstrap", bootstrap), ("bootstrap_inherit", bootstrap), ("dl_load_flags", load_flags)]);
		}
		"XSLoader" => {
			version(i, module, "0.30");
			define(i, module, &[("load", bootstrap), ("bootstrap_inherit", bootstrap)]);
		}
		"PerlIO" => {
			version(i, module, "1.11");
			define(i, module, &[("import", import_layers)]);
		}
		"PerlIO::Layer" => version(i, module, "1.11"),
		"PerlIO::encoding" => {
			i.require_module("Encode")?;
			version(i, module, "0.30");
		}
		"PerlIO::scalar" => version(i, module, "0.31"),
		"PerlIO::mmap" => version(i, module, "0.017"),
		"Tie::Hash::NamedCapture" => version(i, module, "0.13"),
		"attributes" => {
			version(i, module, "0.33");
			for (name, f) in [("get", attribute_get as super::NativeFn), ("reftype", attribute_type),
				("_guess_stash", attribute_stash), ("_fetch_attrs", attribute_fetch)] {
				i.define_native_proto(&format!("attributes::{name}"), f, "$");
			}
			define(i, module, &[("bootstrap", boot), ("_modify_attrs", attribute_modify)]);
			export(i, module, &[], &["get", "reftype"]);
			define(i, module, &[("import", attribute_import)]);
		}
		_ => unreachable!("infrastructure registry: {module}"),
	}
	Ok(())
}

fn boot(_: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(Value::Int(1))) }
fn load_flags(_: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(Value::Int(0))) }
fn bootstrap(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let pkg = if a.is_empty() { i.package().to_string() } else { text(&a, 0) };
	if !provides(&pkg) {
		let entries: Vec<_> = i.av("main::INC").elems().iter().map(|s| s.get().to_pstr().to_string_lossy().into_owned()).collect();
		return Err(i.die_msg(format!("Can't locate loadable object for module {pkg} in @INC (@INC contains: {})", entries.join(" "))));
	}
	i.require_module(&pkg)?;
	if a.len() > 1 && !arg(&a, 1).is_undef() { i.call_method(Value::str(&pkg), "VERSION", vec![arg(&a, 1)], Cx::Scalar)?; }
	Ok(Ret::One(Value::Int(1)))
}

fn builtin_layer(name: &str) -> bool {
	matches!(name, "unix" | "perlio" | "stdio" | "crlf" | "utf8" | "bytes" | "raw" | "pop")
}
fn find_layer(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if a.len() < 2 || a.len() > 3 { return Err(i.die_msg("Usage: PerlIO::Layer::find(class, name, load=0)")); }
	let name = text(&a, 1);
	let supported = if builtin_layer(&name) { true } else if matches!(name.as_str(), "encoding" | "scalar" | "mmap") {
		let module = format!("PerlIO::{name}");
		if arg(&a, 2).truthy() { i.require_module(&module)?; true }
		else { i.sv(&format!("{module}::VERSION")).get().truthy() }
	} else { false };
	if !supported { return Ok(Ret::empty()); }
	let item = i.sv(&format!("PerlIO::Layer::_cache::{name}"));
	let current = item.get();
	if !current.is_undef() { return Ok(Ret::One(current)); }
	let r = Ref::Scalar(new_sv(Value::str(&name)));
	r.bless(Rc::from("PerlIO::Layer"));
	let value = Value::Ref(r);
	item.set(value.clone());
	Ok(Ret::One(value))
}
fn import_layers(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	for n in 1..a.len() {
		let name = text(&a, n);
		find_layer(i, vec![new_sv(Value::str("PerlIO::Layer")), new_sv(Value::str(&name)), new_sv(Value::Int(1))], Cx::Scalar)?;
	}
	Ok(Ret::empty())
}
fn arg_handle(i: &mut Interp<'_>, value: Value) -> Option<Io> {
	match value {
		Value::Glob(g) | Value::Ref(Ref::Glob(g)) => g.io.borrow().clone(),
		Value::Ref(Ref::Io(io)) => Some(io),
		Value::Undef => None,
		v => i.handle(&v.to_pstr().to_string_lossy(), false),
	}
}
fn get_layers(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	if a.len() % 2 != 1 { return Err(i.die_msg("Usage: PerlIO::get_layers(filehandle[,args])")); }
	let mut output = false;
	let mut details = false;
	for pair in a[1..].chunks_exact(2) {
		let key = text(pair, 0);
		let enabled = arg(pair, 1).truthy();
		match key.as_str() {
			"input" => output = !enabled,
			"output" => output = enabled,
			"details" => details = enabled,
			_ => return Err(i.die_msg(format!("get_layers: unknown argument '{key}'"))),
		}
	}
	let mut values = Vec::new();
	// One FETCH of the argument; a reference to a scalar holding a glob names that glob.
	let target = match a.first() { Some(sv) => i.read_sv(sv)?, None => Value::Undef };
	let target = match target {
		Value::Ref(Ref::Scalar(inner)) => match i.read_sv(&inner)? {
			glob @ Value::Glob(_) => glob,
			_ => Value::Ref(Ref::Scalar(inner)),
		},
		other => other,
	};
	if let Some(io) = arg_handle(i, target) {
		for (name, option, flags) in io.borrow().layer_info(output) {
			if details {
				values.push(Value::str(name));
				values.push(option.map_or(Value::Undef, |arg| Value::str(&arg)));
				values.push(Value::Int(i64::from(flags)));
			} else {
				values.push(option.map_or_else(|| Value::str(name), |arg| Value::str(&format!("{name}({arg})"))));
				if flags & 0x8000 != 0 { values.push(Value::str("utf8")); }
			}
		}
	}
	Ok(if cx == Cx::List { Ret::Many(values) } else { Ret::One(values.pop().unwrap_or(Value::Undef)) })
}

fn attribute_result(mut values: Vec<Value>, cx: Cx) -> Ret {
	if cx == Cx::List { Ret::Many(values) } else { Ret::One(values.pop().unwrap_or(Value::Undef)) }
}
fn attribute_class(r: &Ref) -> Option<Rc<str>> {
	r.blessed().or_else(|| match r { Ref::Code(cv) => Some(cv.pkg.clone()), Ref::Glob(g) => Some(g.pkg.clone()), _ => None })
}
fn builtin_attributes(i: &Interp<'_>, r: &Ref) -> Vec<Value> {
	if let Ref::Code(cv) = r { i.code_attributes(cv).into_iter().map(Value::Str).collect() } else { Vec::new() }
}
fn attribute_get(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let Value::Ref(reference) = arg(&a, 0) else { return Err(i.die_msg("Usage: attributes::get $ref")); };
	if a.len() != 1 { return Err(i.die_msg("Usage: attributes::get $ref")); }
	let mut values = builtin_attributes(i, &reference);
	if let Some(class) = attribute_class(&reference) {
		let method = format!("FETCH_{}_ATTRIBUTES", reference.kind_name());
		if let Some(fetch) = i.find_method(&class, &method) {
			let result = i.call_sub(&fetch, vec![new_sv(Value::str(&class)), new_sv(Value::Ref(reference))], Cx::List)?;
			values.extend(result.list());
		}
	}
	Ok(attribute_result(values, cx))
}
fn attribute_fetch(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let Value::Ref(reference) = arg(&a, 0) else { return Err(i.die_msg("Usage: attributes::_fetch_attrs($reference)")); };
	if a.len() != 1 { return Err(i.die_msg("Usage: attributes::_fetch_attrs($reference)")); }
	Ok(attribute_result(builtin_attributes(i, &reference), cx))
}
fn attribute_type(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Value::Ref(reference) = arg(&a, 0) else { return Err(i.die_msg("Usage: attributes::reftype($reference)")); };
	Ok(Ret::One(Value::str(reference.kind_name())))
}
fn attribute_stash(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Value::Ref(reference) = arg(&a, 0) else { return Err(i.die_msg("Usage: attributes::_guess_stash($reference)")); };
	Ok(Ret::One(attribute_class(&reference).map_or(Value::Undef, |class| Value::str(&class))))
}
fn apply_attributes(i: &mut Interp<'_>, r: &Ref, a: &[Sv]) -> PResult<Vec<Value>> {
	let mut unhandled = Vec::new();
	for slot in a {
		let value = i.read_sv(slot)?;
		let spelling = i.stringify(&value)?;
		let rendered = spelling.to_string_lossy();
		let (name, on) = rendered.strip_prefix('-').map_or((rendered.as_ref(), true), |name| (name, false));
		let applied = match r {
			Ref::Code(cv) => i.modify_code_attribute(cv, name, on),
			Ref::Scalar(_) | Ref::Array(_) | Ref::Hash(_) if name == "shared" => {
				if !on { return Err(i.die_msg("A variable may not be unshared")); }
				// The interpreter is not built with ithreads.
				true
			}
			_ => false,
		};
		if !applied { unhandled.push(value); }
	}
	Ok(unhandled)
}
fn attribute_modify(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let Value::Ref(reference) = arg(&a, 0) else { return Err(i.die_msg("Usage: attributes::_modify_attrs(@attributes)")); };
	Ok(attribute_result(apply_attributes(i, &reference, &a[1..])?, cx))
}
fn attribute_import(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let Value::Ref(reference) = arg(&a, 2) else { return super::exporter::import(i, a, cx); };
	let class = attribute_class(&reference).map_or_else(|| text(&a, 1), |package| package.to_string());
	let kind = reference.kind_name();
	let mut unhandled = apply_attributes(i, &reference, &a[3..])?;
	if !unhandled.is_empty() {
		let method = format!("MODIFY_{kind}_ATTRIBUTES");
		if let Some(modify) = i.find_method(&class, &method) {
			let mut args = Vec::with_capacity(unhandled.len() + 2);
			args.extend([new_sv(Value::str(&class)), new_sv(Value::Ref(reference))]);
			let mut passed = Vec::with_capacity(unhandled.len());
			for value in &unhandled { passed.push(i.stringify(value)?); }
			args.extend(unhandled.into_iter().map(new_sv));
			unhandled = i.call_sub(&modify, args, Cx::List)?.list();
			if i.warn_on("reserved") {
				let mut rejected = Vec::with_capacity(unhandled.len());
				for value in &unhandled { rejected.push(i.stringify(value)?); }
				// Accepted attributes spelled all-lowercase may become built-in attributes later.
				let reserved: Vec<_> = passed.iter().filter(|name| !rejected.contains(name)).map(|name| name.to_string_lossy().into_owned())
					.filter(|name| {
						let word = name.split('(').next().unwrap_or_default();
						!word.is_empty() && word.chars().all(char::is_lowercase)
					}).collect();
				if !reserved.is_empty() {
					let s = if reserved.len() == 1 { "" } else { "s" };
					i.warn(format!("{kind} package attribute{s} may clash with future reserved word{s}: {}", reserved.join(" : ")));
				}
			}
		}
	}
	if unhandled.is_empty() { return Ok(Ret::empty()); }
	let mut rendered = Vec::with_capacity(unhandled.len());
	for value in &unhandled { rendered.push(i.stringify(value)?.to_string_lossy().into_owned()); }
	let plural = if rendered.len() == 1 { "" } else { "s" };
	Err(i.die_msg(format!("Invalid {kind} attribute{plural}: {}", rendered.join(" : "))))
}

/// Make Perl's blessed scalar proxy for one of the named-capture hashes.
pub(in crate::perl) fn named_capture_tie(all: bool) -> Value {
	let r = Ref::Scalar(new_sv(Value::Int(if all { 512 } else { 256 })));
	r.bless(Rc::from(NAMED));
	Value::Ref(r)
}
fn named_new(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let all = a[1.min(a.len())..].chunks(2).rev().find(|pair| text(pair, 0) == "all").is_some_and(|p| arg(p, 1).truthy());
	Ok(Ret::One(named_capture_tie(all)))
}
fn named_view(i: &mut Interp<'_>, a: &[Sv], method: &str, num: usize, usage: &str) -> PResult<Option<bool>> {
	if a.len() != num { return Err(i.die_msg(format!("Usage: {NAMED}::{method}({usage})"))); }
	let Value::Ref(Ref::Scalar(s)) = arg(a, 0) else { return Ok(None); };
	Ok(Some(s.get().to_i64() & 512 != 0))
}
fn named_matches(i: &mut Interp<'_>, a: &[Sv], method: &str, num: usize, usage: &str) -> PResult<Option<Vec<(PStr, Value)>>> {
	Ok(named_view(i, a, method, num, usage)?.and_then(|all| rx::match_hash(i, if all { "-" } else { "+" })))
}
fn named_fetch(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let key = arg(&a, 1).to_pstr();
	let value = named_matches(i, &a, "FETCH", 2, "$key")?.and_then(|values| values.into_iter().find(|(k, _)| *k == key));
	Ok(Ret::One(value.map_or(Value::Undef, |(_, v)| v)))
}
fn named_mutation(i: &mut Interp<'_>, a: &[Sv], method: &str, num: usize, usage: &str) -> PResult<Ret> {
	if a.len() != num { return Err(i.die_msg(format!("Usage: {NAMED}::{method}({usage})"))); }
	Err(i.die_msg("Modification of a read-only value attempted"))
}
fn named_store(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { named_mutation(i, &a, "STORE", 3, "$key, $value") }
fn named_delete(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { named_mutation(i, &a, "DELETE", 2, "$key") }
fn named_clear(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { named_mutation(i, &a, "CLEAR", 1, "") }
fn named_exists(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let key = arg(&a, 1).to_pstr();
	let Some(items) = named_matches(i, &a, "EXISTS", 2, "$key")? else { return Ok(Ret::empty()); };
	Ok(boolean(items.iter().any(|(k, _)| *k == key)))
}
fn named_first(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let item = named_matches(i, &a, "FIRSTKEY", 1, "")?.and_then(|v| v.into_iter().next());
	Ok(Ret::One(item.map_or(Value::Undef, |(k, _)| Value::Str(k))))
}
fn named_next(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let previous = arg(&a, 1).to_pstr();
	let item = named_matches(i, &a, "NEXTKEY", 2, "$lastkey")?.and_then(|v| {
		let mut iter = v.into_iter();
		iter.find(|(k, _)| *k == previous)?;
		iter.next()
	});
	Ok(Ret::One(item.map_or(Value::Undef, |(k, _)| Value::Str(k))))
}
fn named_scalar(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let count = named_view(i, &a, "SCALAR", 1, "")?.and_then(|all| rx::named_count(i, all));
	Ok(Ret::One(count.map_or(Value::Undef, |n| Value::Int(n as i64))))
}
