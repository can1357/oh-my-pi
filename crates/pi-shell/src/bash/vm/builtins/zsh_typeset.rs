//! zsh `typeset` and its family (`declare`, `local`, `export`,
//! `readonly`, `integer`, `float`): a port of zsh 5.9 `builtin.c`
//! `bin_typeset`, `typeset_single`, `typeset_setbase`,
//! `typeset_setwidth`, `getasg`, and of `params.c` `printparamnode` /
//! `printparamvalue` with the `pmtypes` table, over the zsh parameter code
//! ([`params`]).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::{BString, ByteSlice};

use super::{
	Control, Ctx, Need, Outcome, R, done,
	zsh_args::{Func, Ops, isset, pattern_arg, zerr, zx},
	zsh_names,
	zsh_print::charset,
	zsh_quote::{Charset, quotedzputs},
};
use crate::bash::{
	diag::Diag,
	syntax::zsh::{
		tok,
		tok::{head, span, tail},
	},
	vm::{
		expand::{Expander, X},
		state::{self, Level},
		zsh::{
			math::{self, FloatKind, Number},
			params::{self, PValue, Param, PmFlags},
			specials::Special,
		},
	},
	zshopt::ZshOpt,
};

/// `PM_ARRAY`.
pub const PM_ARRAY: u32 = 1 << 0;
/// `PM_INTEGER`.
pub const PM_INTEGER: u32 = 1 << 1;
/// `PM_EFLOAT`.
pub const PM_EFLOAT: u32 = 1 << 2;
/// `PM_FFLOAT`.
pub const PM_FFLOAT: u32 = 1 << 3;
/// `PM_HASHED`.
pub const PM_HASHED: u32 = 1 << 4;
/// `PM_LEFT`.
pub const PM_LEFT: u32 = 1 << 5;
/// `PM_RIGHT_B`.
pub const PM_RIGHT_B: u32 = 1 << 6;
/// `PM_RIGHT_Z`.
pub const PM_RIGHT_Z: u32 = 1 << 7;
/// `PM_LOWER`.
pub const PM_LOWER: u32 = 1 << 8;
/// `PM_UPPER`.
pub const PM_UPPER: u32 = 1 << 9;
/// `PM_READONLY`.
pub const PM_READONLY: u32 = 1 << 10;
/// `PM_TAGGED`.
pub const PM_TAGGED: u32 = 1 << 11;
/// `PM_EXPORTED`.
pub const PM_EXPORTED: u32 = 1 << 12;
/// `PM_UNIQUE`.
pub const PM_UNIQUE: u32 = 1 << 13;
/// `PM_HIDE`.
pub const PM_HIDE: u32 = 1 << 14;
/// `PM_HIDEVAL`.
pub const PM_HIDEVAL: u32 = 1 << 15;
/// `PM_TIED`.
pub const PM_TIED: u32 = 1 << 16;
/// `PM_LOCAL`.
pub const PM_LOCAL: u32 = 1 << 19;
/// `PM_SPECIAL`.
pub const PM_SPECIAL: u32 = 1 << 20;
/// `PM_RO_BY_DESIGN`.
pub const PM_RO_BY_DESIGN: u32 = 1 << 21;
/// `PM_DECLARED`.
pub const PM_DECLARED: u32 = 1 << 22;
/// `PM_UNSET`.
pub const PM_UNSET: u32 = 1 << 24;
/// `PM_DEFAULTED` (`PM_DECLARED|PM_UNSET`).
pub const PM_DEFAULTED: u32 = PM_DECLARED | PM_UNSET;
/// `PM_AUTOLOAD`.
pub const PM_AUTOLOAD: u32 = 1 << 26;

/// `PM_TYPE`: the type bits.
pub const fn pm_type(f: u32) -> u32 {
	f & (PM_INTEGER | PM_EFLOAT | PM_FFLOAT | PM_ARRAY | PM_HASHED)
}

/// `PRINT_NAMEONLY`.
pub const PRINT_NAMEONLY: u32 = 1 << 0;
/// `PRINT_TYPE`.
pub const PRINT_TYPE: u32 = 1 << 1;
/// `PRINT_KV_PAIR`.
const PRINT_KV_PAIR: u32 = 1 << 3;
/// `PRINT_INCLUDEVALUE`.
pub const PRINT_INCLUDEVALUE: u32 = 1 << 4;
/// `PRINT_TYPESET`.
pub const PRINT_TYPESET: u32 = 1 << 5;
/// `PRINT_LINE`.
pub const PRINT_LINE: u32 = 1 << 6;
/// `PRINT_POSIX_EXPORT`.
pub const PRINT_POSIX_EXPORT: u32 = 1 << 7;
/// `PRINT_POSIX_READONLY`.
pub const PRINT_POSIX_READONLY: u32 = 1 << 8;

/// `TYPESET_OPTSTR`: option letters in `PM_*` bit order from `PM_ARRAY`.
const TYPESET_OPTSTR: &[u8] = b"aiEFALRZlurtxUhHTkz";

/// zsh's `pmtypes` table: flag, `typeset -p` letter, and whether the
/// base (`b`), width (`w`) or local level (`l`) applies; the `typeset +`
/// words are [`PMTYPE_WORDS`], in the same order (a byte string, not a
/// table of slices: no dynamic relocations at process start).
const PMTYPES: [(u32, u8, u8); 17] = [
	(PM_AUTOLOAD, 0, 0),
	(PM_INTEGER, b'i', b'b'),
	(PM_EFLOAT, b'E', 0),
	(PM_FFLOAT, b'F', 0),
	(PM_ARRAY, b'a', 0),
	(PM_HASHED, b'A', 0),
	(0, 0, b'l'),
	(PM_LEFT, b'L', b'w'),
	(PM_RIGHT_B, b'R', b'w'),
	(PM_RIGHT_Z, b'Z', b'w'),
	(PM_LOWER, b'l', 0),
	(PM_UPPER, b'u', 0),
	(PM_READONLY, b'r', 0),
	(PM_TAGGED, b't', 0),
	(PM_EXPORTED, b'x', 0),
	(PM_UNIQUE, b'U', 0),
	(PM_TIED, b'T', 0),
];

/// The `typeset +` words of [`PMTYPES`], `|` separated.
const PMTYPE_WORDS: &[u8] =
	b"undefined|integer|float|float|array|association|local|left justified|\
	right justified|zero filled|lowercase|uppercase|readonly|tagged|exported|unique|tied";

