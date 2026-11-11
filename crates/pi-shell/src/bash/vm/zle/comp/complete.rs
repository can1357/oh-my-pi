//! zsh 5.9 `Src/Zle/complete.c` (zsh/complete): the `compadd` and
//! `compset` builtins, the completion special parameters (`words`,
//! `CURRENT`, `PREFIX`, …, `compstate`) and the `-prefix`, `-suffix`,
//! `-after`, `-between` conditions.

use bstr::{BString, ByteSlice};

use super::{
	Comp,
	types::{Cadata, caf, cmf},
	with_taken,
};
use crate::bash::{
	diag::Diag,
	pattern::zsh::{PatFlags, Pattern, remnulargs, tokenize},
	syntax::zsh::tok::{META, is_tok, metafy, unmetafy, untokenize},
	vm::{
		builtins::{
			Ctx, Need, R, done,
			zsh_args::{zerr, zx},
		},
		expand::{Expander, Stop, X},
		proc::{Probe, ProbeResult, Vproc},
		zsh::{
			assoc_order::ZHash,
			params::{PValue, PmFlags, parse_int},
			subst::singsub,
			zpattern,
		},
	},
	zshopt::ZshOpt,
};

/// complete.c's globals: the values of the completion special
/// parameters.
#[derive(Clone, Debug, Default)]
pub struct State {
	/// `$CURRENT`.
	pub compcurrent:      i64,
	/// `compstate[list_max]`.
	pub complistmax:      i64,
	/// `compstate[ignored]`.
	pub compignored:      i64,
	/// `$words`.
	pub compwords:        Vec<BString>,
	/// `compstate[redirs]` (zsh `compredirs`).
	pub compredirs:       Vec<BString>,
	/// `$PREFIX`.
	pub compprefix:       Option<BString>,
	/// `$SUFFIX`.
	pub compsuffix:       Option<BString>,
	/// zsh `complastprefix`.
	pub complastprefix:   Option<BString>,
	/// zsh `complastsuffix`.
	pub complastsuffix:   Option<BString>,
	/// `$ISUFFIX`.
	pub compisuffix:      Option<BString>,
	/// `$QIPREFIX`.
	pub compqiprefix:     Option<BString>,
	/// `$QISUFFIX`.
	pub compqisuffix:     Option<BString>,
	/// `compstate[quote]`.
	pub compquote:        Option<BString>,
	/// `compstate[all_quotes]` (the `QT_*` bytes).
	pub compqstack:       Option<BString>,
	/// `compstate[pattern_match]`.
	pub comppatmatch:     Option<BString>,
	/// `compstate[last_prompt]`.
	pub complastprompt:   Option<BString>,
	/// `$IPREFIX`.
	pub compiprefix:      Option<BString>,
	/// `compstate[context]`.
	pub compcontext:      Option<BString>,
	/// `compstate[parameter]`.
	pub compparameter:    Option<BString>,
	/// `compstate[redirect]`.
	pub compredirect:     Option<BString>,
	/// `compstate[quoting]`.
	pub compquoting:      Option<BString>,
	/// `compstate[restore]`.
	pub comprestore:      Option<BString>,
	/// `compstate[list]`.
	pub complist:         Option<BString>,
	/// `compstate[insert]`.
	pub compinsert:       Option<BString>,
	/// `compstate[exact]`.
	pub compexact:        Option<BString>,
	/// `compstate[exact_string]`.
	pub compexactstr:     Option<BString>,
	/// `compstate[pattern_insert]`.
	pub comppatinsert:    Option<BString>,
	/// `compstate[to_end]`.
	pub comptoend:        Option<BString>,
	/// `compstate[old_list]`.
	pub compoldlist:      Option<BString>,
	/// `compstate[old_insert]`.
	pub compoldins:       Option<BString>,
	/// `compstate[vared]`.
	pub compvared:        Option<BString>,
	/// The special parameters marked unset (zsh `PM_UNSET` on
	/// `comprpms[i]`; `CP_*` bits).
	pub runset:           i32,
	/// The `compstate` keys marked unset (`PM_UNSET` on `compkpms[i]`).
	pub kunset:           i32,
	/// `unset compstate` deleted the keys (zsh's freed `pm->u.hash`).
	pub kgone:            bool,
	/// Keys of `compstate` that are no completion key (assigned by shell
	/// code), in the order they were added.
	pub extra:            Vec<(BString, BString)>,
	/// Bumped by every assignment or unset of `compstate[pattern_match]`
	/// (zsh compares the `comppatmatch` pointer).
	pub comppatmatch_gen: u32,
	/// The values `comp_wrapper` restores, one per shell function running
	/// inside the completion function.
	pub wraps:            Vec<WrapSave>,
}

/// What zsh `comp_wrapper` saves around a shell function called while a
/// completion function runs.
#[derive(Clone, Debug, Default)]
pub struct WrapSave {
	/// Frame count of the call (the vproc's frames with its own).
	pub depth:   usize,
	/// `comprestore` before the call.
	pub orest:   Option<BString>,
	/// `compcurrent`.
	pub ocur:    i64,
	/// `compprefix`.
	pub opre:    Option<BString>,
	/// `compsuffix`.
	pub osuf:    Option<BString>,
	/// `compiprefix`.
	pub oipre:   Option<BString>,
	/// `compisuffix`.
	pub oisuf:   Option<BString>,
	/// `compqiprefix`.
	pub oqipre:  Option<BString>,
	/// `compqisuffix`.
	pub oqisuf:  Option<BString>,
	/// `compquote`.
	pub oq:      Option<BString>,
	/// `compquoting`.
	pub oqi:     Option<BString>,
	/// `compqstack`.
	pub oqs:     Option<BString>,
	/// `zle_tricky`'s `autoq`.
	pub oaq:     Option<BString>,
	/// `compwords`.
	pub owords:  Vec<BString>,
	/// `compredirs`.
	pub oredirs: Vec<BString>,
	/// The real parameters that were unset at the call.
	pub runset:  i32,
	/// `CP_RESTORE` when `compstate[restore]` was unset.
	pub kunset:  i32,
}

/// zsh `CPN_*`: index of a special parameter (bit number of `CP_*`).
pub mod cpn {
	/// `words`.
	pub const WORDS: i32 = 0;
	/// `redirections`.
	pub const REDIRS: i32 = 1;
	/// `CURRENT`.
	pub const CURRENT: i32 = 2;
	/// `PREFIX`.
	pub const PREFIX: i32 = 3;
	/// `SUFFIX`.
	pub const SUFFIX: i32 = 4;
	/// `IPREFIX`.
	pub const IPREFIX: i32 = 5;
	/// `ISUFFIX`.
	pub const ISUFFIX: i32 = 6;
	/// `QIPREFIX`.
	pub const QIPREFIX: i32 = 7;
	/// `QISUFFIX`.
	pub const QISUFFIX: i32 = 8;
	/// `compstate`.
	pub const COMPSTATE: i32 = 9;
}

