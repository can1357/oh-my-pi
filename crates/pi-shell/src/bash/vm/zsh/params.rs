//! zsh parameters as zsh code sees them: a port of zsh 5.9's
//! `params.c` value layer (`fetchvalue`, `getstrvalue`, `getarrvalue`,
//! `assignstrvalue`, `setarrvalue`, `assignsparam`, `assignaparam`,
//! `sethparam`, `assignnparam`, `unsetparam`, `createparam`) over the
//! engine's store.
//!
//! # View rules
//!
//! - A zsh array is a stored [`VarValue::Indexed`]: zsh index `i` is key `i −
//!   1` (under `ksharrays` index `i` is key `i`: the same element). Reads fill
//!   gaps with `""`; writes store a dense array, and densifying a sparse (bash)
//!   array reports [`LossyKind::SparseGaps`] once per crossing.
//! - An association is a stored [`VarValue::Assoc`] in zsh's iteration order
//!   ([`super::assoc_order`]).
//! - Integers are stored as zsh prints them (`16#FF`), floats as their shortest
//!   exact text (zsh keeps the `double`) and shown in their style
//!   (`1.500000000e+00`) when read as a string ([`float_display`]), with
//!   [`Attrs::INTEGER`] / [`Attrs::ZSH_FLOAT_E`] / [`Attrs::ZSH_FLOAT_F`] and
//!   the base or precision in the base field; padding (`-L -R -Z`) and case
//!   (`-l -u`) are applied when a substitution reads the value, as zsh's
//!   `getstrvalue` does.
//! - Specials ([`super::specials`]) are views over engine state; a bash
//!   variable named like one is shadowed ([`LossyKind::Shadowed`]).
//!
//! [`Param`] values are raw bytes, as the store keeps them; the strings
//! of a [`Value`] (what substitution works on) are metafied.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::sync::Arc;

use bstr::{BStr, BString, ByteSlice};

use super::{
	arith,
	assoc_order::ZHash,
	math::{self, Assigned, FloatKind, Number},
	specials::{self, Special},
	subscript, text,
};
use crate::bash::{
	diag::Diag,
	ids::Platform,
	pattern::zsh::Pattern,
	store::{Attrs, Key, KeyBuf, LossyKind, MiscKey, Record, Table, VarValue},
	syntax::zsh::tok::{
		DASH, INBRACK, MARKER, POUND, QSTRING, QUEST, STAR, STRING, at, head, metafy, span, tail,
		unmetafy, untokenize,
	},
	vm::{
		builtins::{Ctx, zsh_module},
		expand::{Expander, Stop, X},
		mode,
		state::{self, Level, Var},
	},
	zshopt::ZshOpt,
};

/// zsh's `PM_*` parameter flags (`zsh.h`), with zsh's bit values.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct PmFlags(pub u32);

impl PmFlags {
	/// `PM_ARRAY`.
	pub const ARRAY: Self = Self(1);
	/// `PM_DECLARED`: named by `typeset` (an unset declared parameter).
	pub const DECLARED: Self = Self(1 << 22);
	/// `PM_EFLOAT`.
	pub const EFLOAT: Self = Self(1 << 2);
	/// `PM_EXPORTED`.
	pub const EXPORTED: Self = Self(1 << 12);
	/// `PM_FFLOAT`.
	pub const FFLOAT: Self = Self(1 << 3);
	/// `PM_HASHED`.
	pub const HASHED: Self = Self(1 << 4);
	/// `PM_HIDE`.
	pub const HIDE: Self = Self(1 << 14);
	/// `PM_HIDEVAL`.
	pub const HIDEVAL: Self = Self(1 << 15);
	/// `PM_INTEGER`.
	pub const INTEGER: Self = Self(1 << 1);
	/// `PM_LEFT`.
	pub const LEFT: Self = Self(1 << 5);
	/// `PM_LOCAL`.
	pub const LOCAL: Self = Self(1 << 19);
	/// `PM_LOWER`.
	pub const LOWER: Self = Self(1 << 8);
	/// `PM_READONLY`.
	pub const READONLY: Self = Self(1 << 10);
	/// `PM_REMOVABLE`: here only zsh/param/private's mark of a private
	/// parameter ([`Attrs::ZSH_PRIVATE`]), which also carries `PM_HIDE`,
	/// `PM_SPECIAL` and `PM_RO_BY_DESIGN` (zsh `makeprivate`).
	pub const REMOVABLE: Self = Self(1 << 25);
	/// `PM_RIGHT_B`.
	pub const RIGHT_B: Self = Self(1 << 6);
	/// `PM_RIGHT_Z`.
	pub const RIGHT_Z: Self = Self(1 << 7);
	/// `PM_RO_BY_DESIGN`: a special that is read-only by nature (not shown
	/// by `typeset -p`/`readonly -p`).
	pub const RO_BY_DESIGN: Self = Self(1 << 21);
	/// `PM_SCALAR`.
	pub const SCALAR: Self = Self(0);
	/// `PM_SPECIAL`.
	pub const SPECIAL: Self = Self(1 << 20);
	/// `PM_TAGGED`.
	pub const TAGGED: Self = Self(1 << 11);
	/// `PM_TIED`.
	pub const TIED: Self = Self(1 << 16);
	/// The type bits (zsh `PM_TYPE`).
	const TYPE_MASK: u32 = 0x1f;
	/// `PM_UNIQUE`.
	pub const UNIQUE: Self = Self(1 << 13);
	/// `PM_UNSET`.
	pub const UNSET: Self = Self(1 << 24);
	/// `PM_UPPER`.
	pub const UPPER: Self = Self(1 << 9);

	/// The raw bits (zsh's `PM_*` values).
	pub const fn bits(self) -> u32 {
		self.0
	}

	/// Flags from raw `PM_*` bits.
	pub const fn from_bits(bits: u32) -> Self {
		Self(bits)
	}

	/// Whether every flag of `o` is set.
	pub const fn contains(self, o: Self) -> bool {
		self.0 & o.0 == o.0
	}

	/// Whether any flag of `o` is set.
	pub const fn intersects(self, o: Self) -> bool {
		self.0 & o.0 != 0
	}

	/// Union.
	pub const fn with(self, o: Self) -> Self {
		Self(self.0 | o.0)
	}

	/// Difference.
	pub const fn without(self, o: Self) -> Self {
		Self(self.0 & !o.0)
	}

	/// zsh `PM_TYPE`: the type bits only.
	pub const fn type_bits(self) -> Self {
		Self(self.0 & Self::TYPE_MASK)
	}

	/// The flags a stored variable stands for.
	pub fn from_var(v: &Var) -> Self {
		let a = v.attrs;
		let mut f = match &v.value {
			VarValue::Indexed(_) => Self::ARRAY,
			VarValue::Assoc(_) => Self::HASHED,
			VarValue::Str(_) if a.contains(Attrs::ASSOC) => Self::HASHED,
			VarValue::Str(_) if a.contains(Attrs::INDEXED) => Self::ARRAY,
			VarValue::Str(_) if a.contains(Attrs::ZSH_FLOAT_E) => Self::EFLOAT,
			VarValue::Str(_) if a.contains(Attrs::ZSH_FLOAT_F) => Self::FFLOAT,
			VarValue::Str(_) if a.contains(Attrs::INTEGER) => Self::INTEGER,
			VarValue::Str(_) => Self::SCALAR,
		};
		for (attr, pm) in ATTR_MAP {
			if a.contains(attr) {
				f = f.with(pm);
			}
		}
		if a.contains(Attrs::INVISIBLE) {
			f = f.with(Self::UNSET);
			if a.contains(Attrs::ZSH_DEFAULTED) {
				f = f.with(Self::DECLARED);
			}
		}
		if a.contains(Attrs::ZSH_PRIVATE) {
			f = f
				.with(Self::HIDE)
				.with(Self::SPECIAL)
				.with(Self::RO_BY_DESIGN);
		}
		f
	}

	/// The store attributes for these flags with zsh `width` and `base`.
	pub fn to_attrs(self, width: u16, base: u8) -> Attrs {
		let mut a = match self.type_bits() {
			Self::ARRAY => Attrs::INDEXED,
			Self::HASHED => Attrs::ASSOC,
			Self::INTEGER => Attrs::INTEGER,
			Self::EFLOAT => Attrs::ZSH_FLOAT_E,
			Self::FFLOAT => Attrs::ZSH_FLOAT_F,
			_ => Attrs::NONE,
		};
		for (attr, pm) in ATTR_MAP {
			if self.contains(pm) {
				a = a.with(attr);
			}
		}
		if self.contains(Self::UNSET) {
			a = a.with(Attrs::INVISIBLE);
			if self.contains(Self::DECLARED) {
				a = a.with(Attrs::ZSH_DEFAULTED);
			}
		}
		a.with_width(width).with_base(base)
	}
}

/// Store attributes and the zsh flags they stand for (besides the type).
const ATTR_MAP: [(Attrs, PmFlags); 13] = [
	(Attrs::LOWER, PmFlags::LOWER),
	(Attrs::UPPER, PmFlags::UPPER),
	(Attrs::READONLY, PmFlags::READONLY),
	(Attrs::EXPORT, PmFlags::EXPORTED),
	(Attrs::TRACE, PmFlags::TAGGED),
	(Attrs::ZSH_LEFT, PmFlags::LEFT),
	(Attrs::ZSH_RIGHT_B, PmFlags::RIGHT_B),
	(Attrs::ZSH_RIGHT_Z, PmFlags::RIGHT_Z),
	(Attrs::ZSH_UNIQUE, PmFlags::UNIQUE),
	(Attrs::ZSH_TIED, PmFlags::TIED),
	(Attrs::ZSH_HIDE, PmFlags::HIDE),
	(Attrs::ZSH_HIDEVAL, PmFlags::HIDEVAL),
	(Attrs::ZSH_PRIVATE, PmFlags::REMOVABLE),
];

/// A parameter's value as zsh code sees it (raw bytes).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PValue {
	/// Scalar, integer or float (as text).
	Scalar(BString),
	/// Array, dense, in index order.
	Array(Vec<BString>),
	/// Association, in zsh's iteration order.
	Hash(Vec<(BString, BString)>),
}

/// A zsh parameter (zsh `struct param`), copied out of the shell's state.
#[derive(Clone, Debug)]
pub struct Param {
	/// Name.
	pub name:    BString,
	/// zsh flags (type, attributes, `UNSET`, `SPECIAL`, …).
	pub flags:   PmFlags,
	/// `-L/-R/-Z` width (0: none).
	pub width:   u16,
	/// Integer output base or float precision (0: default).
	pub base:    u8,
	/// Value.
	pub value:   PValue,
	/// The special it is, when zsh code sees one.
	pub special: Option<Special>,
	/// The scope binding it (`state::binding_scope`); `None`: global.
	pub scope:   Option<usize>,
	/// `typeset -T` partner and separator (built-in ties included).
	pub tied:    Option<(BString, u8)>,
	/// The value was not computed: a keyed special
	/// ([`Special::keyed`]) about to be read through one key, which
	/// [`specials::get_elem`] answers alone. [`Param::materialize`]
	/// computes the whole value for every other use.
	pub lazy:    bool,
	/// The stored attributes (association table size included).
	attrs:       Attrs,
}

impl Param {
	/// A new parameter of type `flags` with an empty value.
	fn new(name: &[u8], flags: PmFlags) -> Self {
		let value = match flags.type_bits() {
			PmFlags::ARRAY => PValue::Array(Vec::new()),
			PmFlags::HASHED => PValue::Hash(Vec::new()),
			_ => PValue::Scalar(BString::default()),
		};
		Self {
			name: BString::from(name),
			flags,
			width: 0,
			base: 0,
			value,
			special: None,
			scope: None,
			tied: None,
			lazy: false,
			attrs: flags.to_attrs(0, 0),
		}
	}

	/// The parameter a computed special shows, on the shell's `platform`
	/// (a tie's separator).
	pub fn special(
		name: &[u8],
		flags: PmFlags,
		value: PValue,
		sp: Special,
		platform: Platform,
	) -> Self {
		Self {
			name: BString::from(name),
			flags,
			width: 0,
			base: 0,
			value,
			special: Some(sp),
			scope: None,
			tied: sp
				.tie_partner(platform)
				.map(|(p, sep)| (BString::from(p), sep)),
			lazy: false,
			attrs: flags.to_attrs(0, 0),
		}
	}

	/// A keyed special whose value is computed only when needed
	/// ([`Param::lazy`]).
	fn lazy_special(name: &[u8], sp: Special, platform: Platform) -> Self {
		let mut p = Self::special(name, sp.flags(), PValue::Hash(Vec::new()), sp, platform);
		p.lazy = true;
		p
	}

	/// Compute the whole value of a [`Param::lazy`] parameter.
	///
	/// # Errors
	/// [`Stop::Store`] when the state cannot be read.
	pub fn materialize(&mut self, ex: &mut Expander<'_, '_>) -> X<()> {
		if !self.lazy {
			return Ok(());
		}
		if let Some(sp) = self.special {
			let value = specials::param(ex, sp, &self.name)?.value;
			self.value = value;
		} else if let Some(full) = getparam(ex, &self.name)? {
			// A stored parameter read without its value (an element
			// assigned in place).
			self.value = full.value;
		}
		self.lazy = false;
		Ok(())
	}

	/// The scalar text (no padding or case applied): a scalar's value,
	/// an array's elements joined with spaces, an association's values.
	pub fn text(&self) -> BString {
		match &self.value {
			PValue::Scalar(s) if self.flags.intersects(PmFlags::EFLOAT.with(PmFlags::FFLOAT)) => {
				float_display(self, s)
			},
			PValue::Scalar(s) => s.clone(),
			PValue::Array(a) => BString::from(a.join(&b" "[..])),
			PValue::Hash(h) => {
				let vals: Vec<&[u8]> = h.iter().map(|(_, v)| v.as_slice()).collect();
				BString::from(vals.join(&b" "[..]))
			},
		}
	}

	/// zsh `getstrvalue` with `VALFLAG_SUBST`: [`Self::text`] with the
	/// `-L/-R/-Z` padding and `-l/-u` case applied (raw bytes).
	pub fn strval(&self, mb: bool) -> BString {
		let s = metafy(&self.text());
		BString::from(unmetafy(&pad_and_case(self, s, false, mb)))
	}

	/// The type description of `${(t)x}` and `$parameters` (subst.c's
	/// `wantt` block).
	pub fn type_name(&self) -> BString {
		let f = self.flags;
		let mut s = String::from(match f.type_bits() {
			PmFlags::ARRAY => "array",
			PmFlags::INTEGER => "integer",
			PmFlags::EFLOAT | PmFlags::FFLOAT => "float",
			PmFlags::HASHED => "association",
			_ => "scalar",
		});
		// zsh/complete's specials are locals of the completion function
		// (`makecompparams` at `locallevel + 1`).
		if (self.scope.is_some() && self.special.is_none())
			|| matches!(self.special, Some(Special::Comp(_)))
			|| f.contains(PmFlags::LOCAL)
		{
			s.push_str("-local");
		}
		for (flag, word) in [
			(PmFlags::LEFT, "-left"),
			(PmFlags::RIGHT_B, "-right_blanks"),
			(PmFlags::RIGHT_Z, "-right_zeros"),
			(PmFlags::LOWER, "-lower"),
			(PmFlags::UPPER, "-upper"),
			(PmFlags::READONLY, "-readonly"),
			(PmFlags::TAGGED, "-tag"),
			(PmFlags::TIED, "-tied"),
			(PmFlags::EXPORTED, "-export"),
			(PmFlags::UNIQUE, "-unique"),
			(PmFlags::HIDE, "-hide"),
			(PmFlags::HIDEVAL, "-hideval"),
			(PmFlags::SPECIAL, "-special"),
		] {
			if f.contains(flag) {
				s.push_str(word);
			}
		}
		BString::from(s)
	}

	/// Whether the parameter is set (not `UNSET`).
	pub const fn is_set(&self) -> bool {
		!self.flags.contains(PmFlags::UNSET)
	}

	/// The number an integer or float parameter holds (`None` for other
	/// types).
	pub fn numval(&self) -> Option<Number> {
		let PValue::Scalar(s) = &self.value else {
			return None;
		};
		match self.flags.type_bits() {
			PmFlags::INTEGER => Some(Number::Int(parse_int(s))),
			PmFlags::EFLOAT | PmFlags::FFLOAT => Some(Number::Float(parse_float(s))),
			_ => None,
		}
	}
}

/// zsh `getstrvalue`'s `VALFLAG_SUBST` block on the metafied text `s`:
/// `-L/-R/-Z` padding and `-l/-u` case.
fn pad_and_case(pm: &Param, s: Vec<u8>, cbases: bool, mb: bool) -> Vec<u8> {
	let f = pm.flags;
	let mut s = s;
	if f.intersects(PmFlags::LEFT.with(PmFlags::RIGHT_B).with(PmFlags::RIGHT_Z)) {
		let fwidth = if pm.width > 0 {
			usize::from(pm.width)
		} else {
			text::strlen_chars(&s, mb)
		};
		let lr = PmFlags(f.0 & (PmFlags::LEFT.0 | PmFlags::RIGHT_B.0 | PmFlags::RIGHT_Z.0));
		if lr.contains(PmFlags::LEFT) {
			let mut t = 0;
			if f.contains(PmFlags::RIGHT_Z) {
				while t < s.len() && s[t] == b'0' {
					t += 1;
				}
			} else {
				while t < s.len() && text::iblank(s[t]) {
					t += 1;
				}
			}
			let mut tend = t;
			let mut t0 = 0;
			while t0 < fwidth && tend < s.len() {
				tend += text::charlen(&s, tend, mb);
				t0 += 1;
			}
			let mut out = span(&s, t, tend).to_vec();
			out.resize(out.len() + (fwidth - t0), b' ');
			s = out;
		} else {
			let charlen = text::strlen_chars(&s, mb);
			if charlen < fwidth {
				let mut zero = true;
				let mut valprefend = 0;
				if f.contains(PmFlags::RIGHT_Z) {
					let mut t = 0;
					while t < s.len() && text::iblank(s[t]) {
						t += 1;
					}
					let numeric =
						f.intersects(PmFlags::INTEGER.with(PmFlags::EFLOAT).with(PmFlags::FFLOAT));
					if numeric && s.get(t) == Some(&b'-') {
						t += 1;
					}
					if f.contains(PmFlags::INTEGER) {
						if cbases && s.get(t) == Some(&b'0') && s.get(t + 1) == Some(&b'x') {
							t += 2;
						} else if let Some(h) = tail(&s, t).iter().position(|&c| c == b'#') {
							t += h + 1;
						}
					}
					valprefend = t;
					if t >= s.len() || (!numeric && !s[t].is_ascii_digit()) {
						zero = false;
					}
				}
				let pad = fwidth - charlen;
				let fill = if f.contains(PmFlags::RIGHT_B) || !zero {
					b' '
				} else {
					b'0'
				};
				let mut out = Vec::with_capacity(s.len() + pad);
				out.extend_from_slice(head(&s, valprefend));
				out.resize(out.len() + pad, fill);
				out.extend_from_slice(tail(&s, valprefend));
				s = out;
			} else {
				let mut skip = 0;
				for _ in 0..charlen - fwidth {
					skip += text::charlen(&s, skip, mb);
				}
				s.drain(..skip);
			}
		}
	}
	if f.contains(PmFlags::LOWER) && !f.contains(PmFlags::UPPER) {
		s = text::casemodify(&s, text::CaseMod::Lower, mb);
	} else if f.contains(PmFlags::UPPER) && !f.contains(PmFlags::LOWER) {
		s = text::casemodify(&s, text::CaseMod::Upper, mb);
	}
	s
}

