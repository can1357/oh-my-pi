//! zsh/mathfunc: the math functions of `Src/Modules/mathfunc.c`.
//!
//! Ported from zsh 5.9 `Src/Modules/mathfunc.c` (MIT-style licence,
//! Copyright (c) 1992-1997 Paul Falstad and the zsh development group).

use bstr::{BString, ByteSlice};

use crate::bash::{
	diag::Diag,
	store::{Key, KeyBuf, MiscKey, Record},
	vm::{
		expand::{Expander, Stop, X},
		state,
		zsh::{
			math::{FuncArgs, FuncKind, MathFunc, Number},
			params,
		},
	},
};

/// zsh `TF_NOCONV`: the argument is not converted to a float.
const NOCONV: u8 = 1;
/// zsh `TF_INT1`: the first argument is an integer.
const INT1: u8 = 2;
/// zsh `TF_INT2`: the second argument is an integer.
const INT2: u8 = 4;
/// zsh `TF_NOASS`: the result is not the float `retd`.
const NOASS: u8 = 8;

/// The numeric functions (zsh `mftab`): name, `minargs`, `maxargs` and
/// type flags.
const TABLE: &[(&str, usize, usize, u8)] = &[
	("abs", 1, 1, NOCONV | NOASS),
	("acos", 1, 1, 0),
	("acosh", 1, 1, 0),
	("asin", 1, 1, 0),
	("asinh", 1, 1, 0),
	("atan", 1, 2, 0),
	("atanh", 1, 1, 0),
	("cbrt", 1, 1, 0),
	("ceil", 1, 1, 0),
	("copysign", 2, 2, 0),
	("cos", 1, 1, 0),
	("cosh", 1, 1, 0),
	("erf", 1, 1, 0),
	("erfc", 1, 1, 0),
	("exp", 1, 1, 0),
	("expm1", 1, 1, 0),
	("fabs", 1, 1, 0),
	("float", 1, 1, 0),
	("floor", 1, 1, 0),
	("fmod", 2, 2, 0),
	("gamma", 1, 1, 0),
	("hypot", 2, 2, 0),
	("ilogb", 1, 1, NOASS),
	("int", 1, 1, NOASS),
	("j0", 1, 1, 0),
	("j1", 1, 1, 0),
	("jn", 2, 2, INT1),
	("ldexp", 2, 2, INT2),
	("lgamma", 1, 1, 0),
	("log", 1, 1, 0),
	("log10", 1, 1, 0),
	("log1p", 1, 1, 0),
	("log2", 1, 1, 0),
	("logb", 1, 1, 0),
	("nextafter", 2, 2, 0),
	("rint", 1, 1, 0),
	("scalb", 2, 2, INT2),
	("signgam", 0, 0, NOASS),
	("sin", 1, 1, 0),
	("sinh", 1, 1, 0),
	("sqrt", 1, 1, 0),
	("tan", 1, 1, 0),
	("tanh", 1, 1, 0),
	("y0", 1, 1, 0),
	("y1", 1, 1, 0),
	("yn", 2, 2, INT1),
];

/// The table entry of numeric function `name`.
fn entry(name: &[u8]) -> Option<&'static (&'static str, usize, usize, u8)> {
	TABLE.iter().find(|e| e.0.as_bytes() == name)
}

/// The definition of zsh/mathfunc function `name`.
pub fn def(name: &[u8]) -> Option<MathFunc> {
	if name == b"rand48" {
		// zsh `STRMATHFUNC`: the argument text, no count check.
		return Some(MathFunc { kind: FuncKind::String, min_args: 0, max_args: Some(0) });
	}
	entry(name).map(|&(_, min, max, _)| MathFunc {
		kind:     FuncKind::Numeric,
		min_args: min,
		max_args: Some(max),
	})
}

/// Call zsh/mathfunc function `name`.
///
/// # Errors
/// The function's math error, a parameter error of `rand48`'s seed
/// parameter, a store failure.
pub fn call(ex: &mut Expander<'_, '_>, name: &[u8], args: FuncArgs<'_>) -> X<Number> {
	match args {
		FuncArgs::Text(t) if name == b"rand48" => rand48(ex, t),
		FuncArgs::Numbers(argv) => match entry(name) {
			Some(&(_, _, _, flags)) => math_func(ex, name, argv, flags),
			None => Err(unknown(name)),
		},
		_ => Err(unknown(name)),
	}
}

/// A call of a name this module does not define.
fn unknown(name: &[u8]) -> Stop {
	Stop::Fail(Diag::Unsupported { what: format!("math function `{}'", name.as_bstr()).into() })
}

/// zsh's `signgam` as the last `lgamma` left it (0 before any).
fn signgam(ex: &mut Expander<'_, '_>) -> X<i64> {
	Ok(match state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ZshSigngam))? {
		Some(Record::Misc(v)) => v.to_str().ok().and_then(|s| s.parse().ok()).unwrap_or(0),
		_ => 0,
	})
}

