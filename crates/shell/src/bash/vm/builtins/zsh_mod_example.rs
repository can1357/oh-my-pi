//! zsh/example: the `example` builtin, the `-len` and `-ex` conditions,
//! the `length` and `sum` math functions, the `exint`, `exstr` and
//! `exarr` parameters, the load and unload messages, and the wrapper that
//! runs functions whose names start with `example` with `GLOB_DOTS` set.
//!
//! The parameters' values (zsh's C variables `intparam`, `strparam`,
//! `arrparam`), whether each parameter is set, and the `GLOB_DOTS` values
//! the wrapper restores live in the store ([`MiscKey::ZshExample`]), which
//! holds a record exactly while the module is loaded.
//!
//! Ported from zsh 5.9 `Src/Modules/example.c` (MIT-style licence,
//! Copyright (c) 1992-1997 Paul Falstad and the zsh development group).

use bstr::{BString, ByteSlice};

use super::{Ctx, R, done, zsh_args::Ops};
use crate::bash::{
	diag::Diag,
	store::{Key, KeyBuf, MiscKey, Record, StateStore, StoreError},
	vm::{
		Cx, Kernel,
		expand::{Expander, Stop, X},
		proc::{PendingWrite, Vproc},
		state,
		zsh::{
			arith,
			math::{FuncArgs, FuncKind, MathFunc, Number},
			params::PValue,
		},
	},
	zshopt::ZshOpt,
};

/// zsh/example's `setup_` message.
const SETUP: &[u8] = b"The example module has now been set up.\n";
/// zsh/example's `finish_` message.
const FINISH: &[u8] = b"Thank you for using the example module.  Have a nice day.\n";

/// Which parameter: `exint`, `exstr`, `exarr`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ExParam {
	/// `exint` (zsh's `intparam`).
	Int,
	/// `exstr` (zsh's `strparam`).
	Str,
	/// `exarr` (zsh's `arrparam`).
	Arr,
}

impl ExParam {
	/// The set flag's letter in the record.
	const fn letter(self) -> u8 {
		match self {
			Self::Int => b'i',
			Self::Str => b's',
			Self::Arr => b'a',
		}
	}
}

/// The module's state.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Example {
	/// The parameters that are set (`i`, `s`, `a`).
	set:   Vec<u8>,
	int:   i64,
	str:   BString,
	arr:   Vec<BString>,
	/// The wrapped calls in progress: frame depth and the `GLOB_DOTS`
	/// value to restore.
	calls: Vec<(usize, bool)>,
}

impl Example {
	/// The state a [`MiscKey::ZshExample`] record holds: set letters,
	/// `intparam`, `strparam`, the wrapped calls (`depth:0|1` comma
	/// separated), then `arrparam`'s elements.
	fn decode(w: &[BString]) -> Self {
		let get = |i: usize| w.get(i).cloned().unwrap_or_default();
		let calls = get(3)
			.split_str(",")
			.filter_map(|c| {
				let (d, g) = c.split_once_str(":")?;
				Some((d.to_str().ok()?.parse().ok()?, g == b"1"))
			})
			.collect();
		Self {
			set: get(0).into(),
			int: get(1)
				.to_str()
				.ok()
				.and_then(|s| s.parse().ok())
				.unwrap_or(0),
			str: get(2),
			arr: w.get(4..).unwrap_or_default().to_vec(),
			calls,
		}
	}

	fn encode(&self) -> Record {
		let calls: Vec<String> = self
			.calls
			.iter()
			.map(|(d, g)| format!("{d}:{}", u8::from(*g)))
			.collect();
		let mut w = vec![
			BString::from(self.set.clone()),
			BString::from(self.int.to_string()),
			self.str.clone(),
			BString::from(calls.join(",")),
		];
		w.extend(self.arr.iter().cloned());
		Record::Words(w)
	}

	fn is_set(&self, p: ExParam) -> bool {
		self.set.contains(&p.letter())
	}

	fn mark(&mut self, p: ExParam, on: bool) {
		self.set.retain(|&c| c != p.letter());
		if on {
			self.set.push(p.letter());
		}
	}
}

fn load(store: &mut dyn StateStore, vp: &Vproc) -> Result<Option<Example>, StoreError> {
	Ok(match state::record(store, vp, Key::Misc(MiscKey::ZshExample))? {
		Some(Record::Words(w)) => Some(Example::decode(w)),
		_ => None,
	})
}

fn save(k: &mut Kernel, store: &mut dyn StateStore, vp: &mut Vproc, e: &Example) {
	state::store_record(&mut k.root, store, vp, KeyBuf::Misc(MiscKey::ZshExample), Some(e.encode()));
}

/// The state `boot_` sets up.
fn booted() -> Example {
	Example {
		set:   b"isa".to_vec(),
		int:   42,
		str:   "example".into(),
		arr:   vec!["example".into(), "array".into()],
		calls: Vec::new(),
	}
}