/// zsh `CP_*`: bits of the special parameters.
pub const CP_WORDS: i32 = 1 << cpn::WORDS;
/// `CP_REDIRS`.
pub const CP_REDIRS: i32 = 1 << cpn::REDIRS;
/// `CP_CURRENT`.
pub const CP_CURRENT: i32 = 1 << cpn::CURRENT;
/// `CP_PREFIX`.
pub const CP_PREFIX: i32 = 1 << cpn::PREFIX;
/// `CP_SUFFIX`.
pub const CP_SUFFIX: i32 = 1 << cpn::SUFFIX;
/// `CP_IPREFIX`.
pub const CP_IPREFIX: i32 = 1 << cpn::IPREFIX;
/// `CP_ISUFFIX`.
pub const CP_ISUFFIX: i32 = 1 << cpn::ISUFFIX;
/// `CP_QIPREFIX`.
pub const CP_QIPREFIX: i32 = 1 << cpn::QIPREFIX;
/// `CP_QISUFFIX`.
pub const CP_QISUFFIX: i32 = 1 << cpn::QISUFFIX;
/// `CP_COMPSTATE`.
pub const CP_COMPSTATE: i32 = 1 << cpn::COMPSTATE;
/// `CP_ALLREALS`.
pub const CP_ALLREALS: i32 = 0x3ff;

/// zsh `CPN_*` of the `compstate` keys (index into [`KEYS`]).
pub mod kpn {
	/// `nmatches`.
	pub const NMATCHES: i32 = 0;
	/// `context`.
	pub const CONTEXT: i32 = 1;
	/// `parameter`.
	pub const PARAMETER: i32 = 2;
	/// `redirect`.
	pub const REDIRECT: i32 = 3;
	/// `quote`.
	pub const QUOTE: i32 = 4;
	/// `quoting`.
	pub const QUOTING: i32 = 5;
	/// `restore`.
	pub const RESTORE: i32 = 6;
	/// `list`.
	pub const LIST: i32 = 7;
	/// `insert`.
	pub const INSERT: i32 = 8;
	/// `exact`.
	pub const EXACT: i32 = 9;
	/// `exact_string`.
	pub const EXACTSTR: i32 = 10;
	/// `pattern_match`.
	pub const PATMATCH: i32 = 11;
	/// `pattern_insert`.
	pub const PATINSERT: i32 = 12;
	/// `unambiguous`.
	pub const UNAMBIG: i32 = 13;
	/// `unambiguous_cursor`.
	pub const UNAMBIGC: i32 = 14;
	/// `unambiguous_positions`.
	pub const UNAMBIGP: i32 = 15;
	/// `insert_positions`.
	pub const INSERTP: i32 = 16;
	/// `list_max`.
	pub const LISTMAX: i32 = 17;
	/// `last_prompt`.
	pub const LASTPROMPT: i32 = 18;
	/// `to_end`.
	pub const TOEND: i32 = 19;
	/// `old_list`.
	pub const OLDLIST: i32 = 20;
	/// `old_insert`.
	pub const OLDINS: i32 = 21;
	/// `vared`.
	pub const VARED: i32 = 22;
	/// `list_lines`.
	pub const LISTLINES: i32 = 23;
	/// `all_quotes`.
	pub const QUOTES: i32 = 24;
	/// `ignored`.
	pub const IGNORED: i32 = 25;
}

/// `CP_PARAMETER`.
pub const CP_PARAMETER: i32 = 1 << kpn::PARAMETER;
/// `CP_REDIRECT`.
pub const CP_REDIRECT: i32 = 1 << kpn::REDIRECT;
/// `CP_QUOTE`.
pub const CP_QUOTE: i32 = 1 << kpn::QUOTE;
/// `CP_QUOTING`.
pub const CP_QUOTING: i32 = 1 << kpn::QUOTING;
/// `CP_RESTORE`.
pub const CP_RESTORE: i32 = 1 << kpn::RESTORE;
/// `CP_LIST`.
pub const CP_LIST: i32 = 1 << kpn::LIST;
/// `CP_INSERT`.
pub const CP_INSERT: i32 = 1 << kpn::INSERT;
/// `CP_EXACT`.
pub const CP_EXACT: i32 = 1 << kpn::EXACT;
/// `CP_EXACTSTR`.
pub const CP_EXACTSTR: i32 = 1 << kpn::EXACTSTR;
/// `CP_PATMATCH`.
pub const CP_PATMATCH: i32 = 1 << kpn::PATMATCH;
/// `CP_LASTPROMPT`.
pub const CP_LASTPROMPT: i32 = 1 << kpn::LASTPROMPT;
/// `CP_OLDLIST`.
pub const CP_OLDLIST: i32 = 1 << kpn::OLDLIST;
/// `CP_OLDINS`.
pub const CP_OLDINS: i32 = 1 << kpn::OLDINS;
/// `CP_VARED`.
pub const CP_VARED: i32 = 1 << kpn::VARED;
/// `CP_ALLKEYS`.
pub const CP_ALLKEYS: i32 = 0x3ff_ffff;

/// zsh `makecompparams()`: the special parameters and `compstate`'s keys
/// exist anew, all set (the caller then marks some unset with
/// [`comp_setunset`]); their values are the fields of `c.complete`.
pub fn makecompparams(c: &mut super::Comp) {
	let s = &mut c.complete;
	s.runset = 0;
	s.kunset = 0;
	s.kgone = false;
	s.extra.clear();
	s.wraps.clear();
}

/// zsh `comp_setunset(rset, runset, kset, kunset)`: mark special
/// parameters (`CP_*` bits) and `compstate` keys set or unset.
pub fn comp_setunset(c: &mut super::Comp, rset: i32, runset: i32, kset: i32, kunset: i32) {
	let s = &mut c.complete;
	if rset >= 0 || runset >= 0 {
		let (rset, runset) = (rset.max(0), runset.max(0));
		s.runset = (s.runset & !rset) | runset;
	}
	if !s.kgone && (kset >= 0 || kunset >= 0) {
		let (kset, kunset) = (kset.max(0), kunset.max(0));
		s.kunset = (s.kunset & !kset) | kunset;
	}
}

// ---- the special parameters
// ----------------------------------------------------

/// One completion special parameter (zsh `comprparams`, plus `compstate`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Cp {
	/// `words`.
	Words,
	/// `redirections`.
	Redirections,
	/// `CURRENT`.
	Current,
	/// `PREFIX`.
	Prefix,
	/// `SUFFIX`.
	Suffix,
	/// `IPREFIX`.
	Iprefix,
	/// `ISUFFIX`.
	Isuffix,
	/// `QIPREFIX`.
	Qiprefix,
	/// `QISUFFIX`.
	Qisuffix,
	/// `compstate`.
	Compstate,
}

/// The names [`lookup`] knows.
pub(crate) const NAMES: &[&[u8]] = &[
	b"words",
	b"redirections",
	b"CURRENT",
	b"PREFIX",
	b"SUFFIX",
	b"IPREFIX",
	b"ISUFFIX",
	b"QIPREFIX",
	b"QISUFFIX",
	b"compstate",
];

/// The completion special `name` names, if any.
pub const fn lookup(name: &[u8]) -> Option<Cp> {
	Some(match name {
		b"words" => Cp::Words,
		b"redirections" => Cp::Redirections,
		b"CURRENT" => Cp::Current,
		b"PREFIX" => Cp::Prefix,
		b"SUFFIX" => Cp::Suffix,
		b"IPREFIX" => Cp::Iprefix,
		b"ISUFFIX" => Cp::Isuffix,
		b"QIPREFIX" => Cp::Qiprefix,
		b"QISUFFIX" => Cp::Qisuffix,
		b"compstate" => Cp::Compstate,
		_ => return None,
	})
}

impl Cp {
	/// Its `CPN_*` index.
	pub const fn index(self) -> i32 {
		match self {
			Self::Words => cpn::WORDS,
			Self::Redirections => cpn::REDIRS,
			Self::Current => cpn::CURRENT,
			Self::Prefix => cpn::PREFIX,
			Self::Suffix => cpn::SUFFIX,
			Self::Iprefix => cpn::IPREFIX,
			Self::Isuffix => cpn::ISUFFIX,
			Self::Qiprefix => cpn::QIPREFIX,
			Self::Qisuffix => cpn::QISUFFIX,
			Self::Compstate => cpn::COMPSTATE,
		}
	}