/// What `printparamnode` needs besides the parameter.
#[derive(Clone, Copy)]
pub struct PrintEnv {
	/// zsh `locallevel`: the current function scope (`None` at top level).
	pub locallevel: Option<usize>,
	/// `RC_QUOTES`.
	pub rcquotes:   bool,
	/// Character classification for quoting.
	pub cs:         Charset,
}

impl PrintEnv {
	/// The printing environment of the vproc `ctx` runs in.
	pub fn of(ctx: &mut Ctx<'_, '_>) -> Result<Self, Need> {
		let locallevel = state::func_scope(&ctx.k.root, ctx.cx.store, ctx.vp)?;
		Ok(Self { locallevel, rcquotes: isset(ctx, ZshOpt::Rcquotes)?, cs: charset(ctx)? })
	}

	fn q(&self, s: &[u8], out: &mut Vec<u8>) {
		out.extend_from_slice(&quotedzputs(s, self.rcquotes, self.cs));
	}
}

/// zsh `printparamvalue`: `=value` (or the bare value for an
/// association's element).
fn printparamvalue(pe: &PrintEnv, p: &Param, printflags: u32, out: &mut Vec<u8>) {
	if printflags & PRINT_KV_PAIR == 0 {
		out.push(b'=');
	}
	let f = p.flags.bits();
	match pm_type(f) {
		PM_INTEGER => {
			let v = p.numval().map_or(0, Number::to_int);
			out.extend_from_slice(v.to_string().as_bytes());
		},
		PM_EFLOAT | PM_FFLOAT => {
			let v = p.numval().map_or(0.0, Number::to_float);
			let kind = if f & PM_EFLOAT != 0 {
				FloatKind::Exponent
			} else {
				FloatKind::Fixed
			};
			out.extend_from_slice(math::convfloat(v, i32::from(p.base), kind).as_bytes());
		},
		PM_ARRAY => {
			let items: &[BString] = match &p.value {
				PValue::Array(a) => a,
				_ => &[],
			};
			out.push(b'(');
			if printflags & PRINT_LINE == 0 {
				out.push(b' ');
			}
			for (i, item) in items.iter().enumerate() {
				if printflags & PRINT_LINE != 0 {
					out.extend_from_slice(b"\n  ");
				} else if i > 0 {
					out.push(b' ');
				}
				pe.q(item, out);
			}
			if !items.is_empty() && printflags & PRINT_LINE != 0 {
				out.push(b'\n');
			}
			if printflags & PRINT_LINE == 0 {
				out.push(b' ');
			}
			out.push(b')');
		},
		PM_HASHED => {
			// `scanhashtable(ht, 1, …)`: sorted by key (`ztrcmp`).
			let mut pairs: Vec<&(BString, BString)> = match &p.value {
				PValue::Hash(h) => h.iter().collect(),
				_ => Vec::new(),
			};
			pairs.sort_unstable_by(|a, b| a.0.cmp(&b.0));
			out.push(b'(');
			if printflags & PRINT_LINE == 0 {
				out.push(b' ');
			}
			for (k, v) in pairs.iter().copied() {
				// `printparamnode` of each element with `PRINT_KV_PAIR`.
				if printflags & PRINT_LINE != 0 {
					out.extend_from_slice(b"\n  ");
				}
				out.push(b'[');
				pe.q(k, out);
				out.extend_from_slice(b"]=");
				pe.q(v, out);
				if printflags & PRINT_LINE == 0 {
					out.push(b' ');
				}
			}
			if !pairs.is_empty() && printflags & PRINT_LINE != 0 {
				out.push(b'\n');
			}
			out.push(b')');
		},
		_ => {
			if let PValue::Scalar(s) = &p.value {
				pe.q(s, out);
			}
		},
	}
}

/// zsh `printparamnode`: one parameter as `typeset`, `typeset -p`,
/// `typeset +` and `set` list it. `peer` is the tied partner of a `-T`
/// parameter.
pub fn printparamnode(
	pe: &PrintEnv,
	p: &Param,
	peer: Option<&Param>,
	mut printflags: u32,
	out: &mut Vec<u8>,
) {
	let f = p.flags.bits();
	if f & PM_UNSET != 0 {
		if (printflags & (PRINT_POSIX_READONLY | PRINT_POSIX_EXPORT) != 0
			&& f & (PM_READONLY | PM_EXPORTED) != 0)
			|| f & PM_DEFAULTED == PM_DEFAULTED
		{
			printflags |= PRINT_NAMEONLY;
		} else {
			return;
		}
	}
	if f & PM_AUTOLOAD != 0 {
		printflags |= PRINT_NAMEONLY;
	}
	let local = p.scope.is_some();
	if printflags & (PRINT_TYPESET | PRINT_POSIX_READONLY | PRINT_POSIX_EXPORT) != 0 {
		if f & (PM_RO_BY_DESIGN | PM_AUTOLOAD) != 0 {
			return;
		}
		if printflags & PRINT_POSIX_EXPORT != 0 {
			if f & PM_EXPORTED == 0 {
				return;
			}
			out.extend_from_slice(b"export ");
		} else if printflags & PRINT_POSIX_READONLY != 0 {
			if f & PM_READONLY == 0 {
				return;
			}
			out.extend_from_slice(b"readonly ");
		} else if let Some(ll) = pe.locallevel
			&& p.scope.is_some_and(|s| s >= ll)
		{
			out.extend_from_slice(b"typeset ");
		} else if f & PM_EXPORTED != 0 && f & (PM_ARRAY | PM_HASHED) == 0 {
			out.extend_from_slice(b"export ");
		} else if pe.locallevel.is_some() {
			out.extend_from_slice(b"typeset -g ");
		} else {
			out.extend_from_slice(b"typeset ");
		}
	}
	// The value printed: for `typeset -p` of a tied scalar, its array's.
	let mut shown = p;
	let mut tied_peer: Option<&Param> = None;
	if printflags & (PRINT_TYPE | PRINT_TYPESET) != 0 {
		let mut doneminus = false;
		for (&(bin, letter, extra), word) in PMTYPES.iter().zip(PMTYPE_WORDS.split(|&c| c == b'|')) {
			let doprint = if extra == b'l' {
				local
			} else {
				(bin != PM_EXPORTED || local || f & (PM_LOCAL | PM_ARRAY | PM_HASHED) != 0)
					&& f & bin != 0
			};
			if !doprint {
				continue;
			}
			if printflags & PRINT_TYPESET != 0 {
				if letter != 0 {
					if !doneminus {
						out.push(b'-');
						doneminus = true;
					}
					out.push(letter);
				}
			} else {
				out.extend_from_slice(word);
				out.push(b' ');
			}
			if extra == b'b' && p.base != 0 {
				out.extend_from_slice(format!("{} ", p.base).as_bytes());
				doneminus = false;
			}
			if extra == b'w' && p.width != 0 {
				out.extend_from_slice(format!("{} ", p.width).as_bytes());
				doneminus = false;
			}
		}
		if doneminus {
			out.push(b' ');
		}
		if f & PM_TIED != 0
			&& let Some(other) = peer
		{
			// `typeset -p` shows the array's value under the scalar's
			// attributes.
			let name_shown = if printflags & PRINT_TYPESET == 0 || f & PM_ARRAY != 0 {
				tied_peer = Some(other);
				&other.name
			} else {
				tied_peer = Some(p);
				shown = other;
				&p.name
			};
			pe.q(name_shown, out);
			out.push(b' ');
		}
	}
	let sf = shown.flags.bits();
	pe.q(&shown.name, out);
	if printflags & PRINT_NAMEONLY == 0
		&& (sf & PM_HIDEVAL == 0 || printflags & PRINT_INCLUDEVALUE != 0)
	{
		printparamvalue(pe, shown, printflags, out);
	}
	if let Some(scalar) = tied_peer
		&& printflags & PRINT_TYPESET != 0
		&& sf & PM_SPECIAL == 0
	{
		// The join character, when it is not `:`.
		let sep = scalar
			.tied
			.as_ref()
			.or(shown.tied.as_ref())
			.map_or(b':', |(_, sep)| *sep);
		if sep != b':' {
			out.push(b' ');
			let buf: &[u8] = if sep == 0 {
				b""
			} else {
				std::slice::from_ref(&sep)
			};
			pe.q(buf, out);
		}
	}
	out.push(b'\n');
}

