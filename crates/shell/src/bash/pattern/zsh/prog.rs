//! The compiled form of a zsh pattern: zsh 5.9 `pattern.c`'s program of
//! `union upat` units and the `struct patprog` header (`zsh.h`).
//!
//! A program is a vector of [`Upat`] units. Index 0 is never a node (zsh's
//! programme starts after the header at `startoff`), so 0 stands for zsh's
//! NULL "next" pointer. A node's operands follow it: `P_OPERAND(p)` is
//! `p + 1`, and next links are distances in units, backwards for
//! [`P_BACK`], so relocating a chunk (zsh `patinsert`) keeps them valid.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use super::{PatFlags, class::SetItem};

/// Number of parentheses that can capture under `(#b)` (zsh `NSUBEXP`).
pub(super) const NSUBEXP: usize = 9;

/// End of program (zsh `P_END`).
pub(super) const P_END: u8 = 0x00;
/// Test if the following exclusion already failed (zsh `P_EXCSYNC`).
pub(super) const P_EXCSYNC: u8 = 0x01;
/// Test if the exclusion matched the original branch (zsh `P_EXCEND`).
pub(super) const P_EXCEND: u8 = 0x02;
/// Match "", next points backward (zsh `P_BACK`).
pub(super) const P_BACK: u8 = 0x03;
/// Match the operand string (zsh `P_EXACTLY`).
pub(super) const P_EXACTLY: u8 = 0x04;
/// Match the empty string (zsh `P_NOTHING`).
pub(super) const P_NOTHING: u8 = 0x05;
/// Simple operand 0 or more times (zsh `P_ONEHASH`).
pub(super) const P_ONEHASH: u8 = 0x06;
/// Simple operand 1 or more times (zsh `P_TWOHASH`).
pub(super) const P_TWOHASH: u8 = 0x07;
/// Match nothing and set the globbing flags (zsh `P_GFLAGS`).
pub(super) const P_GFLAGS: u8 = 0x08;
/// `(#s)`: start of string (zsh `P_ISSTART`).
pub(super) const P_ISSTART: u8 = 0x09;
/// `(#e)`: end of string (zsh `P_ISEND`).
pub(super) const P_ISEND: u8 = 0x0a;
/// Initialise a `P_COUNT` (zsh `P_COUNTSTART`).
pub(super) const P_COUNTSTART: u8 = 0x0b;
/// `(#cN,M)` repetition (zsh `P_COUNT`).
pub(super) const P_COUNT: u8 = 0x0c;
/// An alternative (zsh `P_BRANCH`).
pub(super) const P_BRANCH: u8 = 0x20;
/// An alternative that must consume input (zsh `P_WBRANCH`).
pub(super) const P_WBRANCH: u8 = 0x21;
/// Exclude this from the previous branch (zsh `P_EXCLUDE`).
pub(super) const P_EXCLUDE: u8 = 0x30;
/// Exclusion against the whole path so far (zsh `P_EXCLUDP`).
pub(super) const P_EXCLUDP: u8 = 0x31;
/// `?` (zsh `P_ANY`).
pub(super) const P_ANY: u8 = 0x40;
/// `[...]` (zsh `P_ANYOF`).
pub(super) const P_ANYOF: u8 = 0x41;
/// `[^...]` (zsh `P_ANYBUT`).
pub(super) const P_ANYBUT: u8 = 0x42;
/// `*` (zsh `P_STAR`).
pub(super) const P_STAR: u8 = 0x43;
/// `<n-m>` (zsh `P_NUMRNG`).
pub(super) const P_NUMRNG: u8 = 0x44;
/// `<n->` (zsh `P_NUMFROM`).
pub(super) const P_NUMFROM: u8 = 0x45;
/// `<-m>` (zsh `P_NUMTO`).
pub(super) const P_NUMTO: u8 = 0x46;
/// `<->` (zsh `P_NUMANY`).
pub(super) const P_NUMANY: u8 = 0x47;
/// Start of capture `n` is `P_OPEN + n` (zsh `P_OPEN`).
pub(super) const P_OPEN: u8 = 0x80;
/// End of capture `n` is `P_CLOSE + n` (zsh `P_CLOSE`).
pub(super) const P_CLOSE: u8 = 0x90;