	/// zsh's type flags (`comprparams[].type`; `PM_SPECIAL` is added by
	/// the caller, `PM_LOCAL`'s level shows as the parameter's scope).
	pub const fn flags(self) -> PmFlags {
		match self {
			Self::Words | Self::Redirections => PmFlags::ARRAY,
			Self::Current => PmFlags::INTEGER,
			Self::Qiprefix | Self::Qisuffix => PmFlags::READONLY,
			Self::Compstate => PmFlags::HASHED,
			Self::Prefix | Self::Suffix | Self::Iprefix | Self::Isuffix => PmFlags::SCALAR,
		}
	}
}

/// Whether the completion specials exist in `vp` now: a completion
/// function runs (zsh `makecompparams` locals of `callcompfunc`'s scope).
pub fn visible(vp: &Vproc) -> bool {
	super::incompfunc(vp) == 1
}

/// The value type of a `compstate` key.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kt {
	/// A string variable.
	Str,
	/// An integer variable.
	Int,
}

/// zsh `compkparams`: name, type, read-only, in table order (the
/// `CPN_*` index is the position).
const KEYS: [(&str, Kt, bool); 26] = [
	("nmatches", Kt::Int, true),
	("context", Kt::Str, false),
	("parameter", Kt::Str, false),
	("redirect", Kt::Str, false),
	("quote", Kt::Str, true),
	("quoting", Kt::Str, true),
	("restore", Kt::Str, false),
	("list", Kt::Str, false),
	("insert", Kt::Str, false),
	("exact", Kt::Str, false),
	("exact_string", Kt::Str, false),
	("pattern_match", Kt::Str, false),
	("pattern_insert", Kt::Str, false),
	("unambiguous", Kt::Str, true),
	("unambiguous_cursor", Kt::Int, true),
	("unambiguous_positions", Kt::Str, true),
	("insert_positions", Kt::Str, true),
	("list_max", Kt::Int, false),
	("last_prompt", Kt::Str, false),
	("to_end", Kt::Str, false),
	("old_list", Kt::Str, false),
	("old_insert", Kt::Str, false),
	("vared", Kt::Str, false),
	("list_lines", Kt::Int, true),
	("all_quotes", Kt::Str, true),
	("ignored", Kt::Int, true),
];

/// The string variable behind a plain `compstate` key.
const fn key_var(s: &mut State, i: i32) -> Option<&mut Option<BString>> {
	Some(match i {
		kpn::CONTEXT => &mut s.compcontext,
		kpn::PARAMETER => &mut s.compparameter,
		kpn::REDIRECT => &mut s.compredirect,
		kpn::QUOTE => &mut s.compquote,
		kpn::QUOTING => &mut s.compquoting,
		kpn::RESTORE => &mut s.comprestore,
		kpn::INSERT => &mut s.compinsert,
		kpn::EXACT => &mut s.compexact,
		kpn::EXACTSTR => &mut s.compexactstr,
		kpn::PATMATCH => &mut s.comppatmatch,
		kpn::PATINSERT => &mut s.comppatinsert,
		kpn::LASTPROMPT => &mut s.complastprompt,
		kpn::TOEND => &mut s.comptoend,
		kpn::OLDLIST => &mut s.compoldlist,
		kpn::OLDINS => &mut s.compoldins,
		kpn::VARED => &mut s.compvared,
		_ => return None,
	})
}

/// zsh `get_compqstack`: the quoting stack as the quote characters.
fn get_compqstack(c: &Comp) -> BString {
	let mut out = BString::default();
	for &q in c
		.complete
		.compqstack
		.as_deref()
		.map_or(&[][..], |s| s.as_slice())
	{
		if let Some(&ch) = super::compcore::comp_quoting_string(q).first() {
			out.push(ch);
		}
	}
	out
}

/// The value of `compstate[KEYS[i]]` (metafied, as zsh's getfn returns
/// it).
fn key_value(ex: &mut Expander<'_, '_>, c: &mut Comp, i: i32) -> BString {
	let int = |n: i64| BString::from(n.to_string());
	match i {
		kpn::NMATCHES => {
			let n = if super::compcore::permmatches(ex, c, 0) != 0 {
				0
			} else {
				c.core.nmatches
			};
			int(i64::from(n))
		},
		kpn::LIST => c.complete.complist.clone().unwrap_or_default(),
		kpn::UNAMBIG => super::compresult::unambig_data(c, None, None, None),
		kpn::UNAMBIGC => {
			let mut cur = 0;
			super::compresult::unambig_data(c, Some(&mut cur), None, None);
			int(i64::from(cur))
		},
		kpn::UNAMBIGP => {
			let mut p = BString::default();
			super::compresult::unambig_data(c, None, Some(&mut p), None);
			p
		},
		kpn::INSERTP => {
			let mut p = BString::default();
			super::compresult::unambig_data(c, None, None, Some(&mut p));
			p
		},
		kpn::LISTMAX => int(c.complete.complistmax),
		kpn::LISTLINES => int(i64::from(super::compresult::list_lines(ex, c))),
		kpn::QUOTES => get_compqstack(c),
		kpn::IGNORED => int(c.complete.compignored),
		_ => key_var(&mut c.complete, i)
			.and_then(|v| v.clone())
			.unwrap_or_default(),
	}
}

/// zsh's `compstate` table: every key in insertion order (zsh
/// `newparamtable(31, …)`), extras after; the ones set, in zsh's
/// iteration order, values raw.
fn get_compstate(ex: &mut Expander<'_, '_>, c: &mut Comp) -> Vec<(BString, BString)> {
	let mut h = ZHash::with_buckets(31);
	if !c.complete.kgone {
		for (i, &(name, ..)) in KEYS.iter().enumerate() {
			let i = i as i32;
			if c.complete.kunset & (1 << i) != 0 {
				continue;
			}
			let v = key_value(ex, c, i);
			h.insert(BString::from(name), BString::from(unmetafy(&v)));
		}
	}
	for (k, v) in &c.complete.extra {
		h.insert(k.clone(), v.clone());
	}
	h.iter().cloned().collect()
}

/// zsh `set_compstate` (and the per-key set functions an element
/// assignment reaches): `new` is the whole table as shell code left it.
/// A known key missing from it was unset (zsh `compunsetfn`: a string
/// becomes empty, an integer stays).
fn set_compstate(ex: &mut Expander<'_, '_>, c: &mut Comp, new: Vec<(BString, BString)>) -> X<()> {
	if c.complete.kgone {
		c.complete.extra = new;
		return Ok(());
	}
	let mut seen = 0i32;
	let mut extra = Vec::new();
	for (k, v) in new {
		let Some(i) = KEYS
			.iter()
			.position(|&(n, ..)| n.as_bytes() == k.as_slice())
		else {
			extra.push((k, v));
			continue;
		};
		let (_, kt, ro) = KEYS[i];
		let i = i as i32;
		seen |= 1 << i;
		let shown = c.complete.kunset & (1 << i) == 0;
		if ro {
			if !shown || unmetafy(&key_value(ex, c, i)) != v {
				return Err(Stop::Fail(Diag::Readonly { name: k }));
			}
			continue;
		}
		let mv = BString::from(metafy(&v));
		match (i, kt) {
			(kpn::LIST, _) => super::compresult::comp_list(c, Some(&mv)),
			(kpn::LISTMAX, _) => c.complete.complistmax = parse_int(&v),
			(_, Kt::Str) => {
				if i == kpn::PATMATCH {
					c.complete.comppatmatch_gen = c.complete.comppatmatch_gen.wrapping_add(1);
				}
				if let Some(var) = key_var(&mut c.complete, i) {
					*var = Some(mv);
				}
			},
			(_, Kt::Int) => {},
		}
		c.complete.kunset &= !(1 << i);
	}
	for (i, &(name, kt, ro)) in KEYS.iter().enumerate() {
		let i = i as i32;
		if seen & (1 << i) != 0 || c.complete.kunset & (1 << i) != 0 {
			continue;
		}
		if ro {
			return Err(Stop::Fail(Diag::Readonly { name: BString::from(name) }));
		}
		if kt == Kt::Str
			&& let Some(var) = key_var(&mut c.complete, i)
		{
			*var = Some(BString::default());
			if i == kpn::PATMATCH {
				c.complete.comppatmatch_gen = c.complete.comppatmatch_gen.wrapping_add(1);
			}
		}
	}
	c.complete.extra = extra;
	Ok(())
}