// ---- SCANPM_* / VALFLAG_* / ASSPM_* -----------------------------------------

/// `SCANPM_WANTVALS`.
pub const SCANPM_WANTVALS: u32 = 1;
/// `SCANPM_WANTKEYS`.
pub const SCANPM_WANTKEYS: u32 = 1 << 1;
/// `SCANPM_WANTINDEX`.
pub const SCANPM_WANTINDEX: u32 = 1 << 2;
/// `SCANPM_MATCHKEY`.
pub const SCANPM_MATCHKEY: u32 = 1 << 3;
/// `SCANPM_MATCHVAL`.
pub const SCANPM_MATCHVAL: u32 = 1 << 4;
/// `SCANPM_MATCHMANY`.
pub const SCANPM_MATCHMANY: u32 = 1 << 5;
/// `SCANPM_ASSIGNING`.
pub const SCANPM_ASSIGNING: u32 = 1 << 6;
/// `SCANPM_KEYMATCH`.
pub const SCANPM_KEYMATCH: u32 = 1 << 7;
/// `SCANPM_DQUOTED`.
pub const SCANPM_DQUOTED: u32 = 1 << 8;
/// `SCANPM_ARRONLY`.
pub const SCANPM_ARRONLY: u32 = 1 << 9;
/// `SCANPM_CHECKING`.
pub const SCANPM_CHECKING: u32 = 1 << 10;
/// Not zsh's: a reader that only needs the text of one array element
/// (`paramsubst`) lets [`fetchvalue`] read just that element of a stored
/// array instead of the whole array ([`window_elem`]).
pub const SCANPM_WINDOW: u32 = 1 << 11;
/// `SCANPM_ISVAR_AT`: every bit from 15 up.
pub const SCANPM_ISVAR_AT: u32 = !0 << 15;

/// `VALFLAG_INV`: inverse subscripting.
pub const VALFLAG_INV: u32 = 1;
/// `VALFLAG_EMPTY`: the subscripted range is empty.
pub const VALFLAG_EMPTY: u32 = 2;
/// `VALFLAG_SUBST`: a substitution reads it (padding and case apply).
pub const VALFLAG_SUBST: u32 = 4;

/// `ASSPM_AUGMENT`: `+=`.
pub const ASSPM_AUGMENT: u32 = 1;
/// `ASSPM_WARN_CREATE`.
pub const ASSPM_WARN_CREATE: u32 = 1 << 1;
/// `ASSPM_WARN_NESTED`.
pub const ASSPM_WARN_NESTED: u32 = 1 << 2;
/// `ASSPM_WARN`.
pub const ASSPM_WARN: u32 = ASSPM_WARN_CREATE | ASSPM_WARN_NESTED;
/// `ASSPM_ENV_IMPORT`: the value comes from the environment.
pub const ASSPM_ENV_IMPORT: u32 = 1 << 3;
/// `ASSPM_KEY_VALUE`: the array value holds `[key]=value` triples
/// (`Marker`, key, value).
pub const ASSPM_KEY_VALUE: u32 = 1 << 4;

// ---- helpers
// ------------------------------------------------------------------

/// One zsh option for the vproc the expander runs in.
///
/// # Errors
/// A store failure when the option cannot be read.
pub(crate) fn opt(ex: &mut Expander<'_, '_>, o: ZshOpt) -> X<bool> {
	Ok(state::zsh_option(&mut ex.k.root, ex.cx.store, ex.vp, o)?)
}

/// A zsh error (`zerr`): abort the command.
pub(super) const fn fail(d: Diag) -> Stop {
	Stop::Fail(d)
}

/// `read-only variable: NAME`.
fn readonly(name: &[u8]) -> Stop {
	fail(Diag::Readonly { name: BString::from(unmetafy(name)) })
}

/// `NAME: WHAT`.
fn bad_assign(name: &[u8], what: &'static str) -> Stop {
	fail(Diag::BadAssign { name: BString::from(unmetafy(name)), what: what.into() })
}

/// A subscript error with zsh's text.
pub(super) fn bad_subscript(msg: impl Into<BString>) -> Stop {
	fail(Diag::ZshSubscript { msg: msg.into() })
}

/// zsh `isident`: a name, a run of digits, or either with a balanced
/// `[…]` subscript after it (`s` untokenized or tokenized, metafied);
/// `wide` as for [`text::ident_end`] ([`wide_idents`]).
pub fn isident(s: &[u8], wide: bool) -> bool {
	if s.is_empty() {
		return false;
	}
	let end = if s[0].is_ascii_digit() {
		s.iter()
			.position(|c| !c.is_ascii_digit())
			.unwrap_or(s.len())
	} else {
		text::ident_end(s, 0, wide)
	};
	if end == s.len() {
		return true;
	}
	if end == 0 || !matches!(at(s, end), b'[' | INBRACK) {
		return false;
	}
	match subscript::parse_subscript_end(tail(s, end + 1), false, b']') {
		Some(e) => end + 1 + e + 1 == s.len(),
		None => false,
	}
}

/// The stored variable named `name` as `vp` sees it (declared-but-unset
/// ones included), borrowed, and the scope binding it.
fn read_var<'a>(ex: &'a mut Expander<'_, '_>, name: &[u8]) -> X<(Option<&'a Var>, Option<usize>)> {
	let (var, scope) = state::lookup_declared_scoped(&ex.k.root, ex.cx.store, ex.vp, name)?;
	let var = var.filter(|v| !bash_only(name, v));
	Ok((var, scope.filter(|_| var.is_some())))
}

/// Whether a stored variable is one the bash side keeps for its own
/// options (the read-only `SHELLOPTS` and `BASHOPTS` it rewrites after
/// every option change): zsh has no such parameters.
const fn bash_only(name: &[u8], v: &Var) -> bool {
	matches!(name, b"SHELLOPTS" | b"BASHOPTS") && v.attrs.contains(Attrs::READONLY)
}

/// A stored indexed array read the zsh way: dense, gaps filled with `""`;
/// `true` when it had gaps.
fn dense(items: &[(i64, BString)]) -> (Vec<BString>, bool) {
	let Some(&(last, _)) = items.last() else {
		return (Vec::new(), false);
	};
	let len = usize::try_from(last + 1).unwrap_or(0);
	if items.len() == len && items.first().is_some_and(|e| e.0 == 0) {
		return (items.iter().map(|e| e.1.clone()).collect(), false);
	}
	let mut out = vec![BString::default(); len];
	for (k, v) in items {
		if let Ok(i) = usize::try_from(*k)
			&& i < len
		{
			out[i] = v.clone();
		}
	}
	(out, true)
}

/// Change the join character of the `typeset -T` tie whose scalar is
/// `scalar` (zsh `typeset_single`'s `tdp->joinchar = joinchar`); `false`
/// when it has no such tie or already uses `sep`.
///
/// # Errors
/// [`Stop::Store`] when the store fails.
pub fn set_tie_sep(ex: &mut Expander<'_, '_>, scalar: &[u8], sep: u8) -> X<bool> {
	let mut words = match state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ZshTies))? {
		Some(Record::Words(w)) => w.clone(),
		_ => return Ok(false),
	};
	let Some(t) = words
		.as_chunks_mut::<3>()
		.0
		.iter_mut()
		.find(|t| t[0].as_slice() == scalar)
	else {
		return Ok(false);
	};
	if t[2].first() == Some(&sep) {
		return Ok(false);
	}
	t[2] = BString::from(vec![sep]);
	state::store_record(
		&mut ex.k.root,
		ex.cx.store,
		ex.vp,
		KeyBuf::Misc(MiscKey::ZshTies),
		Some(Record::Words(words)),
	);
	Ok(true)
}

/// The partner and separator of a `typeset -T` tie of `name`.
fn tie_of(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<(BString, BString, u8)>> {
	let Some(Record::Words(words)) = state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ZshTies))?
	else {
		return Ok(None);
	};
	for t in words.as_chunks::<3>().0 {
		if t[0].as_slice() == name || t[1].as_slice() == name {
			let sep = t[2].first().copied().unwrap_or(b':');
			return Ok(Some((t[0].clone(), t[1].clone(), sep)));
		}
	}
	Ok(None)
}

/// The parameter for a stored variable.
fn param_of(
	name: &[u8],
	var: &Var,
	scope: Option<usize>,
	plain: Option<Special>,
	type_only: bool,
) -> Param {
	let flags = PmFlags::from_var(var);
	let value = match &var.value {
		_ if type_only => match flags.type_bits() {
			PmFlags::ARRAY => PValue::Array(Vec::new()),
			PmFlags::HASHED => PValue::Hash(Vec::new()),
			_ => PValue::Scalar(BString::default()),
		},
		VarValue::Str(s) => {
			if flags.type_bits() == PmFlags::ARRAY {
				PValue::Array(Vec::new())
			} else if flags.type_bits() == PmFlags::HASHED {
				PValue::Hash(Vec::new())
			} else {
				PValue::Scalar(s.clone())
			}
		},
		VarValue::Indexed(items) => PValue::Array(dense(items).0),
		VarValue::Assoc(items) => PValue::Hash(items.to_vec()),
	};
	let mut p = Param {
		name: BString::from(name),
		flags,
		width: var.attrs.width(),
		base: if flags.type_bits() == PmFlags::HASHED {
			0
		} else {
			var.attrs.base()
		},
		value,
		special: None,
		scope,
		tied: None,
		lazy: false,
		attrs: var.attrs,
	};
	if let Some(sp) = plain {
		p.flags = p
			.flags
			.with(sp.flags().without(PmFlags(PmFlags::TYPE_MASK)));
		if p.flags.type_bits() == PmFlags::SCALAR {
			p.flags = p.flags.with(sp.flags().type_bits());
		}
		p.special = Some(sp);
	}
	p
}

/// Report that zsh code used `name`, a special that hides a set bash
/// variable of the same name.
fn shadowed(ex: &mut Expander<'_, '_>, name: &[u8]) {
	let what = format!("value of bash variable `{}' (shadowed by the zsh special)", name.as_bstr());
	mode::report_lossy(ex.k, ex.cx, ex.vp, ex.line, LossyKind::Shadowed, what);
}

// ---- readers
// ------------------------------------------------------------------

