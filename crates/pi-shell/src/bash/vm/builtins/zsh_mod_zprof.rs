//! zsh/zprof: shell function profiling and the `zprof` builtin.
//!
//! zsh wraps every shell function call while the module is loaded
//! (`zprof_wrapper`). Here the call path asks [`enter`] after a zsh
//! function's frame is pushed and [`leave`] when the call returns to its
//! caller; both are one store lookup that finds nothing unless the module
//! is loaded: the profile ([`MiscKey::ZshZprof`]) exists exactly while it
//! is (its boot hook creates it, unloading removes it). Times are
//! milliseconds of the host clock.
//!
//! Each stack entry remembers the frame depth of its call, so calls that
//! never returned normally (an error unwinding several frames) are
//! dropped from the stack without being charged, where zsh's wrapper
//! would still see them return.
//!
//! Ported from zsh 5.9 `Src/Modules/zprof.c` (MIT-style licence,
//! Copyright (c) 1992-1997 Paul Falstad and the zsh development group).

use bstr::{BString, ByteSlice};

use super::{Ctx, R, done, zsh_args::Ops};
use crate::bash::{
	store::{Key, KeyBuf, MiscKey, Record, StateStore, StoreError},
	vm::{Cx, Kernel, proc::Vproc, state},
};

/// zsh `struct pfunc`.
#[derive(Clone, Debug, PartialEq)]
struct Pfunc {
	name:  BString,
	calls: i64,
	/// Time inside the function and its callees (not recursive calls).
	time:  f64,
	/// Time inside the function itself.
	self_: f64,
}

/// zsh `struct parc`: calls from one function to another.
#[derive(Clone, Debug, PartialEq)]
struct Parc {
	from:  usize,
	to:    usize,
	calls: i64,
	time:  f64,
	self_: f64,
}

/// zsh `struct sfunc`: a call in progress.
#[derive(Clone, Debug, PartialEq)]
struct Sfunc {
	f:     usize,
	/// Start of the time charged to the function itself (moved on by
	/// its callees' time).
	beg:   f64,
	/// When the call started.
	prev:  f64,
	/// The arc of this call (`None`: called from outside any function).
	arc:   Option<usize>,
	/// `vp.frames.len()` with the call's frame pushed.
	depth: usize,
}

/// The profile: functions and arcs in creation order (zsh keeps lists
/// newest first), and the calls in progress.
#[derive(Clone, Debug, Default, PartialEq)]
struct Prof {
	funcs: Vec<Pfunc>,
	arcs:  Vec<Parc>,
	stack: Vec<Sfunc>,
}

/// A number of the record.
fn num<T: std::str::FromStr + Default>(w: &BString) -> T {
	w.to_str()
		.ok()
		.and_then(|s| s.parse().ok())
		.unwrap_or_default()
}

impl Prof {
	/// The profile a [`MiscKey::ZshZprof`] record holds: the counts, then
	/// 4 words per function, 5 per arc, 5 per stack entry (`-` for no arc).
	fn decode(w: &[BString]) -> Self {
		let mut p = Self::default();
		let (Some(nf), Some(na), Some(ns)) = (w.first(), w.get(1), w.get(2)) else {
			return p;
		};
		let (nf, na, ns): (usize, usize, usize) = (num(nf), num(na), num(ns));
		let mut it = w.get(3..).unwrap_or_default().iter();
		for _ in 0..nf {
			let (Some(name), Some(c), Some(t), Some(s)) = (it.next(), it.next(), it.next(), it.next())
			else {
				return Self::default();
			};
			p.funcs
				.push(Pfunc { name: name.clone(), calls: num(c), time: num(t), self_: num(s) });
		}
		for _ in 0..na {
			let (Some(f), Some(t), Some(c), Some(tm), Some(s)) =
				(it.next(), it.next(), it.next(), it.next(), it.next())
			else {
				return Self::default();
			};
			p.arcs.push(Parc {
				from:  num(f),
				to:    num(t),
				calls: num(c),
				time:  num(tm),
				self_: num(s),
			});
		}
		for _ in 0..ns {
			let (Some(f), Some(b), Some(pv), Some(a), Some(d)) =
				(it.next(), it.next(), it.next(), it.next(), it.next())
			else {
				return Self::default();
			};
			let arc = (a.as_slice() != b"-").then(|| num(a));
			p.stack
				.push(Sfunc { f: num(f), beg: num(b), prev: num(pv), arc, depth: num(d) });
		}
		p
	}