fn scalar(s: Option<&BString>) -> PValue {
	PValue::Scalar(BString::from(unmetafy(s.map_or(&b""[..], |s| s.as_slice()))))
}

fn array(a: &[BString]) -> PValue {
	PValue::Array(a.iter().map(|s| BString::from(unmetafy(s))).collect())
}

/// The value of `cp` (`None`: unset or not visible).
pub fn get(ex: &mut Expander<'_, '_>, cp: Cp) -> Option<PValue> {
	if !visible(ex.vp) {
		return None;
	}
	if super::comp(ex.vp).is_some_and(|c| c.complete.runset & (1 << cp.index()) != 0) {
		return None;
	}
	Some(with_taken(ex, |ex, c| {
		let s = &c.complete;
		match cp {
			Cp::Words => array(&s.compwords),
			Cp::Redirections => array(&s.compredirs),
			Cp::Current => PValue::Scalar(BString::from(s.compcurrent.to_string())),
			Cp::Prefix => scalar(s.compprefix.as_ref()),
			Cp::Suffix => scalar(s.compsuffix.as_ref()),
			Cp::Iprefix => scalar(s.compiprefix.as_ref()),
			Cp::Isuffix => scalar(s.compisuffix.as_ref()),
			Cp::Qiprefix => scalar(s.compqiprefix.as_ref()),
			Cp::Qisuffix => scalar(s.compqisuffix.as_ref()),
			Cp::Compstate => PValue::Hash(get_compstate(ex, c)),
		}
	}))
}

fn as_scalar(v: &PValue) -> BString {
	match v {
		PValue::Scalar(s) => s.clone(),
		PValue::Array(a) => BString::from(a.join(&b" "[..])),
		PValue::Hash(h) => BString::from(
			h.iter()
				.map(|(_, v)| v.as_slice())
				.collect::<Vec<_>>()
				.join(&b" "[..]),
		),
	}
}

fn as_array(v: PValue) -> Vec<BString> {
	match v {
		PValue::Array(a) => a,
		PValue::Scalar(s) => vec![s],
		PValue::Hash(h) => h.into_iter().flat_map(|(k, v)| [k, v]).collect(),
	}
}

/// Assign `value` to `cp` (zsh's `strvarsetfn`, `intvarsetfn`,
/// `arrvarsetfn`, `set_compstate`; read-only ones are refused by the
/// caller).
///
/// # Errors
/// `read-only variable` for a read-only `compstate` key.
pub fn set(ex: &mut Expander<'_, '_>, cp: Cp, value: PValue) -> X<()> {
	if !visible(ex.vp) {
		return Ok(());
	}
	with_taken(ex, |ex, c| {
		let meta = |v: &PValue| Some(BString::from(metafy(&as_scalar(v))));
		let s = &mut c.complete;
		match cp {
			Cp::Words => {
				s.compwords = as_array(value)
					.iter()
					.map(|e| BString::from(metafy(e)))
					.collect();
			},
			Cp::Redirections => {
				s.compredirs = as_array(value)
					.iter()
					.map(|e| BString::from(metafy(e)))
					.collect();
			},
			Cp::Current => s.compcurrent = parse_int(&as_scalar(&value)),
			Cp::Prefix => s.compprefix = meta(&value),
			Cp::Suffix => s.compsuffix = meta(&value),
			Cp::Iprefix => s.compiprefix = meta(&value),
			Cp::Isuffix => s.compisuffix = meta(&value),
			Cp::Qiprefix => s.compqiprefix = meta(&value),
			Cp::Qisuffix => s.compqisuffix = meta(&value),
			Cp::Compstate => {
				let PValue::Hash(h) = value else {
					return Ok(());
				};
				set_compstate(ex, c, h)?;
			},
		}
		c.complete.runset &= !(1 << cp.index());
		Ok(())
	})
}

/// Unset `cp` (zsh `compunsetfn(pm, 1)`): a string becomes empty, an
/// array empty, `compstate` loses its keys; the parameter stays.
pub fn unset(ex: &mut Expander<'_, '_>, cp: Cp) {
	let Some(c) = super::comp_mut(ex.vp) else {
		return;
	};
	if c.incompfunc != 1 {
		return;
	}
	let s = &mut c.complete;
	let empty = || Some(BString::default());
	match cp {
		Cp::Words => s.compwords.clear(),
		Cp::Redirections => s.compredirs.clear(),
		Cp::Current => {},
		Cp::Prefix => s.compprefix = empty(),
		Cp::Suffix => s.compsuffix = empty(),
		Cp::Iprefix => s.compiprefix = empty(),
		Cp::Isuffix => s.compisuffix = empty(),
		Cp::Qiprefix => s.compqiprefix = empty(),
		Cp::Qisuffix => s.compqisuffix = empty(),
		Cp::Compstate => {
			s.kgone = true;
			s.extra.clear();
		},
	}
}

// ---- comp_wrapper
// ----------------------------------------------------------------

const WRAPPED: i32 = CP_WORDS
	| CP_REDIRS
	| CP_CURRENT
	| CP_PREFIX
	| CP_SUFFIX
	| CP_IPREFIX
	| CP_ISUFFIX
	| CP_QIPREFIX
	| CP_QISUFFIX;

/// zsh `comp_wrapper` before a shell function runs (its frame is on top
/// of `vp`): inside a completion function, save the completion state
/// the function may change and set `compstate[restore]` to `auto`.
pub fn wrap_enter(vp: &mut Vproc) {
	let depth = vp.frames.len();
	let Some(c) = super::comp_mut(vp) else {
		return;
	};
	if c.incompfunc != 1 {
		return;
	}
	let aq = c.tricky.autoq.clone();
	let s = &mut c.complete;
	s.wraps.retain(|w| w.depth < depth);
	let save = WrapSave {
		depth,
		orest: s.comprestore.replace(BString::from("auto")),
		ocur: s.compcurrent,
		opre: s.compprefix.clone(),
		osuf: s.compsuffix.clone(),
		oipre: s.compiprefix.clone(),
		oisuf: s.compisuffix.clone(),
		oqipre: s.compqiprefix.clone(),
		oqisuf: s.compqisuffix.clone(),
		oq: s.compquote.clone(),
		oqi: s.compquoting.clone(),
		oqs: s.compqstack.clone(),
		oaq: aq,
		owords: s.compwords.clone(),
		oredirs: s.compredirs.clone(),
		runset: s.runset & WRAPPED,
		kunset: s.kunset & CP_RESTORE,
	};
	s.wraps.push(save);
}

