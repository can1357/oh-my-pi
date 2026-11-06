//! `compvalues`: the parser behind `_values` (zsh 5.9
//! `Src/Zle/computil.c`, `parse_cvdef` … `bin_compvalues`).
//!
//! `compvalues -i` parses the value definitions and the current word and
//! keeps both (zsh's `cv_laststate` and the definition it points to, with
//! the `active` flags the word left) in the [`MiscKey::ZshCompValues`]
//! record; the other sub-options read it. zsh's cache of parsed
//! definitions only saves time, so `-i` parses afresh each call.

use bstr::BString;
use serde::{Deserialize, Serialize};

use super::{
	args::{Caarg, at, lossy, parse_caarg, xor_list},
	compcurrent, compstr, compwords, fin, gate, ignore_prefix, ignore_suffix, load, save, setaparam,
	sethparam, setsparam, warn,
};
use crate::bash::{
	pattern::zsh::remnulargs,
	store::MiscKey,
	syntax::zsh::{
		parse_subst_string,
		tok::{self, SNULL, STRING, untokenize},
	},
	vm::{
		builtins::{Ctx, Need, R, done, zsh_args::Ops},
		zsh::text::{getkey, getkeystring},
	},
};

/// A value without an argument.
const CVV_NOARG: u8 = 0;
/// A value with an argument.
const CVV_ARG: u8 = 1;
/// A value with an optional argument.
const CVV_OPT: u8 = 2;

/// zsh `struct cvval`: one value.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Cvval {
	/// The name (as written).
	name:   BString,
	/// The description.
	descr:  Option<BString>,
	/// Exclusions when this value is given.
	xor:    Option<Vec<BString>>,
	/// `CVV_*`.
	typ:    u8,
	/// The argument.
	arg:    Option<Caarg>,
	/// Still allowed.
	active: bool,
}

/// zsh `struct cvdef`: the value definitions.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Cvdef {
	/// The description (`_values`' first argument).
	descr:  BString,
	/// `-s`: several values in a word.
	hassep: bool,
	/// The separator between values.
	sep:    u8,
	/// `-S`: the separator between a value and its argument.
	argsep: u8,
	/// The values.
	vals:   Vec<Cvval>,
	/// `-w`: look at the other words too.
	words:  bool,
}

/// zsh's `cv_parsed` and `cv_laststate`.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Record {
	parsed: bool,
	d:      Cvdef,
	/// The value whose argument is being completed (`cv_laststate.def`).
	def:    Option<usize>,
	/// The values and their arguments (`$val_args`).
	vals:   Vec<BString>,
}

