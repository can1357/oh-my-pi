//! Benchmark: timing records, repeated Perl calls and rate comparisons.

use std::{fmt::Write, rc::Rc};

use super::{calendar, hires};
use crate::perl::{
	interp::{Cx, Interp, PResult, Ret},
	modules::{arg, define, export, export_tag, text, version},
	sprintf::sprintf,
	value::{Cv, HKey, PStr, Ref, Sv, Value, format_float, new_av, new_hv, new_sv},
};

const PKG: &str = "Benchmark";
const HIRES: &str = "Benchmark::_omp_hires";
const CACHE_ON: &str = "Benchmark::_omp_cache_on";
const CACHE: &str = "Benchmark::_omp_cache";
const DEFAULT: &[&str] = &["timeit", "timethis", "timethese", "timediff", "timestr"];
const EXTRA: &[&str] = &["timesum", "cmpthese", "countit", "clearcache", "clearallcache", "disablecache", "enablecache"];

/// Install Benchmark timing functions and object methods.
pub(super) fn load(interp: &mut Interp<'_>) {
	version(interp, PKG, "1.23");
	define(interp, PKG, &[("new", new), ("timeit", timeit), ("timethis", timethis), ("timethese", timethese), ("countit", countit),
		("timediff", timediff), ("timesum", timesum), ("timestr", timestr), ("cmpthese", cmpthese), ("iters", iters),
		("cpu_a", cpu_a), ("cpu_p", cpu_p), ("cpu_c", cpu_c), ("elapsed", cpu_p), ("real", real),
		("enablecache", enablecache), ("disablecache", disablecache), ("clearcache", clearcache), ("clearallcache", clearallcache)]);
	interp.sv(CACHE_ON).set(Value::Int(1));
	export(interp, PKG, DEFAULT, EXTRA);
	let all = DEFAULT.iter().chain(EXTRA).copied().collect::<Vec<_>>();
	export_tag(interp, PKG, "all", &all);
	interp.define_native("Benchmark::import", import);
}