/// [`printparamnode`] of `p`, looking up its tied partner.
pub fn print_param(
	ex: &mut Expander<'_, '_>,
	pe: &PrintEnv,
	p: &Param,
	printflags: u32,
	out: &mut Vec<u8>,
) -> X<()> {
	let peer = match &p.tied {
		Some((other, _)) if p.flags.bits() & PM_TIED != 0 => params::getparam(ex, other)?,
		_ => None,
	};
	printparamnode(pe, p, peer.as_ref(), printflags, out);
	Ok(())
}

/// `scanmatchtable(paramtab, pat, 1, flags1, flags2, printparamnode,
/// printflags)`: every parameter, sorted, whose flags have any of
/// `flags1` (or `flags1` is 0) and none of `flags2`, matching `pat`.
pub fn print_params(
	ctx: &mut Ctx<'_, '_>,
	pat: Option<&super::zsh_args::ZPat>,
	flags1: u32,
	flags2: u32,
	printflags: u32,
) -> Result<Result<usize, Diag>, Need> {
	let pe = PrintEnv::of(ctx)?;
	let r = zx(ctx, |ex| {
		let mut out = Vec::new();
		let mut n = 0;
		for p in params::scan(ex)? {
			let f = p.flags.bits();
			if (flags1 == 0 || f & flags1 != 0)
				&& f & flags2 == 0
				&& pat.is_none_or(|pat| pat.matches(&p.name))
			{
				n += 1;
				print_param(ex, &pe, &p, printflags, &mut out)?;
			}
		}
		Ok((n, out))
	})?;
	Ok(r.map(|(n, out)| {
		ctx.out(&out);
		n
	}))
}

/// One argument of the typeset family (zsh `struct asgment`).
#[derive(Clone, Debug)]
pub struct Asg {
	/// `name` (possibly with a subscript).
	pub name:  BString,
	/// The value.
	pub value: AsgVal,
}

/// The value of an [`Asg`].
#[derive(Clone, Debug)]
pub enum AsgVal {
	/// No `=`.
	None,
	/// `name=value`.
	Scalar(BString),
	/// `name=(…)`: the elements (raw), or with `kv` zsh's `ASG_KEY_VALUE`
	/// list: metafied, each `[k]=v` element a `Marker` (`Marker` `+` for
	/// `[k]+=v`), key, value triple between the plain elements.
	Array {
		/// Elements.
		elems: Vec<BString>,
		/// `[key]=value` elements are present.
		kv:    bool,
	},
}

impl Asg {
	/// `ASG_VALUEP`.
	pub const fn has_value(&self) -> bool {
		!matches!(self.value, AsgVal::None)
	}

	/// `ASG_ARRAYP`.
	pub const fn is_array(&self) -> bool {
		matches!(self.value, AsgVal::Array { .. })
	}
}

/// zsh `getasg` over every argument: `name`, `name=value`, or (for words
/// written as array assignments, argv indexes in `ctx.compound`, `base`
/// being the argv index of `args[0]`) `name=(…)`. `None` for an empty
/// name (`=x`: zsh's `bad assignment`).
pub fn getasgs(ctx: &Ctx<'_, '_>, args: &[BString], base: usize) -> Option<Vec<Asg>> {
	let mut out = Vec::with_capacity(args.len());
	for (i, a) in args.iter().enumerate() {
		if a.first() == Some(&b'=') {
			return None;
		}
		let compound = ctx.compound.iter().any(|&c| c as usize == base + i);
		let Some(eq) = a.find_byte(b'=') else {
			out.push(Asg { name: a.clone(), value: AsgVal::None });
			continue;
		};
		let name = BString::from(head(a, eq));
		let v = tail(a, eq + 1);
		let value = if compound && v.starts_with(b"(") && v.ends_with(b")") {
			let elems = super::vars::parse_compound(span(v, 1, v.len() - 1));
			let kv = elems.iter().any(|(k, ..)| k.is_some());
			let mut flat = Vec::with_capacity(elems.len() * if kv { 3 } else { 1 });
			for (k, append, v) in elems {
				if !kv {
					flat.push(v);
					continue;
				}
				if let Some(k) = k {
					let marker: &[u8] = if append {
						&[tok::MARKER, b'+']
					} else {
						&[tok::MARKER]
					};
					flat.push(BString::from(marker));
					flat.push(tok::metafy(&k).into());
				}
				flat.push(tok::metafy(&v).into());
			}
			AsgVal::Array { elems: flat, kv }
		} else {
			AsgVal::Scalar(v.into())
		};
		out.push(Asg { name, value });
	}
	Some(out)
}

/// What [`typeset_single`] came to.
enum Single {
	/// Done.
	Ok,
	/// `zwarnnam`: reported, status 1, go on.
	Fail,
	/// `zerr`/`zerrnam`: reported, the command line is abandoned.
	Abort,
}