/// Operand offset of a `P_COUNT` (zsh `P_CT_OPERAND`; the count arguments
/// occupy one [`Upat::Count`] unit here).
pub(super) const P_CT_OPERAND: usize = 2;

/// Piece is simple enough to be a `#`/`##` operand (zsh `P_SIMPLE`).
pub(super) const P_SIMPLE: u8 = 0x01;
/// Starts with a `#` or `##` closure (zsh `P_HSTART`).
pub(super) const P_HSTART: u8 = 0x02;
/// Can be matched with a string compare (zsh `P_PURESTR`).
pub(super) const P_PURESTR: u8 = 0x04;

/// Globbing flags: the low 8 bits are the approximation error count.
pub(super) const GF_ERRS: u32 = 0xff;
/// `(#l)` (zsh `GF_LCMATCHUC`).
pub(super) const GF_LCMATCHUC: u32 = 0x0100;
/// `(#i)` (zsh `GF_IGNCASE`).
pub(super) const GF_IGNCASE: u32 = 0x0200;
/// `(#b)` (zsh `GF_BACKREF`).
pub(super) const GF_BACKREF: u32 = 0x0400;
/// `(#m)` (zsh `GF_MATCHREF`).
pub(super) const GF_MATCHREF: u32 = 0x0800;
/// `(#u)`, the `MULTIBYTE` option (zsh `GF_MULTIBYTE`).
pub(super) const GF_MULTIBYTE: u32 = 0x1000;

/// One unit of a compiled program (zsh `union upat`): a node, or an operand
/// of the node before it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Upat {
	/// An operator and the distance to the next node, 0 for none (zsh
	/// `P_OP`/`P_NEXT`).
	Node { op: u8, next: u32 },
	/// `P_EXACTLY` operand: unmetafied, untokenized text (zsh `lstr`).
	Exact(Box<[u8]>),
	/// `P_ANYOF`/`P_ANYBUT` operand (zsh's `str` with `PP_*` codes).
	Set(Box<[SetItem]>),
	/// A bound of a numeric range (zsh `zrange_t`).
	Num(i64),
	/// `P_GFLAGS` operand.
	Flags(u32),
	/// The match-time scratch slot of a `P_WBRANCH`, `P_EXCLUDE` or
	/// `P_EXCLUDP` (zsh's `uc*` operand, NULL at compile time).
	Sync(u16),
	/// `P_COUNT` arguments; `max` is -1 for no maximum, `slot` indexes the
	/// match-time count state (zsh `P_CT_CURRENT`, `P_CT_PTR`).
	Count { min: i64, max: i64, slot: u16 },
}

/// A compiled pattern (zsh `struct patprog` plus its programme).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Prog {
	/// The programme; empty for `PAT_PURES` and `PAT_ANY`.
	pub code:      Box<[Upat]>,
	/// The pure string of a `PAT_PURES` pattern, unmetafied.
	pub pure:      Box<[u8]>,
	/// The string that must occur in a subject (zsh `mustoff`/`patmlen`).
	pub must:      Option<Box<[u8]>>,
	/// Globbing flags at the start (zsh `globflags`).
	pub globflags: u32,
	/// Globbing flags after the end (zsh `globend`).
	pub globend:   u32,
	/// `PAT_*` flags (zsh `flags`).
	pub flags:     PatFlags,
	/// Number of capturing parentheses (zsh `patnpar`).
	pub npar:      u8,
	/// Scratch slots the programme's `Upat::Sync` operands index.
	pub nsync:     u16,
	/// Count slots the programme's `Upat::Count` operands index.
	pub ncount:    u16,
	/// The `MULTIBYTE` option at compile time, which zsh's `CHARSUB` and
	/// `MB_METASTRLEN` read when they count characters.
	pub multibyte: bool,
}