	fn encode(&self) -> Record {
		fn s(v: impl std::fmt::Display) -> BString {
			BString::from(v.to_string())
		}
		let mut w = vec![s(self.funcs.len()), s(self.arcs.len()), s(self.stack.len())];
		for f in &self.funcs {
			w.extend([f.name.clone(), s(f.calls), s(f.time), s(f.self_)]);
		}
		for a in &self.arcs {
			w.extend([s(a.from), s(a.to), s(a.calls), s(a.time), s(a.self_)]);
		}
		for e in &self.stack {
			let arc = e.arc.map_or_else(|| BString::from("-"), s);
			w.extend([s(e.f), s(e.beg), s(e.prev), arc, s(e.depth)]);
		}
		Record::Words(w)
	}

	/// Forget the calls whose frames are gone (`depth` frames remain).
	fn drop_stale(&mut self, depth: usize) {
		while self.stack.last().is_some_and(|e| e.depth > depth) {
			self.stack.pop();
		}
	}
}

/// The profile while zsh/zprof is loaded.
fn load(store: &mut dyn StateStore, vp: &Vproc) -> Result<Option<Prof>, StoreError> {
	Ok(match state::record(store, vp, Key::Misc(MiscKey::ZshZprof))? {
		Some(Record::Words(w)) => Some(Prof::decode(w)),
		_ => None,
	})
}

fn save(k: &mut Kernel, store: &mut dyn StateStore, vp: &mut Vproc, p: &Prof) {
	state::store_record(&mut k.root, store, vp, KeyBuf::Misc(MiscKey::ZshZprof), Some(p.encode()));
}

/// The host clock in milliseconds (zsh's `gettimeofday` in ms).
#[allow(clippy::cast_precision_loss, reason = "a clock reading")]
fn now_ms(cx: &Cx<'_>) -> f64 {
	cx.host.now_ns() as f64 / 1_000_000.0
}

/// The name zsh/zprof profiles a call of `name` under: an anonymous
/// function is `(anon) [FILE:LINE]` (zsh `name_for_anonymous_function`:
/// the `scriptfilename` it runs in and the line of its definition).
fn profile_name(
	k: &Kernel,
	vp: &Vproc,
	cx: &mut Cx<'_>,
	name: &[u8],
	line: u32,
) -> Result<BString, StoreError> {
	if name != crate::bash::ir::ANON.as_bytes() {
		return Ok(BString::from(name));
	}
	let file = super::zsh_print::scriptfilename(k, cx.store, vp)?;
	let mut s = BString::from(name);
	s.extend_from_slice(b" [");
	s.extend_from_slice(&file);
	s.extend_from_slice(format!(":{line}]").as_bytes());
	Ok(s)
}

/// A call of zsh function `name` from line `line` starts (its frame is on
/// top of `vp`, its call-stack level not yet): the first half of zsh's
/// `zprof_wrapper`. Nothing unless zsh/zprof is loaded.
pub fn enter(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, name: &[u8], line: u32) {
	let mut p = match load(cx.store, vp) {
		Ok(Some(p)) => p,
		Ok(None) => return,
		Err(e) => return k.fail(e),
	};
	let name = match profile_name(k, vp, cx, name, line) {
		Ok(n) => n,
		Err(e) => return k.fail(e),
	};
	let name = name.as_slice();
	let depth = vp.frames.len();
	p.drop_stale(depth - 1);
	let f = if let Some(i) = p.funcs.iter().position(|f| f.name.as_slice() == name) {
		i
	} else {
		p.funcs
			.push(Pfunc { name: BString::from(name), calls: 0, time: 0.0, self_: 0.0 });
		p.funcs.len() - 1
	};
	let arc = p.stack.last().map(|top| {
		let from = top.f;
		if let Some(i) = p.arcs.iter().position(|a| a.from == from && a.to == f) {
			i
		} else {
			p.arcs
				.push(Parc { from, to: f, calls: 0, time: 0.0, self_: 0.0 });
			p.arcs.len() - 1
		}
	});
	p.funcs[f].calls += 1;
	let now = now_ms(cx);
	p.stack.push(Sfunc { f, beg: now, prev: now, arc, depth });
	save(k, cx.store, vp, &p);
}