/// zsh `math_func`.
fn math_func(ex: &mut Expander<'_, '_>, name: &[u8], argv: &[Number], flags: u8) -> X<Number> {
	let mut argd = 0.0;
	let mut argd2 = 0.0;
	// C `int argi = (zlong)…`: truncated to an `int`.
	let mut argi = 0i32;
	if let Some(&a0) = argv.first()
		&& flags & NOCONV == 0
	{
		if flags & INT1 != 0 {
			argi = a0.to_int() as i32;
		} else {
			argd = a0.to_float();
		}
		if let Some(&a1) = argv.get(1) {
			if flags & INT2 != 0 {
				argi = a1.to_int() as i32;
			} else {
				argd2 = a1.to_float();
			}
		}
	}
	let retd = match name {
		b"abs" => {
			return Ok(match argv.first().copied().unwrap_or(Number::Int(0)) {
				Number::Int(l) => Number::Int(l.wrapping_abs()),
				Number::Float(d) => Number::Float(d.abs()),
			});
		},
		b"ilogb" => return Ok(Number::Int(i64::from(libm::ilogb(argd)))),
		b"int" => return Ok(Number::Int(argd as i64)),
		b"signgam" => return Ok(Number::Int(signgam(ex)?)),
		b"acos" => argd.acos(),
		b"acosh" => libm::acosh(argd),
		b"asin" => argd.asin(),
		b"asinh" => libm::asinh(argd),
		b"atan" => {
			if argv.len() == 2 {
				argd.atan2(argd2)
			} else {
				argd.atan()
			}
		},
		b"atanh" => libm::atanh(argd),
		b"cbrt" => argd.cbrt(),
		b"ceil" => argd.ceil(),
		b"copysign" => argd.copysign(argd2),
		b"cos" => argd.cos(),
		b"cosh" => argd.cosh(),
		b"erf" => libm::erf(argd),
		b"erfc" => libm::erfc(argd),
		b"exp" => argd.exp(),
		b"expm1" => argd.exp_m1(),
		b"fabs" => argd.abs(),
		b"float" => argd,
		b"floor" => argd.floor(),
		b"fmod" => argd % argd2,
		// zsh uses `tgamma` where it exists; it leaves `signgam` alone.
		b"gamma" => libm::tgamma(argd),
		b"hypot" => argd.hypot(argd2),
		b"j0" => libm::j0(argd),
		b"j1" => libm::j1(argd),
		b"jn" => libm::jn(argi, argd2),
		b"ldexp" => libm::ldexp(argd, argi),
		b"lgamma" => {
			let (r, sign) = libm::lgamma_r(argd);
			let key = KeyBuf::Misc(MiscKey::ZshSigngam);
			let rec = Some(Record::Misc(BString::from(sign.to_string())));
			state::store_record(&mut ex.k.root, ex.cx.store, ex.vp, key, rec);
			r
		},
		b"log" => argd.ln(),
		b"log10" => argd.log10(),
		b"log1p" => argd.ln_1p(),
		b"log2" => argd.log2(),
		b"logb" => logb(argd),
		b"nextafter" => libm::nextafter(argd, argd2),
		b"rint" => argd.round_ties_even(),
		b"scalb" => libm::scalbn(argd, argi),
		b"sin" => argd.sin(),
		b"sinh" => argd.sinh(),
		b"sqrt" => argd.sqrt(),
		b"tan" => argd.tan(),
		b"tanh" => argd.tanh(),
		b"y0" => libm::y0(argd),
		b"y1" => libm::y1(argd),
		b"yn" => libm::yn(argi, argd2),
		_ => return Err(unknown(name)),
	};
	Ok(Number::Float(retd))
}

/// C `logb`: the unbiased exponent of `x` as a float (`-Inf` for zero,
/// `Inf` for an infinity, NaN for NaN).
fn logb(x: f64) -> f64 {
	if x.is_nan() {
		x
	} else if x == 0.0 {
		f64::NEG_INFINITY
	} else if x.is_infinite() {
		f64::INFINITY
	} else {
		f64::from(libm::ilogb(x))
	}
}

/// zsh `math_string`'s `rand48([param])`: `erand48` over the seed kept as
/// 12 hex digits in `param` (a fresh random seed when it holds none), or
/// over a fresh random seed.
fn rand48(ex: &mut Expander<'_, '_>, text: &[u8]) -> X<Number> {
	let arg = text.trim_with(|c| c == ' ' || c == '\t');
	let mut seed = [0u16; 3];
	let mut do_init = true;
	if !arg.is_empty()
		&& let Some(s) = params::getsparam(ex, arg)?
		&& s.len() >= 12
	{
		do_init = false;
		'parse: for (i, slot) in seed.iter_mut().enumerate() {
			for &c in &s[i * 4..i * 4 + 4] {
				let Some(d) = char::from(c).to_digit(16) else {
					do_init = true;
					break 'parse;
				};
				*slot = *slot * 16 + d as u16;
			}
		}
	}
	if do_init {
		// zsh seeds from `rand()`, the generator behind `$RANDOM`.
		for slot in &mut seed {
			*slot = (ex.k.next_random(ex.cx.store) & 0xffff) as u16;
		}
	}
	let x = u64::from(seed[2]) << 32 | u64::from(seed[1]) << 16 | u64::from(seed[0]);
	let x = 0x5_deec_e66d_u64.wrapping_mul(x).wrapping_add(0xb) & ((1 << 48) - 1);
	let ret = x as f64 / (1u64 << 48) as f64;
	if !arg.is_empty() {
		let out = format!("{:04x}{:04x}{:04x}", x & 0xffff, (x >> 16) & 0xffff, x >> 32);
		params::assignsparam(ex, arg, out.as_bytes(), 0)?;
	}
	Ok(Number::Float(ret))
}