/// zsh `comp_wrapper` after the function returned (its frame is gone):
/// with `compstate[restore]` still `auto`, the saved state comes back.
pub fn wrap_leave(vp: &mut Vproc) {
	let depth = vp.frames.len() + 1;
	let Some(c) = super::comp_mut(vp) else {
		return;
	};
	let s = &mut c.complete;
	s.wraps.retain(|w| w.depth <= depth);
	if s.wraps.last().is_none_or(|w| w.depth != depth) {
		return;
	}
	let Some(w) = s.wraps.pop() else {
		return;
	};
	if s
		.comprestore
		.as_deref()
		.is_some_and(|r| r.as_slice() == b"auto")
	{
		s.compcurrent = w.ocur;
		s.compprefix = w.opre;
		s.compsuffix = w.osuf;
		s.compiprefix = w.oipre;
		s.compisuffix = w.oisuf;
		s.compqiprefix = w.oqipre;
		s.compqisuffix = w.oqisuf;
		s.compquote = w.oq;
		s.compquoting = w.oqi;
		s.compqstack = w.oqs;
		s.compwords = w.owords;
		s.compredirs = w.oredirs;
		s.comprestore = w.orest;
		c.tricky.autoq = w.oaq;
		comp_setunset(
			c,
			CP_COMPSTATE | (!w.runset & WRAPPED),
			w.runset & CP_ALLREALS,
			!w.kunset & CP_RESTORE,
			w.kunset & CP_ALLKEYS,
		);
	} else {
		s.comprestore = w.orest;
		comp_setunset(c, CP_COMPSTATE, 0, !w.kunset & CP_RESTORE, w.kunset & CP_RESTORE);
	}
}

// ---- compset and the conditions
// ---------------------------------------------------

/// zsh `CVT_*`: what `do_comp_vars` tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cvt {
	/// `compset -n`: a range of word numbers.
	RangeNum,
	/// `compset -N`, `-after`, `-between`: a range of words by patterns.
	RangePat,
	/// `compset -p`: a prefix length.
	PreNum,
	/// `compset -P`, `-prefix`: a prefix pattern.
	PrePat,
	/// `compset -s`: a suffix length.
	SufNum,
	/// `compset -S`, `-suffix`: a suffix pattern.
	SufPat,
}

/// zsh `ignore_prefix(l)`: move the first `l` bytes of `$PREFIX` to
/// `$IPREFIX`.
pub fn ignore_prefix(c: &mut Comp, l: usize) {
	if l == 0 {
		return;
	}
	let s = &mut c.complete;
	let pre = s.compprefix.take().unwrap_or_default();
	let l = l.min(pre.len());
	let mut ip = s.compiprefix.take().unwrap_or_default();
	ip.extend_from_slice(&pre[..l]);
	s.compiprefix = Some(ip);
	s.compprefix = Some(BString::from(&pre[l..]));
}

/// zsh `ignore_suffix(l)`: move the last `l` bytes of `$SUFFIX` to the
/// front of `$ISUFFIX`.
pub fn ignore_suffix(c: &mut Comp, l: usize) {
	if l == 0 {
		return;
	}
	let s = &mut c.complete;
	let suf = s.compsuffix.take().unwrap_or_default();
	let at = suf.len().saturating_sub(l);
	let mut is = BString::from(&suf[at..]);
	is.extend_from_slice(s.compisuffix.as_deref().map_or(&[][..], |v| v.as_slice()));
	s.compisuffix = Some(is);
	s.compsuffix = Some(BString::from(&suf[..at]));
}

/// zsh `restrict_range(b, e)`: keep `words[b+1,e+1]` (0-based `b..=e`),
/// `CURRENT` following.
pub fn restrict_range(c: &mut Comp, b: i64, e: i64) {
	let s = &mut c.complete;
	let wl = s.compwords.len() as i64 - 1;
	if wl != 0 && b >= 0 && e >= 0 && (b > 0 || e < wl) {
		let e = e.min(wl);
		let n = (e - b + 1).max(0) as usize;
		let b = b as usize;
		let words: Vec<BString> = s.compwords.iter().skip(b).take(n).cloned().collect();
		s.compwords = words;
		s.compcurrent -= b as i64;
	}
}

/// zsh `mb_metacharlenconv`'s length: bytes of the (multibyte,
/// metafied) character at `s[i..]`; a token or invalid byte is one
/// character.
fn metacharlen(s: &[u8], i: usize, multibyte: bool) -> usize {
	let b = s[i];
	if !multibyte || b <= 0x7f {
		return 1 + usize::from(b == META);
	}
	if is_tok(b) {
		return 1;
	}
	let mut raw = Vec::with_capacity(4);
	let mut p = i;
	while p < s.len() && raw.len() < 4 {
		let c = if s[p] == META {
			p += 1;
			s.get(p).map_or(0, |&c| c ^ 32)
		} else if is_tok(s[p]) {
			break;
		} else {
			s[p]
		};
		p += 1;
		raw.push(c);
		match std::str::from_utf8(&raw) {
			Ok(_) => return p - i,
			Err(e) if e.error_len().is_some() => break,
			Err(_) => {},
		}
	}
	1 + usize::from(b == META)
}

/// zsh `backwardmetafiedchar`: the start of the character before `end`
/// in the metafied `s`.
fn backwardmetafiedchar(s: &[u8], end: usize, multibyte: bool) -> usize {
	let mut i = 0;
	let mut last = 0;
	while i < end {
		last = i;
		i += metacharlen(s, i, multibyte);
	}
	last
}

/// `pattry` on a metafied subject (the match variables set as zsh does).
fn pattry(ex: &mut Expander<'_, '_>, pat: &Pattern, s: &[u8]) -> X<bool> {
	zpattern::matches(ex, pat, &unmetafy(s))
}