/// A function call returned to its caller (its frame is gone): the second
/// half of zsh's `zprof_wrapper`. Nothing unless zsh/zprof is loaded.
pub fn leave(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>) {
	let mut p = match load(cx.store, vp) {
		Ok(Some(p)) => p,
		Ok(None) => return,
		Err(e) => return k.fail(e),
	};
	let depth = vp.frames.len() + 1;
	p.drop_stale(depth);
	if p.stack.last().is_none_or(|e| e.depth != depth) {
		// The call started before the module was loaded.
		save(k, cx.store, vp, &p);
		return;
	}
	let Some(sf) = p.stack.pop() else {
		return;
	};
	let now = now_ms(cx);
	if let Some(f) = p.funcs.get_mut(sf.f) {
		f.self_ += now - sf.beg;
	}
	// A recursive call's time is the outermost call's.
	if !p.stack.iter().any(|e| e.f == sf.f)
		&& let Some(f) = p.funcs.get_mut(sf.f)
	{
		f.time += now - sf.prev;
	}
	if let Some(a) = sf.arc.and_then(|a| p.arcs.get_mut(a)) {
		a.calls += 1;
		a.self_ += now - sf.beg;
	}
	if let Some(top) = p.stack.last_mut() {
		top.beg += now - sf.prev;
		if let Some(a) = sf.arc.and_then(|a| p.arcs.get_mut(a)) {
			a.time += now - sf.prev;
		}
	}
	save(k, cx.store, vp, &p);
}

/// zsh/zprof's `boot_`: an empty profile (which turns the call hooks on).
pub fn boot(ctx: &mut Ctx<'_, '_>) {
	ctx.store_record(KeyBuf::Misc(MiscKey::ZshZprof), Some(Prof::default().encode()));
}

/// zsh/zprof's `cleanup_`: the profile goes (the call hooks turn off).
pub fn cleanup(ctx: &mut Ctx<'_, '_>) {
	ctx.store_record(KeyBuf::Misc(MiscKey::ZshZprof), None);
}

/// C `printf("%W.2f")` of `v` (`nan`, `inf` as C writes them).
fn f2(v: f64, width: usize) -> String {
	let s = if v.is_nan() {
		"nan".to_owned()
	} else if v.is_infinite() {
		if v > 0.0 { "inf" } else { "-inf" }.to_owned()
	} else {
		format!("{v:.2}")
	};
	format!("{s:>width$}")
}

/// `calls` as C's `(double)`.
#[allow(clippy::cast_precision_loss, reason = "zsh's (double) cast")]
const fn d(n: i64) -> f64 {
	n as f64
}

/// zsh `bin_zprof`: `zprof` prints the profile, `zprof -c` clears it.
pub fn zprof(ctx: &mut Ctx<'_, '_>, ops: &Ops) -> R {
	let Some(mut p) = load(ctx.cx.store, ctx.vp)? else {
		return done(0);
	};
	if ops.isset(b'c') {
		// The calls in progress refer to the functions cleared.
		p = Prof::default();
		ctx.store_record(KeyBuf::Misc(MiscKey::ZshZprof), Some(p.encode()));
		return done(0);
	}
	ctx.out(report(&p).as_bytes());
	done(0)
}