/// zsh `parse_cvdef`: `Err` with the warning to print.
fn parse_cvdef(args: &[BString]) -> Result<Cvdef, String> {
	let mut i = 0;
	let (mut sep, mut asep, mut hassep, mut words) = (0u8, b'=', false, false);
	while i + 1 < args.len()
		&& args[i].len() == 2
		&& args[i][0] == b'-'
		&& matches!(args[i][1], b's' | b'S' | b'w')
	{
		match args[i][1] {
			b's' => {
				hassep = true;
				sep = at(&args[i + 1], 0);
				i += 2;
			},
			b'S' => {
				asep = at(&args[i + 1], 0);
				i += 2;
			},
			_ => {
				words = true;
				i += 1;
			},
		}
	}
	if i + 1 >= args.len() {
		return Err("not enough arguments".into());
	}
	let mut ret =
		Cvdef { descr: args[i].clone(), hassep, sep, argsep: asep, vals: Vec::new(), words };
	for spec in &args[i + 1..] {
		let invalid = |what: &str| Err(format!("{what}: {}", lossy(spec)));
		let p: &[u8] = spec;
		let mut k = 0;
		let mut bs = false;

		// The exclusion list.
		let mut xor = if at(p, 0) == b'(' {
			let mut list = Vec::new();
			let Some(e) = xor_list(p, 0, &mut list) else {
				return invalid("invalid argument");
			};
			k = e;
			Some(list)
		} else {
			None
		};
		let multi = at(p, k) == b'*';
		if multi {
			k += 1;
		}
		// The name.
		let name_start = k;
		while k < p.len() && p[k] != b':' && p[k] != b'[' {
			if p[k] == b'\\' && k + 1 < p.len() {
				k += 1;
				bs = true;
			}
			k += 1;
		}
		let name = &p[name_start..k];
		if hassep && sep == 0 && name_start + usize::from(bs) + 1 < k {
			return Err("no multi-letter values with empty separator allowed".into());
		}
		// The description.
		let mut c = at(p, k);
		let mut descr = None;
		if c == b'[' {
			k += 1;
			let d = k;
			while k < p.len() && p[k] != b']' {
				if p[k] == b'\\' && k + 1 < p.len() {
					k += 1;
				}
				k += 1;
			}
			if k >= p.len() {
				return invalid("invalid value definition");
			}
			descr = Some(BString::from(&p[d..k]));
			k += 1;
			c = at(p, k);
		}
		if c != 0 && c != b':' {
			return invalid("invalid value definition");
		}
		// The argument.
		let (typ, arg) = if c == b':' {
			if hassep && sep == 0 {
				return Err("no value with argument with empty separator allowed".into());
			}
			k += 1;
			let typ = if at(p, k) == b':' {
				k += 1;
				CVV_OPT
			} else {
				CVV_ARG
			};
			(typ, Some(parse_caarg(false, 0, 0, 0, Some(name), p, &mut k, None)))
		} else {
			(CVV_NOARG, None)
		};
		if !multi {
			xor.get_or_insert_with(Vec::new).push(name.into());
		}
		ret.vals
			.push(Cvval { name: name.into(), descr, xor, typ, arg, active: false });
	}
	Ok(ret)
}

/// zsh `cv_get_val`.
fn cv_get_val(d: &Cvdef, name: &[u8]) -> Option<usize> {
	d.vals.iter().position(|v| v.name == name)
}

/// zsh `cv_quote_get_val`: the value `name` names once its quotes are
/// removed (zsh `parse_subst_string`, `remnulargs`, `untokenize`).
fn cv_quote_get_val(d: &Cvdef, name: &[u8]) -> Option<usize> {
	let m = tok::metafy(name);
	let mut v = match parse_subst_string(&m) {
		Ok(v) => dollar_quotes(v),
		Err(_) => m,
	};
	remnulargs(&mut v);
	untokenize(&mut v);
	cv_get_val(d, &tok::unmetafy(&v))
}

/// The `$'…'` decoding at the end of zsh's `parse_subst_string`.
fn dollar_quotes(v: Vec<u8>) -> Vec<u8> {
	if !v.windows(2).any(|w| w == [STRING, SNULL]) {
		return v;
	}
	let mut out = Vec::with_capacity(v.len());
	let mut i = 0;
	while i < v.len() {
		if v[i] == STRING && v.get(i + 1) == Some(&SNULL) {
			let k = getkeystring(tok::tail(&v, i + 2), getkey::DOLLARS_QUOTE);
			out.extend_from_slice(&k.text);
			i += 2 + k.consumed;
		} else {
			out.push(v[i]);
			i += 1;
		}
	}
	out
}

/// zsh `cv_inactive`.
fn cv_inactive(d: &mut Cvdef, v: usize) {
	let Some(xor) = std::mem::take(&mut d.vals[v].xor) else {
		return;
	};
	for x in &xor {
		if let Some(o) = cv_get_val(d, x) {
			d.vals[o].active = false;
		}
	}
	d.vals[v].xor = Some(xor);
}