fn import(interp: &mut Interp<'_>, mut a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	for (idx, sv) in a.iter().enumerate().skip(1) {
		if interp.read_sv(sv)?.to_pstr().bytes == b":hireswallclock" {
			a.remove(idx);
			interp.sv(HIRES).set(Value::Int(1));
			break;
		}
	}
	crate::perl::modules::exporter::import(interp, a, cx)
}
fn one(v: Value) -> PResult<Ret> { Ok(Ret::One(v)) }
fn record(v: &Value) -> [f64; 6] {
	if let Value::Ref(Ref::Array(a)) = v {
		let a = a.elems();
		std::array::from_fn(|i| a.get(i).map_or(0.0, |s| s.get().to_f64()))
	} else { [0.0; 6] }
}
fn bench(class: Rc<str>, t: [f64; 6]) -> Value {
	let mut vals = t.into_iter().map(Value::Num).collect::<Vec<_>>();
	vals[5] = Value::Int(t[5] as i64);
	let r = Ref::Array(new_av(vals));
	r.bless(class);
	Value::Ref(r)
}
fn class(v: &Value) -> Rc<str> {
	if let Value::Ref(r) = v { r.blessed().unwrap_or_else(|| Rc::from(PKG)) }
	else if v.is_undef() { Rc::from(PKG) }
	else { Rc::from(v.to_pstr().to_string_lossy().as_ref()) }
}
fn snapshot(interp: &mut Interp<'_>) -> [f64; 6] {
	let h = interp.sv(HIRES).get().truthy();
	let now = calendar::epoch_f64();
	let (user, sys) = hires::resource_time(false);
	let (cuser, csys) = hires::resource_time(true);
	let quantize = |t: f64| (t * 100.0).floor() * 0.01;
	[if h { now } else { now.floor() }, quantize(user), quantize(sys), quantize(cuser), quantize(csys), 0.0]
}
fn new(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let mut t = snapshot(interp);
	t[5] = arg(&a, 1).to_f64();
	one(bench(class(&arg(&a, 0)), t))
}
fn combine(a: &[Sv], subtract: bool) -> PResult<Ret> {
	let left = arg(a, 0);
	let lhs = record(&left);
	let rhs = record(&arg(a, 1));
	one(bench(class(&left), std::array::from_fn(|i| if subtract { lhs[i] - rhs[i] } else { lhs[i] + rhs[i] })))
}
fn timediff(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { combine(&a, true) }
fn timesum(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { combine(&a, false) }
fn cpu_p(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { let t = record(&arg(&a, 0)); one(Value::Num(t[1] + t[2])) }
fn cpu_c(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { let t = record(&arg(&a, 0)); one(Value::Num(t[3] + t[4])) }
fn cpu_a(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { let t = record(&arg(&a, 0)); one(Value::Num(t[1..=4].iter().sum())) }
fn real(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Num(record(&arg(&a, 0))[0])) }
fn iters(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Int(record(&arg(&a, 0))[5] as i64)) }

fn code(interp: &mut Interp<'_>, v: Value, for_what: &str) -> PResult<Cv> {
	if let Value::Ref(Ref::Code(cv)) = v { return Ok(cv); }
	if matches!(v, Value::Ref(_) | Value::Undef) {
		return Err(interp.die_msg(format!("usage: $result = {for_what}($count, 'code' );        or\n       $result = {for_what}($count, sub {{ code }} );\n")));
	}
	let pkg = interp.package();
	let mut source = format!("package {pkg}; sub {{\n").into_bytes();
	source.extend(v.to_pstr().bytes);
	source.extend_from_slice(b"\n};");
	let result = interp.load_source("(eval)", &source)?;
	if let Value::Ref(Ref::Code(cv)) = result { Ok(cv) }
	else { Err(interp.die_msg("couldn't compile benchmark code")) }
}
fn run(interp: &mut Interp<'_>, cv: Option<&Cv>, iters: u64) -> PResult<()> {
	for _ in 0..iters {
		interp.poll()?;
		if let Some(cv) = cv { interp.call_sub(cv, Vec::new(), Cx::Void)?; }
	}
	Ok(())
}
fn over(interp: &mut Interp<'_>, iters: u64) -> PResult<[f64; 6]> {
	let memo = interp.hv(CACHE);
	let enabled = interp.sv(CACHE_ON).get().truthy();
	let key = if enabled { Some(HKey::new(&Value::UInt(iters).to_pstr())) } else { None };
	if let Some(key) = &key && let Some(val) = memo.entries().get(key) { return Ok(record(&val.get())); }
	let before = snapshot(interp);
	run(interp, None, iters)?;
	let end = snapshot(interp);
	let overhead = std::array::from_fn(|i| end[i] - before[i]);
	if let Some(key) = key { memo.entries_mut().insert(key, new_sv(bench(Rc::from(PKG), overhead))); }
	Ok(overhead)
}
fn exact(interp: &mut Interp<'_>, cv: &Cv, iters: u64) -> PResult<[f64; 6]> {
	let overhead = over(interp, iters)?;
	let before = snapshot(interp);
	run(interp, Some(cv), iters)?;
	let end = snapshot(interp);
	Ok(std::array::from_fn(|i| if i == 5 { iters as f64 } else { end[i] - before[i] - overhead[i] }))
}
fn measure(interp: &mut Interp<'_>, cv: &Cv, seconds: f64) -> PResult<[f64; 6]> {
	let target = if seconds == 0.0 { 3.0 } else { seconds.abs() };
	if !target.is_finite() || target < 0.1 { return Err(interp.die_msg(format!("countit({target}, ...): timelimit cannot be less than 0.1.\n"))); }
	let before = snapshot(interp);
	let now = || if cfg!(unix) { hires::cpu_seconds() } else { calendar::epoch_f64() };
	let raw = now();
	let mut iters = 0;
	let mut batch = 1;
	loop {
		run(interp, Some(cv), batch)?;
		iters += batch;
		let elapsed = now() - raw;
		if elapsed >= target { break; }
		let pred = if elapsed > 0.0 { ((target - elapsed) * iters as f64 / elapsed).ceil() as u64 } else { batch * 2 };
		batch = pred.clamp(1, (batch * 2).min(65_536));
	}
	let end = snapshot(interp);
	let overhead = over(interp, iters)?;
	Ok(std::array::from_fn(|i| if i == 5 { iters as f64 } else { end[i] - before[i] - overhead[i] }))
}
fn timeit(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let n = arg(&a, 0).to_i64();
	if n < 0 { return Err(interp.die_msg(format!("negative loopcount {n}"))); }
	let cv = code(interp, arg(&a, 1), "timeit")?;
	one(bench(Rc::from(PKG), exact(interp, &cv, n as u64)?))
}
fn countit(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let t = arg(&a, 0).to_f64();
	let cv = code(interp, arg(&a, 1), "countit")?;
	one(bench(Rc::from(PKG), measure(interp, &cv, t)?))
}

fn fmt(interp: &mut Interp<'_>, n: f64, template: &PStr) -> String {
	sprintf(template, &[Value::Num(n)], &mut interp.conv()).map_or_else(|_| format_float(n).to_string_lossy().into_owned(), |s| s.to_string_lossy().into_owned())
}
fn show(interp: &mut Interp<'_>, t: [f64; 6], style: &str, format: &str) -> String {
	if style == "none" { return String::new(); }
	let fmt_code = if format.is_empty() { "5.2f" } else { format };
	let fmt_code = PStr::from_str(&format!("%{fmt_code}"));
	let [wall, u, s, cu, cs, iters] = t;
	let cpu = if style == "noc" { u + s } else if style == "nop" { cu + cs } else { u + s + cu + cs };
	let style = if style.is_empty() || style == "auto" { if cu != 0.0 || cs != 0.0 { "all" } else { "noc" } } else { style };
	let wall = format_float(wall).to_string_lossy().into_owned();
	let mut out = match style {
		"all" => format!("{wall:>2} wallclock secs ({} usr {} sys + {} cusr {} csys = {} CPU)", fmt(interp, u, &fmt_code), fmt(interp, s, &fmt_code),
			fmt(interp, cu, &fmt_code), fmt(interp, cs, &fmt_code), fmt(interp, cpu, &fmt_code)),
		"noc" => format!("{wall:>2} wallclock secs ({} usr + {} sys = {} CPU)", fmt(interp, u, &fmt_code), fmt(interp, s, &fmt_code), fmt(interp, cpu, &fmt_code)),
		"nop" => format!("{wall:>2} wallclock secs ({} cusr + {} csys = {} CPU)", fmt(interp, cu, &fmt_code), fmt(interp, cs, &fmt_code), fmt(interp, cpu, &fmt_code)),
		_ => format!("{wall} {u} {s} {cu} {cs} {iters} {style}"),
	};
	if cpu > 0.0 && iters > 0.0 { let _ = write!(out, " @ {}/s (n={iters})", fmt(interp, iters / cpu, &fmt_code)); }
	out
}
fn timestr(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::str(&show(interp, record(&arg(&a, 0)), &text(&a, 1), &text(&a, 2)))) }
fn print(interp: &mut Interp<'_>, msg: &str) { let _ = interp.selected().borrow_mut().write(&PStr::from_str(msg)); }
fn timed(interp: &mut Interp<'_>, n: f64, v: Value, name: &str, style: &str) -> PResult<[f64; 6]> {
	let cv = code(interp, v, "timethis")?;
	let result = if n <= 0.0 { measure(interp, &cv, n)? } else { exact(interp, &cv, n as u64)? };
	if style != "none" { let result = show(interp, result, style, ""); print(interp, &format!("{name:>10}: {result}\n")); }
	if result[1] + result[2] < 0.1 { print(interp, "            (warning: too few iterations for a reliable count)\n"); }
	Ok(result)
}
fn timethis(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let n = arg(&a, 0).to_f64();
	let name = if arg(&a, 2).is_undef() { format!("timethis {n}") } else { text(&a, 2) };
	one(bench(Rc::from(PKG), timed(interp, n, arg(&a, 1), &name, &text(&a, 3))?))
}
fn many(interp: &mut Interp<'_>, n: f64, args: Value, style: &str) -> PResult<Value> {
	let Value::Ref(Ref::Hash(h)) = args else { return Err(interp.die_msg("usage: timethese($count, { Name1 => 'code1', Name2 => 'code2', ... });\n")); };
	let mut jobs = h.entries().iter().map(|(k, v)| (k.to_pstr(), v.clone())).collect::<Vec<_>>();
	jobs.sort_unstable_by(|l, r| l.0.cmp(&r.0));
	if style != "none" {
		let labels = jobs.iter().map(|(k, _)| k.to_string_lossy()).collect::<Vec<_>>();
		let count = if n <= 0.0 { format!("each running at least {} CPU seconds", if n == 0.0 { 3.0 } else { n.abs() }) } else { format!("{n} iterations") };
		print(interp, &format!("Benchmark: timing {count} of {}...\n", labels.join(", ")));
	}
	let h = new_hv();
	for (k, v) in jobs {
		let v = interp.read_sv(&v)?;
		let times = timed(interp, n, v, &k.to_string_lossy(), style)?;
		h.entries_mut().insert(HKey::new(&k), new_sv(bench(Rc::from(PKG), times)));
	}
	Ok(Value::Ref(Ref::Hash(h)))
}
fn timethese(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(many(interp, arg(&a, 0).to_f64(), arg(&a, 1), &text(&a, 2))?) }

fn cmpthese(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (tested, style) = if let Value::Ref(Ref::Hash(h)) = arg(&a, 0) { (Value::Ref(Ref::Hash(h)), text(&a, 1)) }
	else {
		let style = text(&a, 2);
		let raw = if style.is_empty() { "none" } else { &style };
		(many(interp, arg(&a, 0).to_f64(), arg(&a, 1), raw)?, style)
	};
	let Value::Ref(Ref::Hash(h)) = tested else { return one(Value::Undef); };
	let mut row_items = h.entries().iter().map(|(k, v)| {
		let t = record(&v.get());
		let cpu = t[1] + t[2];
		(k.to_pstr().to_string_lossy().into_owned(), if cpu > 0.0 { t[5] / cpu } else { 0.0 })
	}).collect::<Vec<_>>();
	row_items.sort_unstable_by(|(n, r), (m, s)| r.total_cmp(s).then_with(|| n.cmp(m)));
	let per_iteration = row_items.last().is_some_and(|x| x.1 > 0.0 && x.1 < 1.0);
	let mut head = vec![String::new(), if per_iteration { "s/iter" } else { "Rate" }.to_owned()];
	head.extend(row_items.iter().map(|x| x.0.clone()));
	let mut table = vec![head];
	for (index, (name, rate)) in row_items.iter().enumerate() {
		let shown = if per_iteration && *rate > 0.0 { show_rate(rate.recip()) } else { format!("{}/s", show_rate(*rate)) };
		let mut row = vec![name.clone(), shown];
		for (other, (_, speed)) in row_items.iter().enumerate() {
			row.push(if index == other { "--".into() } else if *speed == 0.0 { "Inf%".into() } else { format!("{:.0}%", (rate / speed - 1.0) * 100.0) });
		}
		table.push(row);
	}
	if style != "none" {
		let widths = (0..table[0].len()).map(|i| table.iter().map(|row| row[i].len()).max().unwrap_or(0)).collect::<Vec<_>>();
		let mut output = String::new();
		for row in &table {
			for (i, (col, &width)) in row.iter().zip(&widths).enumerate() {
				if i == 0 { let _ = write!(output, "{col:<width$}"); }
				else { let _ = write!(output, " {col:>width$}"); }
			}
			output.push('\n');
		}
		print(interp, &output);
	}
	one(Value::Ref(Ref::Array(new_av(table.into_iter().map(|row| Value::Ref(Ref::Array(new_av(row.iter().map(|s| Value::str(s)).collect())))).collect()))))
}
fn show_rate(rate: f64) -> String {
	if rate < 1.0 { format!("{rate:.3}") } else if rate < 10.0 { format!("{rate:.2}") }
	else if rate < 1000.0 { format!("{rate:.1}") } else { format!("{rate:.0}") }
}

fn switch(interp: &mut Interp<'_>, a: &[Sv], enabled: bool) -> PResult<Ret> {
	if !a.is_empty() { return Err(interp.die_msg(format!("usage: {}cache();\n", if enabled { "enable" } else { "disable" }))); }
	let state = Value::Int(i64::from(enabled));
	interp.sv(CACHE_ON).set(state.clone());
	one(state)
}
fn enablecache(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { switch(interp, &a, true) }
fn disablecache(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { switch(interp, &a, false) }
fn clearcache(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if a.len() != 1 { return Err(interp.die_msg("usage: clearcache($n);\n")); }
	let count = arg(&a, 0);
	let old = interp.hv(CACHE).entries_mut().shift_remove(&HKey::new(&count.to_pstr()));
	one(old.map_or(Value::Undef, |s| s.get()))
}
fn clearallcache(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if !a.is_empty() { return Err(interp.die_msg("usage: clearallcache();\n")); }
	interp.hv(CACHE).entries_mut().clear();
	Ok(Ret::empty())
}