/// The builtin's state shared by every [`typeset_single`] call.
struct Ts<'o> {
	func:   Func,
	on:     u32,
	off:    u32,
	roff:   u32,
	ops:    &'o Ops,
	posix:  bool,
	silent: bool,
	unset:  bool,
	pe:     PrintEnv,
}

/// zsh `zerrnam(name, msg)`: the message under the builtin's name; the
/// command line is abandoned.
fn zerrnam(ctx: &mut Ctx<'_, '_>, msg: String) -> Single {
	ctx.usage(msg);
	Single::Abort
}

/// `typeset_setwidth`: the width argument of `-L`/`-R`/`-Z`; `Err` after
/// `bad width value`.
fn setwidth(ctx: &mut Ctx<'_, '_>, ops: &Ops, on: u32, cur: u16, always: bool) -> Result<u16, ()> {
	let arg = if on & PM_LEFT != 0 && ops.hasarg(b'L') {
		ops.arg(b'L')
	} else if on & PM_RIGHT_B != 0 && ops.hasarg(b'R') {
		ops.arg(b'R')
	} else if on & PM_RIGHT_Z != 0 && ops.hasarg(b'Z') {
		ops.arg(b'Z')
	} else {
		None
	};
	match arg {
		Some(a) => {
			if let Some(w) = a.to_str().ok().and_then(|s| s.parse::<u16>().ok()) {
				Ok(w)
			} else {
				ctx.usage(format!("bad width value: {}", a.as_bstr()));
				Err(())
			}
		},
		None => Ok(if always { 0 } else { cur }),
	}
}

/// `typeset_setbase`: the base of `-i N` or the precision of `-E N`/`-F
/// N`; `Err` after `bad base value`, `bad precision value` or `invalid
/// base`.
fn setbase(ctx: &mut Ctx<'_, '_>, ops: &Ops, on: u32, cur: u8, always: bool) -> Result<u8, ()> {
	let arg = if on & PM_INTEGER != 0 && ops.hasarg(b'i') {
		ops.arg(b'i')
	} else if on & PM_EFLOAT != 0 && ops.hasarg(b'E') {
		ops.arg(b'E')
	} else if on & PM_FFLOAT != 0 && ops.hasarg(b'F') {
		ops.arg(b'F')
	} else {
		None
	};
	let Some(a) = arg else {
		return Ok(if always { 0 } else { cur });
	};
	let Some(base) = a.to_str().ok().and_then(|s| s.parse::<i64>().ok()) else {
		let what = if on & PM_INTEGER != 0 {
			"base"
		} else {
			"precision"
		};
		ctx.usage(format!("bad {what} value: {}", a.as_bstr()));
		return Err(());
	};
	if on & PM_INTEGER != 0 && !(2..=36).contains(&base) {
		ctx.usage(format!("invalid base (must be 2 to 36 inclusive): {base}"));
		return Err(());
	}
	Ok(u8::try_from(base).unwrap_or(u8::MAX))
}

/// Run `f` over the parameter code; a parameter error is `zerr`ed and
/// abandons the command.
fn px<T>(
	ctx: &mut Ctx<'_, '_>,
	f: impl FnOnce(&mut Expander<'_, '_>) -> X<T>,
) -> Result<Option<T>, Need> {
	match zx(ctx, f)? {
		Ok(v) => Ok(Some(v)),
		Err(d) => {
			ctx.diag(d);
			Ok(None)
		},
	}
}

/// Assign `asg`'s value to `name` (`assignsparam`/`assignaparam`).
fn assign(ex: &mut Expander<'_, '_>, name: &[u8], value: &AsgVal, array_param: bool) -> X<()> {
	match value {
		AsgVal::None => Ok(()),
		AsgVal::Array { elems, kv: false } => params::assignaparam(ex, name, elems.clone(), 0),
		AsgVal::Array { elems, kv: true } => params::assignaparam_kv(ex, name, elems),
		// A scalar value for an array (a special one): one element, or
		// none when empty.
		AsgVal::Scalar(v) if array_param => {
			let elems = if v.is_empty() {
				Vec::new()
			} else {
				vec![v.clone()]
			};
			params::assignaparam(ex, name, elems, 0)
		},
		AsgVal::Scalar(v) => params::assignsparam(ex, name, v, 0),
	}
}

