//! Core list and scalar utilities (List::Util, Scalar::Util).

use std::{cmp::Ordering, collections::HashSet, rc::Rc};

use super::{arg, boolean, define, export, version};
use crate::perl::{
	ast::{Builtin, BuiltinOrigin, Call, CallTarget},
	interp::{Cx, Flow, Interp, NativeFn, PResult, Ret},
	ops,
	value::{Cv, Dual, Gv, Num, PStr, Ref, Sv, Value, new_av, new_sv},
};

/// Register public exports, callbacks and precise prototypes for both packages.
pub(super) fn load(i: &mut Interp<'_>, package: &str) -> PResult<()> {
	version(i, package, "1.55");
	if package == "Scalar::Util" {
		let defs: &[(&str, NativeFn)] = &[("blessed", blessed), ("reftype", reftype), ("looks_like_number", looks_numeric),
			("refaddr", refaddr), ("dualvar", dualvar), ("isdual", isdual), ("readonly", readonly),
			("weaken", weaken), ("unweaken", unweaken), ("isweak", isweak), ("openhandle", openhandle),
			("isvstring", false_value), ("tainted", false_value), ("set_prototype", set_prototype)];
		export(i, package, &[], &defs.iter().map(|(s, _)| *s).collect::<Vec<_>>());
		for &(name, f) in defs {
			let prototype = match name { "dualvar" => "$$", "set_prototype" => "&$", _ => "$" };
			i.define_native_proto(&format!("{package}::{name}"), f, prototype);
		}
		return Ok(());
	}
	let defs: &[(&str, NativeFn, &str)] = &[
		("all", all, "&@"), ("any", any, "&@"), ("first", first, "&@"), ("none", none, "&@"), ("notall", notall, "&@"),
		("reduce", reduce, "&@"), ("reductions", reductions, "&@"), ("min", min, "@"), ("max", max, "@"),
		("minstr", minstr, "@"), ("maxstr", maxstr, "@"), ("product", product, "@"), ("sum", sum, "@"), ("sum0", sum0, "@"),
		("sample", sample, "$@"), ("shuffle", shuffle, "@"), ("uniq", uniq, "@"), ("uniqint", uniqint, "@"),
		("uniqnum", uniqnum, "@"), ("uniqstr", uniqstr, "@"), ("head", head, "$@"), ("tail", tail, "$@"),
		("pairs", pairs, "@"), ("unpairs", unpairs, "@"), ("pairkeys", pairkeys, "@"), ("pairvalues", pairvalues, "@"),
		("pairmap", pairmap, "&@"), ("pairgrep", pairgrep, "&@"), ("pairfirst", pairfirst, "&@"),
	];
	export(i, package, &[], &defs.iter().map(|(s, _, _)| *s).collect::<Vec<_>>());
	for &(name, f, prototype) in defs { i.define_native_proto(&format!("{package}::{name}"), f, prototype); }
	define(i, "List::Util::_Pair", &[("key", pair_key), ("value", pair_value)]);
	Ok(())
}