/// zsh `cv_next`: the value at `s[from..]`; the value, where the next one
/// starts (`None`: no more), and where its argument starts.
fn cv_next(d: &Cvdef, s: &[u8], from: usize) -> (Option<usize>, Option<usize>, Option<usize>) {
	if from >= s.len() {
		return (None, None, None);
	}
	let takes_arg = |r: Option<usize>| r.is_some_and(|r| d.vals[r].typ != CVV_NOARG);
	if (d.hassep && d.sep == 0) || d.argsep == 0 {
		// The shortest prefix that names a value, up to the separator.
		let ec = if d.hassep && d.sep != 0 {
			d.sep
		} else {
			d.argsep
		};
		let mut i = from;
		let r = loop {
			i += 1;
			let r = cv_quote_get_val(d, &s[from..i]);
			if r.is_some() || at(s, i) == 0 || s[i] == ec {
				break r;
			}
		};
		let os = i;
		let mut sp = if d.hassep && d.sep != 0 {
			s[os..].iter().position(|&c| c == d.sep).map(|k| os + k + 1)
		} else {
			Some(os)
		};
		let ap = if d.argsep != 0 && at(s, os) == d.argsep {
			sp = None;
			Some(os + 1)
		} else if takes_arg(r) {
			Some(os)
		} else {
			None
		};
		(r, sp, ap)
	} else if d.hassep {
		let find = |c: u8, start: usize| s[start..].iter().position(|&b| b == c).map(|k| start + k);
		let mut ns = find(d.sep, from);
		let mut skip = false;
		let mut aspos = None;
		let (ap, sap) = match find(d.argsep, from) {
			Some(a) if ns.is_none_or(|n| a <= n) => {
				ns = find(d.sep, a + 1);
				skip = true;
				aspos = Some(a);
				(Some(a + 1), Some(a))
			},
			_ => (None, ns),
		};
		let r = cv_quote_get_val(d, &s[from..sap.unwrap_or(s.len())]);
		if !takes_arg(r) && skip {
			ns = aspos;
		}
		let sp = match ns {
			Some(n) if !(Some(n) == aspos && takes_arg(r)) => Some(n + 1),
			_ => None,
		};
		(r, sp, ap)
	} else {
		let a = s[from..]
			.iter()
			.position(|&c| c == d.argsep)
			.map(|k| from + k);
		let r = cv_quote_get_val(d, &s[from..a.unwrap_or(s.len())]);
		(r, None, a.map(|a| a + 1))
	}
}

/// The argument at `s[a..]` ending before the separator at `sp - 1` (zsh
/// cuts the string there, which leaves it whole when that is before `a`).
fn arg_upto(s: &[u8], a: usize, sp: usize) -> &[u8] {
	if sp > a { &s[a..sp - 1] } else { &s[a..] }
}