/// zsh `typeset_single`: apply the builtin's flags (and value) to one
/// parameter `pname` (currently `pm`). `tie` is the array partner and
/// join character when creating a `-T` scalar.
#[expect(clippy::too_many_lines, reason = "one function, as zsh's typeset_single")]
fn typeset_single(
	ctx: &mut Ctx<'_, '_>,
	ts: &Ts<'_>,
	pname: &[u8],
	pm: Option<Param>,
	asg: &Asg,
	mut on: u32,
	off: u32,
) -> Result<Single, Need> {
	let roff = ts.roff;
	let locallevel = ts.pe.locallevel;
	let pmf = pm.as_ref().map_or(0, |p| p.flags.bits());
	let mut usepm: u8 = u8::from(
		pm.is_some() && (pmf & PM_UNSET == 0 || (ts.posix && pmf & (PM_READONLY | PM_EXPORTED) != 0)),
	);
	if usepm == 0 && pm.is_some() && pmf & PM_SPECIAL != 0 {
		usepm = 2;
	}
	let mut newspecial = false;
	if usepm != 0 && pm.as_ref().is_some_and(|p| p.scope != locallevel) && on & PM_LOCAL != 0 {
		if pmf & PM_SPECIAL != 0 && on & PM_HIDE == 0 && pmf & PM_HIDE & !off == 0 {
			newspecial = true;
		}
		usepm = 0;
	}
	let mut tc = false;
	if asg.is_array()
		&& pm_type(on) == 0
		&& !(usepm != 0 && pm_type(pmf) & (PM_ARRAY | PM_HASHED) != 0)
	{
		on |= PM_ARRAY;
	}
	if usepm != 0
		&& asg.is_array()
		&& !newspecial
		&& pm_type(pmf) != PM_ARRAY
		&& pm_type(pmf) != PM_HASHED
	{
		if on & (PM_EFLOAT | PM_FFLOAT | PM_INTEGER) != 0 {
			return Ok(zerrnam(
				ctx,
				format!("{}: can't assign array value to non-array", pname.as_bstr()),
			));
		}
		if pmf & PM_SPECIAL != 0 {
			return Ok(zerrnam(
				ctx,
				format!("{}: can't assign array value to non-array special", pname.as_bstr()),
			));
		}
		tc = true;
		usepm = 0;
	} else if usepm != 0 || newspecial {
		let chflags = ((off & pmf) | (on & !pmf))
			& (PM_INTEGER | PM_EFLOAT | PM_FFLOAT | PM_HASHED | PM_ARRAY | PM_TIED | PM_AUTOLOAD);
		tc = chflags != 0 && chflags != (PM_EFLOAT | PM_FFLOAT);
		if tc {
			usepm = 0;
		}
	}
	let readonly = (usepm != 0 || newspecial) && off & pmf & PM_READONLY != 0;
	if readonly || tc {
		if pmf & PM_SPECIAL != 0 {
			return Ok(zerrnam(
				ctx,
				format!("{}: can't change type of a special parameter", pname.as_bstr()),
			));
		}
		if pmf & PM_AUTOLOAD != 0 {
			return Ok(zerrnam(
				ctx,
				format!("{}: can't change type of autoloaded parameter", pname.as_bstr()),
			));
		}
	}
	if ts.posix {
		if on & (PM_READONLY | PM_EXPORTED) != 0
			&& (usepm == 0 || pmf & PM_UNSET != 0)
			&& !asg.has_value()
		{
			on |= PM_UNSET;
		} else if usepm != 0
			&& pmf & PM_READONLY != 0
			&& on & PM_READONLY == 0
			&& ts.func != Func::Export
		{
			ctx.diag(Diag::Readonly { name: pname.into() });
			return Ok(Single::Abort);
		}
	}
	if usepm != 0 {
		let pm = pm.expect("usepm implies a parameter");
		let wrong = if asg.is_array() {
			pm_type(pmf) & (PM_ARRAY | PM_HASHED) == 0
		} else {
			matches!(asg.value, AsgVal::Scalar(_)) && pm_type(pmf) & (PM_ARRAY | PM_HASHED) != 0
		};
		if wrong {
			return Ok(zerrnam(ctx, format!("{}: inconsistent type for assignment", pname.as_bstr())));
		}
		on &= !PM_LOCAL;
		if on == 0 && roff == 0 && !asg.has_value() {
			let flags = if ts.ops.isset(b'p') {
				Some(PRINT_TYPESET)
			} else if !ts.ops.isset(b'g') && (!ts.silent || ts.ops.isset(b'm')) {
				Some(PRINT_INCLUDEVALUE)
			} else {
				None
			};
			if let Some(flags) = flags {
				let pe = ts.pe;
				let Some(out) = px(ctx, |ex| {
					let mut out = Vec::new();
					print_param(ex, &pe, &pm, flags, &mut out)?;
					Ok(out)
				})?
				else {
					return Ok(Single::Abort);
				};
				ctx.out(&out);
			}
			return Ok(Single::Ok);
		}
		let mut flags = pmf | (on & !PM_READONLY);
		if usepm == 2 {
			flags &= !off;
		} else {
			let mut off = off;
			if on & PM_READONLY == 0 || !ts.posix {
				off |= PM_UNSET;
			}
			flags &= !off;
		}
		let Ok(width) = setwidth(ctx, ts.ops, on, pm.width, false) else {
			return Ok(Single::Fail);
		};
		let Ok(base) = setbase(ctx, ts.ops, on, pm.base, false) else {
			return Ok(Single::Fail);
		};
		let name = pname.to_vec();
		let value = asg.value.clone();
		let array_param = pm_type(flags) & (PM_ARRAY | PM_HASHED) != 0;
		let readonly_on = on & PM_READONLY;
		let print = ts.ops.isset(b'p');
		let pe = ts.pe;
		let r = px(ctx, |ex| {
			params::set_flags(ex, &name, PmFlags::from_bits(flags), width, base)?;
			assign(ex, &name, &value, array_param)?;
			if readonly_on != 0 {
				params::set_flags(ex, &name, PmFlags::from_bits(flags | readonly_on), width, base)?;
			}
			let mut out = Vec::new();
			if print && let Some(p) = params::getparam(ex, &name)? {
				print_param(ex, &pe, &p, PRINT_TYPESET, &mut out)?;
			}
			Ok(out)
		})?;
		return Ok(match r {
			Some(out) => {
				ctx.out(&out);
				Single::Ok
			},
			None => Single::Abort,
		});
	}
	let wrong = if asg.is_array() {
		on & (PM_ARRAY | PM_HASHED) == 0
	} else {
		matches!(asg.value, AsgVal::Scalar(_)) && on & (PM_ARRAY | PM_HASHED) != 0
	};
	if wrong {
		return Ok(zerrnam(ctx, format!("{}: inconsistent type for assignment", pname.as_bstr())));
	}
	let mut value = asg.value.clone();
	// The scope the parameter is created in: a type conversion keeps the
	// old one.
	let mut scope = if on & PM_LOCAL != 0 {
		Where::Scope(locallevel)
	} else {
		Where::Dynamic
	};
	if tc {
		let pm = pm.as_ref().expect("a type conversion has a parameter");
		on |= !off & (PM_READONLY | PM_EXPORTED) & pmf;
		scope = Where::Scope(pm.scope);
		if !asg.has_value() && (pmf | on) & (PM_ARRAY | PM_HASHED) == 0 {
			value = AsgVal::Scalar(pm.strval());
		}
		let name = pname.to_vec();
		if px(ctx, |ex| {
			params::set_flags(ex, &name, PmFlags::from_bits(pmf & !PM_READONLY), pm.width, pm.base)?;
			params::unsetparam(ex, &name)
		})?
		.is_none()
		{
			return Ok(Single::Abort);
		}
	}
	if let Some(sub) = pname.find_byte(b'[') {
		if on & PM_READONLY != 0 {
			return Ok(zerrnam(
				ctx,
				format!("{}: can't create readonly array elements", pname.as_bstr()),
			));
		}
		if on & PM_LOCAL != 0 && locallevel.is_some() {
			let base_name = head(pname, sub).to_vec();
			let Some(p) = px(ctx, |ex| params::getparam(ex, &base_name))? else {
				return Ok(Single::Abort);
			};
			if p.is_none_or(|p| p.scope != locallevel) {
				return Ok(zerrnam(
					ctx,
					format!("{}: can't create local array elements", pname.as_bstr()),
				));
			}
		}
		let name = pname.to_vec();
		let r = match &value {
			AsgVal::Array { .. } if pm_type(on) == PM_ARRAY => {
				px(ctx, |ex| assign(ex, &name, &value, true))?
			},
			AsgVal::Array { .. } => {
				return Ok(zerrnam(
					ctx,
					format!("{}: inconsistent array element or slice assignment", pname.as_bstr()),
				));
			},
			_ if pm_type(on) == 0 => {
				let v = match &value {
					AsgVal::Scalar(v) => v.clone(),
					_ => BString::default(),
				};
				px(ctx, |ex| params::assignsparam(ex, &name, &v, 0))?
			},
			_ => {
				return Ok(zerrnam(
					ctx,
					format!("{}: inconsistent array element or slice assignment", pname.as_bstr()),
				));
			},
		};
		return Ok(if r.is_some() {
			Single::Ok
		} else {
			Single::Abort
		});
	}
	let name = pname.to_vec();
	let known = pm.is_some() || newspecial;
	if !(params::isident(pname) || known)
		|| (pname.first().is_some_and(u8::is_ascii_digit) && pname != b"0")
	{
		let msg = if pname.first().is_some_and(u8::is_ascii_digit) {
			format!("not an identifier: {}", pname.as_bstr())
		} else {
			format!("not valid in this context: {}", pname.as_bstr())
		};
		return Ok(zerrnam(ctx, msg));
	}
	let Ok(width) = setwidth(ctx, ts.ops, on, 0, newspecial) else {
		return Ok(Single::Fail);
	};
	let Ok(base) = setbase(ctx, ts.ops, on, 0, newspecial) else {
		return Ok(Single::Fail);
	};
	let mut flags = on & !(PM_READONLY | PM_LOCAL);
	if ts.unset && !value_given(&value) {
		flags |= PM_DEFAULTED;
	}
	let readonly_on = on & PM_READONLY;
	let array_param = pm_type(flags) & (PM_ARRAY | PM_HASHED) != 0;
	// A local tied special (`local path`): zsh keeps it special at the new
	// level, starting empty; here the scalar it is computed from (`PATH`)
	// becomes local, keeping its export.
	let tied_local = pm
		.as_ref()
		.and_then(|p| p.special)
		.filter(|s| newspecial && matches!(s, Special::TiedArray(_)))
		.and_then(Special::tie_partner);
	let r = px(ctx, |ex| {
		if let Some((partner, _)) = tied_local {
			let partner = partner.as_bytes();
			let cur = params::getparam(ex, partner)?;
			// Already local here (`typeset MANPATH` then `typeset -T
			// MANPATH manpath`): the special keeps its value.
			if cur
				.as_ref()
				.is_none_or(|p| !matches!(scope, Where::Scope(s) if s == p.scope))
			{
				let exported = cur.map_or(0, |p| p.flags.bits() & PM_EXPORTED);
				create_in(ex, partner, PmFlags::from_bits(exported), (0, 0), scope);
			}
		} else {
			create_in(ex, &name, PmFlags::from_bits(flags), (width, base), scope);
		}
		assign(ex, &name, &value, array_param)?;
		if readonly_on != 0 {
			let p = params::getparam(ex, &name)?;
			let (f, w, b) = p.map_or((flags, width, base), |p| (p.flags.bits(), p.width, p.base));
			params::set_flags(ex, &name, PmFlags::from_bits(f | readonly_on), w, b)?;
		}
		Ok(())
	})?;
	Ok(if r.is_some() {
		Single::Ok
	} else {
		Single::Abort
	})
}