/// zsh `do_comp_vars(test, na, sa, nb, sb, mod)`: whether the test
/// holds; with `md` the completion state is narrowed accordingly.
/// Patterns are tokenized and metafied.
#[expect(clippy::too_many_lines, reason = "one function, as zsh's do_comp_vars")]
pub fn do_comp_vars(
	ex: &mut Expander<'_, '_>,
	c: &mut Comp,
	test: Cvt,
	mut na: i64,
	sa: Option<&[u8]>,
	mut nb: i64,
	sb: Option<&[u8]>,
	md: bool,
) -> X<bool> {
	match test {
		Cvt::RangeNum => {
			let l = c.complete.compwords.len() as i64;
			if na < 0 {
				na += l;
			} else {
				na -= 1;
			}
			if nb < 0 {
				nb += l;
			} else {
				nb -= 1;
			}
			let cur = c.complete.compcurrent - 1;
			if cur < na || cur > nb {
				return Ok(false);
			}
			if md {
				restrict_range(c, na, nb);
			}
			Ok(true)
		},
		Cvt::RangePat => {
			let l = c.complete.compwords.len() as i64;
			let mut i = c.complete.compcurrent - 1;
			if i < 0 || i >= l {
				return Ok(false);
			}
			let sa = singsub(ex, sa.unwrap_or_default().to_vec())?;
			let pp = zpattern::try_compile(ex, &sa, PatFlags::NONE)?;
			let (mut t, mut b, mut e) = (false, 0i64, l - 1);
			i -= 1;
			while i >= 0 {
				let w = c.complete.compwords[i as usize].clone();
				if let Some(p) = &pp
					&& pattry(ex, p, &w)?
				{
					b = i + 1;
					t = true;
					break;
				}
				i -= 1;
			}
			if t && let Some(sb) = sb {
				let mut tt = false;
				let sb = singsub(ex, sb.to_vec())?;
				let pp = zpattern::try_compile(ex, &sb, PatFlags::NONE)?;
				i += 1;
				while i < l {
					let w = c.complete.compwords[i as usize].clone();
					if let Some(p) = &pp
						&& pattry(ex, p, &w)?
					{
						e = i - 1;
						tt = true;
						break;
					}
					i += 1;
				}
				if tt && i < c.complete.compcurrent {
					t = false;
				}
			}
			if e < b {
				t = false;
			}
			if t && md {
				restrict_range(c, b, e);
			}
			Ok(t)
		},
		Cvt::PreNum | Cvt::SufNum => {
			if na < 0 {
				return Ok(false);
			}
			if na > 0 && md {
				let multibyte = super::isset(ex, ZshOpt::Multibyte);
				if multibyte {
					if test == Cvt::PreNum {
						let pre = c.complete.compprefix.clone().unwrap_or_default();
						let (mut p, mut sum) = (0usize, 0usize);
						while p < pre.len() && na > 0 {
							let len = metacharlen(&pre, p, true);
							p += len;
							sum += len;
							na -= 1;
						}
						if na != 0 {
							return Ok(false);
						}
						na = sum as i64;
					} else {
						let suf = c.complete.compsuffix.clone().unwrap_or_default();
						let end = suf.len();
						let mut ptr = end;
						loop {
							let more = na > 0;
							na -= 1;
							if !more || ptr == 0 {
								break;
							}
							ptr = backwardmetafiedchar(&suf, ptr, true);
						}
						if na >= 0 {
							return Ok(false);
						}
						na = (end - ptr) as i64;
					}
				} else {
					let len = if test == Cvt::PreNum {
						&c.complete.compprefix
					} else {
						&c.complete.compsuffix
					}
					.as_ref()
					.map_or(0, |s| s.len());
					if (len as i64) < na {
						return Ok(false);
					}
				}
				if test == Cvt::PreNum {
					ignore_prefix(c, na as usize);
				} else {
					ignore_suffix(c, na as usize);
				}
			}
			Ok(true)
		},
		Cvt::PrePat | Cvt::SufPat => {
			if na == 0 {
				return Ok(false);
			}
			let Some(pp) = zpattern::try_compile(ex, sa.unwrap_or_default(), PatFlags::NONE)? else {
				return Ok(false);
			};
			if test == Cvt::PrePat {
				let pre = c.complete.compprefix.clone().unwrap_or_default();
				let l = pre.len();
				if l == 0 {
					return Ok((na == 1 || na == -1) && pattry(ex, &pp, &pre)?);
				}
				let add: i64;
				let mut p;
				if na < 0 {
					p = l;
					na = -na;
					add = -1;
				} else {
					p = (1 + usize::from(pre[0] == META)).min(l);
					add = 1;
				}
				loop {
					if pattry(ex, &pp, &pre[..p])? {
						na -= 1;
						if na == 0 {
							break;
						}
					}
					if add > 0 {
						if p == l {
							return Ok(false);
						}
						p = (p + 1 + usize::from(pre[p] == META)).min(l);
					} else {
						if p == 0 {
							return Ok(false);
						}
						p -= 1;
						if p > 0 && pre[p - 1] == META {
							p -= 1;
						}
					}
				}
				if md {
					ignore_prefix(c, p);
				}
			} else {
				let suf = c.complete.compsuffix.clone().unwrap_or_default();
				let l = suf.len();
				if l == 0 {
					return Ok((na == 1 || na == -1) && pattry(ex, &pp, &suf)?);
				}
				let add: i64;
				let mut p;
				if na < 0 {
					p = 0;
					na = -na;
					add = 1;
				} else {
					p = l - 1;
					if p > 0 && suf[p - 1] == META {
						p -= 1;
					}
					add = -1;
				}
				loop {
					if pattry(ex, &pp, &suf[p..])? {
						na -= 1;
						if na == 0 {
							break;
						}
					}
					if add > 0 {
						if p == l {
							return Ok(false);
						}
						p += if suf[p] == META { 2 } else { 1 };
						p = p.min(l);
					} else {
						if p == 0 {
							return Ok(false);
						}
						p -= 1;
						if p > 0 && suf[p - 1] == META {
							p -= 1;
						}
					}
				}
				if md {
					ignore_suffix(c, l - p);
				}
			}
			Ok(true)
		},
	}
}

/// C `atoi`: leading blanks, a sign, digits; 0 when there are none.
fn atoi(s: &[u8]) -> i64 {
	let mut i = 0;
	while s
		.get(i)
		.is_some_and(|c| matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c))
	{
		i += 1;
	}
	let neg = match s.get(i) {
		Some(b'-') => {
			i += 1;
			true
		},
		Some(b'+') => {
			i += 1;
			false
		},
		_ => false,
	};
	let mut n: i64 = 0;
	while let Some(&d) = s.get(i).filter(|d| d.is_ascii_digit()) {
		n = n.wrapping_mul(10).wrapping_add(i64::from(d - b'0'));
		i += 1;
	}
	i64::from((if neg { n.wrapping_neg() } else { n }) as i32)
}

/// A builtin's text argument as zsh tokenizes it (`tokenize` +
/// `remnulargs` of the metafied argument).
fn tokenized(s: &[u8]) -> Vec<u8> {
	let mut t = metafy(s);
	tokenize(&mut t);
	remnulargs(&mut t);
	t
}

/// The `compset` builtin (zsh `bin_compset`).
///
/// # Errors
/// A store failure, or a substitution to run first.
pub fn compset(ctx: &mut Ctx<'_, '_>, argv: &[BString]) -> R {
	if super::incompfunc(ctx.vp) != 1 {
		ctx.usage("can only be called from completion function");
		return done(1);
	}
	let a0 = argv.first().map_or(&b""[..], |a| a.as_slice());
	if a0.first() != Some(&b'-') {
		ctx.usage("missing option");
		return done(1);
	}
	let opt = a0.get(1).copied().unwrap_or(0);
	let test = match opt {
		b'n' => Cvt::RangeNum,
		b'N' => Cvt::RangePat,
		b'p' => Cvt::PreNum,
		b'P' => Cvt::PrePat,
		b's' => Cvt::SufNum,
		b'S' => Cvt::SufPat,
		b'q' => {
			let r = zx(ctx, |ex| Ok(with_taken(ex, super::compcore::set_comp_sep)))?;
			return match r {
				Ok(st) => done(st),
				Err(d) => zerr(ctx, d),
			};
		},
		_ => {
			ctx.usage(format!("bad option -{}", char::from(opt)));
			return done(1);
		},
	};
	let (sa, sb, next): (&[u8], Option<&[u8]>, usize) = if a0.len() > 2 {
		(&a0[2..], argv.get(1).map(|a| a.as_slice()), 2)
	} else {
		let Some(sa) = argv.get(1) else {
			ctx.usage(format!("missing string for option -{}", char::from(opt)));
			return done(1);
		};
		(sa.as_slice(), argv.get(2).map(|a| a.as_slice()), 3)
	};
	let too_many = if matches!(test, Cvt::PreNum | Cvt::SufNum) {
		sb.is_some()
	} else {
		sb.is_some() && argv.get(next).is_some()
	};
	if too_many {
		ctx.usage("too many arguments");
		return done(1);
	}
	let (na, nb, pa, pb) = match test {
		Cvt::RangeNum => (atoi(sa), sb.map_or(-1, atoi), None, None),
		Cvt::RangePat => (0, 0, Some(tokenized(sa)), sb.map(tokenized)),
		Cvt::PreNum | Cvt::SufNum => (atoi(sa), 0, None, None),
		Cvt::PrePat | Cvt::SufPat => match sb {
			Some(sb) => (atoi(sa), 0, Some(tokenized(sb)), None),
			None => (-1, 0, Some(tokenized(sa)), None),
		},
	};
	let r = zx(ctx, |ex| {
		with_taken(ex, |ex, c| do_comp_vars(ex, c, test, na, pa.as_deref(), nb, pb.as_deref(), true))
	})?;
	match r {
		Ok(t) => done(i32::from(!t)),
		Err(d) => zerr(ctx, d),
	}
}