/// The `zprof` listing.
fn report(p: &Prof) -> String {
	use std::{cmp::Ordering, fmt::Write};

	let desc = |a: f64, b: f64| b.partial_cmp(&a).unwrap_or(Ordering::Equal);
	// zsh's lists are newest first.
	let mut fs: Vec<usize> = (0..p.funcs.len()).rev().collect();
	let total: f64 = fs.iter().map(|&i| p.funcs[i].self_).sum();
	fs.sort_by(|&a, &b| desc(p.funcs[a].self_, p.funcs[b].self_));
	let mut nums = vec![0usize; p.funcs.len()];
	for (n, &i) in fs.iter().enumerate() {
		nums[i] = n + 1;
	}
	let mut arcs: Vec<usize> = (0..p.arcs.len()).rev().collect();
	arcs.sort_by(|&a, &b| desc(p.arcs[a].time, p.arcs[b].time));
	let mut out = String::from(
		"num  calls                time                       self            \
		 name\n-----------------------------------------------------------------------------------\n",
	);
	let fline = |out: &mut String, i: usize| {
		let f = &p.funcs[i];
		let _ = writeln!(
			out,
			"{:>2}) {:>4}       {} {}  {}%  {} {}  {}%  {}",
			nums[i],
			f.calls,
			f2(f.time, 8),
			f2(f.time / d(f.calls), 8),
			f2(f.time / total * 100.0, 6),
			f2(f.self_, 8),
			f2(f.self_ / d(f.calls), 8),
			f2(f.self_ / total * 100.0, 6),
			f.name.as_bstr()
		);
	};
	let aline = |out: &mut String, a: &Parc, other: usize, calls: i64| {
		let _ = writeln!(
			out,
			"    {:>4}/{:<4}  {} {}  {}%  {} {}             {} [{}]",
			a.calls,
			calls,
			f2(a.time, 8),
			f2(a.time / d(a.calls), 8),
			f2(a.time / total * 100.0, 6),
			f2(a.self_, 8),
			f2(a.self_ / d(a.calls), 8),
			p.funcs[other].name.as_bstr(),
			nums[other]
		);
	};
	for &i in &fs {
		fline(&mut out, i);
	}
	fs.sort_by(|&a, &b| desc(p.funcs[a].time, p.funcs[b].time));
	for &i in &fs {
		out.push_str(concat!(
			"\n-------------------------------------------",
			"----------------------------------------\n\n",
		));
		for &ai in &arcs {
			let a = &p.arcs[ai];
			if a.to == i {
				aline(&mut out, a, a.from, p.funcs[i].calls);
			}
		}
		fline(&mut out, i);
		for &ai in arcs.iter().rev() {
			let a = &p.arcs[ai];
			if a.from == i {
				aline(&mut out, a, a.to, p.funcs[a.to].calls);
			}
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn records_round_trip() {
		let p = Prof {
			funcs: vec![Pfunc { name: "f".into(), calls: 2, time: 1.5, self_: 0.25 }, Pfunc {
				name:  "g h".into(),
				calls: 1,
				time:  0.125,
				self_: 0.125,
			}],
			arcs:  vec![Parc { from: 0, to: 1, calls: 1, time: 0.125, self_: 0.125 }],
			stack: vec![Sfunc { f: 0, beg: 3.0, prev: 2.0, arc: None, depth: 4 }],
		};
		let Record::Words(w) = p.encode() else {
			unreachable!()
		};
		assert_eq!(Prof::decode(&w), p);
	}

	#[test]
	fn report_lists_callers_and_callees() {
		let p = Prof {
			funcs: vec![Pfunc { name: "outer".into(), calls: 1, time: 4.0, self_: 1.0 }, Pfunc {
				name:  "inner".into(),
				calls: 2,
				time:  3.0,
				self_: 3.0,
			}],
			arcs:  vec![Parc { from: 0, to: 1, calls: 2, time: 3.0, self_: 3.0 }],
			stack: Vec::new(),
		};
		let rule =
			"-----------------------------------------------------------------------------------";
		let want = format!(
				"num  calls                time                       self            name\n{rule}\n \
				 1)    2           3.00     1.50   75.00%      3.00     1.50   75.00%  inner\n 2)    \
				 1           4.00     4.00  100.00%      1.00     1.00   25.00%  outer\n\n{rule}\n\n \
				 2)    1           4.00     4.00  100.00%      1.00     1.00   25.00%  outer\n       \
				 2/2         3.00     1.50   75.00%      3.00     1.50             inner \
				 [1]\n\n{rule}\n\n       2/2         3.00     1.50   75.00%      3.00     1.50             \
				 outer [2]\n 1)    2           3.00     1.50   75.00%      3.00     1.50   75.00%  \
				 inner\n"
			);
		assert_eq!(report(&p), want);
	}

	#[test]
	fn c_float_formatting() {
		assert_eq!(f2(f64::NAN, 6), "   nan");
		assert_eq!(f2(1.0 / 3.0, 8), "    0.33");
	}
}