/// zsh `cv_parse_word`: parse the current word (and with `-w` the other
/// words) against the definitions; the record to keep.
fn cv_parse_word(ctx: &mut Ctx<'_, '_>, failed: &mut bool, mut d: Cvdef) -> Result<Record, Need> {
	let words = compwords(ctx, failed)?;
	let cc = compcurrent(ctx, failed)?;
	let prefix = compstr(ctx, failed, b"PREFIX")?;
	let suffix = compstr(ctx, failed, b"SUFFIX")?;
	for v in &mut d.vals {
		v.active = true;
	}
	let mut vals: Vec<BString> = Vec::new();
	let mut nosfx = false;

	if d.words && !words.is_empty() {
		for (i, w) in words.iter().enumerate().skip(1) {
			if i as i64 == cc - 1 {
				continue;
			}
			let mut str = Some(0);
			while let Some(si) = str
				&& si < w.len()
			{
				let (val, sp, ap) = cv_next(&d, w, si);
				str = sp;
				if let Some(v) = val {
					vals.push(d.vals[v].name.clone());
					vals.push(match (ap, sp) {
						(Some(a), Some(n)) => arg_upto(w, a, n).into(),
						(Some(a), None) => w[a..].into(),
						(None, _) => BString::default(),
					});
					if (i as i64) + 1 < cc {
						cv_inactive(&mut d, v);
					}
				}
			}
		}
	}

	let mut val = None;
	let mut arg = None;
	let mut str = Some(0);
	let mut pign = 0;
	while let Some(si) = str
		&& si < prefix.len()
	{
		let (v, sp, ap) = cv_next(&d, &prefix, si);
		val = v;
		str = sp;
		arg = ap;
		if let Some(v) = val {
			vals.push(d.vals[v].name.clone());
			vals.push(match (arg, str) {
				(Some(a), Some(n)) => arg_upto(&prefix, a, n).into(),
				(Some(a), None) => {
					nosfx = true;
					let mut t = BString::from(&prefix[a..]);
					t.extend_from_slice(&suffix);
					t
				},
				(None, _) => BString::default(),
			});
			cv_inactive(&mut d, v);
			match str {
				Some(n) => pign = n,
				None => d.vals[v].active = true,
			}
		}
	}
	let def = val
		.filter(|_| arg.is_some() && str.is_none())
		.filter(|&v| d.vals[v].arg.is_some());

	if !nosfx && d.hassep {
		ignore_prefix(ctx, failed, pign)?;
		let mut ign = 0;
		let mut more: Option<&[u8]> = None;
		if d.sep == 0 && val.is_none_or(|v| d.vals[v].typ == CVV_NOARG) {
			ign = suffix.len();
			more = Some(suffix.as_slice());
		} else if d.sep != 0 {
			let ns = suffix.iter().position(|&c| c == d.sep);
			let asp = if d.argsep != 0 {
				suffix.iter().position(|&c| c == d.argsep)
			} else {
				None
			};
			ign = match asp {
				Some(a) if ns.is_none_or(|n| a <= n) => suffix.len() - a,
				_ => ns.map_or(0, |n| suffix.len() - n),
			};
			more = ns.map(|n| &suffix[n + 1..]);
		} else if d.argsep != 0
			&& let Some(a) = suffix.iter().position(|&c| c == d.argsep)
		{
			ign = suffix.len() - a;
		}
		if ign > 0 {
			ignore_suffix(ctx, failed, ign)?;
		}
		// What is left of `SUFFIX` now.
		let rest = &suffix[..suffix.len().saturating_sub(ign)];
		if let Some(more) = more {
			let mut m = Some(0);
			while let Some(mi) = m
				&& mi < more.len()
			{
				let (v, sp, ap) = cv_next(&d, more, mi);
				m = sp;
				if let Some(v) = v {
					vals.push(d.vals[v].name.clone());
					vals.push(match (ap, sp) {
						(Some(a), Some(n)) => arg_upto(more, a, n).into(),
						(Some(a), None) => {
							let mut t = BString::from(&more[a..]);
							t.extend_from_slice(rest);
							t
						},
						(None, _) => BString::default(),
					});
					cv_inactive(&mut d, v);
				}
			}
		}
	} else if let Some(a) = arg {
		ignore_prefix(ctx, failed, a)?;
	} else {
		ignore_prefix(ctx, failed, pign)?;
	}
	Ok(Record { parsed: true, d, def, vals })
}