/// zsh/example's `setup_` and `boot_` from a builtin (`zmodload`): the
/// message, then the parameters' initial values.
pub fn boot(ctx: &mut Ctx<'_, '_>) {
	ctx.out(SETUP);
	ctx.store_record(KeyBuf::Misc(MiscKey::ZshExample), Some(booted().encode()));
}

/// [`boot`] for a load an expansion autoloaded (a parameter, `length`,
/// `sum`, `-len` or `-ex`): the message goes to standard output directly.
pub fn boot_ex(ex: &mut Expander<'_, '_>) {
	ex.vp
		.out
		.push_back(PendingWrite { fd: 1, bytes: SETUP.into(), off: 0 });
	save(ex.k, ex.cx.store, ex.vp, &booted());
}

/// zsh/example's `cleanup_` and `finish_` (`zmodload -u`): the message.
pub fn finish(ctx: &mut Ctx<'_, '_>) {
	ctx.store_record(KeyBuf::Misc(MiscKey::ZshExample), None);
	ctx.out(FINISH);
}

/// zsh `bin_example`: show the options, arguments and parameters, then
/// set the parameters' values from the arguments.
pub fn example(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let mut e = load(ctx.cx.store, ctx.vp)?.unwrap_or_else(booted);
	let mut out = b"Options: ".to_vec();
	for c in 33u8..128 {
		if ops.isset(c) {
			out.push(c);
		}
	}
	out.extend_from_slice(b"\nArguments:");
	for a in args {
		out.push(b' ');
		out.extend_from_slice(a);
	}
	out.extend_from_slice(format!("\nName: {}\n", ctx.name).as_bytes());
	out.extend_from_slice(format!("\nInteger Parameter: {}\n", e.int).as_bytes());
	out.extend_from_slice(b"String Parameter: ");
	out.extend_from_slice(&e.str);
	out.extend_from_slice(b"\nArray Parameter:");
	for a in &e.arr {
		out.push(b' ');
		out.extend_from_slice(a);
	}
	out.push(b'\n');
	ctx.out(&out);
	e.int = i64::try_from(args.len()).unwrap_or(i64::MAX);
	e.str = args.first().cloned().unwrap_or_default();
	e.arr = args.to_vec();
	save(ctx.k, ctx.cx.store, ctx.vp, &e);
	done(0)
}

/// The value of parameter `p` (`None`: unset).
///
/// # Errors
/// A store failure.
pub fn param_get(ex: &mut Expander<'_, '_>, p: ExParam) -> X<Option<PValue>> {
	let Some(e) = load(ex.cx.store, ex.vp)? else {
		return Ok(None);
	};
	if !e.is_set(p) {
		return Ok(None);
	}
	Ok(Some(match p {
		ExParam::Int => PValue::Scalar(BString::from(e.int.to_string())),
		ExParam::Str => PValue::Scalar(e.str),
		ExParam::Arr => PValue::Array(e.arr),
	}))
}

/// Assign `value` to parameter `p` (an integer's text is evaluated).
///
/// # Errors
/// A math error, a store failure.
pub fn param_set(ex: &mut Expander<'_, '_>, p: ExParam, value: PValue) -> X<()> {
	let Some(mut e) = load(ex.cx.store, ex.vp)? else {
		return Ok(());
	};
	let scalar = |v: PValue| match v {
		PValue::Scalar(s) => s,
		PValue::Array(a) => BString::from(a.join(&b" "[..])),
		PValue::Hash(_) => BString::default(),
	};
	match p {
		ExParam::Int => {
			let text = scalar(value);
			e.int = arith::mathevali(ex, &text)?;
		},
		ExParam::Str => e.str = scalar(value),
		ExParam::Arr => {
			e.arr = match value {
				PValue::Array(a) => a,
				PValue::Scalar(s) => vec![s],
				PValue::Hash(h) => h.into_iter().flat_map(|(k, v)| [k, v]).collect(),
			};
		},
	}
	e.mark(p, true);
	save(ex.k, ex.cx.store, ex.vp, &e);
	Ok(())
}

/// Unset parameter `p` (zsh's `stdunsetfn` also clears its C variable).
///
/// # Errors
/// A store failure.
pub fn param_unset(ex: &mut Expander<'_, '_>, p: ExParam) -> X<()> {
	if let Some(mut e) = load(ex.cx.store, ex.vp)? {
		match p {
			ExParam::Int => e.int = 0,
			ExParam::Str => e.str = BString::default(),
			ExParam::Arr => e.arr.clear(),
		}
		e.mark(p, false);
		save(ex.k, ex.cx.store, ex.vp, &e);
	}
	Ok(())
}

