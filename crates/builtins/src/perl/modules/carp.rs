//! Caller-oriented warnings and exceptions (Carp).

use std::{collections::HashSet, fmt::Write as _};

use super::{arg, define, export, version};
use crate::perl::{
	interp::{Cx, Frame, Interp, PResult, Ret},
	value::{HKey, PStr, Ref, Sv, Value, new_sv},
};

/// Install Carp's exports and runtime defaults.
pub(super) fn load(i: &mut Interp<'_>, module: &str) -> PResult<()> {
	version(i, module, "1.52");
	export(i, module, &["confess", "croak", "carp"], &["cluck", "verbose", "longmess", "shortmess"]);
	define(i, module, &[("croak", croak), ("carp", carp), ("confess", confess), ("cluck", cluck),
		("longmess", longmess), ("shortmess", shortmess), ("verbose", verbose)]);
	i.define_native("Carp::import", import);
	for (name, n) in [("CarpLevel", 0), ("Verbose", 0), ("MaxArgLen", 64), ("MaxArgNums", 8), ("MaxEvalLen", 0)] {
		i.sv(&format!("Carp::{name}")).set(Value::Int(n));
	}
	i.hv("Carp::CarpInternal").entries_mut().insert(HKey::new(&PStr::from_bytes(b"Carp")), new_sv(Value::Int(1)));
	Ok(())
}
fn import(i: &mut Interp<'_>, mut a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let was_default = a.len() <= 1;
	a.retain(|v| {
		if v.get().to_pstr().bytes == b"verbose" {
			i.sv("Carp::Verbose").set(Value::Int(1));
			false
		} else { true }
	});
	if a.len() > 1 || was_default { super::exporter::import(i, a, cx) } else { Ok(Ret::empty()) }
}
fn verbose(i: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> {
	i.sv("Carp::Verbose").set(Value::Int(1));
	Ok(Ret::empty())
}
fn croak(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { carp_throw(i, &a, false) }
fn confess(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { carp_throw(i, &a, true) }
fn carp_throw(i: &mut Interp<'_>, a: &[Sv], long: bool) -> PResult<Ret> {
	let value = message(i, a, long)?;
	Err(i.die_value(value))
}
fn carp(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { carp_warn(i, &a, false) }
fn cluck(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { carp_warn(i, &a, true) }
fn carp_warn(i: &mut Interp<'_>, a: &[Sv], long: bool) -> PResult<Ret> {
	let value = message(i, a, long)?;
	let message = i.stringify(&value)?.to_string_lossy().into_owned();
	i.warn(message);
	Ok(Ret::empty())
}
fn longmess(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(message(i, &a, true)?)) }
fn shortmess(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(message(i, &a, false)?)) }
fn number(i: &mut Interp<'_>, name: &str) -> usize {
	i.sv(&format!("Carp::{name}")).get().to_i64().max(0) as usize
}
fn message(i: &mut Interp<'_>, args: &[Sv], long: bool) -> PResult<Value> {
	let first = arg(args, 0);
	if matches!(first, Value::Ref(_)) { return Ok(first); }
	let mut msg = PStr::default();
	for arg in args {
		let value = arg.get();
		msg.push(&i.stringify(&value)?);
	}
	let location = i.location();
	let skip = number(i, "CarpLevel");
	let long = long || number(i, "Verbose") != 0;
	let mut frames = Vec::new();
	for depth in 0..1024 {
		let Some(frame) = i.caller_frame(depth) else { break; };
		frames.push(frame);
	}
	let package = i.package();
	if !long {
		let mut previous = package.clone();
		let mut remaining = skip;
		for frame in &frames {
			if !is_eval(frame) && !internal(i, "Internal", &frame.package)
				&& !internal(i, "CarpInternal", &previous) && !trusted(i, &previous, &frame.package)
			{
				if remaining == 0 {
					msg.push_bytes(format!(" at {} line {}.\n", frame.file, frame.line).as_bytes());
					return Ok(Value::Str(msg));
				}
				remaining -= 1;
			}
			previous = frame.package.clone();
		}
	}
	let mut start = 0_usize;
	if skip_inside(i, &package) {
		for frame in &frames {
			start += 1;
			if !skip_inside(i, &frame.package) { break; }
		}
	}
	let start = start.saturating_add(skip).min(frames.len());
	let (file, line) = start.checked_sub(1).and_then(|n| frames.get(n)).map_or((&location.file, location.line), |fr| (&fr.file, fr.line));
	msg.push_bytes(format!(" at {file} line {line}.\n").as_bytes());
	let max_len = number(i, "MaxArgLen");
	let max_nums = number(i, "MaxArgNums");
	let max_eval = number(i, "MaxEvalLen");
	for frame in frames.iter().skip(start) {
		let call = if is_eval(frame) {
			if let Some(code) = &frame.eval_text {
				format!("{} {}", if frame.is_require { "require" } else { "eval" }, quote(code, max_eval))
			} else { "eval {...}".to_owned() }
		} else {
			let name = frame.sub.as_deref().unwrap_or("__ANON__");
			let mut args = String::new();
			if let Some(values) = &frame.args {
				for (index, value) in values.iter().enumerate() {
					if index != 0 { args.push_str(", "); }
					if max_nums != 0 && index >= max_nums { args.push_str("..."); break; }
					args.push_str(&format_arg(i, value, max_len)?);
				}
			}
			format!("{name}({args})")
		};
		msg.push_bytes(format!("\t{call} called at {} line {}\n", frame.file, frame.line).as_bytes());
	}
	Ok(Value::Str(msg))
}
fn is_eval(frame: &Frame) -> bool { frame.sub.as_deref() == Some("(eval)") }
fn internal(i: &mut Interp<'_>, map: &str, pkg: &str) -> bool {
	i.hv(&format!("Carp::{map}")).entries().get(&HKey::new(&PStr::from_str(pkg))).is_some_and(|slot| slot.get().truthy())
}
fn skip_inside(i: &mut Interp<'_>, pkg: &str) -> bool { internal(i, "Internal", pkg) || internal(i, "CarpInternal", pkg) }
fn trusted(i: &mut Interp<'_>, class: &str, caller: &str) -> bool {
	class == caller || trust_reaches(i, class, caller) || trust_reaches(i, caller, class)
}
fn trust_reaches(i: &mut Interp<'_>, class: &str, caller: &str) -> bool {
	let mut work = vec![class.to_owned()];
	let mut checked = HashSet::new();
	while let Some(name) = work.pop() {
		if name == caller { return true; }
		if !checked.insert(name.clone()) { continue; }
		let not = i.av(&format!("{name}::CARP_NOT"));
		let bases = if not.elems().is_empty() { i.av(&format!("{name}::ISA")) } else { not };
		work.extend(bases.elems().iter().map(|v| v.get().to_pstr().to_string_lossy().into_owned()));
	}
	false
}
fn format_arg(i: &mut Interp<'_>, value: &Value, limit: usize) -> PResult<String> {
	match value {
		Value::Undef => Ok("undef".to_owned()),
		Value::Str(s) => Ok(quote(s, limit)),
		Value::Ref(r) => {
			if let Some(pkg) = r.blessed() && i.find_method(&pkg, "CARP_TRACE").is_some() {
				let rep = i.call_method(value.clone(), "CARP_TRACE", vec![], Cx::Scalar)?.scalar();
				return Ok(i.stringify(&rep)?.to_string_lossy().into_owned());
			}
			let formatter = i.sv("Carp::RefArgFormatter").get();
			if let Value::Ref(Ref::Code(f)) = formatter {
				let rep = i.call_sub(&f, vec![new_sv(value.clone())], Cx::Scalar)?.scalar();
				return Ok(i.stringify(&rep)?.to_string_lossy().into_owned());
			}
			Ok(value.to_pstr().to_string_lossy().into_owned())
		}
		v => Ok(v.to_pstr().to_string_lossy().into_owned()),
	}
}
fn quote(s: &PStr, limit: usize) -> String {
	let mut out = String::from("\"");
	for (n, cp) in s.chars().enumerate() {
		if limit != 0 && n >= limit { out.push_str("\"..."); return out; }
		match cp {
			0x22 => out.push_str("\\\""), 0x5c => out.push_str("\\\\"),
			0x20..=0x7e => out.push(cp as u8 as char),
			_ => { let _ = write!(out, "\\x{{{cp:x}}}"); }
		}
	}
	out.push('"');
	out
}