fn value(v: &Sv) -> Value { v.get() }
fn stringify_entry(i: &mut Interp<'_>, v: &Value) -> PResult<PStr> {
	if v.is_undef() { i.warn_category("uninitialized", "Use of uninitialized value in subroutine entry"); }
	i.stringify(v)
}
fn numify_entry(i: &mut Interp<'_>, v: &Value) -> PResult<Num> {
	if v.is_undef() {
		i.warn_category("uninitialized", "Use of uninitialized value in subroutine entry");
	} else if let Value::Str(s) = v && i.warn_on("numeric") && !v.is_numeric_string() {
		i.warn_category("numeric", format!("Argument \"{}\" isn't numeric in subroutine entry", s.to_string_lossy()));
	}
	i.numify(v)
}
fn referent(a: &[Sv]) -> Option<Ref> { if let Value::Ref(r) = arg(a, 0) { Some(r) } else { None } }
fn blessed(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(referent(&a).and_then(|r| r.blessed()).map_or(Value::Undef, |pkg| Value::str(&pkg)))) }
fn reftype(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(referent(&a).map_or(Value::Undef, |r| Value::str(r.kind_name())))) }
fn refaddr(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(referent(&a).map_or(Value::Undef, |r| Num::UInt(r.addr() as u64).into_value()))) }
fn looks_numeric(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(boolean(a.first().is_some_and(|sv| sv.get().looks_like_number())))
}
fn dualvar(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let num = numify_entry(i, &arg(&a, 0))?;
	let str = stringify_entry(i, &arg(&a, 1))?;
	Ok(Ret::One(Value::Dual(Rc::new(Dual { num, str }))))
}
fn isdual(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(boolean(a.first().is_some_and(|sv| matches!(sv.get(), Value::Dual(_)))))
}
fn readonly(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(Value::Int(if a.first().is_some_and(|sv| super::readonly_sv(i, sv)) { 0x0800_0000 } else { 0 })))
}
fn false_value(_: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(boolean(false)) }
fn weaken(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if let Some(value) = a.first() {
		if value.is_weak() { i.warn_category("misc", "Reference is already weak"); }
		else { value.weaken().map_err(|e| i.die_msg(e))?; }
	}
	Ok(Ret::empty())
}
fn unweaken(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if let Some(value) = a.first() {
		if !value.is_weak() && matches!(value.get(), Value::Ref(_)) { i.warn_category("misc", "Reference is not weak"); }
		else { value.unweaken().map_err(|e| i.die_msg(e))?; }
	}
	Ok(Ret::empty())
}
fn isweak(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(boolean(a.first().is_some_and(|s| s.is_weak())))
}
fn openhandle(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let v = arg(&a, 0);
	let open = match &v {
		Value::Ref(Ref::Io(io)) => io.borrow().is_open(),
		Value::Glob(gv) | Value::Ref(Ref::Glob(gv)) => gv.io.borrow().as_ref().is_some_and(|io| io.borrow().is_open()),
		_ => false,
	};
	Ok(Ret::One(if open { v } else { Value::Undef }))
}
fn set_prototype(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let v = arg(&a, 0);
	let Value::Ref(Ref::Code(code)) = &v else { return Err(i.die_msg("set_prototype: not a reference to a subroutine")); };
	let proto = arg(&a, 1);
	*code.prototype.borrow_mut() = (!proto.is_undef()).then(|| proto.to_pstr());
	Ok(Ret::One(v))
}