/// zsh/complete's conditions (`cond_psfix`, `cond_range`): `-prefix
/// [N] pat`, `-suffix [N] pat`, `-after pat`, `-between pat1 pat2`.
/// `args` are the substituted operands, patterns tokenized.
///
/// # Errors
/// `condition can only be used in completion function` (zsh `zerr`) for
/// `-prefix`/`-suffix` outside one; a math error in `N`.
pub fn cond(ex: &mut Expander<'_, '_>, name: &[u8], args: &[BString]) -> X<bool> {
	let arg = |i: usize| args.get(i).map(|a| a.as_slice());
	match name {
		b"prefix" | b"suffix" => {
			if super::incompfunc(ex.vp) != 1 {
				return Err(Stop::Fail(Diag::Usage {
					msg: "condition can only be used in completion function".into(),
				}));
			}
			let id = if name == b"prefix" {
				Cvt::PrePat
			} else {
				Cvt::SufPat
			};
			let (na, sa) = if args.len() > 1 {
				let mut n = args[0].to_vec();
				untokenize(&mut n);
				(crate::bash::vm::zsh::arith::mathevali(ex, &n)?, arg(1))
			} else {
				(-1, arg(0))
			};
			with_taken(ex, |ex, c| do_comp_vars(ex, c, id, na, sa, 0, None, false))
		},
		b"after" | b"between" => {
			let sb = if name == b"between" { arg(1) } else { None };
			with_taken(ex, |ex, c| do_comp_vars(ex, c, Cvt::RangePat, 0, arg(0), 0, sb, false))
		},
		_ => Err(Stop::Fail(Diag::Usage {
			msg: format!("unknown condition: -{}", name.as_bstr()).into(),
		})),
	}
}

// ---- compadd
// ---------------------------------------------------------------------

/// zsh `orderopts`: `compadd -o` keywords, minimum abbreviation, flag.
const ORDEROPTS: [(&str, usize, u32); 4] = [
	("nosort", 2, caf::NOSORT),
	("match", 3, caf::MATSORT),
	("numeric", 3, caf::NUMSORT),
	("reverse", 3, caf::REVSORT),
];

/// zsh `parse_ordering(arg, flags)`: `Err` when `arg` holds a word that
/// is no ordering (then `flags`, if given, becomes `CAF_MATSORT`), else
/// the orderings are or-ed into `flags`.
fn parse_ordering(arg: &[u8], flags: Option<&mut u32>) -> Result<(), ()> {
	let mut fl = 0;
	for opt in arg.split(|&c| c == b',') {
		let found = ORDEROPTS
			.iter()
			.rev()
			.find(|&&(name, abbrev, _)| opt.len() >= abbrev && name.as_bytes().starts_with(opt));
		if let Some(&(_, _, f)) = found {
			fl |= f;
		} else {
			if let Some(flags) = flags {
				*flags = caf::MATSORT;
			}
			return Err(());
		}
	}
	if let Some(flags) = flags {
		*flags |= fl;
	}
	Ok(())
}

/// Where a `compadd` option's argument goes (zsh's `sp`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Sp {
	Ign,
	Pre,
	Suf,
	Group,
	Ipre,
	Isuf,
	Ppre,
	Psuf,
	Prpre,
	M,
	Exp,
	Mesg,
	Rems,
	Remf,
	Apar,
	Opar,
	Dpar,
	Disp,
	Oarg,
}