/// `compvalues -i|-D|-C|-V|-s|-S|-d|-L|-v ARGS…` (zsh `bin_compvalues`):
/// `_values`' parser of its definitions and of the current word.
pub fn compvalues(ctx: &mut Ctx<'_, '_>, _ops: &Ops, args: &[BString]) -> R {
	if !gate(ctx) {
		return done(1);
	}
	let Some(a0) = args.first() else {
		return warn(ctx, "not enough arguments");
	};
	if a0.len() != 2 || a0[0] != b'-' {
		return warn(ctx, format!("invalid argument: {}", lossy(a0)));
	}
	let o = a0[1];
	let rec: Option<Record> = load(ctx, MiscKey::ZshCompValues)?;
	let rec = match rec {
		Some(r) if r.parsed => Some(r),
		r if o == b'i' => r,
		_ => return warn(ctx, "no parsed state"),
	};
	let (min, max): (usize, Option<usize>) = match o {
		b'i' => (2, None),
		b'D' => (2, Some(2)),
		b'C' | b's' | b'S' | b'd' | b'v' => (1, Some(1)),
		b'V' => (3, Some(3)),
		b'L' => (3, Some(4)),
		_ => return warn(ctx, format!("invalid option: {}", lossy(a0))),
	};
	let n = args.len() - 1;
	if n < min {
		return warn(ctx, "not enough arguments");
	} else if max.is_some_and(|m| n > m) {
		return warn(ctx, "too many arguments");
	}
	let mut failed = false;
	if o == b'i' {
		let d = match parse_cvdef(&args[1..]) {
			Ok(d) => d,
			Err(msg) => {
				if let Some(mut r) = rec
					&& r.parsed
				{
					r.parsed = false;
					save(ctx, MiscKey::ZshCompValues, Some(&r));
				}
				return warn(ctx, msg);
			},
		};
		let rec = cv_parse_word(ctx, &mut failed, d)?;
		save(ctx, MiscKey::ZshCompValues, Some(&rec));
		return fin(0, failed);
	}
	let rec = rec.expect("parsed state");
	let d = &rec.d;
	let def = rec.def.and_then(|v| d.vals[v].arg.as_ref());
	let ret = match o {
		b'D' => match def {
			Some(a) => {
				setsparam(ctx, &mut failed, &args[1], &a.descr)?;
				setsparam(ctx, &mut failed, &args[2], &a.action)?;
				0
			},
			None => 1,
		},
		b'C' => match def {
			Some(a) => {
				setsparam(
					ctx,
					&mut failed,
					&args[1],
					a.opt.as_ref().map_or(&[][..], |o| o.as_slice()),
				)?;
				0
			},
			None => 1,
		},
		b'V' => {
			let mut lists: [Vec<BString>; 3] = Default::default();
			for p in d.vals.iter().filter(|p| p.active) {
				let mut str = p.name.clone();
				if let Some(ds) = &p.descr {
					str.push(b':');
					str.extend_from_slice(ds);
				}
				lists[usize::from(p.typ.min(CVV_OPT))].push(str);
			}
			let [noarg, arg, opt] = lists;
			setaparam(ctx, &mut failed, &args[1], noarg)?;
			setaparam(ctx, &mut failed, &args[2], arg)?;
			setaparam(ctx, &mut failed, &args[3], opt)?;
			0
		},
		b's' => {
			if d.hassep {
				let s: &[u8] = if d.sep == 0 {
					&[]
				} else {
					std::slice::from_ref(&d.sep)
				};
				setsparam(ctx, &mut failed, &args[1], s)?;
				0
			} else {
				1
			}
		},
		b'S' => {
			let s: &[u8] = if d.argsep == 0 {
				&[]
			} else {
				std::slice::from_ref(&d.argsep)
			};
			setsparam(ctx, &mut failed, &args[1], s)?;
			0
		},
		b'd' => {
			setsparam(ctx, &mut failed, &args[1], &d.descr)?;
			0
		},
		b'L' => match cv_get_val(d, &args[1])
			.and_then(|v| Some((&d.vals[v].name, d.vals[v].arg.as_ref()?)))
		{
			Some((name, a)) => {
				setsparam(ctx, &mut failed, &args[2], &a.descr)?;
				setsparam(ctx, &mut failed, &args[3], &a.action)?;
				if let Some(p) = args.get(4) {
					setsparam(ctx, &mut failed, p, name)?;
				}
				0
			},
			None => 1,
		},
		b'v' => {
			sethparam(ctx, &mut failed, &args[1], &rec.vals)?;
			0
		},
		_ => unreachable!("sub-option checked above"),
	};
	fin(ret, failed)
}