/// zsh `paramtab->getnode`: the parameter `name` as zsh code sees it,
/// specials included; a declared-but-unset one has [`PmFlags::UNSET`].
///
/// # Errors
/// [`Stop::Store`] when the store fails.
pub fn getparam(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<Param>> {
	getparam_in(ex, name, Defer::None)
}

/// [`getparam`] for a read through one key: a keyed special
/// ([`Special::keyed`]) comes back [`Param::lazy`], its whole value not
/// computed (`$+functions[f]` must not regenerate every function body).
///
/// # Errors
/// [`Stop::Store`] when the store fails.
pub fn getparam_lazy(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<Param>> {
	getparam_in(ex, name, Defer::Keyed)
}

/// The value of key `key` of the ordinary association `name` as stored,
/// without reading the rest of it; `None` when the key (or the
/// association) is absent.
///
/// # Errors
/// [`Stop::Store`] when the store fails.
pub(super) fn stored_elem(
	ex: &mut Expander<'_, '_>,
	name: &[u8],
	key: &[u8],
) -> X<Option<BString>> {
	Ok(match read_var(ex, name)?.0.map(|v| &v.value) {
		Some(VarValue::Assoc(items)) => items.get(key).cloned(),
		_ => None,
	})
}

/// [`getparam`] for its type and flags only (zsh/parameter's
/// `$parameters`): stored values are not copied and no computed special's
/// value is computed (each keystroke
/// of a highlighter scanning `$parameters` must not list the history).
///
/// # Errors
/// [`Stop::Store`] when the store fails.
pub fn getparam_type(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<Param>> {
	getparam_in(ex, name, Defer::All)
}

/// Which computed specials [`getparam_in`] leaves [`Param::lazy`].
#[derive(Clone, Copy, PartialEq, Eq)]
enum Defer {
	/// None: every value is computed.
	None,
	/// Keyed specials ([`Special::keyed`]).
	Keyed,
	/// Every computed special, and the values of stored parameters.
	All,
	/// Only stored parameter values; computed getters still run.
	Stored,
}

fn getparam_in(ex: &mut Expander<'_, '_>, name: &[u8], defer: Defer) -> X<Option<Param>> {
	let mut sp = specials::as_started(ex, specials::lookup(name), name)?;
	// The editor's parameters exist while shell code runs for the line
	// editor (zsh `makezleparams` locals); otherwise the names are plain.
	if let Some(Special::Zle(z)) = sp
		&& !crate::bash::vm::zle::params::visible(ex.vp, z)
	{
		sp = None;
	}
	// zsh/complete's exist while a completion function runs.
	if let Some(Special::Comp(_)) = sp
		&& !crate::bash::vm::zle::comp::complete::visible(ex.vp)
	{
		sp = None;
	}
	// A module's parameter exists while its module provides it (and
	// autoloads the module when it is an autoload stub).
	let mut pstate = zsh_module::ParamState::default();
	if sp.is_some_and(|s| s.module().is_some()) {
		match zsh_module::param_state(ex, name)? {
			Some(s) => pstate = s,
			None => sp = None,
		}
	}
	let (var, scope) = read_var(ex, name)?;
	let attrs = var.map(|v| v.attrs);
	// Only ordinary parameters need the stored value. A computed special
	// uses its backing binding's attributes, never a copy of its value.
	let hide = !pstate.unhidden && sp.is_some_and(|s| s.flags().contains(PmFlags::HIDE));
	let hidden = attrs.is_some_and(|a| a.contains(Attrs::ZSH_HIDE) || (hide && scope.is_some()));
	// A read of one key leaves an ordinary association in the store
	// ([`stored_elem`] looks the key up there).
	let mut keyed_stored = false;
	let stored = if sp.is_none_or(Special::is_plain) || hidden {
		var.map(|v| {
			keyed_stored =
				defer == Defer::Keyed && sp.is_none() && matches!(v.value, VarValue::Assoc(_));
			let mut p = param_of(
				name,
				v,
				scope,
				sp.filter(|s| s.is_plain() && !v.attrs.contains(Attrs::ZSH_HIDE)),
				matches!(defer, Defer::All | Defer::Stored) || keyed_stored,
			);
			p.lazy = keyed_stored;
			p
		})
	} else {
		None
	};
	// An autoload stub of a parameter no module of the engine defines
	// (`zmodload -ap`): loading its module fails to define it.
	if sp.is_none() && attrs.is_none() && zsh_module::param_stub(ex.cx.store, ex.vp, name)? {
		zsh_module::param_present(ex, name)?;
		return Ok(None);
	}
	if let Some(sp) = sp
		&& !sp.is_plain()
	{
		// zsh `typeset_single` makes a local of a `PM_HIDE` special's name
		// an ordinary parameter hiding it (from the functions it calls too).
		if !hidden {
			// `local SECONDS`: the special itself, local to that scope.
			let local = attrs.is_some_and(|a| a.contains(Attrs::ZSH_LOCAL_SPECIAL));
			if attrs.is_some() && !local && !sp.is_backed_by(name) {
				shadowed(ex, name);
			}
			let mut p = if pstate.unset {
				// `unset` kept the special, `PM_UNSET`.
				let flags = sp.flags().with(PmFlags::UNSET);
				let value = match flags.type_bits() {
					PmFlags::ARRAY => PValue::Array(Vec::new()),
					PmFlags::HASHED => PValue::Hash(Vec::new()),
					_ => PValue::Scalar(BString::default()),
				};
				Param::special(name, flags, value, sp, ex.k.engine.config().platform)
			} else if (defer == Defer::All && sp != Special::Seconds)
				|| (defer == Defer::Keyed && sp.keyed())
			{
				Param::lazy_special(name, sp, ex.k.engine.config().platform)
			} else {
				specials::param(ex, sp, name)?
			};
			if !hide {
				p.flags = p.flags.without(PmFlags::HIDE);
			}
			if local {
				p.flags = p.flags.with(PmFlags::LOCAL);
				p.scope = scope;
			}
			// `typeset -U path`: the array side of a special tie is unique,
			// marked on the record of its scalar, which holds its value.
			if let Special::TiedArray(t) = sp
				&& state::lookup(&ex.k.root, ex.cx.store, ex.vp, t.scalar().as_bytes())?
					.is_some_and(|v| v.attrs.contains(Attrs::ZSH_UNIQUE))
			{
				p.flags = p.flags.with(PmFlags::UNIQUE);
			}
			return Ok(Some(p));
		}
	}
	let Some(mut p) = stored else {
		if let Some(sp @ Special::Version(_)) = sp {
			let p = specials::param(ex, sp, name)?;
			return Ok(Some(Param { special: None, ..p }));
		}
		return Ok(None);
	};
	// A local hiding a special (`typeset -h`) is an ordinary parameter.
	let sp = sp.filter(|_| !p.attrs.contains(Attrs::ZSH_HIDE));
	// On a special tie's scalar the mark is its array's ([`set_flags`]):
	// `PATH=…` keeps its words.
	if matches!(sp, Some(Special::TiedScalar(_))) {
		p.flags = p.flags.without(PmFlags::UNIQUE);
	}
	if p.attrs.contains(Attrs::ZSH_TIED)
		&& let Some((scalar, array, sep)) = tie_of(ex, name)?
	{
		let partner = if scalar.as_slice() == name {
			array
		} else {
			scalar
		};
		p.tied = Some((partner, sep));
	}
	if let Some(sp) = sp
		&& let Some((partner, sep)) = sp.tie_partner(ex.k.engine.config().platform)
	{
		// zsh/watch's `WATCH` is tied without `PM_TIED`.
		p.flags = p
			.flags
			.with(PmFlags::from_bits(sp.flags().bits() & PmFlags::TIED.bits()));
		p.tied = Some((BString::from(partner), sep));
	}
	Ok(Some(p))
}

/// zsh `getsparam`: the scalar value of `name` (may carry a subscript),
/// raw; `None` when unset.
///
/// # Errors
/// A subscript error, a parked substitution, a store failure.
pub fn getsparam(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<BString>> {
	let s = metafy(name);
	let mut pos = 0;
	let Some(mut v) = fetchvalue(ex, &s, &mut pos, 1, 0)? else {
		return Ok(None);
	};
	Ok(Some(BString::from(unmetafy(&v.getstrvalue(ex)?))))
}

/// zsh `getaparam`: the elements of array `name`, raw; `None` when it is
/// no array.
///
/// # Errors
/// As [`getsparam`].
pub fn getaparam(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<Vec<BString>>> {
	let s = metafy(name);
	let mut pos = 0;
	let Some(mut v) = fetchvalue(ex, &s, &mut pos, 1, 0)? else {
		return Ok(None);
	};
	if v.isarr == 0 || v.pm.flags.type_bits() != PmFlags::ARRAY {
		return Ok(None);
	}
	Ok(Some(
		v.getarrvalue(ex)?
			.iter()
			.map(|e| BString::from(unmetafy(e)))
			.collect(),
	))
}

/// Every parameter zsh code sees (globals, the locals visible, specials),
/// sorted by name.
///
/// # Errors
/// [`Stop::Store`] when the store fails.
pub fn scan(ex: &mut Expander<'_, '_>) -> X<Vec<Param>> {
	let names = scan_names(ex)?;
	let mut out = Vec::with_capacity(names.len());
	for n in names {
		if let Some(p) = getparam(ex, &n)? {
			out.push(p);
		}
	}
	Ok(out)
}

/// The names [`scan`] visits, sorted and unique; `$parameters` uses it to
/// list every parameter without computing its own value.
///
/// # Errors
/// [`Stop::Store`] when the store fails.
pub fn scan_names(ex: &mut Expander<'_, '_>) -> X<Vec<BString>> {
	let recs = state::scan_declared(&ex.k.root, ex.cx.store, ex.vp, Table::Var)?;
	let mut names: Vec<BString> = recs
		.into_iter()
		.filter_map(|(k, _)| match k {
			KeyBuf::Var(n) => Some(n),
			_ => None,
		})
		.collect();
	names.extend(super::text::word_list(specials::NAMES).map(BString::from));
	names.sort();
	names.dedup();
	Ok(names)
}

// ---- values
// -------------------------------------------------------------------

/// An association element a subscript selected (zsh replaces `v->pm` by the
/// element's own parameter).
#[derive(Clone, Debug)]
pub struct HashElem {
	/// The key (raw).
	pub key:   BString,
	/// Its value (raw); `None` when the key is not set.
	pub value: Option<BString>,
}

/// A compiled subscript pattern of a hash scan (zsh's `scanprog` /
/// `scanstr`).
#[derive(Clone)]
pub(super) struct Scan {
	/// The pattern keys or values are matched against.
	pub prog: Option<Arc<Pattern>>,
	/// `(k)`/`(K)`: the subject keys-as-patterns are matched against.
	pub text: Vec<u8>,
}

/// zsh `struct value`: a parameter and the part of it a subscript chose.
#[derive(Clone)]
pub struct Value {
	/// The parameter.
	pub pm:          Param,
	/// The association element a subscript chose.
	pub elem:        Option<HashElem>,
	/// zsh `isarr` (`SCANPM_*` bits; 0: a scalar view).
	pub isarr:       u32,
	/// `VALFLAG_*`.
	pub flags:       u32,
	/// Start of the range (0-based, possibly negative from the end).
	pub start:       i64,
	/// End of the range (exclusive; -1: to the end).
	pub end:         i64,
	/// The whole array, metafied (zsh's cached `v->arr`).
	arr:             Option<Vec<Vec<u8>>>,
	/// The pattern of a hash scan.
	pub(super) scan: Option<Scan>,
}

impl Value {
	/// A value over the whole of `pm`.
	pub const fn of(pm: Param) -> Self {
		Self { pm, elem: None, isarr: 0, flags: 0, start: 0, end: -1, arr: None, scan: None }
	}

	/// A temporary parameter holding `val` (subst.c's
	/// `createparam(nulstring, …)` for subscripts of expression values).
	pub fn temp_scalar(val: &[u8]) -> Self {
		let mut pm = Param::new(b"", PmFlags::SCALAR);
		pm.value = PValue::Scalar(BString::from(unmetafy(val)));
		Self::of(pm)
	}

	/// A temporary array parameter holding `items` (metafied).
	pub fn temp_array(items: &[Vec<u8>]) -> Self {
		let mut pm = Param::new(b"", PmFlags::ARRAY);
		pm.value = PValue::Array(items.iter().map(|e| BString::from(unmetafy(e))).collect());
		let mut v = Self::of(pm);
		v.arr = Some(items.to_vec());
		v
	}

	/// The parameter's flags, or a hash element's (`SCALAR`, `UNSET` when
	/// missing).
	pub const fn pm_flags(&self) -> PmFlags {
		match &self.elem {
			Some(e) if e.value.is_none() => PmFlags::UNSET,
			Some(_) => PmFlags::SCALAR,
			None => self.pm.flags,
		}
	}

	/// Cache zsh `getvaluearr`: the whole array (metafied), or the
	/// association scan its flags select. Scalar views leave it absent.
	fn ensure_valuearr(&mut self, ex: &mut Expander<'_, '_>) -> X<()> {
		if self.arr.is_some() || self.elem.is_some() {
			return Ok(());
		}
		let arr = match &self.pm.value {
			PValue::Array(a) if self.pm.flags.type_bits() == PmFlags::ARRAY => {
				a.iter().map(|e| metafy(e)).collect()
			},
			PValue::Hash(h) if self.pm.flags.type_bits() == PmFlags::HASHED => {
				let a = self.paramvalarr(ex, h)?;
				self.start = 0;
				self.end = i64::try_from(a.len()).unwrap_or(i64::MAX) + 1;
				a
			},
			_ => return Ok(()),
		};
		self.arr = Some(arr);
		Ok(())
	}

	/// zsh `paramvalarr` + `scanparamvals` over the entries `h`.
	fn paramvalarr(&self, ex: &mut Expander<'_, '_>, h: &[(BString, BString)]) -> X<Vec<Vec<u8>>> {
		let flags = self.isarr;
		if flags & (SCANPM_MATCHVAL | SCANPM_MATCHKEY | SCANPM_KEYMATCH) == 0 {
			// Plain key/value iteration needs no pattern environment, and
			// value-only reads never need to encode the keys.
			let keys = flags & SCANPM_WANTKEYS != 0;
			let vals = !keys || flags & SCANPM_WANTVALS != 0;
			let mut out = Vec::with_capacity(h.len() * (usize::from(keys) + usize::from(vals)));
			for (k, v) in h {
				if keys {
					out.push(metafy(k));
				}
				if vals {
					out.push(metafy(v));
				}
			}
			return Ok(out);
		}
		let env = super::zpattern::char_env(ex)?;
		let opts = super::zpattern::opts(ex)?;
		let mut out: Vec<Vec<u8>> = Vec::new();
		for (k, val) in h {
			if !out.is_empty()
				&& flags & SCANPM_MATCHMANY == 0
				&& flags & (SCANPM_MATCHVAL | SCANPM_MATCHKEY | SCANPM_KEYMATCH) != 0
			{
				break;
			}
			let key = metafy(k);
			if flags & SCANPM_KEYMATCH != 0 {
				let mut tmp = key.clone();
				crate::bash::pattern::zsh::tokenize(&mut tmp);
				crate::bash::pattern::zsh::remnulargs(&mut tmp);
				let subject = self.scan.as_ref().map_or_default(|s| s.text.as_slice());
				match Pattern::compile(&tmp, crate::bash::pattern::zsh::PatFlags::NONE, &opts) {
					Ok(p) if p.matches(subject, &env.env()) => {},
					_ => continue,
				}
			} else if flags & SCANPM_MATCHKEY != 0 {
				let ok = self
					.scan
					.as_ref()
					.and_then(|s| s.prog.as_ref())
					.is_some_and(|p| p.matches(&key, &env.env()));
				if !ok {
					continue;
				}
			}
			if flags & SCANPM_WANTKEYS != 0 {
				out.push(key);
				if flags & (SCANPM_WANTVALS | SCANPM_MATCHVAL) == 0 {
					continue;
				}
			}
			let value = metafy(val);
			if flags & SCANPM_MATCHVAL != 0 {
				let ok = self
					.scan
					.as_ref()
					.and_then(|s| s.prog.as_ref())
					.is_some_and(|p| p.matches(&value, &env.env()));
				if ok {
					if flags & SCANPM_WANTVALS != 0 || flags & SCANPM_WANTKEYS == 0 {
						out.push(value);
					}
				} else if flags & SCANPM_WANTKEYS != 0 {
					out.pop();
				}
			} else {
				out.push(value);
			}
		}
		Ok(out)
	}

	/// zsh `getstrvalue`: the scalar view (metafied).
	///
	/// # Errors
	/// A store failure or an option read failing.
	pub fn getstrvalue(&mut self, ex: &mut Expander<'_, '_>) -> X<Vec<u8>> {
		if self.flags & VALFLAG_INV != 0 && self.pm.flags.type_bits() != PmFlags::HASHED {
			return Ok(self.start.to_string().into_bytes());
		}
		let mut s: Vec<u8> = if let Some(e) = &self.elem {
			metafy(e.value.as_ref().map_or(&[][..], |v| &v[..]))
		} else {
			match self.pm.flags.type_bits() {
				PmFlags::HASHED | PmFlags::ARRAY => {
					// A scalar indexed-array view needs one element, not a
					// metafied copy of every element and an array cache.
					if self.pm.flags.type_bits() == PmFlags::ARRAY
						&& self.isarr == 0
						&& self.arr.is_none()
						&& let PValue::Array(a) = &self.pm.value
					{
						if self.start < 0 {
							self.start += i64::try_from(a.len()).unwrap_or(0);
						}
						return Ok(usize::try_from(self.start)
							.ok()
							.and_then(|i| a.get(i))
							.map_or_else(Vec::new, |s| metafy(s)));
					}
					self.ensure_valuearr(ex)?;
					let ss = self.arr.as_deref().unwrap_or_default();
					if self.isarr != 0 {
						let ifs = ifs(ex)?;
						return Ok(text::sepjoin(ss, None, ifs.as_deref(), mb(ex)?));
					}
					if self.start < 0 {
						self.start += i64::try_from(ss.len()).unwrap_or(0);
					}
					let at = usize::try_from(self.start).ok();
					return Ok(at.and_then(|i| ss.get(i)).cloned().unwrap_or_default());
				},
				_ => match &self.pm.value {
					PValue::Scalar(s)
						if self
							.pm
							.flags
							.intersects(PmFlags::EFLOAT.with(PmFlags::FFLOAT)) =>
					{
						metafy(&float_display(&self.pm, s))
					},
					PValue::Scalar(s) => metafy(s),
					_ => Vec::new(),
				},
			}
		};
		let mb = mb(ex)?;
		if self.flags & VALFLAG_SUBST != 0 && self.elem.is_none() {
			let cbases = opt(ex, ZshOpt::Cbases)?;
			s = pad_and_case(&self.pm, s, cbases, mb);
		}
		Ok(self.slice_str(s, mb))
	}

	/// The `[start, end)` character range of a scalar view (the tail of
	/// zsh `getstrvalue`).
	fn slice_str(&mut self, s: Vec<u8>, mb: bool) -> Vec<u8> {
		if self.start == 0 && self.end == -1 {
			return s;
		}
		let len = i64::try_from(s.len()).unwrap_or(i64::MAX);
		if self.start < 0 {
			self.start = (self.start + len).max(0);
		}
		if self.end < 0 {
			self.end += len;
			if self.end >= 0 {
				let e = usize::try_from(self.end).unwrap_or(0);
				if e < s.len() {
					self.end += i64::try_from(text::charlen(&s, e, mb)).unwrap_or(1);
				}
			}
		}
		if self.start > len || self.end <= self.start {
			return Vec::new();
		}
		let a = usize::try_from(self.start).unwrap_or(0);
		let b = usize::try_from(self.end.min(len)).unwrap_or(0);
		span(&s, a, b).to_vec()
	}

	/// zsh `getarrvalue`: the array view (metafied).
	///
	/// # Errors
	/// As [`Self::getstrvalue`].
	pub fn getarrvalue(&mut self, ex: &mut Expander<'_, '_>) -> X<Vec<Vec<u8>>> {
		if self.isarr == 0 && self.pm.flags.contains(PmFlags::UNSET) && self.elem.is_none() {
			return Ok(Vec::new());
		}
		if self.flags & VALFLAG_INV != 0 {
			return Ok(vec![self.start.to_string().into_bytes()]);
		}
		self.ensure_valuearr(ex)?;
		let scalar = if self.arr.is_none() {
			vec![self.getstrvalue(ex)?]
		} else {
			Vec::new()
		};
		let s = self.arr.as_deref().unwrap_or(&scalar);
		if self.start == 0 && self.end == -1 {
			return Ok(s.to_vec());
		}
		let n = i64::try_from(s.len()).unwrap_or(i64::MAX);
		if self.start < 0 {
			self.start += n;
		}
		if self.end < 0 {
			self.end += n + 1;
		}
		let empties = |k: i64| vec![Vec::new(); usize::try_from(k.max(0)).unwrap_or(0)];
		Ok(if self.end <= self.start {
			Vec::new()
		} else if self.start < 0 {
			empties(1)
		} else if n <= self.start {
			empties(self.end - (self.start + 1))
		} else {
			let a = usize::try_from(self.start).unwrap_or(0);
			let b = usize::try_from(self.end.min(n)).unwrap_or(0);
			span(s, a, b).to_vec()
		})
	}

	/// zsh `getnumvalue`.
	///
	/// # Errors
	/// A math error or a store failure.
	pub fn getnumvalue(&mut self, ex: &mut Expander<'_, '_>) -> X<Number> {
		if self.flags & VALFLAG_INV != 0 {
			return Ok(Number::Int(self.start));
		}
		if self.isarr != 0 {
			let a = self.getarrvalue(ex)?;
			let ifs = ifs(ex)?;
			let s = text::sepjoin(&a, None, ifs.as_deref(), mb(ex)?);
			return arith::matheval(ex, &s);
		}
		if self.elem.is_none() {
			match self.pm.flags.type_bits() {
				PmFlags::INTEGER => {
					if let PValue::Scalar(s) = &self.pm.value {
						return Ok(Number::Int(parse_int(s)));
					}
				},
				PmFlags::EFLOAT | PmFlags::FFLOAT => {
					if let PValue::Scalar(s) = &self.pm.value {
						return Ok(Number::Float(parse_float(s)));
					}
				},
				_ => {},
			}
		}
		let s = self.getstrvalue(ex)?;
		arith::matheval(ex, &s)
	}
}

/// The value of a stored integer (`[base#]digits`, `0x…`), 0 when it does
/// not parse.
pub fn parse_int(s: &[u8]) -> i64 {
	let s = s.trim_with(|c| c == ' ');
	let (neg, s) = match s.split_first() {
		Some((b'-', r)) => (true, r),
		_ => (false, s),
	};
	let (base, digits) = if let Some(h) = s.iter().position(|&c| c == b'#') {
		let b = std::str::from_utf8(head(s, h))
			.ok()
			.and_then(|b| b.parse::<u32>().ok())
			.unwrap_or(10);
		(b, tail(s, h + 1))
	} else if s.starts_with(b"0x") || s.starts_with(b"0X") {
		(16, tail(s, 2))
	} else {
		(10, s)
	};
	let mut v: i64 = 0;
	for &c in digits {
		if c == b'_' {
			continue;
		}
		let Some(d) = (c as char).to_digit(36).filter(|&d| d < base.clamp(2, 36)) else {
			break;
		};
		v = v.wrapping_mul(i64::from(base)).wrapping_add(i64::from(d));
	}
	if neg { v.wrapping_neg() } else { v }
}

/// The value of a stored float, 0.0 when it does not parse.
fn parse_float(s: &[u8]) -> f64 {
	std::str::from_utf8(s)
		.ok()
		.and_then(|s| s.trim().parse().ok())
		.unwrap_or(0.0)
}

/// `$IFS` (metafied) for joins; `None` when unset.
pub(super) fn ifs(ex: &mut Expander<'_, '_>) -> X<Option<Vec<u8>>> {
	Ok(state::lookup(&ex.k.root, ex.cx.store, ex.vp, b"IFS")?
		.map(|v| metafy(v.as_scalar().unwrap_or_default())))
}

/// The separator classes of `$IFS` (zsh's default when unset).
pub(super) fn seps(ex: &mut Expander<'_, '_>) -> X<text::Seps> {
	let mb = mb(ex)?;
	Ok(match ifs(ex)? {
		Some(v) => text::Seps::new(&v, mb),
		None => text::Seps::new(text::DEFAULT_IFS, mb),
	})
}

/// zsh `isset(MULTIBYTE)` in a UTF-8 locale: characters are UTF-8
/// sequences (zsh's `MB_METACHARLEN` and friends decode them) rather than
/// bytes.
///
/// # Errors
/// A store failure reading the option.
pub fn mb_in(
	k: &mut crate::bash::vm::Kernel,
	store: &mut dyn crate::bash::store::StateStore,
	vp: &crate::bash::vm::proc::Vproc,
) -> Result<bool, crate::bash::store::StoreError> {
	Ok(state::zsh_option(&mut k.root, store, vp, ZshOpt::Multibyte)?
		&& crate::bash::vm::locale::is_utf8(k, store, vp))
}

/// [`mb_in`] where a store failure cannot stop the caller: it is recorded
/// on the kernel and reads as off.
pub fn mb_quiet(
	k: &mut crate::bash::vm::Kernel,
	store: &mut dyn crate::bash::store::StateStore,
	vp: &crate::bash::vm::proc::Vproc,
) -> bool {
	mb_in(k, store, vp).unwrap_or_else(|e| {
		k.fail(e);
		false
	})
}

/// [`mb_in`] for the expander.
///
/// # Errors
/// A store failure reading the option.
pub fn mb(ex: &mut Expander<'_, '_>) -> X<bool> {
	Ok(mb_in(ex.k, ex.cx.store, ex.vp)?)
}

/// Whether identifiers admit non-ASCII alphanumerics (zsh `itype_end`
/// with `IIDENT`): [`mb_in`] without `POSIX_IDENTIFIERS`.
///
/// # Errors
/// A store failure reading an option.
pub fn wide_idents_in(
	k: &mut crate::bash::vm::Kernel,
	store: &mut dyn crate::bash::store::StateStore,
	vp: &crate::bash::vm::proc::Vproc,
) -> Result<bool, crate::bash::store::StoreError> {
	Ok(mb_in(k, store, vp)? && !state::zsh_option(&mut k.root, store, vp, ZshOpt::Posixidentifiers)?)
}

/// The collation zsh sorts with (`strcoll` in the `LC_COLLATE` locale:
/// the first of `LC_ALL`, `LC_COLLATE` and `LANG` set and non-empty);
/// `None` for the `C` locale (bytes compare). A store failure is recorded
/// on the root and reads as `C`.
pub fn collator_in(
	root: &mut state::Root,
	store: &mut dyn crate::bash::store::StateStore,
	vp: &crate::bash::vm::proc::Vproc,
) -> Option<crate::sys::langinfo::Collator> {
	for name in [&b"LC_ALL"[..], b"LC_COLLATE", b"LANG"] {
		let found = state::lookup(root, store, vp, name).map(|v| {
			v.and_then(|v| v.as_scalar())
				.filter(|s| !s.is_empty())
				.map(|s| s.to_vec())
		});
		match found {
			Ok(Some(s)) => return crate::sys::langinfo::Collator::new(&s),
			Ok(None) => {},
			Err(e) => {
				root.fail(e);
				return None;
			},
		}
	}
	None
}

/// [`collator_in`] for the expander.
pub fn collator(ex: &mut Expander<'_, '_>) -> Option<crate::sys::langinfo::Collator> {
	collator_in(&mut ex.k.root, ex.cx.store, ex.vp)
}

/// The history character `quotestring` quotes ([`text::QuoteOpts::bang`]
/// and [`text::QuoteOpts::bang_special`]): zsh's `bangchar` under
/// `BANGHIST` (0 without), and whether it is `ISPECIAL` (zsh
/// `inittyptab`'s `ZTF_BANGCHAR`: an interactive shell reading its
/// standard input). A store failure is recorded on the root and reads as
/// no history character.
pub fn bang_quoting(
	root: &mut state::Root,
	store: &mut dyn crate::bash::store::StateStore,
	vp: &crate::bash::vm::proc::Vproc,
) -> (u8, bool) {
	fn read(
		root: &mut state::Root,
		store: &mut dyn crate::bash::store::StateStore,
		vp: &crate::bash::vm::proc::Vproc,
	) -> Result<(u8, bool), crate::bash::store::StoreError> {
		if !state::zsh_option(root, store, vp, ZshOpt::Banghist)? {
			return Ok((0, false));
		}
		let bang = crate::bash::vm::builtins::history::zsh::histchars_param(root, store, vp)?
			.first()
			.copied()
			.unwrap_or(0);
		let special = state::zsh_option(root, store, vp, ZshOpt::Interactive)?
			&& state::zsh_option(root, store, vp, ZshOpt::Shinstdin)?;
		Ok((bang, special && bang != 0))
	}
	read(root, store, vp).unwrap_or_else(|e| {
		root.fail(e);
		(0, false)
	})
}

/// [`wide_idents_in`] for a builtin; a store failure is recorded on the
/// kernel and reads as off.
pub fn wide_idents_ctx(ctx: &mut Ctx<'_, '_>) -> bool {
	wide_idents_in(ctx.k, ctx.cx.store, ctx.vp).unwrap_or_else(|e| {
		ctx.k.fail(e);
		false
	})
}

/// [`mb_in`] for a builtin; a store failure is recorded on the kernel
/// and reads as off.
pub fn mb_ctx(ctx: &mut Ctx<'_, '_>) -> bool {
	mb_in(ctx.k, ctx.cx.store, ctx.vp).unwrap_or_else(|e| {
		ctx.k.fail(e);
		false
	})
}

/// [`wide_idents_in`] for the expander.
///
/// # Errors
/// A store failure reading an option.
pub fn wide_idents(ex: &mut Expander<'_, '_>) -> X<bool> {
	Ok(wide_idents_in(ex.k, ex.cx.store, ex.vp)?)
}

/// zsh `fetchvalue`: the parameter whose name starts at `s[*pos]` (a
/// tokenized, metafied name: an identifier, digits, or one of `? # $ * -
/// ! @`), with its subscript when `bracks > 0`; `*pos` moves past what
/// was read. `None`: no such (set or declared) parameter, or no name.
///
/// # Errors
/// A subscript error, a parked substitution, a store failure.
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's fetchvalue")]
pub fn fetchvalue(
	ex: &mut Expander<'_, '_>,
	s: &[u8],
	pos: &mut usize,
	bracks: i32,
	flags: u32,
) -> X<Option<Value>> {
	let window = flags & SCANPM_WINDOW != 0;
	let flags = flags & !SCANPM_WINDOW;
	let t = *pos;
	let mut i = t;
	let c = s.get(i).copied().unwrap_or(0);
	let mut ppar: i64 = 0;
	let mut name: Vec<u8> = Vec::new();
	let ident_e = text::ident_end(s, i, wide_idents(ex)?);
	if c.is_ascii_digit() {
		if bracks >= 0 {
			let e = tail(s, i)
				.iter()
				.position(|c| !c.is_ascii_digit())
				.map_or(s.len(), |n| i + n);
			ppar = std::str::from_utf8(span(s, i, e))
				.ok()
				.and_then(|d| d.parse().ok())
				.unwrap_or(i64::MAX);
			name.extend_from_slice(span(s, i, e));
			i = e;
		} else {
			ppar = i64::from(c - b'0');
			name.push(c);
			i += 1;
		}
	} else if ident_e != i {
		name.extend_from_slice(span(s, i, ident_e));
		i = ident_e;
	} else {
		let n = match c {
			QUEST => b'?',
			POUND => b'#',
			STRING | QSTRING => b'$',
			STAR => b'*',
			DASH | b'-' => b'-',
			b'#' | b'?' | b'$' | b'!' | b'@' | b'*' => c,
			_ => return Ok(None),
		};
		name.push(n);
		i += 1;
	}
	let mut v = if ppar > 0 {
		let mut v = Value::of(specials::param(ex, Special::Argv, b"")?);
		v.start = ppar - 1;
		v.end = ppar;
		v
	} else {
		let isvarat = name == b"@";
		let lookup: &[u8] = if name.first() == Some(&b'0') {
			b"0"
		} else {
			&name
		};
		// A read through a subscript of a keyed special looks up that key
		// alone; an assignment rewrites the whole value, so it needs it.
		let keyed =
			bracks > 0 && flags & SCANPM_ASSIGNING == 0 && matches!(s.get(i), Some(&(b'[' | INBRACK)));
		let pm = if keyed && window && plain_subscript(s, i) && specials::lookup(lookup).is_none() {
			getparam_window(ex, lookup)?
		} else if keyed {
			getparam_lazy(ex, lookup)?
		} else {
			getparam(ex, lookup)?
		};
		let Some(pm) = pm else {
			*pos = i;
			return Ok(None);
		};
		if pm.flags.contains(PmFlags::UNSET) && !pm.flags.contains(PmFlags::DECLARED) {
			*pos = i;
			return Ok(None);
		}
		let mut v = Value::of(pm);
		if v.pm.flags.intersects(PmFlags::ARRAY.with(PmFlags::HASHED)) {
			v.isarr = flags | if isvarat { SCANPM_ISVAR_AT } else { 0 };
			if v.isarr == 0 {
				v.isarr = SCANPM_ARRONLY;
			}
		}
		if bracks > 0 && matches!(s.get(i), Some(&(b'[' | INBRACK))) {
			subscript::getindex(ex, s, &mut i, &mut v, flags)?;
			if v.pm.lazy && v.elem.is_none() && v.pm.special.is_none() {
				window_elem(ex, &mut v)?;
			}
			if v.elem.is_none() {
				v.pm.materialize(ex)?;
			}
			*pos = i;
			return Ok(Some(v));
		} else if flags & SCANPM_ASSIGNING == 0
			&& v.isarr != 0
			&& text::ident_end(&name, 0, true) > 0
			&& opt(ex, ZshOpt::Ksharrays)?
		{
			v.end = 1;
			v.isarr = 0;
		}
		v
	};
	if ppar > 0 {
		v.pm.name = BString::from(name);
	}
	if bracks == 0 && i < s.len() {
		return Ok(None);
	}
	*pos = i;
	Ok(Some(v))
}

/// Whether the subscript opening at `s[open]` is a plain one (no `(flags)`,
/// not `*` or `@`): one that resolves to positions, not by searching or
/// taking the whole value.
fn plain_subscript(s: &[u8], open: usize) -> bool {
	!matches!(
		s.get(open + 1),
		Some(&(b'(' | crate::bash::syntax::zsh::tok::INPAR | b'*' | b'@' | STAR))
	)
}

/// [`getparam_lazy`] for a [`SCANPM_WINDOW`] read through a plain
/// subscript: an ordinary stored dense array also comes without its value
/// ([`Param::lazy`]), for [`window_elem`] to load what the subscript
/// selects.
fn getparam_window(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<Param>> {
	if let Some(mut pm) = getparam_in(ex, name, Defer::Stored)?
		&& pm.flags.type_bits() == PmFlags::ARRAY
		&& pm.special.is_none()
		&& pm.tied.is_none()
		&& !pm.flags.contains(PmFlags::UNSET)
		&& matches!(read_var(ex, name)?.0.map(|v| &v.value), Some(VarValue::Indexed(items)) if dense_from_zero(items))
	{
		pm.lazy = true;
		pm.value = PValue::Array(Vec::new());
		return Ok(Some(pm));
	}
	getparam_lazy(ex, name)
}

/// Load what the subscripted view `v` of a [`getparam_window`] array
/// reads. A single element (`$a[i]`) is loaded alone, as a one-element
/// array `v` starts at; an index outside the array leaves it empty, which
/// `paramsubst` reads as unset, as it does that index of the whole array.
/// Any other view loads the whole array.
///
/// # Errors
/// A store failure.
fn window_elem(ex: &mut Expander<'_, '_>, v: &mut Value) -> X<()> {
	let single = v.isarr == 0 && v.flags & VALFLAG_INV == 0 && v.end == v.start + 1;
	if !single {
		return v.pm.materialize(ex);
	}
	let name = v.pm.name.clone();
	let elem = match read_var(ex, &name)?.0.map(|var| &var.value) {
		Some(VarValue::Indexed(items)) if dense_from_zero(items) => {
			let len = i64::try_from(items.len()).unwrap_or(i64::MAX);
			let at = if v.start < 0 { v.start + len } else { v.start };
			usize::try_from(at)
				.ok()
				.and_then(|at| items.get(at))
				.map(|(_, e)| e.clone())
		},
		_ => return v.pm.materialize(ex),
	};
	v.pm.value = PValue::Array(elem.into_iter().collect());
	v.pm.lazy = false;
	v.start = 0;
	v.end = 1;
	Ok(())
}

// ---- writers
// ------------------------------------------------------------------

/// Where a write of `name` lands: the scope that binds it, else global.
const fn level_for(_pm: &Param) -> Level {
	Level::Dynamic
}

/// Store `pm` (its flags, width, base and value) where it is bound, the
/// value converted to the store's shape; a tie partner is kept in step.
fn store_param(ex: &mut Expander<'_, '_>, pm: &Param) -> X<()> {
	store_param_assignment(ex, pm, false)
}

// Arithmetic opts in at the value setter, not after synchronization: a
// committed value remains an assignment even when a later tie/prompt hook
// fails.
fn store_param_assignment(ex: &mut Expander<'_, '_>, pm: &Param, trace: bool) -> X<()> {
	if let Some(sp) = pm.special
		&& !sp.is_plain()
	{
		// `typeset -U` keeps a special array (`fpath`, `path`) and the words
		// of its tied scalar unique too (zsh `uniqarray` in their setters).
		let value = match &pm.value {
			PValue::Array(a) if pm.flags.contains(PmFlags::UNIQUE) => PValue::Array(uniq(a)),
			PValue::Scalar(s) if pm.flags.contains(PmFlags::UNIQUE) && !s.is_empty() => {
				match sp.tie_partner(ex.k.engine.config().platform) {
					Some((_, sep)) => {
						let words: Vec<BString> = s.split(|&c| c == sep).map(BString::from).collect();
						PValue::Scalar(BString::from(uniq(&words).join(&[sep][..])))
					},
					None => pm.value.clone(),
				}
			},
			value => value.clone(),
		};
		specials::set(ex, sp, &pm.name, value)?;
		if trace {
			super::super::builtins::emit_assignment(ex.k, ex.cx, ex.vp, &pm.name, level_for(pm));
		}
		return Ok(());
	}
	// The scalar of a `typeset -UT` tie keeps its words unique (zsh's
	// colon-array `setfn` with `PM_UNIQUE`).
	let uniq_pm;
	let pm = match &pm.value {
		PValue::Scalar(s) if pm.flags.contains(PmFlags::UNIQUE.with(PmFlags::TIED)) => {
			let tie = match pm
				.special
				.and_then(|sp| sp.tie_partner(ex.k.engine.config().platform))
			{
				Some((array, sep)) => Some((pm.name.clone(), BString::from(array), sep)),
				None => tie_of(ex, &pm.name)?,
			};
			match tie {
				Some((scalar, _, sep)) if scalar == pm.name && !s.is_empty() => {
					let words: Vec<BString> = s.split(|&c| c == sep).map(BString::from).collect();
					let joined = uniq(&words).join(&[sep][..]);
					uniq_pm = Param { value: PValue::Scalar(BString::from(joined)), ..pm.clone() };
					&uniq_pm
				},
				_ => pm,
			}
		},
		_ => pm,
	};
	let mut attrs = pm.flags.to_attrs(pm.width, pm.base);
	let value = match &pm.value {
		PValue::Scalar(s) => VarValue::Str(s.clone()),
		PValue::Array(a) => {
			// Densifying a sparse (bash) array is a lossy crossing.
			let sparse = matches!(
				state::lookup_declared(&ex.k.root, ex.cx.store, ex.vp, &pm.name)?,
				Some(Var { value: VarValue::Indexed(old), .. })
					if old.last().is_some_and(|&(last, _)| {
						usize::try_from(last + 1).unwrap_or(0) != old.len()
							|| old.first().is_none_or(|e| e.0 != 0)
					})
			);
			if sparse {
				let what = format!("gaps of sparse array `{}'", pm.name);
				mode::report_lossy(ex.k, ex.cx, ex.vp, ex.line, LossyKind::SparseGaps, what);
			}
			let a = if pm.flags.contains(PmFlags::UNIQUE) {
				uniq(a)
			} else {
				a.clone()
			};
			indexed(a)
		},
		PValue::Hash(h) => {
			attrs = attrs.with_base(pm.attrs.base());
			VarValue::Assoc(h.clone().into())
		},
	};
	if !pm.flags.contains(PmFlags::UNSET) {
		attrs = attrs.without(Attrs::INVISIBLE);
	}
	let level = level_for(pm);
	state::store_var(
		&mut ex.k.root,
		ex.cx.store,
		ex.vp,
		&pm.name,
		Some(Var { attrs, value }),
		level,
	);
	if trace {
		super::super::builtins::emit_assignment(ex.k, ex.cx, ex.vp, &pm.name, level);
	}
	if pm.flags.contains(PmFlags::TIED) {
		sync_tie(ex, pm)?;
	}
	if let PValue::Scalar(s) = &pm.value
		&& pm.special.is_some()
	{
		share_prompt(ex, &pm.name, s)?;
	}
	// zsh `strsetfn`: a plain scalar that names a directory (or any, under
	// `AUTO_NAME_DIRS`) keeps its named directory up to date.
	if pm.special.is_none()
		&& pm.flags.type_bits() == PmFlags::SCALAR
		&& let PValue::Scalar(s) = &pm.value
	{
		super::nameddir::scalar_assigned(ex, &pm.name, s)?;
	}
	// zsh `arrfixenv`: a new `PATH` empties the command hash table.
	if pm.name == "PATH" {
		crate::bash::vm::builtins::flush_hash(&mut ex.k.root, ex.cx.store, ex.vp)?;
	}
	Ok(())
}

/// Give the other names of the prompt special `name` (`PS1`, `PROMPT`,
/// `prompt`, …: one variable in zsh) the value `s`, keeping their own
/// attributes.
fn share_prompt(ex: &mut Expander<'_, '_>, name: &[u8], s: &BString) -> X<()> {
	for &other in specials::prompt_group(name) {
		if other == name {
			continue;
		}
		let old = state::lookup_declared(&ex.k.root, ex.cx.store, ex.vp, other)?;
		// A hidden local of that name (`typeset -h`) is a plain parameter.
		if old.is_some_and(|v| v.attrs.contains(Attrs::ZSH_HIDE)) {
			continue;
		}
		let attrs = old.map_or(Attrs::NONE, |v| v.attrs.without(Attrs::INVISIBLE));
		let var = Var { attrs, value: VarValue::Str(s.clone()) };
		state::store_var(&mut ex.k.root, ex.cx.store, ex.vp, other, Some(var), Level::Dynamic);
	}
	Ok(())
}

/// Keep the other side of a `typeset -T` tie equal to `pm`'s value.
fn sync_tie(ex: &mut Expander<'_, '_>, pm: &Param) -> X<()> {
	let Some((scalar, array, sep)) = tie_of(ex, &pm.name)? else {
		return Ok(());
	};
	let (other, value) = if pm.name == scalar {
		let s = match &pm.value {
			PValue::Scalar(s) => s.clone(),
			_ => pm.text(),
		};
		let items: Vec<BString> = if s.is_empty() {
			Vec::new()
		} else {
			s.split(|&c| c == sep).map(BString::from).collect()
		};
		(array, indexed(items))
	} else {
		let items = match &pm.value {
			PValue::Array(a) => a.clone(),
			v => vec![match v {
				PValue::Scalar(s) => s.clone(),
				_ => BString::default(),
			}],
		};
		(scalar, VarValue::Str(BString::from(items.join(&[sep][..]))))
	};
	let attrs = match state::lookup_declared(&ex.k.root, ex.cx.store, ex.vp, &other)? {
		Some(v) => v.attrs,
		None => Attrs::ZSH_TIED,
	};
	let attrs = attrs.without(Attrs::INVISIBLE);
	state::store_var(
		&mut ex.k.root,
		ex.cx.store,
		ex.vp,
		&other,
		Some(Var { attrs, value }),
		Level::Dynamic,
	);
	Ok(())
}

/// A dense array as the store keeps it (keys `0..n`).
pub(super) fn indexed(items: Vec<BString>) -> VarValue {
	VarValue::Indexed((0_i64..).zip(items).collect())
}

/// zsh `simple_arrayuniq`: the first occurrence of each element kept.
fn uniq(a: &[BString]) -> Vec<BString> {
	let mut seen = hashbrown::HashSet::with_capacity(a.len());
	a.iter()
		.filter(|e| seen.insert(e.as_slice()))
		.cloned()
		.collect()
}

/// The integer text of `v` for `pm` (zsh `convbase` with the parameter's
/// base).
fn int_text(ex: &mut Expander<'_, '_>, pm: &Param, v: i64) -> X<BString> {
	let o = arith::math_options(ex)?;
	Ok(BString::from(math::convbase(v, i32::from(pm.base), o)))
}

/// The float text of `d` for `pm` (zsh `convfloat` with its precision and
/// style).
fn float_text(pm: &Param, d: f64) -> BString {
	let kind = if pm.flags.contains(PmFlags::EFLOAT) {
		FloatKind::Exponent
	} else {
		FloatKind::Fixed
	};
	BString::from(math::convfloat(d, i32::from(pm.base), kind))
}

/// A float as stored: its shortest exact text, which [`parse_float`] reads
/// back unchanged (zsh keeps the `double`: arithmetic sees every digit, a
/// string read the parameter's style, [`float_display`]).
fn float_store(d: f64) -> BString {
	BString::from(format!("{d:?}"))
}

/// The stored float `s` of `pm` as zsh shows it ([`float_text`]); an
/// empty value stays empty.
fn float_display(pm: &Param, s: &[u8]) -> BString {
	if s.is_empty() {
		return BString::default();
	}
	float_text(pm, parse_float(s))
}

/// [`float_display`] of a stored variable: `s` in the style its `attrs`
/// give (`-E`/`-F` and the precision in the base field); `None` when it
/// is no float (its text is shown as stored).
pub fn stored_float_display(attrs: Attrs, s: &[u8]) -> Option<BString> {
	let kind = if attrs.contains(Attrs::ZSH_FLOAT_E) {
		FloatKind::Exponent
	} else if attrs.contains(Attrs::ZSH_FLOAT_F) {
		FloatKind::Fixed
	} else {
		return None;
	};
	if s.is_empty() {
		return Some(BString::default());
	}
	Some(BString::from(math::convfloat(parse_float(s), i32::from(attrs.base()), kind)))
}

/// zsh `createparam` for an assignment to a name that does not exist (or
/// was just unset): a new global parameter of type `flags`.
fn create(ex: &mut Expander<'_, '_>, name: &[u8], flags: PmFlags) -> X<Param> {
	let mut pm = Param::new(name, flags);
	if opt(ex, ZshOpt::Allexport)? && !flags.intersects(PmFlags::ARRAY.with(PmFlags::HASHED)) {
		pm.flags = pm.flags.with(PmFlags::EXPORTED);
	}
	// The array side of an unset special tie (`fpath` with `FPATH` unset)
	// stays special: zsh reuses its node, so the assignment sets the scalar.
	pm.special = specials::as_started(ex, specials::lookup(name), name)?
		.filter(|s| s.is_plain() || matches!(s, Special::TiedArray(_)));
	if let Some(sp @ Special::TiedArray(_)) = pm.special {
		pm.flags = sp.flags().with(pm.flags.without(PmFlags::UNSET));
	}
	Ok(pm)
}

/// zsh `createparam` of a global `name` over a zsh/param/private private
/// parameter (the innermost binding of `name`, visible or not, is one):
/// `NAME: can't change parameter attribute` (the private is
/// `PM_RO_BY_DESIGN`). An assignment in a function called by the
/// declaring one, to a name with no outer parameter, or one to an unset
/// private, ends here.
///
/// # Errors
/// That error; a store failure.
pub fn refuse_private(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<()> {
	if state::innermost_private(&ex.k.root, ex.cx.store, ex.vp, name)? {
		return Err(bad_assign(name, "can't change parameter attribute"));
	}
	Ok(())
}

/// zsh `unsetparam_pm` removing global `pm` (an unset, or the unset before
/// a type change) while zsh/param/private privates hidden from here shadow
/// it: zsh removes the parameter table's node, which is the innermost
/// private, so every private of the name vanishes with the global (the
/// declaring functions then see no parameter).
///
/// # Errors
/// A store failure.
fn drop_shadowing_privates(ex: &mut Expander<'_, '_>, pm: &Param) -> X<()> {
	if pm.scope.is_some()
		|| pm.special.is_some()
		|| !state::innermost_private(&ex.k.root, ex.cx.store, ex.vp, &pm.name)?
	{
		return Ok(());
	}
	for i in 0..state::scope_count(&ex.k.root, ex.vp) {
		if let Some(Some(v)) = state::scope_var(ex.cx.store, ex.vp, i, &pm.name)?
			&& v.attrs.contains(Attrs::ZSH_PRIVATE)
		{
			state::scope_unbind(&mut ex.k.root, ex.cx.store, ex.vp, i, &pm.name);
		}
	}
	Ok(())
}

/// [`create`] where no parameter `name` is set (zsh `createparam` with no
/// usable old parameter): [`refuse_private`] first.
fn create_new(ex: &mut Expander<'_, '_>, name: &[u8], flags: PmFlags) -> X<Param> {
	refuse_private(ex, name)?;
	create(ex, name, flags)
}

/// zsh `unsetparam_pm` of a whole parameter (not an element).
fn unset_pm(ex: &mut Expander<'_, '_>, pm: &Param) -> X<()> {
	if pm.flags.contains(PmFlags::READONLY) {
		return Err(readonly(&pm.name));
	}
	if let Some(sp) = pm.special
		&& !sp.is_plain()
	{
		return specials::unset(ex, sp, &pm.name);
	}
	if pm.flags.contains(PmFlags::TIED)
		&& let Some((scalar, array, _)) = tie_of(ex, &pm.name)?
	{
		let other = if pm.name == scalar { array } else { scalar };
		drop_tie(ex, &pm.name)?;
		// zsh `stdunsetfn`/`tiedarr_unsetfn`: an unset side is no longer
		// tied (a local stays declared without `PM_TIED`).
		drop_attrs(ex, &other, Attrs::ZSH_TIED)?;
		drop_attrs(ex, &pm.name, Attrs::ZSH_TIED)?;
		state::unset_var(&mut ex.k.root, ex.cx.store, ex.vp, &other, true);
	}
	drop_shadowing_privates(ex, pm)?;
	// zsh `unsetparam_pm`: a special parameter is never removed; it stays,
	// unset, with its flags (`export`, its type), so a later assignment
	// exports it again.
	if matches!(pm.special, Some(Special::Plain(i)) if i != u8::MAX)
		&& let Some(var) = state::lookup_declared(&ex.k.root, ex.cx.store, ex.vp, &pm.name)?.cloned()
	{
		let var = Var {
			attrs: var
				.attrs
				.with(Attrs::INVISIBLE)
				.without(Attrs::ZSH_DEFAULTED),
			value: VarValue::Str(BString::default()),
		};
		state::edit_var(
			&mut ex.k.root,
			ex.cx.store,
			ex.vp,
			&pm.name,
			Level::Dynamic,
			state::VarEdit::Replace(var),
		)?;
		return Ok(());
	}
	state::unset_var(&mut ex.k.root, ex.cx.store, ex.vp, &pm.name, true);
	// zsh's `strsetfn(pm, NULL)` empties the variable the other prompt
	// names share; they stay set. A hidden local (`typeset -h`) is
	// plain.
	if pm.special.is_some() {
		share_prompt(ex, &pm.name, &BString::default())?;
	}
	// zsh `unsetparam_pm` clears `PM_DECLARED` (like ksh, not bash).
	drop_attrs(ex, &pm.name, Attrs::ZSH_DEFAULTED)
}

/// Drop `attrs` from the visible variable `name` when it has them.
fn drop_attrs(ex: &mut Expander<'_, '_>, name: &[u8], attrs: Attrs) -> X<()> {
	let Some(var) = state::lookup_declared(&ex.k.root, ex.cx.store, ex.vp, name)?
		.filter(|v| v.attrs.contains(attrs))
		.cloned()
	else {
		return Ok(());
	};
	let var = Var { attrs: var.attrs.without(attrs), ..var };
	state::edit_var(
		&mut ex.k.root,
		ex.cx.store,
		ex.vp,
		name,
		Level::Dynamic,
		state::VarEdit::Replace(var),
	)?;
	Ok(())
}

/// Remove the tie record naming `name`.
fn drop_tie(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<()> {
	let words = match state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ZshTies))? {
		Some(Record::Words(w)) => w.clone(),
		_ => return Ok(()),
	};
	let kept: Vec<BString> = words
		.as_chunks::<3>()
		.0
		.iter()
		.filter(|t| t[0].as_slice() != name && t[1].as_slice() != name)
		.flatten()
		.cloned()
		.collect();
	let rec = if kept.is_empty() {
		None
	} else {
		Some(Record::Words(kept))
	};
	state::store_record(&mut ex.k.root, ex.cx.store, ex.vp, KeyBuf::Misc(MiscKey::ZshTies), rec);
	Ok(())
}

impl Value {
	/// zsh `assignstrvalue`: assign the scalar `val` (metafied) to what
	/// this value selects.
	///
	/// # Errors
	/// Read-only, slice-of-association and math errors.
	pub fn assignstrvalue(&mut self, ex: &mut Expander<'_, '_>, val: &[u8], flags: u32) -> X<()> {
		self.assignstrvalue_assignment(ex, val, flags, false)
	}

	fn assignstrvalue_assignment(
		&mut self,
		ex: &mut Expander<'_, '_>,
		val: &[u8],
		flags: u32,
		trace: bool,
	) -> X<()> {
		if self.pm.flags.contains(PmFlags::READONLY) {
			return Err(readonly(&self.pm.name));
		}
		check_restricted(ex, &self.pm.name)?;
		if self.pm.flags.type_bits() == PmFlags::HASHED
			&& self.elem.is_none()
			&& self.isarr & (SCANPM_MATCHMANY | SCANPM_ARRONLY) != 0
		{
			return Err(bad_assign(&self.pm.name, "attempt to set slice of associative array"));
		}
		if self.flags & VALFLAG_EMPTY != 0 {
			return Err(bad_assign(&self.pm.name, "assignment to invalid subscript range"));
		}
		if let Some(e) = &self.elem {
			let mut new = unmetafy(val);
			if self.start == i64::from(i32::MAX)
				&& let Some(old) = &e.value
			{
				let mut s = old.to_vec();
				s.extend_from_slice(&new);
				new = s;
			}
			if self.pm.special == Some(Special::Langinfo) {
				// zsh/langinfo's elements are `PM_READONLY` parameters of
				// their own name.
				return Err(readonly(&e.key));
			}
			if self.pm.special == Some(Special::Mapfile) {
				// zsh/mapfile's `setpmmapfile` writes the file.
				return crate::bash::vm::builtins::zsh_mod_mapfile::set(ex, &e.key, &new);
			}
			// All early-returning special setters are handled above. The
			// ordinary assignment consumes this snapshot and stores it back.
			self.pm.materialize(ex)?;
			let mut h = match &mut self.pm.value {
				PValue::Hash(h) => ZHash::from_owned(std::mem::take(h), self.pm.attrs),
				_ => ZHash::new(),
			};
			h.insert(e.key.clone(), BString::from(new));
			let (items, attrs) = h.into_stored(self.pm.attrs);
			self.pm.attrs = attrs;
			self.pm.value = PValue::Hash(items);
			self.pm.flags = self.pm.flags.without(PmFlags::UNSET);
			return store_param_assignment(ex, &self.pm, trace);
		}
		self.pm.flags = self.pm.flags.without(PmFlags::UNSET);
		match self.pm.flags.type_bits() {
			PmFlags::SCALAR => {
				if self.start == 0 && self.end == -1 {
					self.pm.value = PValue::Scalar(BString::from(unmetafy(val)));
					if self
						.pm
						.flags
						.intersects(PmFlags::LEFT.with(PmFlags::RIGHT_B).with(PmFlags::RIGHT_Z))
						&& self.pm.width == 0
					{
						self.pm.width = u16::try_from(val.len()).unwrap_or(u16::MAX);
					}
				} else {
					let z = match &self.pm.value {
						PValue::Scalar(s) => metafy(s),
						_ => Vec::new(),
					};
					let zlen = i64::try_from(z.len()).unwrap_or(i64::MAX);
					if self.flags & VALFLAG_INV != 0 && !opt(ex, ZshOpt::Ksharrays)? {
						self.start -= 1;
						self.end -= 1;
					}
					if self.start < 0 {
						self.start = (self.start + zlen).max(0);
					}
					self.start = self.start.min(zlen);
					if self.end < 0 {
						self.end += zlen;
						if self.end < 0 {
							self.end = 0;
						} else if self.end >= zlen {
							self.end = zlen;
						} else {
							let e = usize::try_from(self.end).unwrap_or(0);
							self.end += i64::try_from(text::charlen(&z, e, mb(ex)?)).unwrap_or(1);
						}
					} else if self.end > zlen {
						self.end = zlen;
					}
					let a = usize::try_from(self.start).unwrap_or(0);
					let b = usize::try_from(self.end.max(self.start)).unwrap_or(a);
					let mut x = head(&z, a).to_vec();
					x.extend_from_slice(val);
					x.extend_from_slice(tail(&z, b.min(z.len())));
					self.pm.value = PValue::Scalar(BString::from(unmetafy(&x)));
				}
			},
			PmFlags::INTEGER => {
				let ival = if flags & ASSPM_ENV_IMPORT != 0 {
					parse_int(&unmetafy(val))
				} else {
					let (n, lastbase) = arith::matheval_lastbase(ex, val)?;
					if self.pm.base == 0 && lastbase != -1 {
						self.pm.base = u8::try_from(lastbase).unwrap_or(0);
					}
					n.to_int()
				};
				let t = int_text(ex, &self.pm, ival)?;
				self.pm.value = PValue::Scalar(t);
				if self
					.pm
					.flags
					.intersects(PmFlags::LEFT.with(PmFlags::RIGHT_B).with(PmFlags::RIGHT_Z))
					&& self.pm.width == 0
				{
					self.pm.width = u16::try_from(val.len()).unwrap_or(u16::MAX);
				}
			},
			PmFlags::EFLOAT | PmFlags::FFLOAT => {
				let d = if flags & ASSPM_ENV_IMPORT != 0 {
					parse_float(&unmetafy(val))
				} else {
					arith::matheval(ex, val)?.to_float()
				};
				self.pm.value = PValue::Scalar(float_store(d));
				if self
					.pm
					.flags
					.intersects(PmFlags::LEFT.with(PmFlags::RIGHT_B).with(PmFlags::RIGHT_Z))
					&& self.pm.width == 0
				{
					self.pm.width = u16::try_from(val.len()).unwrap_or(u16::MAX);
				}
			},
			PmFlags::ARRAY => return self.setarrvalue_assignment(ex, vec![val.to_vec()], trace),
			_ => {
				return Err(bad_assign(&self.pm.name, "attempt to set associative array to scalar"));
			},
		}
		store_param_assignment(ex, &self.pm, trace)
	}

	/// zsh `setarrvalue`: assign the elements `val` (metafied) to what this
	/// value selects (the whole parameter, a slice, an element).
	///
	/// # Errors
	/// Read-only, type and slice errors.
	pub fn setarrvalue(&mut self, ex: &mut Expander<'_, '_>, val: Vec<Vec<u8>>) -> X<()> {
		self.setarrvalue_assignment(ex, val, false)
	}

	fn setarrvalue_assignment(
		&mut self,
		ex: &mut Expander<'_, '_>,
		val: Vec<Vec<u8>>,
		trace: bool,
	) -> X<()> {
		if self.pm.flags.contains(PmFlags::READONLY) {
			return Err(readonly(&self.pm.name));
		}
		check_restricted(ex, &self.pm.name)?;
		if !self
			.pm
			.flags
			.intersects(PmFlags::ARRAY.with(PmFlags::HASHED))
		{
			return Err(bad_assign(&self.pm.name, "attempt to assign array value to non-array"));
		}
		if self.flags & VALFLAG_EMPTY != 0 {
			return Err(bad_assign(&self.pm.name, "assignment to invalid subscript range"));
		}
		let is_hash = self.pm.flags.type_bits() == PmFlags::HASHED;
		if self.start == 0 && self.end == -1 {
			if is_hash {
				return arrhashsetfn(ex, &mut self.pm, val, 0);
			}
			self.pm.value = PValue::Array(val.iter().map(|e| BString::from(unmetafy(e))).collect());
			self.pm.flags = self.pm.flags.without(PmFlags::UNSET);
			return store_param_assignment(ex, &self.pm, trace);
		}
		if self.start == -1 && self.end == 0 && is_hash {
			return arrhashsetfn(ex, &mut self.pm, val, ASSPM_AUGMENT);
		}
		if is_hash {
			return Err(bad_assign(&self.pm.name, "attempt to set slice of associative array"));
		}
		let old = match &self.pm.value {
			PValue::Array(a) => a.clone(),
			_ => Vec::new(),
		};
		let pre = i64::try_from(old.len()).unwrap_or(i64::MAX);
		if self.flags & VALFLAG_INV != 0 && !opt(ex, ZshOpt::Ksharrays)? {
			if self.start > 0 {
				self.start -= 1;
			}
			self.end -= 1;
		}
		if self.start < 0 {
			self.start = (self.start + pre).max(0);
		}
		if self.end < 0 {
			self.end = (self.end + pre + 1).max(0);
		}
		if self.end < self.start {
			self.end = self.start;
		}
		let start = usize::try_from(self.start).unwrap_or(0);
		let end = usize::try_from(self.end).unwrap_or(0);
		let mut new: Vec<BString> = Vec::with_capacity(start + val.len() + old.len());
		for i in 0..start {
			new.push(old.get(i).cloned().unwrap_or_default());
		}
		new.extend(val.iter().map(|e| BString::from(unmetafy(e))));
		if end < old.len() {
			new.extend(tail(&old, end).iter().cloned());
		}
		self.pm.value = PValue::Array(new);
		self.pm.flags = self.pm.flags.without(PmFlags::UNSET);
		store_param_assignment(ex, &self.pm, trace)
	}
}

/// zsh `arrhashsetfn`: set association `pm` from key/value pairs
/// (`Marker` triples allowed), replacing it or, with `ASSPM_AUGMENT`,
/// adding to it.
fn arrhashsetfn(ex: &mut Expander<'_, '_>, pm: &mut Param, val: Vec<Vec<u8>>, flags: u32) -> X<()> {
	let alen = val.iter().filter(|e| e.first() != Some(&MARKER)).count();
	if alen % 2 != 0 {
		return Err(fail(Diag::ZshSubst {
			msg: BString::from("bad set of key/value pairs for associative array"),
		}));
	}
	let mut h = if flags & ASSPM_AUGMENT != 0 {
		match &pm.value {
			PValue::Hash(h) => ZHash::from_stored(h, pm.attrs),
			_ => ZHash::new(),
		}
	} else {
		ZHash::new()
	};
	let mut it = val.into_iter();
	while let Some(mut k) = it.next() {
		let mut augment = false;
		if k.first() == Some(&MARKER) {
			augment = k.get(1) == Some(&b'+');
			let Some(key) = it.next() else { break };
			k = key;
		}
		let Some(v) = it.next() else { break };
		let key = BString::from(unmetafy(&k));
		let mut value = unmetafy(&v);
		if augment && let Some(old) = h.get(&key) {
			let mut s = old.to_vec();
			s.extend_from_slice(&value);
			value = s;
		}
		h.insert(key, BString::from(value));
	}
	let (items, attrs) = h.into_stored(if flags & ASSPM_AUGMENT != 0 {
		pm.attrs
	} else {
		pm.attrs.with_base(0)
	});
	pm.attrs = attrs;
	pm.value = PValue::Hash(items);
	pm.flags = pm.flags.without(PmFlags::UNSET);
	store_param(ex, pm)
}

/// Whether zsh flags parameter `name` `PM_RESTRICTED` (its specials flagged
/// so, and the `rparams` list `dosetopt` restricts): under `restricted` it
/// cannot be set. Read by the assignments here and by the environment of
/// an external command (`addvars` with `ADDVAR_RESTRICT`).
pub const fn is_restricted(name: &[u8]) -> bool {
	matches!(
		name,
		b"PATH"
			| b"path"
			| b"MODULE_PATH"
			| b"module_path"
			| b"GID"
			| b"EGID"
			| b"UID"
			| b"EUID"
			| b"HISTSIZE"
			| b"SAVEHIST"
			| b"USERNAME"
			| b"IFS"
			| b"SHELL"
			| b"HISTFILE"
			| b"LD_LIBRARY_PATH"
			| b"LD_AOUT_LIBRARY_PATH"
			| b"LD_PRELOAD"
			| b"LD_AOUT_PRELOAD"
	)
}

/// zsh's `PM_RESTRICTED` check of `assignstrvalue`, `setarrvalue` and
/// `setnumvalue`: `NAME: restricted`.
fn check_restricted(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<()> {
	if is_restricted(name) && opt(ex, ZshOpt::Restricted)? {
		return Err(bad_assign(name, "restricted"));
	}
	Ok(())
}

/// The name part of `s` (before a `[`), and whether a subscript follows.
fn split_name(s: &[u8]) -> (&[u8], bool) {
	match s.iter().position(|&c| c == b'[' || c == INBRACK) {
		Some(i) => (head(s, i), true),
		None => (s, false),
	}
}

/// `not an identifier: NAME`.
fn not_ident(name: &[u8]) -> Stop {
	let mut n = name.to_vec();
	untokenize(&mut n);
	fail(Diag::InvalidIdent { name: BString::from(unmetafy(&n)) })
}

/// zsh `check_warn_pm`: under `WARN_CREATE_GLOBAL`, a parameter `created`
/// globally by a function called in this process; under
/// `WARN_NESTED_VAR` (with `may_warn_nested`), an existing one set from a
/// function deeper than its own scope. `pmtype` names its type in the
/// warning.
fn check_warn_pm(
	ex: &mut Expander<'_, '_>,
	pm: &Param,
	pmtype: &str,
	created: bool,
	may_warn_nested: bool,
) -> X<()> {
	if !may_warn_nested && !created {
		return Ok(());
	}
	let created = if created && opt(ex, ZshOpt::Warncreateglobal)? {
		true
	} else if !created && opt(ex, ZshOpt::Warnnestedvar)? {
		false
	} else {
		return Ok(());
	};
	let Some(top) = state::func_scope(&ex.k.root, ex.cx.store, ex.vp)? else {
		return Ok(());
	};
	if created {
		// zsh `locallevel <= forklevel`: no function called since this
		// process forked (a subshell starts without its parent's frames).
		let in_function = ex
			.vp
			.frames
			.iter()
			.any(|f| matches!(f.kind, crate::bash::vm::proc::FrameKind::Function { .. }));
		if !in_function || pm.scope.is_some() {
			return Ok(());
		}
	} else if pm.scope.is_some_and(|s| s >= top) {
		return Ok(());
	}
	if pm.flags.contains(PmFlags::SPECIAL) {
		return Ok(());
	}
	let func = state::scope_func(ex.cx.store, ex.vp, top)?.unwrap_or_default();
	let name = BStr::new(&pm.name);
	let msg = if created {
		format!("{pmtype} parameter {name} created globally in function {func}")
	} else {
		format!("{pmtype} parameter {name} set in enclosing scope in function {func}")
	};
	ex.k
		.diag(ex.cx, ex.vp, ex.line, Diag::Warning { msg: msg.into() });
	Ok(())
}

/// [`fetchvalue`] of a whole assignment target `s` (`name` or
/// `name[sub]`), which must be consumed entirely.
fn target(ex: &mut Expander<'_, '_>, s: &[u8], flags: u32) -> X<Option<Value>> {
	let mut pos = 0;
	fetchvalue(ex, s, &mut pos, 1, flags)
}

/// zsh `assignsparam`: assign scalar `val` (raw) to `name` (raw; may
/// carry a subscript: an element, a slice, an association key).
///
/// # Errors
/// zsh's assignment errors (`not an identifier`, read-only, math, …), a
/// parked substitution in the subscript, a store failure.
pub fn assignsparam(ex: &mut Expander<'_, '_>, name: &[u8], val: &[u8], flags: u32) -> X<()> {
	let s = metafy(name);
	let val = metafy(val);
	assignsparam_meta(ex, &s, val, flags)
}

/// What [`assign_elem_in_place`] did.
enum InPlace {
	/// The element is assigned.
	Done,
	/// Not an element it assigns; nothing evaluated.
	Skipped,
	/// The subscript resolved to `.0` (its value loaded) for the general
	/// path to assign: a slice, a gap after the last element.
	General(Box<Value>),
}

/// zsh `assignsparam` of `name[sub]=val` (metafied `s`) when `pm` (read
/// without its value) is an ordinary stored array or association: the
/// subscript resolves as [`subscript::getindex`] resolves it, and one
/// element is written in place, without the copy of the whole parameter
/// the general path makes (`compinit` assigns thousands of keys one by
/// one; loops fill arrays element by element). A present key or index
/// takes the value where it is; a new key goes where zsh's hash table
/// puts it, a new index at the end.
fn assign_elem_in_place(
	ex: &mut Expander<'_, '_>,
	s: &[u8],
	name: &[u8],
	pm: Param,
	val: &[u8],
) -> X<InPlace> {
	let kind = pm.flags.type_bits();
	let plain = (kind == PmFlags::HASHED || kind == PmFlags::ARRAY) && edits_in_place(ex, &pm)?;
	// A plain subscript: `(flags)`, `*` and `@` read the whole parameter.
	let body = s.get(name.len() + 1..).unwrap_or_default();
	let plain_sub = !matches!(
		body.first(),
		Some(&(b'(' | crate::bash::syntax::zsh::tok::INPAR | b'*' | b'@' | STAR))
	);
	if !plain || !plain_sub {
		return Ok(InPlace::Skipped);
	}
	check_restricted(ex, name)?;
	// An array's subscript needs only its length (`a[-1]`, `a[$#a+1]`):
	// empty elements stand in for the values.
	let len = match read_var(ex, name)?.0.map(|v| &v.value) {
		Some(VarValue::Indexed(items)) if dense_from_zero(items) => items.len(),
		Some(VarValue::Assoc(_)) if kind == PmFlags::HASHED => 0,
		_ => return Ok(InPlace::Skipped),
	};
	let mut lazy = pm;
	lazy.lazy = true;
	if kind == PmFlags::ARRAY {
		lazy.value = PValue::Array(vec![BString::default(); len]);
	}
	let mut v = Value::of(lazy);
	v.isarr = SCANPM_ARRONLY;
	let mut i = name.len();
	subscript::getindex(ex, s, &mut i, &mut v, 0)?;
	let value = unmetafy(val);
	let edit_key;
	let edit = if let Some(e) = &v.elem {
		let (var, _) = read_var(ex, name)?;
		let Some(var) = var else {
			return Ok(InPlace::Skipped);
		};
		let VarValue::Assoc(items) = &var.value else {
			return Ok(InPlace::Skipped);
		};
		edit_key = e.key.clone();
		if items.get(&edit_key).is_some() {
			state::VarEdit::Set {
				elem:   Some(crate::bash::store::Elem::Key(BStr::new(&edit_key))),
				value:  &value,
				append: false,
			}
		} else if let Some(buckets) = super::assoc_order::insert_buckets(items.len(), var.attrs) {
			state::VarEdit::Insert { key: &edit_key, value: &value, buckets }
		} else {
			// The table grows: zsh re-adds every entry.
			let mut h = ZHash::from_stored(items, var.attrs);
			h.insert(edit_key.clone(), BString::from(value.clone()));
			let (items, attrs) = h.into_stored(var.attrs);
			state::VarEdit::Replace(Var { value: VarValue::Assoc(items.into()), attrs })
		}
	} else {
		let single = v.flags & VALFLAG_EMPTY == 0 && v.isarr == 0 && v.end == v.start + 1;
		let start = usize::try_from(v.start)
			.ok()
			.filter(|&st| single && st <= len);
		let Some(start) = start else {
			v.pm.materialize(ex)?;
			return Ok(InPlace::General(Box::new(v)));
		};
		state::VarEdit::Set {
			elem:   Some(crate::bash::store::Elem::Index(i64::try_from(start).unwrap_or(i64::MAX))),
			value:  &value,
			append: false,
		}
	};
	state::edit_var(&mut ex.k.root, ex.cx.store, ex.vp, name, Level::Dynamic, edit)?;
	Ok(InPlace::Done)
}

/// Whether stored indexed elements are a zsh array's: indices `0..len`.
fn dense_from_zero(items: &[(i64, BString)]) -> bool {
	items.first().is_none_or(|(i, _)| *i == 0)
		&& items
			.last()
			.is_none_or(|(i, _)| usize::try_from(*i).is_ok_and(|i| i + 1 == items.len()))
}

/// Whether stored array or association `pm` (read without its value) may
/// be edited in place ([`assign_elem_in_place`], [`append_in_place`]):
/// nothing about it rewrites the values (`-U`, case or padding flags, an
/// indexed array under `KSH_ARRAYS`), it is neither special nor tied, and
/// it is set, writable and visible.
fn edits_in_place(ex: &mut Expander<'_, '_>, pm: &Param) -> X<bool> {
	Ok((pm.flags.type_bits() != PmFlags::ARRAY || !opt(ex, ZshOpt::Ksharrays)?)
		&& !pm.flags.intersects(
			PmFlags::UNIQUE
				.with(PmFlags::LOWER)
				.with(PmFlags::UPPER)
				.with(PmFlags::LEFT)
				.with(PmFlags::RIGHT_B)
				.with(PmFlags::RIGHT_Z),
		)
		&& pm.special.is_none()
		&& pm.tied.is_none()
		&& !pm.flags.intersects(PmFlags::UNSET.with(PmFlags::READONLY))
		&& !pm.attrs.contains(Attrs::INVISIBLE))
}

/// Whether `name` is a plain ASCII identifier (no digits first: not a
/// positional parameter), which a direct read or write can name.
fn plain_ident(name: &[u8]) -> bool {
	matches!(name.first(), Some(c) if c.is_ascii_alphabetic() || *c == b'_')
		&& name.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

/// The type of stored variable `v` when a plain-name assignment or
/// arithmetic may read and write its value directly, as the general path
/// would leave it: a set scalar, integer or float that nothing rewrites
/// or redirects (not read-only, tied, hidden or private; no case, padding
/// or `-U` flags). The caller has checked that no special has its name.
fn direct_type(v: &Var) -> Option<PmFlags> {
	const BLOCKING: [Attrs; 13] = [
		Attrs::INVISIBLE,
		Attrs::READONLY,
		Attrs::ZSH_TIED,
		Attrs::ZSH_HIDE,
		Attrs::ZSH_PRIVATE,
		Attrs::LOWER,
		Attrs::UPPER,
		Attrs::ZSH_LEFT,
		Attrs::ZSH_RIGHT_B,
		Attrs::ZSH_RIGHT_Z,
		Attrs::ZSH_UNIQUE,
		Attrs::ASSOC,
		Attrs::INDEXED,
	];
	if !matches!(v.value, VarValue::Str(_)) || BLOCKING.iter().any(|&a| v.attrs.contains(a)) {
		return None;
	}
	let ty = PmFlags::from_var(v).type_bits();
	matches!(ty, PmFlags::SCALAR | PmFlags::INTEGER | PmFlags::EFLOAT | PmFlags::FFLOAT)
		.then_some(ty)
}

/// The direct ([`direct_type`]) variable `name` (raw): its type and its
/// output base (an integer's `typeset -i N`).
fn direct_var(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<(PmFlags, u8)>> {
	if !plain_ident(name) || specials::lookup(name).is_some() {
		return Ok(None);
	}
	Ok(read_var(ex, name)?
		.0
		.and_then(|v| direct_type(v).map(|ty| (ty, v.attrs.base()))))
}

/// The text `$name` substitutes (metafied) when `name` is a direct scalar
/// or integer ([`direct_var`]: its stored text, as `getstrvalue` gives it
/// without padding or case flags); `None` for any other parameter.
///
/// # Errors
/// A store failure.
pub(super) fn direct_text(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<Vec<u8>>> {
	if !plain_ident(name) || specials::lookup(name).is_some() {
		return Ok(None);
	}
	let Some(var) = read_var(ex, name)?.0 else {
		return Ok(None);
	};
	Ok(match (direct_type(var), &var.value) {
		(Some(PmFlags::SCALAR | PmFlags::INTEGER), VarValue::Str(s)) => Some(metafy(s)),
		_ => None,
	})
}

/// Store `value` (raw) as the value of the direct variable `name`
/// ([`direct_var`]), keeping its attributes, with what the general path's
/// store does for such a variable (a scalar naming a directory updates its
/// named directory). The caller has just read it as a scalar: the store's
/// change is chosen without reading it again.
fn store_direct(ex: &mut Expander<'_, '_>, name: &[u8], ty: PmFlags, value: &[u8]) -> X<()> {
	state::edit_seen(
		&mut ex.k.root,
		ex.cx.store,
		ex.vp,
		name,
		Level::Dynamic,
		state::VarEdit::Set { elem: None, value, append: false },
		Some(state::Seen::Scalar),
	)?;
	if ty == PmFlags::SCALAR {
		super::nameddir::scalar_assigned(ex, name, value)?;
	}
	Ok(())
}

/// zsh `assignaparam` of `name+=(val)` (metafied elements) when `name` is
/// an ordinary stored array ([`edits_in_place`]): the elements go after
/// its last one in place, without the copy of the whole array the general
/// path reads and writes back (a loop appending one element at a time
/// would cost the square of the array's length). `false`: not such an
/// array, nothing done.
fn append_in_place(ex: &mut Expander<'_, '_>, name: &[u8], val: &[Vec<u8>], flags: u32) -> X<bool> {
	let Some(pm) = getparam_in(ex, name, Defer::Stored)? else {
		return Ok(false);
	};
	if pm.flags.type_bits() != PmFlags::ARRAY || !edits_in_place(ex, &pm)? {
		return Ok(false);
	}
	if !matches!(read_var(ex, name)?.0.map(|v| &v.value), Some(VarValue::Indexed(items)) if dense_from_zero(items))
	{
		return Ok(false);
	}
	check_restricted(ex, name)?;
	if flags & ASSPM_WARN != 0 {
		check_warn_pm(ex, &pm, "array", false, true)?;
	}
	let elems = val.iter().map(|e| BString::from(unmetafy(e))).collect();
	state::edit_var(
		&mut ex.k.root,
		ex.cx.store,
		ex.vp,
		name,
		Level::Dynamic,
		state::VarEdit::Push(elems),
	)?;
	Ok(true)
}

/// [`assignsparam`] on metafied text.
pub(super) fn assignsparam_meta(
	ex: &mut Expander<'_, '_>,
	s: &[u8],
	val: Vec<u8>,
	flags: u32,
) -> X<()> {
	if !isident(s, wide_idents(ex)?) {
		return Err(not_ident(s));
	}
	// zsh `assignstrvalue`: nothing is set under `NO_EXEC`.
	if !opt(ex, ZshOpt::Exec)? {
		return Ok(());
	}
	let (name, sub) = split_name(s);
	// An existing ordinary scalar takes the value directly: no parameter
	// to build, nothing to create, revive, warn about or keep in step.
	if !sub
		&& flags & ASSPM_AUGMENT == 0
		&& direct_var(ex, name)?.map(|(ty, _)| ty) == Some(PmFlags::SCALAR)
		&& (flags & ASSPM_WARN == 0 || !opt(ex, ZshOpt::Warnnestedvar)?)
	{
		check_restricted(ex, name)?;
		return store_direct(ex, name, PmFlags::SCALAR, &unmetafy(&val));
	}
	revive_special(ex, name)?;
	let mut flags = flags;
	let mut created = false;
	let mut revived = None;
	if sub {
		// This first read only checks attributes. The target below fetches
		// its value; preserve computed getters without copying stored arrays.
		match getparam_in(ex, name, Defer::Stored)? {
			None => {
				let pm = create_new(ex, name, PmFlags::ARRAY)?;
				store_param(ex, &pm)?;
				created = true;
			},
			Some(pm) if pm.flags.contains(PmFlags::UNSET) && !pm.flags.contains(PmFlags::DECLARED) => {
				let pm = create_new(ex, name, PmFlags::ARRAY)?;
				store_param(ex, &pm)?;
				created = true;
			},
			Some(pm) if pm.flags.contains(PmFlags::READONLY) => return Err(readonly(name)),
			// An element of an existing parameter: nothing to warn about.
			Some(pm) => {
				if flags & ASSPM_AUGMENT == 0 {
					match assign_elem_in_place(ex, s, name, pm, &val)? {
						InPlace::Done => return Ok(()),
						InPlace::General(v) => revived = Some(*v),
						InPlace::Skipped => {},
					}
				}
				flags &= !ASSPM_WARN;
			},
		}
	} else {
		let existing = target(ex, name, 0)?;
		created = existing.is_none();
		let recreate = match &existing {
			None => true,
			Some(v) => {
				((v.pm.flags.contains(PmFlags::ARRAY) && flags & ASSPM_AUGMENT == 0)
					|| v.pm.flags.contains(PmFlags::HASHED))
					&& !v.pm.flags.intersects(PmFlags::SPECIAL.with(PmFlags::TIED))
					&& !opt(ex, ZshOpt::Ksharrays)?
			},
		};
		if recreate {
			if let Some(v) = &existing {
				if v.pm.flags.contains(PmFlags::READONLY) {
					return Err(readonly(name));
				}
				drop_shadowing_privates(ex, &v.pm)?;
				let local = v.pm.scope;
				let mut pm = create(ex, name, PmFlags::SCALAR)?;
				pm.scope = local;
				pm.flags = pm.flags.with(PmFlags(v.pm.flags.0 & PmFlags::EXPORTED.0));
				store_param(ex, &pm)?;
			} else {
				// zsh `createparam`: an unset read-only parameter (`readonly
				// x` under `POSIX_BUILTINS`) still refuses a value.
				let old = getparam(ex, name)?;
				if old
					.as_ref()
					.is_some_and(|p| p.flags.contains(PmFlags::READONLY))
				{
					return Err(readonly(name));
				}
				// zsh `createparam`: an unset special (`NUMERIC` without a
				// numeric argument) is no new parameter: it is set again,
				// through its own setter.
				match old {
					Some(mut pm) if pm.special.is_some_and(|sp| !sp.is_plain()) => {
						pm.flags = pm.flags.without(PmFlags::UNSET);
						revived = Some(Value::of(pm));
					},
					// A stored special `unset` kept (`unsetparam_pm`): set
					// again with its flags, `export` included.
					Some(mut pm) if matches!(pm.special, Some(Special::Plain(i)) if i != u8::MAX) => {
						pm.flags = pm.flags.without(PmFlags::UNSET);
						revived = Some(Value::of(pm));
					},
					_ => {
						let pm = create_new(ex, name, PmFlags::SCALAR)?;
						store_param(ex, &pm)?;
					},
				}
			}
		} else if existing
			.as_ref()
			.is_some_and(|v| v.pm.special.is_none_or(Special::is_plain))
		{
			// Ordinary targets have no computed getter to run again.
			revived = existing;
		}
	}
	let found = match revived {
		Some(v) => Some(v),
		None => target(ex, s, 0)?,
	};
	let Some(mut v) = found else {
		return Ok(());
	};
	if flags & ASSPM_WARN != 0 {
		check_warn_pm(ex, &v.pm, "scalar", created, true)?;
	}
	v.pm.flags = v.pm.flags.without(PmFlags::DECLARED);
	if flags & ASSPM_AUGMENT != 0 {
		if v.start == 0 && v.end == -1 && v.elem.is_none() {
			match v.pm.flags.type_bits() {
				PmFlags::SCALAR => v.start = i64::from(i32::MAX),
				PmFlags::INTEGER | PmFlags::EFLOAT | PmFlags::FFLOAT => {
					let rhs = arith::matheval(ex, &val)?;
					let lhs = v.getnumvalue(ex)?;
					let sum = match (lhs, rhs) {
						(Number::Float(a), b) => Number::Float(a + b.to_float()),
						(Number::Int(a), b) => Number::Int(a.wrapping_add(b.to_int())),
					};
					return setnumvalue(ex, &mut v, sum, None);
				},
				PmFlags::ARRAY => {
					if opt(ex, ZshOpt::Ksharrays)? {
						v.end = 1;
						return kshappend(ex, &mut v, val);
					}
					let n = match &v.pm.value {
						PValue::Array(a) => a.len(),
						_ => 0,
					};
					v.start = i64::try_from(n).unwrap_or(i64::MAX);
					v.end = v.start + 1;
				},
				_ => {},
			}
		} else if v.elem.is_some() {
			v.start = i64::from(i32::MAX);
		} else {
			match v.pm.flags.type_bits() {
				PmFlags::SCALAR => {
					if v.end > 0 {
						v.start = v.end;
					} else {
						let l = match &v.pm.value {
							PValue::Scalar(s) => metafy(s).len(),
							_ => 0,
						};
						v.start = i64::try_from(l).unwrap_or(0) + v.end + 1;
						v.end = v.start;
					}
				},
				PmFlags::INTEGER | PmFlags::EFLOAT | PmFlags::FFLOAT => {
					return Err(fail(Diag::ZshSubst {
						msg: BString::from("attempt to add to slice of a numeric variable"),
					}));
				},
				PmFlags::ARRAY => return kshappend(ex, &mut v, val),
				_ => {},
			}
		}
	}
	v.assignstrvalue(ex, &val, flags)
}

/// `a[i]+=x` on an array (and ksh's `a+=x`): the element at the end of the
/// slice gets `x` appended.
fn kshappend(ex: &mut Expander<'_, '_>, v: &mut Value, val: Vec<u8>) -> X<()> {
	let sstart = if v.end > 0 { v.end - 1 } else { v.end };
	v.start = sstart;
	v.isarr = 0;
	let mut cur = v.getstrvalue(ex)?;
	v.start = sstart;
	cur.extend_from_slice(&val);
	v.assignstrvalue(ex, &cur, 0)
}

/// zsh `setnumvalue`: store number `val` in what `v` selects (`text`: the
/// value as the arithmetic printed it, for scalar targets).
fn setnumvalue(
	ex: &mut Expander<'_, '_>,
	v: &mut Value,
	val: Number,
	text: Option<&[u8]>,
) -> X<()> {
	if v.pm.flags.contains(PmFlags::READONLY) {
		return Err(readonly(&v.pm.name));
	}
	check_restricted(ex, &v.pm.name)?;
	match (v.elem.is_some(), v.pm.flags.type_bits()) {
		(false, PmFlags::INTEGER) => {
			let t = int_text(ex, &v.pm, val.to_int())?;
			v.pm.value = PValue::Scalar(t);
			v.pm.flags = v.pm.flags.without(PmFlags::UNSET);
			store_param_assignment(ex, &v.pm, true)
		},
		(false, PmFlags::EFLOAT | PmFlags::FFLOAT) => {
			v.pm.value = PValue::Scalar(float_store(val.to_float()));
			v.pm.flags = v.pm.flags.without(PmFlags::UNSET);
			store_param_assignment(ex, &v.pm, true)
		},
		_ => {
			let t = match text {
				Some(t) => t.to_vec(),
				None => match val {
					Number::Int(i) => i.to_string().into_bytes(),
					Number::Float(d) => math::format_float(d).into_bytes(),
				},
			};
			v.assignstrvalue_assignment(ex, &t, 0, true)
		},
	}
}

/// zsh `assignaparam`: assign the array `val` (raw elements) to `name`
/// (raw; may carry a subscript: a slice). With [`ASSPM_KEY_VALUE`] the
/// elements are `Marker`/key/value triples.
///
/// # Errors
/// As [`assignsparam`].
pub fn assignaparam(
	ex: &mut Expander<'_, '_>,
	name: &[u8],
	val: Vec<BString>,
	flags: u32,
) -> X<()> {
	let s = metafy(name);
	let val = val.iter().map(|e| metafy(e)).collect();
	assignaparam_meta(ex, &s, val, flags)
}

/// [`assignaparam`] of a typeset `name=(…)` with `[key]=value` elements:
/// `val` is zsh's `ASG_KEY_VALUE` list (metafied, `Marker` triples).
///
/// # Errors
/// As [`assignaparam`]; `bad [key]=value syntax for associative array`
/// for a hash with plain elements.
pub fn assignaparam_kv(ex: &mut Expander<'_, '_>, name: &[u8], val: &[BString]) -> X<()> {
	let val = val.iter().map(|e| e.to_vec()).collect();
	assignaparam_meta(ex, &metafy(name), val, ASSPM_KEY_VALUE)
}

/// [`assignaparam`] on metafied text.
#[expect(clippy::too_many_lines, reason = "a faithful port of one C function")]
pub(super) fn assignaparam_meta(
	ex: &mut Expander<'_, '_>,
	s: &[u8],
	val: Vec<Vec<u8>>,
	flags: u32,
) -> X<()> {
	if !isident(s, wide_idents(ex)?) {
		return Err(not_ident(s));
	}
	// zsh `setarrvalue`: nothing is set under `NO_EXEC`.
	if !opt(ex, ZshOpt::Exec)? {
		return Ok(());
	}
	let (name, sub) = split_name(s);
	revive_special(ex, name)?;
	if flags & ASSPM_AUGMENT != 0
		&& flags & ASSPM_KEY_VALUE == 0
		&& !sub
		&& append_in_place(ex, name, &val, flags)?
	{
		return Ok(());
	}
	let mut val = val;
	let mut created = false;
	let mut may_warn_nested = true;
	if sub {
		match getparam(ex, name)? {
			Some(pm) if !pm.flags.contains(PmFlags::UNSET) || pm.flags.contains(PmFlags::DECLARED) => {
				if pm.flags.type_bits() == PmFlags::HASHED {
					return Err(bad_assign(name, "attempt to set slice of associative array"));
				}
				may_warn_nested = false;
			},
			_ => {
				let pm = create_new(ex, name, PmFlags::ARRAY)?;
				store_param(ex, &pm)?;
				created = true;
			},
		}
	} else {
		let existing = target(ex, name, SCANPM_ASSIGNING)?;
		match existing {
			None => {
				created = true;
				let pm = create_new(ex, name, PmFlags::ARRAY)?;
				store_param(ex, &pm)?;
			},
			Some(mut v)
				if !v.pm.flags.intersects(PmFlags::ARRAY.with(PmFlags::HASHED))
					&& !v.pm.flags.intersects(PmFlags::SPECIAL.with(PmFlags::TIED)) =>
			{
				if v.pm.flags.contains(PmFlags::READONLY) {
					return Err(readonly(name));
				}
				let uniq = PmFlags(v.pm.flags.0 & PmFlags::UNIQUE.0);
				if flags & ASSPM_AUGMENT != 0 {
					let old = v.getstrvalue(ex)?;
					val.insert(0, old);
				}
				drop_shadowing_privates(ex, &v.pm)?;
				let scope = v.pm.scope;
				let mut pm = create(ex, name, PmFlags::ARRAY.with(uniq))?;
				pm.scope = scope;
				store_param(ex, &pm)?;
			},
			Some(_) => {},
		}
	}
	let Some(mut v) = target(ex, s, SCANPM_ASSIGNING)? else {
		return Ok(());
	};
	if flags & ASSPM_WARN != 0 {
		check_warn_pm(ex, &v.pm, "array", created, may_warn_nested)?;
	}
	if flags & ASSPM_KEY_VALUE != 0 {
		if v.pm.flags.type_bits() == PmFlags::ARRAY {
			let ksh = opt(ex, ZshOpt::Ksharrays)?;
			let mut full: Vec<Option<Vec<u8>>> = if flags & ASSPM_AUGMENT != 0 {
				match &v.pm.value {
					PValue::Array(a) => a.iter().map(|e| Some(metafy(e))).collect(),
					_ => Vec::new(),
				}
			} else {
				Vec::new()
			};
			let mut nextind = 0usize;
			let mut it = val.into_iter();
			while let Some(e) = it.next() {
				if e.first() == Some(&MARKER) {
					let augment = e.get(1) == Some(&b'+');
					let Some(idx) = it.next() else { break };
					let Some(value) = it.next() else { break };
					let mut i = arith::mathevali(ex, &idx)?;
					if i < 0 || (!ksh && i == 0) {
						let mut shown = idx;
						untokenize(&mut shown);
						return Err(bad_subscript(format!(
							"bad subscript for direct array assignment: {}",
							BStr::new(&unmetafy(&shown))
						)));
					}
					if !ksh {
						i -= 1;
					}
					let i = usize::try_from(i).unwrap_or(0);
					if full.len() <= i {
						full.resize(i + 1, None);
					}
					let new = match (full.get(i).and_then(Option::as_ref), augment) {
						(Some(old), true) => {
							let mut s = old.clone();
							s.extend_from_slice(&value);
							s
						},
						_ => value,
					};
					if let Some(slot) = full.get_mut(i) {
						*slot = Some(new);
					}
					nextind = i + 1;
				} else {
					if full.len() <= nextind {
						full.resize(nextind + 1, None);
					}
					if let Some(slot) = full.get_mut(nextind) {
						*slot = Some(e);
					}
					nextind += 1;
				}
			}
			let full: Vec<Vec<u8>> = full.into_iter().map(Option::unwrap_or_default).collect();
			v.start = 0;
			v.end = -1;
			return v.setarrvalue(ex, full);
		} else if v.pm.flags.type_bits() == PmFlags::HASHED {
			let mut i = 0;
			while i < val.len() {
				if val[i].first() != Some(&MARKER) {
					return Err(fail(Diag::ZshSubst {
						msg: BString::from("bad [key]=value syntax for associative array"),
					}));
				}
				i += 3;
			}
		} else {
			return Err(fail(Diag::ZshSubst {
				msg: BString::from("invalid use of [key]=value assignment syntax"),
			}));
		}
	}
	if flags & ASSPM_AUGMENT != 0 {
		if v.start == 0 && v.end == -1 {
			if v.pm.flags.type_bits() == PmFlags::ARRAY {
				let n = match &v.pm.value {
					PValue::Array(a) => a.len(),
					_ => 0,
				};
				v.start = i64::try_from(n).unwrap_or(i64::MAX);
				v.end = v.start + 1;
			} else if v.pm.flags.type_bits() == PmFlags::HASHED {
				v.start = -1;
				v.end = 0;
			}
		} else if v.end > 0 {
			v.start = v.end;
			v.end -= 1;
		} else if v.pm.flags.type_bits() == PmFlags::ARRAY {
			let n = match &v.pm.value {
				PValue::Array(a) => a.len(),
				_ => 0,
			};
			v.end += i64::try_from(n).unwrap_or(0);
			v.start = v.end + 1;
		}
	}
	v.setarrvalue(ex, val)
}

/// zsh `unset` of identifier `name` (no subscript) reaching an autoloadable
/// parameter (`gethashnode2` does not load its module): the stub goes,
/// the module stays unloaded. `false` when no stub is the parameter
/// `name` names (a variable hides it, or none names it).
///
/// # Errors
/// A store failure.
pub fn unset_stub(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<bool> {
	Ok(read_var(ex, name)?.0.is_none() && zsh_module::remove_param_stub(ex, name)?)
}

/// zsh `createparam` on an unset module special (after `unset mapfile`,
/// `unset options`) sets it again instead of making a new parameter.
fn revive_special(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<()> {
	if name == b"mapfile" {
		crate::bash::vm::builtins::zsh_mod_mapfile::revive(ex)?;
	} else {
		zsh_module::set_param_unset(ex, name, false)?;
	}
	Ok(())
}

/// zsh `sethparam`: make `name` (raw) an association of the raw key/value
/// pairs `kv` (keys at even indexes).
///
/// # Errors
/// As [`sethparam_meta`].
pub fn sethparam(ex: &mut Expander<'_, '_>, name: &[u8], kv: &[BString]) -> X<()> {
	let kv = kv.iter().map(|e| metafy(e)).collect();
	sethparam_meta(ex, &metafy(name), kv)
}

/// zsh `sethparam` on metafied text: make `s` an association of the
/// key/value pairs `kv`.
///
/// # Errors
/// As [`assignsparam`]; a subscripted name is
/// `nested associative arrays not yet supported`.
pub(super) fn sethparam_meta(ex: &mut Expander<'_, '_>, s: &[u8], kv: Vec<Vec<u8>>) -> X<()> {
	if !isident(s, wide_idents(ex)?) {
		return Err(not_ident(s));
	}
	if split_name(s).1 {
		return Err(fail(Diag::ZshSubst {
			msg: BString::from("nested associative arrays not yet supported"),
		}));
	}
	// zsh `sethparam`: nothing is set under `NO_EXEC`.
	if !opt(ex, ZshOpt::Exec)? {
		return Ok(());
	}
	match target(ex, s, SCANPM_ASSIGNING)? {
		None => {
			let pm = create_new(ex, s, PmFlags::HASHED)?;
			store_param(ex, &pm)?;
		},
		Some(v) if v.pm.flags.type_bits() != PmFlags::HASHED => {
			if v.pm.flags.contains(PmFlags::SPECIAL) {
				return Err(bad_assign(s, "can't change type of a special parameter"));
			}
			if v.pm.flags.contains(PmFlags::READONLY) {
				return Err(readonly(s));
			}
			drop_shadowing_privates(ex, &v.pm)?;
			let scope = v.pm.scope;
			let mut pm = create(ex, s, PmFlags::HASHED)?;
			pm.scope = scope;
			store_param(ex, &pm)?;
		},
		Some(_) => {},
	}
	let Some(mut v) = target(ex, s, SCANPM_ASSIGNING)? else {
		return Ok(());
	};
	v.setarrvalue(ex, kv)
}

/// zsh `assignnparam` (`setnparam`): assign the number `val` to `lval`
/// (may carry a subscript): an integer or float parameter takes the
/// number, a scalar or element takes `text` (the value as printed); a new
/// name becomes an integer (base `radix`) or float parameter. Returns the
/// type assigned, as the arithmetic evaluator needs it.
///
/// # Errors
/// As [`assignsparam`].
pub fn setnparam(
	ex: &mut Expander<'_, '_>,
	lval: &[u8],
	val: Number,
	text: &[u8],
	radix: i32,
) -> X<Assigned> {
	let mut s = lval.to_vec();
	untokenize(&mut s);
	if !isident(&s, wide_idents(ex)?) {
		return Err(not_ident(&s));
	}
	let (name, sub) = split_name(&s);
	// An existing ordinary number or scalar takes the value directly (see
	// `assignsparam_meta`); `setnumvalue` reports it as assigned.
	if !sub
		&& let Some((ty, base)) = direct_var(ex, name)?
		&& !opt(ex, ZshOpt::Warnnestedvar)?
	{
		let (value, assigned) = match number_text(ex, ty, base, val)? {
			Some(numeric) => numeric,
			None => (BString::from(text), Assigned::Other),
		};
		return store_number(ex, name, ty, &value).map(|()| assigned);
	}
	let mut v = target(ex, &s, 0)?;
	let was_unset = if let Some(cur) = &v
		&& cur
			.pm
			.flags
			.intersects(PmFlags::ARRAY.with(PmFlags::HASHED))
		&& !cur
			.pm
			.flags
			.intersects(PmFlags::SPECIAL.with(PmFlags::TIED))
		&& !opt(ex, ZshOpt::Ksharrays)?
		&& !sub
	{
		if cur.pm.flags.contains(PmFlags::READONLY) {
			return Err(readonly(name));
		}
		unset_pm(ex, &cur.pm)?;
		true
	} else {
		false
	};
	if was_unset {
		v = None;
	}
	// A stored special `unset` kept (`unsetparam_pm`) is set again with
	// its flags, `export` included.
	if v.is_none()
		&& !sub
		&& let Some(mut pm) = getparam(ex, name)?
		&& pm.flags.contains(PmFlags::UNSET)
		&& matches!(pm.special, Some(Special::Plain(i)) if i != u8::MAX)
	{
		pm.flags = pm.flags.without(PmFlags::UNSET);
		v = Some(Value::of(pm));
	}
	let mut v = if let Some(v) = v {
		check_warn_pm(ex, &v.pm, "numeric", false, true)?;
		v
	} else {
		let ty = if sub {
			PmFlags::ARRAY
		} else if opt(ex, ZshOpt::Posixidentifiers)? {
			PmFlags::SCALAR
		} else if val.is_float() {
			PmFlags::FFLOAT
		} else {
			PmFlags::INTEGER
		};
		// zsh `setnparam` unsets an array first, removing the parameter
		// table node `createparam` would otherwise find.
		let mut pm = if was_unset {
			create(ex, name, ty)?
		} else {
			create_new(ex, name, ty)?
		};
		if ty == PmFlags::INTEGER {
			pm.base = u8::try_from(radix).unwrap_or(0);
		}
		if ty == PmFlags::INTEGER || ty == PmFlags::FFLOAT {
			pm.value = PValue::Scalar(BString::default());
		}
		store_param(ex, &pm)?;
		match target(ex, &s, 0)? {
			Some(v) => {
				check_warn_pm(ex, &v.pm, "numeric", !was_unset, true)?;
				v
			},
			None => return Ok(Assigned::Other),
		}
	};
	let assigned = match (v.elem.is_some(), v.pm.flags.type_bits()) {
		(false, PmFlags::INTEGER) => Assigned::Integer,
		(false, PmFlags::EFLOAT | PmFlags::FFLOAT) => Assigned::Float,
		_ => Assigned::Other,
	};
	setnumvalue(ex, &mut v, val, Some(text))?;
	Ok(assigned)
}

/// [`setnparam`] of a plain name that is a direct integer or float
/// ([`direct_var`]), stored without the text a scalar target would take
/// (the evaluator need not format the number first); `None` for any other
/// target.
///
/// # Errors
/// As [`setnparam`].
pub fn setnparam_number(
	ex: &mut Expander<'_, '_>,
	lval: &[u8],
	val: Number,
) -> X<Option<Assigned>> {
	let Some((ty, base)) = direct_var(ex, lval)? else {
		return Ok(None);
	};
	if opt(ex, ZshOpt::Warnnestedvar)? {
		return Ok(None);
	}
	let Some((value, assigned)) = number_text(ex, ty, base, val)? else {
		return Ok(None);
	};
	store_number(ex, lval, ty, &value)?;
	Ok(Some(assigned))
}

/// The stored text of number `val` in a direct variable of type `ty`
/// (output base `base` for an integer); `None` for a scalar.
fn number_text(
	ex: &mut Expander<'_, '_>,
	ty: PmFlags,
	base: u8,
	val: Number,
) -> X<Option<(BString, Assigned)>> {
	Ok(Some(match ty {
		// Decimal needs none of the options `convbase` takes.
		PmFlags::INTEGER if matches!(base, 0 | 1 | 10) => {
			(BString::from(val.to_int().to_string()), Assigned::Integer)
		},
		PmFlags::INTEGER => {
			let o = arith::math_options(ex)?;
			(BString::from(math::convbase(val.to_int(), i32::from(base), o)), Assigned::Integer)
		},
		PmFlags::EFLOAT | PmFlags::FFLOAT => (float_store(val.to_float()), Assigned::Float),
		_ => return Ok(None),
	}))
}

/// Store an arithmetic result in direct variable `name` ([`store_direct`])
/// as `setnumvalue` does: restricted names refused, the assignment
/// reported.
fn store_number(ex: &mut Expander<'_, '_>, name: &[u8], ty: PmFlags, value: &[u8]) -> X<()> {
	check_restricted(ex, name)?;
	store_direct(ex, name, ty, value)?;
	super::super::builtins::emit_assignment(ex.k, ex.cx, ex.vp, name, Level::Dynamic);
	Ok(())
}

/// [`getmathparam`] of a plain name when it is a direct variable
/// ([`direct_var`]): its number, or its text for a scalar, read in place.
/// `None`: not such a variable (the caller takes the general path).
///
/// # Errors
/// A store failure.
pub fn direct_math_value(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<math::Param>> {
	if !plain_ident(name) || specials::lookup(name).is_some() {
		return Ok(None);
	}
	let Some(var) = read_var(ex, name)?.0 else {
		return Ok(None);
	};
	let (Some(ty), VarValue::Str(s)) = (direct_type(var), &var.value) else {
		return Ok(None);
	};
	Ok(Some(match ty {
		PmFlags::INTEGER => math::Param::Int(parse_int(s)),
		PmFlags::EFLOAT | PmFlags::FFLOAT => math::Param::Float(parse_float(s)),
		_ => math::Param::Text(s.clone()),
	}))
}

/// The value arithmetic reads for `lval` (zsh `getvalue` +
/// `getnumvalue`): an integer or float parameter's number, else its text
/// (an array joined with spaces), with the [`Value`] it resolved to;
/// `None` when unset.
///
/// # Errors
/// A subscript error, a parked substitution, a store failure.
pub fn getmathparam(ex: &mut Expander<'_, '_>, lval: &[u8]) -> X<Option<(math::Param, Value)>> {
	let mut pos = 0;
	let Some(mut v) = fetchvalue(ex, lval, &mut pos, 1, 0)? else {
		return Ok(None);
	};
	if v.flags & VALFLAG_INV != 0 {
		return Ok(Some((math::Param::Int(v.start), v)));
	}
	if v.elem.is_none() && v.isarr == 0 {
		let n = match (v.pm.flags.type_bits(), &v.pm.value) {
			(PmFlags::INTEGER, PValue::Scalar(s)) if v.start == 0 && v.end == -1 => {
				Some(math::Param::Int(parse_int(s)))
			},
			(PmFlags::EFLOAT | PmFlags::FFLOAT, PValue::Scalar(s)) if v.start == 0 && v.end == -1 => {
				Some(math::Param::Float(parse_float(s)))
			},
			_ => None,
		};
		if let Some(n) = n {
			return Ok(Some((n, v)));
		}
	}
	if v.pm.flags.contains(PmFlags::UNSET) && v.elem.is_none() {
		return Ok(None);
	}
	let s = if v.isarr != 0 {
		let a = v.getarrvalue(ex)?;
		text::sepjoin(&a, Some(b" "), None, false)
	} else {
		v.getstrvalue(ex)?
	};
	Ok(Some((math::Param::Text(BString::from(unmetafy(&s))), v)))
}

/// zsh `setmathvar` through the value [`getmathparam`] resolved: store
/// `val` (`text` for scalar targets) in what `v` selects, without
/// evaluating its subscript again, when the parameter of that name is
/// still the one `v` was resolved in; `false` when it is not (the caller
/// assigns by name).
///
/// # Errors
/// Read-only variables, a store failure.
pub fn setmathvalue(ex: &mut Expander<'_, '_>, v: &Value, val: Number, text: &[u8]) -> X<bool> {
	let Some(pm) = getparam(ex, &v.pm.name)? else {
		return Ok(false);
	};
	if pm.scope != v.pm.scope || pm.flags.contains(PmFlags::UNSET) {
		return Ok(false);
	}
	let mut v = Value {
		pm,
		elem: v.elem.clone(),
		isarr: v.isarr,
		flags: v.flags,
		start: v.start,
		end: v.end,
		arr: None,
		scan: v.scan.clone(),
	};
	setnumvalue(ex, &mut v, val, Some(text))?;
	Ok(true)
}

/// zsh `unsetparam` / the `unset` builtin's element form: unset `name`
/// (raw), or with a subscript one array element (made empty) or one
/// association key (removed).
///
/// # Errors
/// Read-only errors, a bad subscript, a store failure.
pub fn unsetparam(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<()> {
	let s = metafy(name);
	let (base, sub) = split_name(&s);
	if !sub {
		if unset_stub(ex, base)? {
			return Ok(());
		}
		if let Some(pm) = getparam(ex, base)? {
			unset_pm(ex, &pm)?;
		}
		return Ok(());
	}
	// zsh's `bin_unset` reaches the elements of the unset zsh/mapfile
	// special too (its hash table is still there): the file goes, the
	// special stays unset.
	let mapfile_unset =
		base == b"mapfile" && crate::bash::vm::builtins::zsh_mod_mapfile::is_unset(ex)?;
	if mapfile_unset {
		crate::bash::vm::builtins::zsh_mod_mapfile::mark_unset(ex, false);
	}
	let found = target(ex, &s, 0);
	if mapfile_unset {
		crate::bash::vm::builtins::zsh_mod_mapfile::mark_unset(ex, true);
	}
	let Some(mut v) = found? else {
		return Ok(());
	};
	if v.pm.flags.contains(PmFlags::READONLY) {
		return Err(readonly(&v.pm.name));
	}
	if let Some(e) = v.elem.take() {
		if v.pm.special == Some(Special::Mapfile) {
			// zsh/mapfile's `unsetpmmapfile` removes the file.
			return crate::bash::vm::builtins::zsh_mod_mapfile::unset(ex, &e.key);
		}
		if v.pm.special.is_none() && v.pm.tied.is_none() {
			// zsh's tables never shrink: the other entries keep their
			// order, so the stored table loses the one entry in place.
			let (var, _) = read_var(ex, &v.pm.name)?;
			if var.is_some_and(|var| matches!(var.value, VarValue::Assoc(_))) {
				let edit = state::VarEdit::Remove(crate::bash::store::Elem::Key(BStr::new(&e.key)));
				state::edit_var(&mut ex.k.root, ex.cx.store, ex.vp, &v.pm.name, Level::Dynamic, edit)?;
				return Ok(());
			}
		}
		v.pm.materialize(ex)?;
		let mut h = match &v.pm.value {
			PValue::Hash(h) => ZHash::from_stored(h, v.pm.attrs),
			_ => return Ok(()),
		};
		h.remove(&e.key);
		let (items, attrs) = h.into_stored(v.pm.attrs);
		v.pm.attrs = attrs;
		v.pm.value = PValue::Hash(items);
		return store_param(ex, &v.pm);
	}
	if v.pm.flags.type_bits() == PmFlags::ARRAY && v.isarr == 0 {
		// zsh: `unset 'a[i]'` sets the element to the empty string.
		v.end = v.start + 1;
		return v.setarrvalue(ex, vec![Vec::new()]);
	}
	Err(bad_subscript(format!("{}: invalid element for unset", BStr::new(&unmetafy(base)))))
}

// ---- typeset hooks --------------------------------------------------------

/// zsh `createparam` with `typeset`'s flags: a new (or redeclared) empty
/// parameter `name` (raw) of type `flags` at `level` (`Local`: the
/// innermost function's scope, `local`/`typeset` inside a function;
/// `Global`: `typeset -g`/top level). [`PmFlags::HIDE`] makes a local
/// hide a special's specialness; [`PmFlags::UNSET`] declares it unset.
pub fn createparam(
	ex: &mut Expander<'_, '_>,
	name: &[u8],
	flags: PmFlags,
	width: u16,
	base: u8,
	level: Level,
) {
	let mut pm = Param::new(name, flags.without(PmFlags::LOCAL).without(PmFlags::SPECIAL));
	pm.width = width;
	pm.base = base;
	pm.attrs = pm.flags.to_attrs(width, base);
	if flags.contains(PmFlags::UNSET) {
		let attrs = pm.attrs.with(Attrs::INVISIBLE);
		let value = match flags.type_bits() {
			PmFlags::ARRAY => VarValue::Indexed(Vec::new()),
			PmFlags::HASHED => VarValue::Assoc(Default::default()),
			_ => VarValue::Str(BString::default()),
		};
		state::store_var(&mut ex.k.root, ex.cx.store, ex.vp, name, Some(Var { attrs, value }), level);
		return;
	}
	let value = match &pm.value {
		PValue::Scalar(s) => VarValue::Str(s.clone()),
		PValue::Array(_) => VarValue::Indexed(Vec::new()),
		PValue::Hash(_) => VarValue::Assoc(Default::default()),
	};
	state::store_var(
		&mut ex.k.root,
		ex.cx.store,
		ex.vp,
		name,
		Some(Var { attrs: pm.attrs, value }),
		level,
	);
}

/// [`createparam`] in an explicit scope: scope index `scope` of the vproc
/// (`state::binding_scope` numbering), or the global level (`None`): zsh
/// re-creating a parameter at the level it had (`typeset_single`'s
/// `keeplocal`).
pub fn createparam_at(
	ex: &mut Expander<'_, '_>,
	name: &[u8],
	flags: PmFlags,
	width: u16,
	base: u8,
	scope: Option<usize>,
) {
	let Some(i) = scope else {
		createparam(ex, name, flags, width, base, Level::Global);
		return;
	};
	let base_flags = flags.without(PmFlags::LOCAL).without(PmFlags::SPECIAL);
	let attrs = base_flags.to_attrs(width, base);
	let value = match base_flags.type_bits() {
		PmFlags::ARRAY => VarValue::Indexed(Vec::new()),
		PmFlags::HASHED => VarValue::Assoc(Default::default()),
		_ => VarValue::Str(BString::default()),
	};
	state::scope_set(&mut ex.k.root, ex.cx.store, ex.vp, i, name, Some(Var { attrs, value }));
}

/// `typeset` changing the flags of the visible parameter `name` (raw):
/// its value converted as zsh's `typeset_single` does (scalar ↔ integer
/// and float reformatted through the math code, `-U` applied now).
///
/// # Errors
/// A math error converting the value, a store failure.
pub fn set_flags(
	ex: &mut Expander<'_, '_>,
	name: &[u8],
	flags: PmFlags,
	width: u16,
	base: u8,
) -> X<()> {
	let Some(mut pm) = getparam(ex, name)? else {
		createparam(ex, name, flags, width, base, Level::Dynamic);
		return Ok(());
	};
	let old_type = pm.flags.type_bits();
	let new_type = flags.type_bits();
	let text = pm.text();
	pm.flags = PmFlags(
		(flags.0 & !(PmFlags::SPECIAL.0 | PmFlags::LOCAL.0)) | (pm.flags.0 & PmFlags::UNSET.0),
	);
	pm.width = width;
	pm.base = base;
	if let Some(sp) = pm.special.filter(|s| !s.is_plain()) {
		if sp == Special::Seconds {
			specials::set_seconds_type(ex, new_type, base);
			return Ok(());
		}
		// `typeset ±U path`: the array side of a special tie, whose value its
		// scalar's record holds, marks its uniqueness there (scoped with
		// it, `local -U path`) and drops repeated entries now.
		if let Special::TiedArray(t) = sp {
			let unique = flags.contains(PmFlags::UNIQUE);
			let scalar = t.scalar().as_bytes();
			if let Some(mut var) = state::lookup(&ex.k.root, ex.cx.store, ex.vp, scalar)?.cloned() {
				var.attrs = if unique {
					var.attrs.with(Attrs::ZSH_UNIQUE)
				} else {
					var.attrs.without(Attrs::ZSH_UNIQUE)
				};
				state::store_var(&mut ex.k.root, ex.cx.store, ex.vp, scalar, Some(var), Level::Dynamic);
			}
			if unique {
				store_param(ex, &pm)?;
			}
			return Ok(());
		}
		// `typeset ±h` on a module's `PM_HIDE` special.
		if sp.module().is_some() && sp.flags().contains(PmFlags::HIDE) {
			let hide = flags.contains(PmFlags::HIDE);
			crate::bash::vm::builtins::zsh_module::set_param_hidden(ex, name, hide)?;
		}
		return Ok(());
	}
	match new_type {
		PmFlags::INTEGER if !pm.flags.contains(PmFlags::UNSET) => {
			let n = if text.is_empty() {
				0
			} else {
				arith::mathevali(ex, &metafy(&text))?
			};
			pm.value = PValue::Scalar(int_text(ex, &pm, n)?);
		},
		PmFlags::EFLOAT | PmFlags::FFLOAT if !pm.flags.contains(PmFlags::UNSET) => {
			let d = if text.is_empty() {
				0.0
			} else {
				arith::matheval(ex, &metafy(&text))?.to_float()
			};
			pm.value = PValue::Scalar(float_store(d));
		},
		PmFlags::ARRAY if old_type != PmFlags::ARRAY => {
			pm.value = PValue::Array(if text.is_empty() {
				Vec::new()
			} else {
				vec![text]
			});
		},
		PmFlags::HASHED if old_type != PmFlags::HASHED => pm.value = PValue::Hash(Vec::new()),
		PmFlags::SCALAR if old_type != PmFlags::SCALAR => pm.value = PValue::Scalar(text),
		_ => {},
	}
	store_param(ex, &pm)
}

/// `typeset -T SCALAR array [sep]` (zsh `typeset_single`'s tie handling):
/// a fresh, empty pair `scalar` / `array` (raw names) in scope `scope`
/// (scope index; `None`: global). The scalar gets `flags` with
/// [`PmFlags::TIED`]; the array gets `ARRAY|TIED` and the same flags
/// minus `EXPORTED`. The relation is recorded ([`MiscKey::ZshTies`]); the
/// caller assigns a value afterwards.
///
/// # Errors
/// A store failure.
#[expect(clippy::too_many_arguments, reason = "typeset's tie carries every attribute")]
pub fn tie(
	ex: &mut Expander<'_, '_>,
	scalar: &[u8],
	array: &[u8],
	sep: u8,
	flags: PmFlags,
	width: u16,
	base: u8,
	scope: Option<usize>,
) -> X<()> {
	drop_tie(ex, scalar)?;
	drop_tie(ex, array)?;
	let sflags = PmFlags(flags.0 & !PmFlags(PmFlags::TYPE_MASK).0)
		.with(PmFlags::TIED)
		.without(PmFlags::UNSET);
	let aflags = sflags.without(PmFlags::EXPORTED).with(PmFlags::ARRAY);
	for (name, f, value) in [
		(scalar, sflags, VarValue::Str(BString::default())),
		(array, aflags, VarValue::Indexed(Vec::new())),
	] {
		let var = Var { attrs: f.to_attrs(width, base), value };
		match scope {
			Some(i) => state::scope_set(&mut ex.k.root, ex.cx.store, ex.vp, i, name, Some(var)),
			None => {
				state::store_var(&mut ex.k.root, ex.cx.store, ex.vp, name, Some(var), Level::Global);
			},
		}
	}
	let mut words = match state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ZshTies))? {
		Some(Record::Words(w)) => w.clone(),
		_ => Vec::new(),
	};
	words.extend([BString::from(scalar), BString::from(array), BString::from(vec![sep])]);
	state::store_record(
		&mut ex.k.root,
		ex.cx.store,
		ex.vp,
		KeyBuf::Misc(MiscKey::ZshTies),
		Some(Record::Words(words)),
	);
	Ok(())
}

/// Run `f` with an [`Expander`] over a builtin's context: its kernel,
/// state, vproc, line and replay log (a command substitution in a
/// subscript returns [`Stop::Sub`], which the builtin turns into its
/// `Need::Sub` and re-runs).
///
/// # Errors
/// Whatever `f` returns.
pub fn with_ctx<T>(ctx: &mut Ctx<'_, '_>, f: impl FnOnce(&mut Expander<'_, '_>) -> X<T>) -> X<T> {
	let line = ctx.line;
	let mut ex = Expander::new(ctx.k, ctx.cx, ctx.vp, &mut ctx.log, true, line);
	ex.cursor = ctx.log_cursor;
	let r = super::subst::begin_pass(&mut ex).and_then(|()| f(&mut ex));
	let cursor = ex.cursor;
	ctx.log_cursor = cursor;
	r
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn sparse_arrays_read_dense_with_gaps_filled() {
		let items = vec![(0, BString::from("a")), (3, BString::from("d"))];
		let (d, sparse) = dense(&items);
		assert!(sparse);
		assert_eq!(d, [
			BString::from("a"),
			BString::default(),
			BString::default(),
			BString::from("d")
		]);
		let (d, sparse) = dense(&[(0, BString::from("x")), (1, BString::from("y"))]);
		assert!(!sparse);
		assert_eq!(d.len(), 2);
	}

	#[test]
	fn flags_round_trip_through_store_attributes() {
		let f = PmFlags::INTEGER
			.with(PmFlags::RIGHT_Z)
			.with(PmFlags::READONLY);
		let a = f.to_attrs(5, 16);
		let v = Var { attrs: a, value: VarValue::Str(BString::from("16#00FF")) };
		let back = PmFlags::from_var(&v);
		assert_eq!(back, f);
		assert_eq!((a.width(), a.base()), (5, 16));
	}

	#[test]
	fn stored_integers_parse_with_their_base() {
		assert_eq!(parse_int(b"16#FF"), 255);
		assert_eq!(parse_int(b"-2#101"), -5);
		assert_eq!(parse_int(b"0x10"), 16);
		assert_eq!(parse_int(b"42"), 42);
	}

	#[test]
	fn isident_accepts_balanced_subscripts() {
		assert!(isident(b"a", false));
		assert!(isident(b"a[1]", false));
		assert!(isident(b"a[(i)x]", false));
		assert!(isident(b"12", false));
		assert!(!isident(b"a[", false));
		assert!(!isident(b"1a", false));
		assert!(!isident(b"", false));
		assert!(isident("hähä".as_bytes(), true));
		assert!(!isident("hähä".as_bytes(), false));
	}

	#[test]
	fn padding_matches_zsh() {
		// zsh: typeset -Z 5 x=12; typeset -L 4 y=abcdef; typeset -R 4 z=ab
		let mut p = Param::new(b"x", PmFlags::RIGHT_Z);
		p.width = 5;
		assert_eq!(pad_and_case(&p, b"12".to_vec(), false, false), b"00012");
		let mut p = Param::new(b"y", PmFlags::LEFT);
		p.width = 4;
		assert_eq!(pad_and_case(&p, b"abcdef".to_vec(), false, false), b"abcd");
		// zsh: typeset -L 4 y=ééééé; the width counts characters.
		assert_eq!(pad_and_case(&p, "ééééé".as_bytes().to_vec(), false, true), "éééé".as_bytes());
		let mut p = Param::new(b"z", PmFlags::RIGHT_B);
		p.width = 4;
		assert_eq!(pad_and_case(&p, b"ab".to_vec(), false, false), b"  ab");
		let mut p = Param::new(b"i", PmFlags::INTEGER.with(PmFlags::RIGHT_Z));
		p.width = 6;
		assert_eq!(pad_and_case(&p, b"-16#F".to_vec(), false, false), b"-16#0F");
	}
}