/// zsh `cond_p_len` (`-len STR [N]`: `STR` has `N` bytes, or is empty)
/// and `cond_i_ex` (`A -ex B`: `AB` is `example`), over the operands'
/// expanded text.
///
/// # Errors
/// A math error in `N`; an unknown condition name.
pub fn cond(ex: &mut Expander<'_, '_>, name: &[u8], args: &[BString]) -> X<bool> {
	let arg = |i: usize| args.get(i).map_or(&b""[..], |a| a.as_slice());
	match name {
		b"len" => {
			if args.len() > 1 {
				let v = arith::mathevali(ex, arg(1))?;
				Ok(i64::try_from(arg(0).len()).is_ok_and(|n| n == v))
			} else {
				Ok(arg(0).is_empty())
			}
		},
		b"ex" => {
			let mut s = arg(0).to_vec();
			s.extend_from_slice(arg(1));
			Ok(s == b"example")
		},
		_ => Err(Stop::Fail(Diag::Usage {
			msg: format!("unknown condition: {}", name.as_bstr()).into(),
		})),
	}
}

/// The math functions: `length` (`STRMATHFUNC`) and `sum`
/// (`NUMMATHFUNC`, one argument or more).
pub const fn math_def(name: &[u8]) -> Option<MathFunc> {
	match name {
		b"length" => Some(MathFunc { kind: FuncKind::String, min_args: 0, max_args: None }),
		b"sum" => Some(MathFunc { kind: FuncKind::Numeric, min_args: 1, max_args: None }),
		_ => None,
	}
}

/// zsh `math_length` and `math_sum`.
///
/// # Errors
/// An unknown function.
pub fn call_math(name: &[u8], args: FuncArgs<'_>) -> X<Number> {
	match (name, args) {
		(b"length", FuncArgs::Text(t)) => Ok(Number::Int(i64::try_from(t.len()).unwrap_or(i64::MAX))),
		(b"sum", FuncArgs::Numbers(ns)) => {
			// Integers add up as integers until the first float.
			let (mut l, mut d, mut float) = (0i64, 0f64, false);
			for n in ns {
				match *n {
					#[allow(clippy::cast_precision_loss, reason = "zsh's (double) casts")]
					Number::Int(v) => {
						if float {
							d += v as f64;
						} else {
							l = l.wrapping_add(v);
						}
					},
					#[allow(clippy::cast_precision_loss, reason = "zsh's (double) casts")]
					Number::Float(v) => {
						if float {
							d += v;
						} else {
							d = l as f64 + v;
							float = true;
						}
					},
				}
			}
			Ok(if float {
				Number::Float(d)
			} else {
				Number::Int(l)
			})
		},
		_ => Err(Stop::Fail(Diag::BadMathExpr {
			msg: format!("unknown function: {}", name.as_bstr()).into(),
		})),
	}
}

/// A call of zsh function `name` starts (its frame is on top of `vp`):
/// zsh/example's wrapper sets `GLOB_DOTS` for functions named
/// `example…` while the module is loaded.
pub fn enter(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, name: &[u8]) {
	if !name.starts_with(b"example") {
		return;
	}
	let r = (|| -> Result<(), StoreError> {
		let Some(mut e) = load(cx.store, vp)? else {
			return Ok(());
		};
		let depth = vp.frames.len();
		e.calls.retain(|&(d, _)| d < depth);
		let old = state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Globdots)?;
		e.calls.push((depth, old));
		state::set_zsh_option(&mut k.root, cx.store, vp, ZshOpt::Globdots, true)?;
		save(k, cx.store, vp, &e);
		Ok(())
	})();
	if let Err(err) = r {
		k.fail(err);
	}
}

/// A function call returned to its caller: the wrapper restores
/// `GLOB_DOTS` after an `example…` function.
pub fn leave(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>) {
	let r = (|| -> Result<(), StoreError> {
		let Some(mut e) = load(cx.store, vp)? else {
			return Ok(());
		};
		let depth = vp.frames.len() + 1;
		if e.calls.is_empty() {
			return Ok(());
		}
		e.calls.retain(|&(d, _)| d <= depth);
		if let Some(&(d, old)) = e.calls.last()
			&& d == depth
		{
			e.calls.pop();
			state::set_zsh_option(&mut k.root, cx.store, vp, ZshOpt::Globdots, old)?;
		}
		save(k, cx.store, vp, &e);
		Ok(())
	})();
	if let Err(err) = r {
		k.fail(err);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn records_round_trip() {
		let mut e = booted();
		e.calls = vec![(3, false), (5, true)];
		e.mark(ExParam::Str, false);
		let Record::Words(w) = e.encode() else {
			unreachable!()
		};
		assert_eq!(Example::decode(&w), e);
		assert!(!e.is_set(ExParam::Str) && e.is_set(ExParam::Arr));
	}

	#[test]
	fn sum_switches_to_float_at_the_first_float() {
		let ns = [Number::Int(1), Number::Float(2.5), Number::Int(2)];
		assert_eq!(call_math(b"sum", FuncArgs::Numbers(&ns)).ok(), Some(Number::Float(5.5)));
		let ns = [Number::Int(1), Number::Int(2)];
		assert_eq!(call_math(b"sum", FuncArgs::Numbers(&ns)).ok(), Some(Number::Int(3)));
	}
}