impl Prog {
	/// The operator of node `p` (zsh `P_OP`).
	#[inline]
	pub fn op(&self, p: usize) -> u8 {
		op_at(&self.code, p)
	}

	/// The node after `p`, 0 for none (zsh `PATNEXT`).
	#[inline]
	pub fn next(&self, p: usize) -> usize {
		next_at(&self.code, p)
	}

	/// The `P_EXACTLY` string of node `p` (zsh `P_LS_STR`, `P_LS_LEN`).
	#[inline]
	pub fn exact(&self, p: usize) -> &[u8] {
		match self.code.get(p + 1) {
			Some(Upat::Exact(s)) => s,
			_ => &[],
		}
	}

	/// The `P_ANYOF`/`P_ANYBUT` set of node `p`.
	#[inline]
	pub fn set(&self, p: usize) -> &[SetItem] {
		match self.code.get(p + 1) {
			Some(Upat::Set(s)) => s,
			_ => &[],
		}
	}

	/// The numeric operand at unit `p`.
	#[inline]
	pub fn num(&self, p: usize) -> i64 {
		match self.code.get(p) {
			Some(Upat::Num(n)) => *n,
			_ => 0,
		}
	}

	/// The `P_GFLAGS` operand of node `p`.
	#[inline]
	pub fn gflags(&self, p: usize) -> u32 {
		match self.code.get(p + 1) {
			Some(Upat::Flags(f)) => *f,
			_ => 0,
		}
	}

	/// The scratch slot of the `P_WBRANCH`/`P_EXCLUDE` node `p`.
	#[inline]
	pub fn sync(&self, p: usize) -> usize {
		match self.code.get(p + 1) {
			Some(Upat::Sync(s)) => *s as usize,
			_ => usize::MAX,
		}
	}

	/// The `(min, max, slot)` arguments of the `P_COUNT` node `p`.
	#[inline]
	pub fn count(&self, p: usize) -> (i64, i64, usize) {
		match self.code.get(p + 1) {
			Some(Upat::Count { min, max, slot }) => (*min, *max, *slot as usize),
			_ => (0, -1, usize::MAX),
		}
	}
}

/// The operator of node `p` of `code` (zsh `P_OP`); `0xff` for index 0 and
/// for operand units, which no operator test accepts.
#[inline]
pub(super) fn op_at(code: &[Upat], p: usize) -> u8 {
	match code.get(p) {
		Some(Upat::Node { op, .. }) if p != 0 => *op,
		_ => 0xff,
	}
}

/// The node after `p` in `code`, 0 for none (zsh `PATNEXT`).
#[inline]
pub(super) fn next_at(code: &[Upat], p: usize) -> usize {
	match code.get(p) {
		Some(Upat::Node { op, next }) if p != 0 && *next != 0 => {
			if *op == P_BACK {
				p.saturating_sub(*next as usize)
			} else {
				p + *next as usize
			}
		},
		_ => 0,
	}
}

/// Whether `op` is an alternative (zsh `P_ISBRANCH`: bit 5).
#[inline]
pub(super) const fn is_branch(op: u8) -> bool {
	op != 0xff && op & 0x20 != 0
}

/// Whether `op` is an exclusion (zsh `P_ISEXCLUDE`: bits 4 and 5).
#[inline]
pub(super) const fn is_exclude(op: u8) -> bool {
	op != 0xff && op & 0x30 == 0x30
}

/// Whether `op` must not match a leading `.` without `GLOB_DOTS` (zsh
/// `P_NOTDOT`: bit 6).
#[inline]
pub(super) const fn not_dot(op: u8) -> bool {
	op != 0xff && op & 0x40 != 0
}