/// Where [`create_in`] creates a parameter.
#[derive(Clone, Copy)]
enum Where {
	/// The dynamic scope (zsh's current `locallevel` rules).
	Dynamic,
	/// That scope of the vproc (`None`: the global level).
	Scope(Option<usize>),
}

/// zsh `createparam` of `name` at `at` with zsh `width` and `base`.
fn create_in(
	ex: &mut Expander<'_, '_>,
	name: &[u8],
	flags: PmFlags,
	(width, base): (u16, u8),
	at: Where,
) {
	match at {
		Where::Scope(s) => params::createparam_at(ex, name, flags, width, base, s),
		Where::Dynamic => params::createparam(ex, name, flags, width, base, Level::Dynamic),
	}
}

/// Whether an assignment carries a value (`ASG_VALUEP`).
const fn value_given(v: &AsgVal) -> bool {
	!matches!(v, AsgVal::None)
}

/// zsh `bin_typeset` for `typeset`, `declare`, `local`, `export`,
/// `readonly`, `integer` and `float`. `base` is the argv index of
/// `args[0]` (for array assignment words).
#[expect(clippy::too_many_lines, reason = "one function, as zsh's bin_typeset")]
pub fn typeset(
	ctx: &mut Ctx<'_, '_>,
	ops: &mut Ops,
	args: &[BString],
	base: usize,
	func: Func,
) -> R {
	let name = ctx.name;
	let posix = isset(ctx, ZshOpt::Posixbuiltins)?;
	let hasargs = !args.is_empty();
	if matches!(func, Func::Readonly | Func::Export) && posix && hasargs {
		ops.clear(b'p');
	}
	if ops.isset(b'f') {
		return zsh_names::functions(ctx, ops, args, func);
	}
	if func == Func::Readonly && posix && !ops.plus(b'g') {
		ops.set(b'g');
	}
	let (mut on, mut off) = (0u32, 0u32);
	for (i, &c) in TYPESET_OPTSTR.iter().enumerate() {
		if ops.minus(c) {
			on |= 1 << i;
		} else if ops.plus(c) {
			off |= 1 << i;
		}
	}
	let roff = off;
	if on & PM_FFLOAT != 0 {
		off |= PM_UPPER | PM_ARRAY | PM_HASHED | PM_INTEGER | PM_EFLOAT;
		on &= !PM_EFLOAT;
	}
	if on & PM_EFLOAT != 0 {
		off |= PM_UPPER | PM_ARRAY | PM_HASHED | PM_INTEGER | PM_FFLOAT;
	}
	if on & PM_INTEGER != 0 {
		off |= PM_UPPER | PM_ARRAY | PM_HASHED | PM_EFLOAT | PM_FFLOAT;
	}
	if on & (PM_LEFT | PM_RIGHT_Z) != 0 {
		off |= PM_RIGHT_B;
	}
	if on & PM_RIGHT_B != 0 {
		off |= PM_LEFT | PM_RIGHT_Z;
	}
	if on & PM_UPPER != 0 {
		off |= PM_LOWER;
	}
	if on & PM_LOWER != 0 {
		off |= PM_UPPER;
	}
	if on & PM_HASHED != 0 {
		off |= PM_ARRAY;
	}
	if on & PM_TIED != 0 {
		off |= PM_INTEGER | PM_EFLOAT | PM_FFLOAT | PM_ARRAY | PM_HASHED;
	}
	on &= !off;
	let mut printflags = 0;
	if ops.isset(b'p') {
		let ksh = ctx.vp.mode == crate::bash::ids::ModeId::Ksh;
		printflags |= if posix && !ksh && func == Func::Export {
			PRINT_POSIX_EXPORT
		} else if posix && !ksh && func == Func::Readonly {
			PRINT_POSIX_READONLY
		} else {
			PRINT_TYPESET
		};
		if let Some(a) = ops.arg(b'p') {
			match a.to_str().ok().and_then(|s| s.parse::<i64>().ok()) {
				Some(1) => printflags |= PRINT_LINE,
				Some(0) => {},
				_ => {
					ctx.usage(format!("bad argument to -p: {}", a.as_bstr()));
					return done(1);
				},
			}
		}
	}
	if !hasargs {
		let mut exclude = 0;
		if !ops.isset(b'p') {
			if on | roff == 0 {
				printflags |= PRINT_TYPE;
			}
			if roff != 0 || ops.isset(b'+') {
				printflags |= PRINT_NAMEONLY;
			}
		} else if printflags & (PRINT_POSIX_EXPORT | PRINT_POSIX_READONLY) != 0 {
			exclude = (PM_ARRAY | PM_HASHED) & !(on | roff);
		}
		return match print_params(ctx, None, on | roff, exclude, printflags)? {
			Ok(_) => done(0),
			Err(d) => zerr(ctx, d),
		};
	}
	if !(ops.isset(b'g') || ops.isset(b'x') || ops.isset(b'm'))
		|| ops.plus(b'g')
		|| name.starts_with('l')
		|| (!isset(ctx, ZshOpt::Globalexport)? && !ops.isset(b'g'))
	{
		on |= PM_LOCAL;
	}
	let Some(asgs) = getasgs(ctx, args, base) else {
		ctx.diag(Diag::Usage { msg: "bad assignment".into() });
		return Ok(Outcome { status: 1, control: Control::DiscardAll });
	};
	let ts = Ts {
		func,
		on,
		off,
		roff,
		ops,
		posix,
		silent: isset(ctx, ZshOpt::Typesetsilent)?,
		unset: isset(ctx, ZshOpt::Typesettounset)?,
		pe: PrintEnv::of(ctx)?,
	};
	if on & PM_TIED != 0 && !ops.isset(b'p') {
		return tie(ctx, &ts, &asgs);
	}
	if off & PM_TIED != 0 {
		ctx.usage("use unset to remove tied variables");
		return Ok(Outcome { status: 1, control: Control::DiscardAll });
	}
	let mut returnval = 0;
	if ops.isset(b'm') {
		if !ops.isset(b'p') {
			if on | roff == 0 {
				printflags |= PRINT_TYPE;
			}
			if on == 0 {
				printflags |= PRINT_NAMEONLY;
			}
		}
		for asg in &asgs {
			let Some(pat) = pattern_arg(ctx, &asg.name)? else {
				returnval = 1;
				continue;
			};
			if ops.plus(b'm') && !asg.has_value() {
				if let Err(d) = print_params(ctx, Some(&pat), on | roff, 0, printflags)? {
					return zerr(ctx, d);
				}
				continue;
			}
			let Some(all) = px(ctx, params::scan)? else {
				return Ok(Outcome { status: 1, control: Control::DiscardAll });
			};
			for p in all
				.into_iter()
				.filter(|p| p.flags.bits() & PM_UNSET == 0 && pat.matches(&p.name))
			{
				let pname = p.name.clone();
				match typeset_single(ctx, &ts, &pname, Some(p), asg, ts.on, ts.off)? {
					Single::Ok => {},
					Single::Fail => returnval = 1,
					Single::Abort => return Ok(Outcome { status: 1, control: Control::DiscardAll }),
				}
			}
		}
		return done(returnval);
	}
	for asg in &asgs {
		let n = asg.name.clone();
		let Some(pm) = px(ctx, |ex| params::getparam(ex, &n))? else {
			return Ok(Outcome { status: 1, control: Control::DiscardAll });
		};
		if ops.isset(b'p') {
			if let Some(p) = pm {
				let pe = ts.pe;
				let Some(out) = px(ctx, |ex| {
					let mut out = Vec::new();
					print_param(ex, &pe, &p, printflags, &mut out)?;
					Ok(out)
				})?
				else {
					return Ok(Outcome { status: 1, control: Control::DiscardAll });
				};
				ctx.out(&out);
			} else {
				ctx.usage(format!("no such variable: {}", asg.name.as_bstr()));
				returnval = 1;
			}
			continue;
		}
		match typeset_single(ctx, &ts, &n, pm, asg, ts.on, ts.off)? {
			Single::Ok => {},
			Single::Fail => returnval = 1,
			Single::Abort => return Ok(Outcome { status: 1, control: Control::DiscardAll }),
		}
	}
	done(returnval)
}