#[derive(Clone, Copy)]
enum Predicate { All, Any, None, NotAll, First }
fn callback(i: &mut Interp<'_>, a: &[Sv], op: &str) -> PResult<Cv> {
	if let Value::Ref(Ref::Code(c)) = arg(a, 0) { Ok(c) }
	else { Err(i.die_msg(format!("Not a subroutine reference in {op}"))) }
}
fn predicate(i: &mut Interp<'_>, a: &[Sv], mode: Predicate, op: &str) -> PResult<Ret> {
	let cv = callback(i, a, op)?;
	for sv in a.iter().skip(1) {
		if i.is_cancelled() { return Err(Flow::Cancelled); }
		let check = i.with_topic(sv.clone(), |i| i.call_sub(&cv, vec![], Cx::Scalar))?.scalar();
		let yes = i.truthy(&check)?;
		match mode {
			Predicate::First if yes => return Ok(Ret::One(value(sv))),
			Predicate::All if !yes => return Ok(boolean(false)),
			Predicate::Any if yes => return Ok(boolean(true)),
			Predicate::None if yes => return Ok(boolean(false)),
			Predicate::NotAll if !yes => return Ok(boolean(true)),
			_ => {}
		}
	}
	Ok(match mode { Predicate::First => Ret::empty(), _ => boolean(matches!(mode, Predicate::All | Predicate::None)) })
}
macro_rules! predicate_fns { ($($name:ident => $mode:ident),* $(,)?) => {$ (
	fn $name(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { predicate(i, &a, Predicate::$mode, stringify!($name)) }
)*}; }
predicate_fns! { all => All, any => Any, none => None, notall => NotAll, first => First }

fn pair_globs(i: &mut Interp<'_>) -> (Gv, Gv) {
	let pkg = i.package();
	(i.glob(&format!("{pkg}::a")), i.glob(&format!("{pkg}::b")))
}
fn with_ab<T>(i: &mut Interp<'_>, (ga, gb): &(Gv, Gv), a: Sv, b: Sv, f: impl FnOnce(&mut Interp<'_>) -> PResult<T>) -> PResult<T> {
	let saved_a = ga.scalar.replace(a);
	let saved_b = gb.scalar.replace(b);
	let ret = f(i);
	ga.scalar.replace(saved_a);
	gb.scalar.replace(saved_b);
	ret
}
fn reduce(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { fold(i, &a, false, Cx::Scalar) }
fn reductions(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { fold(i, &a, true, cx) }
fn fold(i: &mut Interp<'_>, a: &[Sv], reductions: bool, cx: Cx) -> PResult<Ret> {
	let cv = callback(i, a, if reductions { "reductions" } else { "reduce" })?;
	let Some(first) = a.get(1) else { return Ok(if reductions && cx == Cx::List { Ret::Many(Vec::new()) } else { Ret::empty() }); };
	let accumulator = new_sv(value(first));
	let keep_all = reductions && cx == Cx::List;
	let mut out = if keep_all { vec![value(first)] } else { Vec::new() };
	let globs = pair_globs(i);
	for next in a.iter().skip(2) {
		if i.is_cancelled() { return Err(Flow::Cancelled); }
		let v = with_ab(i, &globs, accumulator.clone(), next.clone(), |i| i.call_sub(&cv, vec![], Cx::Scalar))?.scalar();
		if keep_all { out.push(v.clone()); }
		accumulator.set(v);
	}
	Ok(if keep_all { Ret::Many(out) } else { Ret::One(value(&accumulator)) })
}

fn extreme(i: &mut Interp<'_>, a: &[Sv], max: bool, string: bool) -> PResult<Ret> {
	let Some(first) = a.first() else { return Ok(Ret::empty()) };
	let mut best = value(first);
	if string {
		let mut key = stringify_entry(i, &best)?;
		for sv in a.iter().skip(1) {
			let candidate = value(sv);
			let new = stringify_entry(i, &candidate)?;
			if if max { new > key } else { new < key } { key = new; best = candidate; }
		}
	} else {
		let mut key = numify_entry(i, &best)?;
		for sv in a.iter().skip(1) {
			let candidate = value(sv);
			let n = numify_entry(i, &candidate)?;
			let smaller = ops::num_cmp(n, key) == Some(Ordering::Less);
			if (max && !smaller) || (!max && smaller) { key = n; best = candidate; }
		}
	}
	Ok(Ret::One(best))
}
fn min(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { extreme(i, &a, false, false) }
fn max(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { extreme(i, &a, true, false) }
fn minstr(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { extreme(i, &a, false, true) }
fn maxstr(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { extreme(i, &a, true, true) }
fn sum(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { if a.is_empty() { Ok(Ret::empty()) } else { sum0(i, a, Cx::Scalar) } }
fn sum0(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let mut acc = Num::Int(0);
	for sv in a { acc = ops::add(acc, numify_entry(i, &value(&sv))?); }
	Ok(Ret::One(acc.into_value()))
}
fn product(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let mut acc = Num::Int(1);
	for sv in a { acc = ops::mul(acc, numify_entry(i, &value(&sv))?); }
	Ok(Ret::One(acc.into_value()))
}
fn values_ret(mut a: impl DoubleEndedIterator<Item = Value>, cx: Cx) -> Ret {
	if cx == Cx::List { Ret::Many(a.collect()) } else { Ret::One(a.next_back().unwrap_or(Value::Undef)) }
}
fn head(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { take(i, &a, false, cx) }
fn tail(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { take(i, &a, true, cx) }
fn take(i: &mut Interp<'_>, a: &[Sv], tail: bool, cx: Cx) -> PResult<Ret> {
	let n = i.numify(&arg(a, 0))?.wrapping_iv();
	let rest = &a[1.min(a.len())..];
	let count = if n < 0 { rest.len().saturating_sub(n.unsigned_abs() as usize) } else { rest.len().min(n as usize) };
	let slice = if tail { &rest[rest.len() - count..] } else { &rest[..count] };
	Ok(values_ret(slice.iter().map(value), cx))
}
fn random(i: &mut Interp<'_>, rand: Option<&Cv>) -> PResult<f64> {
	if let Some(rand) = rand { return Ok(i.call_sub(rand, vec![], Cx::Scalar)?.scalar().to_f64()); }
	let call = Call { target: CallTarget::Builtin(Builtin::Rand, BuiltinOrigin::Core), args: None, slot: None, prototype: None };
	let Some(ret) = crate::perl::func::data::call(i, Builtin::Rand, &call, Cx::Scalar) else { return Err(i.die_msg("rand is unavailable")); };
	Ok(ret?.scalar().to_f64())
}
fn sample(i: &mut Interp<'_>, mut a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let n = i.numify(&arg(&a, 0))?.wrapping_iv().max(0) as usize;
	let n = n.min(a.len().saturating_sub(1));
	let start = a.len().min(1);
	shuffled(i, &mut a[start..], n, cx)
}
fn shuffle(i: &mut Interp<'_>, mut a: Vec<Sv>, cx: Cx) -> PResult<Ret> { let n = a.len(); shuffled(i, &mut a, n, cx) }
fn shuffled(i: &mut Interp<'_>, a: &mut [Sv], n: usize, cx: Cx) -> PResult<Ret> {
	let r = i.sv("List::Util::RAND");
	let cv = match r.get() { Value::Ref(Ref::Code(cv)) => Some(cv), _ => None };
	let start = a.len() - n;
	for index in (start.max(1)..a.len()).rev() {
		let pick = (random(i, cv.as_ref())? * ((index + 1) as f64)) as usize;
		a.swap(index, pick.min(index));
	}
	Ok(values_ret(a[start..].iter().map(value), cx))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Unique { Any, String, Number, Integer }
#[derive(PartialEq, Eq, Hash)]
enum UniqueKey { Undef, String(PStr), Integer(u64), Float(u64) }
fn number_key(n: Num) -> UniqueKey {
	match n {
		Num::Int(n) => UniqueKey::Integer(n as u64),
		Num::UInt(n) => UniqueKey::Float((n as f64).to_bits()),
		Num::Float(n) if n.is_nan() => UniqueKey::Float(f64::NAN.to_bits()),
		Num::Float(n) if n >= i64::MIN as f64 && n < -(i64::MIN as f64) && n.fract() == 0.0 => UniqueKey::Integer(n as i64 as u64),
		Num::Float(n) => UniqueKey::Float(n.to_bits()),
	}
}
fn unique(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx, mode: Unique) -> PResult<Ret> {
	let mut seen = HashSet::with_capacity(a.len());
	let mut out = Vec::new();
	for sv in a {
		let mut v = value(&sv);
		let key = match mode {
			Unique::Any if v.is_undef() => UniqueKey::Undef,
			Unique::Any | Unique::String => {
				let s = stringify_entry(i, &v)?;
				if mode == Unique::String { v = Value::Str(s.clone()); }
				UniqueKey::String(s)
			}
			Unique::Number => number_key(numify_entry(i, &v)?),
			Unique::Integer => {
				let n = numify_entry(i, &v)?;
				let n = match n {
					Num::Float(f) if f.is_finite() && f >= i64::MIN as f64 && f < -(i64::MIN as f64) => Num::Int(f as i64),
					Num::Float(f) => Num::Float(f.trunc()),
					_ => n,
				};
				v = n.into_value(); number_key(n)
			}
		};
		if seen.insert(key) && cx == Cx::List { out.push(v); }
	}
	Ok(if cx == Cx::List { Ret::Many(out) } else { Ret::One(Value::Int(seen.len() as i64)) })
}
fn uniq(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { unique(i, a, cx, Unique::Any) }
fn uniqstr(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { unique(i, a, cx, Unique::String) }
fn uniqnum(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { unique(i, a, cx, Unique::Number) }
fn uniqint(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { unique(i, a, cx, Unique::Integer) }

fn odd(i: &mut Interp<'_>, n: usize, name: &str) {
	if n % 2 != 0 { i.warn_category("misc", format!("Odd number of elements in {name}")); }
}
fn pair(i: &mut Interp<'_>, a: &[Sv], cx: Cx, member: Option<usize>, name: &str) -> PResult<Ret> {
	odd(i, a.len(), name);
	Ok(values_ret(a.chunks(2).map(|p| {
		if let Some(n) = member { return arg(p, n); }
		let r = Ref::Array(new_av(vec![arg(p, 0), arg(p, 1)]));
		r.bless(Rc::from("List::Util::_Pair"));
		Value::Ref(r)
	}), cx))
}
fn pairs(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { pair(i, &a, cx, None, "pairs") }
fn pairkeys(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { pair(i, &a, cx, Some(0), "pairkeys") }
fn pairvalues(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { pair(i, &a, cx, Some(1), "pairvalues") }
fn get_pair(i: &mut Interp<'_>, a: &[Sv], which: usize) -> PResult<Value> {
	let Value::Ref(Ref::Array(pair)) = arg(a, 0) else { return Err(i.die_msg("Not an ARRAY reference")); };
	let v = arg(&pair.elems(), which);
	Ok(v)
}
fn pair_key(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(get_pair(i, &a, 0)?)) }
fn pair_value(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(get_pair(i, &a, 1)?)) }
fn unpairs(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let mut out = Vec::with_capacity(if cx == Cx::List { 2 * a.len() } else { 0 });
	for sv in &a {
		let Value::Ref(Ref::Array(pair)) = value(sv) else { return Err(i.die_msg("Not an ARRAY reference")); };
		if cx == Cx::List {
			let elems = pair.elems();
			out.extend([arg(&elems, 0), arg(&elems, 1)]);
		}
	}
	Ok(if cx == Cx::List { Ret::Many(out) } else { Ret::One(Value::Int(a.len() as i64)) })
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum PairCall { Map, Grep, First }
fn pair_call(i: &mut Interp<'_>, a: &[Sv], cx: Cx, op: PairCall, name: &str) -> PResult<Ret> {
	let cv = callback(i, a, name)?;
	let a = &a[1..];
	odd(i, a.len(), name);
	let mut out = Vec::new();
	let mut count = 0_usize;
	let globs = pair_globs(i);
	for p in a.chunks(2) {
		if i.is_cancelled() { return Err(Flow::Cancelled); }
		let first = p[0].clone();
		let second = p.get(1).cloned().unwrap_or_else(|| new_sv(Value::Undef));
		let context = if op == PairCall::Map { Cx::List } else { Cx::Scalar };
		let got = with_ab(i, &globs, first.clone(), second.clone(), |i| i.call_sub(&cv, vec![], context))?;
		if op == PairCall::Map {
			let elements = got.list();
			count += elements.len();
			if cx == Cx::List { out.extend(elements); }
		} else if i.truthy(&got.scalar())? {
			if op == PairCall::First { return Ok(if cx == Cx::List { Ret::Many(vec![value(&first), value(&second)]) } else { boolean(true) }); }
			count += 1;
			if cx == Cx::List { out.extend([value(&first), value(&second)]); }
		}
	}
	Ok(if cx == Cx::List { Ret::Many(out) } else if op == PairCall::First { boolean(false) } else { Ret::One(Value::Int(count as i64)) })
}
fn pairmap(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { pair_call(i, &a, cx, PairCall::Map, "pairmap") }
fn pairgrep(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { pair_call(i, &a, cx, PairCall::Grep, "pairgrep") }
fn pairfirst(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { pair_call(i, &a, cx, PairCall::First, "pairfirst") }