/// The `compadd` builtin (zsh `bin_compadd`).
///
/// # Errors
/// A store failure, a probe (file modes for `-f`), or a substitution to
/// run first.
#[expect(clippy::too_many_lines, reason = "one function, as zsh's bin_compadd")]
pub fn compadd(ctx: &mut Ctx<'_, '_>, argv: &[BString]) -> R {
	if super::incompfunc(ctx.vp) != 1 {
		ctx.usage("can only be called from completion function");
		return done(1);
	}
	let mut dat = Cadata { aflags: caf::MATCH, dummies: -1, ..Cadata::default() };
	let mut mstr: Option<Vec<u8>> = None;
	let mut oarg: Option<Vec<u8>> = None;
	let mut i = 0;
	'opts: while let Some(a) = argv.get(i).filter(|a| a.first() == Some(&b'-')) {
		if a.len() == 1 {
			i += 1;
			break;
		}
		let mut p = 1;
		while p < a.len() {
			let ch = a[p];
			let mut m: Option<Vec<u8>> = None;
			let mut order = 0i32;
			let mut sp: Option<Sp> = None;
			let mut e: &str = "string expected after -";
			match ch {
				b'q' => dat.flags |= cmf::REMOVE,
				b'Q' => dat.aflags |= caf::QUOTE,
				b'C' => dat.aflags |= caf::ALL,
				b'f' => dat.flags |= cmf::FILE,
				b'e' => dat.flags |= cmf::ISPAR,
				b'a' => dat.aflags |= caf::ARRAYS,
				b'k' => dat.aflags |= caf::ARRAYS | caf::KEYS,
				b'F' => sp = Some(Sp::Ign),
				b'n' => dat.flags |= cmf::NOLIST,
				b'U' => dat.aflags &= !caf::MATCH,
				b'P' => sp = Some(Sp::Pre),
				b'S' => sp = Some(Sp::Suf),
				b'J' => {
					sp = Some(Sp::Group);
					e = "group name expected after -";
				},
				b'V' => {
					if dat.group.is_none() {
						dat.aflags |= caf::NOSORT;
					}
					sp = Some(Sp::Group);
					e = "group name expected after -";
				},
				b'1' => {
					if dat.aflags & caf::UNIQCON == 0 {
						dat.aflags |= caf::UNIQALL;
					}
				},
				b'2' => {
					if dat.aflags & caf::UNIQALL == 0 {
						dat.aflags |= caf::UNIQCON;
					}
				},
				b'i' => sp = Some(Sp::Ipre),
				b'I' => sp = Some(Sp::Isuf),
				b'p' => sp = Some(Sp::Ppre),
				b's' => sp = Some(Sp::Psuf),
				b'W' => sp = Some(Sp::Prpre),
				b'M' => {
					sp = Some(Sp::M);
					e = "matching specification expected after -";
				},
				b'X' => sp = Some(Sp::Exp),
				b'x' => sp = Some(Sp::Mesg),
				b'r' => {
					dat.flags |= cmf::REMOVE;
					sp = Some(Sp::Rems);
				},
				b'R' => {
					dat.flags |= cmf::REMOVE;
					sp = Some(Sp::Remf);
					e = "function name expected after -";
				},
				b'A' => {
					sp = Some(Sp::Apar);
					e = "parameter name expected after -";
				},
				b'O' => {
					sp = Some(Sp::Opar);
					e = "parameter name expected after -";
				},
				b'D' => {
					dat.dpar.push(BString::default());
					sp = Some(Sp::Dpar);
					e = "parameter name expected after -";
				},
				b'd' => {
					sp = Some(Sp::Disp);
					e = "parameter name expected after -";
				},
				b'l' => dat.flags |= cmf::DISPLINE,
				b'o' => {
					order = if oarg.is_some() { -1 } else { 1 };
					sp = Some(Sp::Oarg);
				},
				b'E' => {
					if p + 1 < a.len() {
						dat.dummies = atoi(&a[p + 1..]) as i32;
						p = a.len() - 1;
					} else if let Some(n) = argv.get(i + 1) {
						i += 1;
						dat.dummies = atoi(n) as i32;
					} else {
						ctx.usage(format!("number expected after -{}", char::from(ch)));
						return done(1);
					}
					if dat.dummies < 0 {
						ctx.usage(format!("invalid number: {}", dat.dummies));
						return done(1);
					}
				},
				b'-' => {
					i += 1;
					break 'opts;
				},
				_ => {
					ctx.usage(format!("bad option: -{}", char::from(ch)));
					return done(1);
				},
			}
			if let Some(sp) = sp {
				let set_first =
					|v: &[u8], dat: &mut Cadata, oarg: &mut Option<Vec<u8>>, m: &mut Option<Vec<u8>>| {
						let v = BString::from(metafy(v));
						let first = |o: &mut Option<BString>| {
							if o.is_none() {
								*o = Some(v.clone());
							}
						};
						match sp {
							Sp::Ign => first(&mut dat.ign),
							Sp::Pre => first(&mut dat.pre),
							Sp::Suf => first(&mut dat.suf),
							Sp::Group => first(&mut dat.group),
							Sp::Ipre => first(&mut dat.ipre),
							Sp::Isuf => first(&mut dat.isuf),
							Sp::Ppre => first(&mut dat.ppre),
							Sp::Psuf => first(&mut dat.psuf),
							Sp::Prpre => first(&mut dat.prpre),
							Sp::Exp => first(&mut dat.exp),
							Sp::Mesg => first(&mut dat.mesg),
							Sp::Rems => first(&mut dat.rems),
							Sp::Remf => first(&mut dat.remf),
							Sp::Apar => first(&mut dat.apar),
							Sp::Opar => first(&mut dat.opar),
							Sp::Disp => first(&mut dat.disp),
							Sp::Dpar => {
								if let Some(last) = dat.dpar.last_mut() {
									*last = v;
								}
							},
							Sp::M => *m = Some(v.to_vec()),
							Sp::Oarg => {
								if oarg.is_none() {
									*oarg = Some(v.to_vec());
								}
							},
						}
					};
				if p + 1 < a.len() {
					// Pasted argument: -Xfoo.
					set_first(&a[p + 1..], &mut dat, &mut oarg, &mut m);
					let parsed = order == 0 || {
						let o = oarg.clone().unwrap_or_default();
						parse_ordering(&o, (order == 1).then_some(&mut dat.aflags)).is_ok()
					};
					if parsed {
						p = a.len() - 1;
					}
				} else if let Some(next) = argv.get(i + 1) {
					// Argument in a separate word: -X foo.
					i += 1;
					set_first(next, &mut dat, &mut oarg, &mut m);
					if order != 0 {
						let o = oarg.clone().unwrap_or_default();
						if parse_ordering(&o, (order == 1).then_some(&mut dat.aflags)).is_err() {
							i -= 1;
						}
					}
				} else if order == 0 {
					ctx.usage(format!("{e}{}", char::from(ch)));
					return done(1);
				}
				if let Some(m) = m {
					match &mut mstr {
						Some(s) => {
							s.push(b' ');
							s.extend_from_slice(&m);
						},
						None => mstr = Some(m),
					}
				}
			}
			p += 1;
		}
		i += 1;
	}
	let args: Vec<BString> = argv
		.get(i..)
		.unwrap_or_default()
		.iter()
		.map(|a| BString::from(metafy(a)))
		.collect();
	if let Some(ms) = &mstr {
		let mut warns: Vec<Vec<u8>> = Vec::new();
		let r = super::compmatch::parse_cmatcher(Some(ctx.name.as_bytes()), ms, &mut |w: &[u8]| {
			warns.push(w.to_vec());
		});
		for w in warns {
			ctx.usage(String::from_utf8_lossy(&w).into_owned());
		}
		match r {
			Ok(m) => dat.matcher = m,
			Err(()) => return done(1),
		}
	}
	if args.is_empty()
		&& dat.group.is_none()
		&& dat.mesg.is_none()
		&& dat.aflags & (caf::NOSORT | caf::UNIQALL | caf::UNIQCON | caf::ALL) == 0
	{
		return done(1);
	}
	// File modes for `-f` matches (zsh's `ztat` in add_match_data): asked
	// for before anything changes, so a re-run after a probe repeats
	// nothing.
	if dat.flags & cmf::FILE != 0 {
		let r =
			zx(ctx, |ex| with_taken(ex, |ex, c| super::compcore::ztat_paths(ex, c, &dat, &args)))?;
		let paths = match r {
			Ok(p) => p,
			Err(d) => return zerr(ctx, d),
		};
		let mut cache = std::collections::HashMap::with_capacity(paths.len());
		for pb in paths {
			let l = ztat(ctx, &pb, true)?;
			let s = ztat(ctx, &pb, false)?;
			cache.insert(pb, (l, s));
		}
		if let Some(c) = super::comp_mut(ctx.vp) {
			c.core.ztat_cache = cache;
		}
	}
	let r =
		zx(ctx, |ex| with_taken(ex, |ex, c| super::compcore::addmatches(ex, c, &mut dat, &args)))?;
	match r {
		Ok(st) => done(st),
		Err(d) => zerr(ctx, d),
	}
}

/// zsh `ztat(nam, buf, ls)` as a probe: the full `st_mode` of the
/// metafied path, retried with backslashes removed when it fails.
fn ztat(ctx: &mut Ctx<'_, '_>, nam: &[u8], ls: bool) -> Result<Option<u32>, Need> {
	let raw = unmetafy(nam);
	let stat = |ctx: &mut Ctx<'_, '_>, path: Vec<u8>| -> Result<Option<u32>, Need> {
		// Relative to the shell's directory, not the process's.
		let path = crate::bash::vm::probe::absolute(&ctx.vp.cwd, &path);
		Ok(match ctx.probe(Probe::Stat { path, follow: !ls })? {
			ProbeResult::Stat(Some(st)) => Some(st_mode(&st)),
			_ => None,
		})
	};
	if let Some(m) = stat(ctx, raw.clone())? {
		return Ok(Some(m));
	}
	let mut stripped = Vec::with_capacity(raw.len());
	let mut q = 0;
	while q < raw.len() {
		if raw[q] == b'\\' && q + 1 < raw.len() {
			q += 1;
		}
		stripped.push(raw[q]);
		q += 1;
	}
	stat(ctx, stripped)
}

/// `st_mode` with the file type bits (`S_IF*`) of `st`.
const fn st_mode(st: &crate::bash::fs::Stat) -> u32 {
	use crate::bash::fs::StatKind as K;
	let t = match st.kind {
		K::File => 0o100_000,
		K::Dir => 0o040_000,
		K::Symlink => 0o120_000,
		K::Fifo => 0o010_000,
		K::Socket => 0o140_000,
		K::CharDev => 0o020_000,
		K::BlockDev => 0o060_000,
	};
	t | (st.mode & 0o7777)
}