/// `typeset -T SCALAR array [sep]` (the tied branch of `bin_typeset`).
fn tie(ctx: &mut Ctx<'_, '_>, ts: &Ts<'_>, asgs: &[Asg]) -> R {
	let fail = |ctx: &mut Ctx<'_, '_>, msg: String| {
		ctx.usage(msg);
		done(1)
	};
	let abort = |ctx: &mut Ctx<'_, '_>, msg: String| {
		ctx.usage(msg);
		Ok(Outcome { status: 1, control: Control::DiscardAll })
	};
	if ts.ops.isset(b'm') {
		return fail(ctx, "incompatible options for -T".into());
	}
	if asgs.len() < 2 {
		return fail(ctx, "-T requires names of scalar and array".into());
	}
	if asgs.len() > 3 {
		return fail(ctx, "too many arguments for -T".into());
	}
	let (s, a) = (&asgs[0], &asgs[1]);
	if s.is_array() {
		return fail(ctx, format!("first argument of tie must be scalar: {}", s.name.as_bstr()));
	}
	if !a.is_array() && a.has_value() {
		return fail(ctx, format!("second argument of tie must be array: {}", a.name.as_bstr()));
	}
	if s.name == a.name {
		return abort(ctx, format!("can't tie a variable to itself: {}", s.name.as_bstr()));
	}
	if s.name.contains(&b'[') || a.name.contains(&b'[') {
		return abort(ctx, format!("can't tie array elements: {}", s.name.as_bstr()));
	}
	if s.has_value() && a.has_value() {
		return abort(ctx, format!("only one tied parameter can have value: {}", s.name.as_bstr()));
	}
	let joinchar = match asgs.get(2) {
		None => b':',
		Some(j) if j.has_value() => {
			return fail(ctx, "third argument of tie must be join character".into());
		},
		Some(j) => j.name.first().copied().unwrap_or(0),
	};
	let (sname, aname) = (s.name.clone(), a.name.clone());
	let Some((pm, apm)) =
		px(ctx, |ex| Ok((params::getparam(ex, &sname)?, params::getparam(ex, &aname)?)))?
	else {
		return Ok(Outcome { status: 1, control: Control::DiscardAll });
	};
	let special_tied = |p: &Option<Param>| {
		p.as_ref()
			.is_some_and(|p| p.flags.bits() & (PM_SPECIAL | PM_TIED) == PM_SPECIAL | PM_TIED)
	};
	let partner = |p: &Option<Param>| {
		p.as_ref()
			.and_then(|p| p.tied.as_ref().map(|(n, _)| n.clone()))
			.unwrap_or_default()
	};
	let mut on = ts.on & !ts.off;
	let mut already = false;
	let mut oldval: Option<BString> = None;
	if special_tied(&pm) {
		if partner(&pm) != aname
			|| apm
				.as_ref()
				.is_none_or(|p| p.flags.bits() & PM_SPECIAL == 0)
		{
			let e = partner(&pm);
			return fail(
				ctx,
				format!(
					"{} special parameter can only be tied to special parameter {}",
					sname.as_bstr(),
					e.as_bstr()
				),
			);
		}
		if joinchar != b':' {
			return fail(ctx, "cannot change the join character of special tied parameters".into());
		}
		already = true;
	} else if special_tied(&apm) {
		let e = partner(&apm);
		return fail(
			ctx,
			format!(
				"{} special parameter can only be tied to special parameter {}",
				aname.as_bstr(),
				e.as_bstr()
			),
		);
	} else if let Some(p) = &pm {
		let f = p.flags.bits();
		if (f & PM_UNSET == 0 || f & PM_DECLARED != 0)
			&& (ts.pe.locallevel == p.scope || on & PM_LOCAL == 0)
		{
			if f & PM_TIED != 0 {
				if pm_type(f) != 0 {
					return fail(ctx, format!("already tied as non-scalar: {}", sname.as_bstr()));
				} else if partner(&pm) == aname {
					already = true;
				} else {
					return fail(ctx, format!("can't tie already tied scalar: {}", sname.as_bstr()));
				}
			} else {
				if !s.has_value() && !a.has_value() && pm_type(f) & (PM_ARRAY | PM_HASHED) == 0 {
					oldval = Some(p.strval());
				}
				on |= f & !ts.roff & PM_EXPORTED;
			}
		}
	}
	if already {
		let r1 = typeset_single(ctx, ts, &sname, pm, s, on, ts.off)?;
		if !matches!(r1, Single::Ok) {
			return Ok(Outcome { status: 1, control: Control::None });
		}
		// A new join character re-splits the words (zsh reassigns the
		// scalar, which its getter joins with the new character).
		if !s.has_value() {
			let r = px(ctx, |ex| {
				if params::set_tie_sep(ex, &sname, joinchar)? {
					let words = params::getaparam(ex, &aname)?.unwrap_or_default();
					let joined = BString::from(words.join(&[joinchar][..]));
					let items = joined
						.split(|&c| c == joinchar)
						.map(BString::from)
						.collect();
					params::assignaparam(ex, &aname, items, 0)?;
				}
				Ok(())
			})?;
			if r.is_none() {
				return Ok(Outcome { status: 1, control: Control::DiscardAll });
			}
		}
		let r2 = typeset_single(
			ctx,
			ts,
			&aname,
			apm,
			a,
			(on | PM_ARRAY) & !PM_EXPORTED,
			ts.off & !PM_ARRAY,
		)?;
		return done(i32::from(!matches!(r2, Single::Ok)));
	}
	// A local pair lives in the current function; otherwise where the
	// scalar already is (global when new).
	let scope = if on & PM_LOCAL != 0 {
		ts.pe.locallevel
	} else {
		pm.as_ref().and_then(|p| p.scope)
	};
	let svalue = match &s.value {
		AsgVal::Scalar(v) => Some(v.clone()),
		_ => oldval,
	};
	let avalue = match &a.value {
		AsgVal::Array { elems, kv } => Some((elems.clone(), *kv)),
		_ => None,
	};
	let flags = on & !(PM_LOCAL | PM_READONLY);
	let width_base = (setwidth(ctx, ts.ops, on, 0, false), setbase(ctx, ts.ops, on, 0, false));
	let (Ok(width), Ok(base)) = width_base else {
		return done(1);
	};
	let readonly_on = on & PM_READONLY;
	let r = px(ctx, |ex| {
		params::tie(ex, &sname, &aname, joinchar, PmFlags::from_bits(flags), width, base, scope)?;
		// zsh makes the array read-only before assigning its value
		// (`readonly -T VAR var=(a b)` fails: `read-only variable: var`).
		if readonly_on != 0 && avalue.is_some() {
			params::set_flags(
				ex,
				&aname,
				PmFlags::from_bits(flags | PM_ARRAY | readonly_on).without(PmFlags::EXPORTED),
				width,
				base,
			)?;
		}
		if let Some((elems, kv)) = avalue {
			if kv {
				params::assignaparam_kv(ex, &aname, &elems)?;
			} else {
				params::assignaparam(ex, &aname, elems, 0)?;
			}
		} else if let Some(v) = svalue {
			params::assignsparam(ex, &sname, &v, 0)?;
		}
		if readonly_on != 0 {
			for n in [&sname, &aname] {
				if let Some(p) = params::getparam(ex, n)? {
					params::set_flags(
						ex,
						n,
						PmFlags::from_bits(p.flags.bits() | readonly_on),
						p.width,
						p.base,
					)?;
				}
			}
		}
		Ok(())
	})?;
	if r.is_none() {
		return Ok(Outcome { status: 1, control: Control::DiscardAll });
	}
	done(0)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn typeset_optstr_maps_letters_to_pm_bits() {
		let bit = |c: u8| 1u32 << TYPESET_OPTSTR.iter().position(|&o| o == c).unwrap();
		assert_eq!(bit(b'a'), PM_ARRAY);
		assert_eq!(bit(b'i'), PM_INTEGER);
		assert_eq!(bit(b'A'), PM_HASHED);
		assert_eq!(bit(b'r'), PM_READONLY);
		assert_eq!(bit(b'x'), PM_EXPORTED);
		assert_eq!(bit(b'U'), PM_UNIQUE);
		assert_eq!(bit(b'T'), PM_TIED);
	}
}
