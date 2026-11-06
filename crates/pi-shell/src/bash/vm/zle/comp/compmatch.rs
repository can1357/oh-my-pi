//! zsh 5.9 `Src/Zle/compmatch.c`: matching matches against the word
//! with `-M` specs (`match_str`, `comp_match`), the `cline` lists the
//! unambiguous string is built from (`join_clines`, …), and complete.c's
//! spec parser (`parse_cmatcher`, in [`parse`]).
//!
//! C walks its strings with pointers and temporarily cuts them with NUL
//! bytes; here a string being matched is a NUL-terminated byte buffer and
//! a pointer is an `isize` position in it (reads outside the buffer see
//! zsh's terminating NUL). A `cline`'s `line`/`word`/`orig` are owned
//! copies of the `llen`/`wlen`/`olen` bytes the C pointer covers when the
//! cline is made (see [`Cline`]); C code that reads past a cline's
//! length into the rest of the original string sees NULs here.
//!
//! zsh is built with `MULTIBYTE_SUPPORT`: characters are code points
//! (`convchar_t` = `u32`, `WEOF` = [`CHR_INVALID`]) decoded from
//! metafied UTF-8. Character classes in matcher patterns are tested with
//! zsh's default `$IFS`/`$WORDCHARS` for `[:IFS:]`, `[:IFSSPACE:]` and
//! `[:WORD:]` ([`CharEnv::DEFAULT`]).

mod join;
mod parse;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use bstr::BString;

pub use self::{
	join::join_clines,
	parse::{
		mb_patmatchindex, mb_patmatchrange, parse_cmatcher, patmatchrange, pattern_range_to_string,
	},
};
use super::{
	Comp,
	types::{Brinfo, Cl, Cline, Clines, Cmatcher, Cpattern, clf, cmatcher_flags as cmf},
};
use crate::bash::{
	pattern::zsh::{CharEnv, Pattern, remnulargs, tokenize},
	syntax::zsh::{parse_subst_string, tok},
	vm::expand::Expander,
};

/// compmatch.c's globals (and compcore.c's `freecl`).
#[derive(Clone, Debug, Default)]
pub struct State {
	/// zsh `matchbuf`: the match string being built (exactly
	/// `matchbufadded` bytes here; C NUL-terminates it).
	pub matchbuf:      BString,
	/// zsh `matchbuflen` (the size zsh has allocated for `matchbuf`).
	pub matchbuflen:   i32,
	/// zsh `matchbufadded`.
	pub matchbufadded: i32,
	/// zsh `matchparts`.
	pub matchparts:    Option<Cl>,
	/// zsh `matchlastpart`.
	pub matchlastpart: Option<Cl>,
	/// zsh `matchsubs`.
	pub matchsubs:     Option<Cl>,
	/// zsh `matchlastsub`.
	pub matchlastsub:  Option<Cl>,
	/// zsh `freecl` (compcore.c): clines freed by [`free_cline`], reused
	/// by [`get_cline`] and [`cp_cline`]; chained through `next`. Freed
	/// nodes keep their other fields, as in C (code reads a freed cline).
	/// zsh resets it to `NULL` when a completion starts.
	pub freecl:        Option<Cl>,
}

/// zsh `CHR_INVALID` (`WEOF`): no character.
pub const CHR_INVALID: u32 = u32::MAX;

/// zsh `PP_LOWER` (a match type of [`pattern_match1_ind`]).
pub(crate) const PP_LOWER: i32 = 8;
/// zsh `PP_UPPER`.
pub(crate) const PP_UPPER: i32 = 12;
/// zsh `PP_RANGE`: `a-z` in a class string.
pub(crate) const PP_RANGE: u8 = 21;

// ---- C-string helpers ------------------------------------------------------

/// The byte at `i`, 0 outside `s` (zsh's NUL).
const fn at(s: &[u8], i: isize) -> u8 {
	if i < 0 { 0 } else { tok::at(s, i as usize) }
}

/// `s` from `i` (empty outside `s`).
fn tail(s: &[u8], i: isize) -> &[u8] {
	if i < 0 { &[] } else { tok::tail(s, i as usize) }
}

/// Store `v` at `i` when `i` is inside `s`.
fn set(s: &mut [u8], i: isize, v: u8) {
	if i >= 0 {
		tok::set_at(s, i as usize, v);
	}
}

/// C `strlen`.
fn strlen(s: &[u8]) -> usize {
	s.iter().position(|&b| b == 0).unwrap_or(s.len())
}

/// C `strncmp(a, b, n) != 0`.
fn strncmp_ne(a: &[u8], b: &[u8], n: i32) -> bool {
	for i in 0..n.max(0) as isize {
		let (x, y) = (at(a, i), at(b, i));
		if x != y {
			return true;
		}
		if x == 0 {
			return false;
		}
	}
	false
}

/// The `n` bytes a C pointer `s` with length `n` covers (stopping at
/// the string's end; nothing for `n <= 0`).
fn cut(s: &[u8], n: i32) -> BString {
	let n = usize::try_from(n).unwrap_or(0).min(strlen(s));
	BString::from(&s[..n])
}

/// `s` with a terminating NUL.
fn cstr(s: &[u8]) -> Vec<u8> {
	let mut v = Vec::with_capacity(s.len() + 1);
	v.extend_from_slice(s);
	v.push(0);
	v
}

/// One `mbrtowc` step on the bytes of one character so far.
enum Mb {
	Valid(u32),
	Incomplete,
	Invalid,
}

fn mbdecode(b: &[u8]) -> Mb {
	match core::str::from_utf8(b) {
		Ok(s) => Mb::Valid(s.chars().next().map_or(0, |c| c as u32)),
		Err(e) if e.error_len().is_none() && e.valid_up_to() == 0 && b.len() < 4 => Mb::Incomplete,
		Err(_) => Mb::Invalid,
	}
}

/// zsh `mb_metacharlenconv_r` with a fresh state: the metafied length
/// of the character at the start of `s` and the character
/// ([`CHR_INVALID`] when the bytes are none).
pub(crate) fn mb_metacharlenconv(s: &[u8]) -> (usize, u32) {
	let b0 = at(s, 0);
	if b0 <= 0x7f {
		return (1, u32::from(b0));
	}
	let mut buf = [0u8; 4];
	let mut n = 0;
	let mut p = 0isize;
	while at(s, p) != 0 {
		let inchar = if at(s, p) == tok::META {
			p += 1;
			at(s, p) ^ 32
		} else if tok::is_meta(at(s, p)) {
			break;
		} else {
			at(s, p)
		};
		p += 1;
		if n == buf.len() {
			break;
		}
		buf[n] = inchar;
		n += 1;
		match mbdecode(&buf[..n]) {
			Mb::Valid(c) => return (p as usize, c),
			Mb::Incomplete => {},
			Mb::Invalid => break,
		}
	}
	(
		if p > 0 {
			1 + usize::from(b0 == tok::META)
		} else {
			0
		},
		CHR_INVALID,
	)
}

/// zsh `unmeta_one`: the character at the start of the metafied `s` and
/// its metafied length (0 at the end).
fn unmeta_one(s: &[u8]) -> (u32, usize) {
	if at(s, 0) == 0 {
		return (0, 0);
	}
	let (n, c) = mb_metacharlenconv(s);
	(c, n)
}

/// zsh `ZC_tolower` (`towlower`).
pub(crate) fn zc_tolower(c: u32) -> u32 {
	char::from_u32(c).map_or(c, |ch| {
		let mut it = ch.to_lowercase();
		match (it.next(), it.next()) {
			(Some(l), None) => l as u32,
			_ => c,
		}
	})
}

/// zsh `ZC_toupper` (`towupper`).
pub(crate) fn zc_toupper(c: u32) -> u32 {
	char::from_u32(c).map_or(c, |ch| {
		let mut it = ch.to_uppercase();
		match (it.next(), it.next()) {
			(Some(u), None) => u as u32,
			_ => c,
		}
	})
}

/// zsh `zlelineasstring(line, len, 0, …, 0)` for completion: the wide
/// characters as a metafied multibyte string (`?` for one that has no
/// encoding).
fn zlelineasstring(line: &[u32]) -> Vec<u8> {
	let mut raw = Vec::with_capacity(line.len());
	for &c in line {
		match char::from_u32(c) {
			Some(ch) => {
				let mut b = [0u8; 4];
				raw.extend_from_slice(ch.encode_utf8(&mut b).as_bytes());
			},
			None => raw.push(b'?'),
		}
	}
	tok::metafy(&raw)
}

// ---- matchers -------------------------------------------------------------

/// zsh `cpatterns_same`: whether two pattern lists are the same.
fn cpatterns_same(a: &[Cpattern], b: &[Cpattern]) -> bool {
	a == b
}

/// zsh `cmatchers_same`: whether two matchers are the same.
fn cmatchers_same(a: &Cmatcher, b: &Cmatcher) -> bool {
	core::ptr::eq(a, b)
		|| (a.flags == b.flags
			&& a.llen == b.llen
			&& a.wlen == b.wlen
			&& (a.llen == 0 || cpatterns_same(&a.line, &b.line))
			&& (a.wlen <= 0 || cpatterns_same(&a.word, &b.word))
			&& (a.flags & (cmf::LEFT | cmf::RIGHT) == 0
				|| (a.lalen == b.lalen
					&& a.ralen == b.ralen
					&& (a.lalen == 0 || cpatterns_same(&a.left, &b.left))
					&& (a.ralen == 0 || cpatterns_same(&a.right, &b.right)))))
}

/// zsh `add_bmatchers`: put the matchers of `m` usable for building
/// strings (no anchors, or `r:|x=*`-like) in front of `bmatchers`.
pub fn add_bmatchers(c: &mut Comp, m: Option<&Arc<Cmatcher>>) {
	let mut add = Vec::new();
	let mut m = m;
	while let Some(x) = m {
		if (x.flags == 0 && x.wlen > 0 && x.llen > 0)
			|| (x.flags == cmf::RIGHT && x.wlen < 0 && x.llen == 0)
		{
			add.push(Arc::clone(x));
		}
		m = x.next.as_ref();
	}
	let mut list = c.core.bmatchers.take();
	for x in add.into_iter().rev() {
		list = Some(Arc::new(super::types::Cmlist {
			next:    list,
			matcher: Some(x),
			str:     BString::default(),
		}));
	}
	c.core.bmatchers = list;
}

/// zsh `update_bmatchers`: after `mstack` changed, drop `bmatchers`
/// entries no longer in it (zsh's loop: the list restarts after the last
/// entry not found).
pub fn update_bmatchers(c: &mut Comp) {
	let mut p = c.core.bmatchers.clone();
	while let Some(pn) = p.take() {
		let mut t = false;
		let mut ms = c.core.mstack.as_deref();
		while let Some(m) = ms
			&& !t
		{
			let mut mp = m.matcher.as_deref();
			while let Some(x) = mp
				&& !t
			{
				t = pn.matcher.as_deref().is_some_and(|y| cmatchers_same(x, y));
				mp = x.next.as_deref();
			}
			ms = m.next.as_deref();
		}
		p.clone_from(&pn.next);
		if !t {
			c.core.bmatchers.clone_from(&p);
		}
	}
}

// ---- clines ----------------------------------------------------------------

/// Allocate a cline, from `freecl` first (zsh's `get_cline`/`cp_cline`
/// allocation).
fn new_cline(c: &mut Comp, data: Cline) -> Cl {
	if let Some(r) = c.matcher.freecl {
		c.matcher.freecl = c.clines.get(r).next;
		*c.clines.get_mut(r) = data;
		r
	} else {
		c.clines.alloc(data)
	}
}

/// zsh `get_cline`: a new cline for the `ll` bytes of `l`, the `wl` of
/// `w` and the `ol` of `o` (`None` = C `NULL`).
#[allow(clippy::too_many_arguments, reason = "mirrors the zsh C function's parameters")]
pub fn get_cline(
	c: &mut Comp,
	l: Option<&[u8]>,
	ll: i32,
	w: Option<&[u8]>,
	wl: i32,
	o: Option<&[u8]>,
	ol: i32,
	fl: u32,
) -> Cl {
	new_cline(c, Cline {
		next:   None,
		flags:  fl,
		line:   l.map(|s| cut(s, ll)),
		llen:   ll,
		word:   w.map(|s| cut(s, wl)),
		wlen:   wl,
		orig:   o.map(|s| cut(s, ol)),
		olen:   ol,
		slen:   0,
		prefix: None,
		suffix: None,
		min:    0,
		max:    0,
	})
}

/// zsh `free_cline`: put a cline list and its sub-lists on `freecl`.
pub fn free_cline(c: &mut Comp, mut l: Option<Cl>) {
	while let Some(x) = l {
		let n = c.clines.get(x).next;
		c.clines.get_mut(x).next = c.matcher.freecl;
		c.matcher.freecl = Some(x);
		let (p, s) = (c.clines.get(x).prefix, c.clines.get(x).suffix);
		free_cline(c, p);
		free_cline(c, s);
		l = n;
	}
}

/// zsh `cp_cline`: copy a cline list (and, with `deep`, one level of
/// sub-lists).
pub fn cp_cline(c: &mut Comp, mut l: Option<Cl>, deep: bool) -> Option<Cl> {
	let mut r = None;
	let mut last: Option<Cl> = None;
	while let Some(x) = l {
		let data = c.clines.get(x).clone();
		let t = new_cline(c, data);
		if deep {
			if let Some(p) = c.clines.get(t).prefix {
				let np = cp_cline(c, Some(p), false);
				c.clines.get_mut(t).prefix = np;
			}
			if let Some(s) = c.clines.get(t).suffix {
				let ns = cp_cline(c, Some(s), false);
				c.clines.get_mut(t).suffix = ns;
			}
		}
		match last {
			Some(p) => c.clines.get_mut(p).next = Some(t),
			None => r = Some(t),
		}
		last = Some(t);
		l = c.clines.get(x).next;
	}
	if let Some(p) = last {
		c.clines.get_mut(p).next = None;
	}
	r
}

/// zsh `cline_sublen`: the length of a cline with its sub-lists.
pub fn cline_sublen(cl: &Clines, l: Cl) -> i32 {
	let x = cl.get(l);
	let one = |y: &Cline| {
		if y.flags & clf::LINE != 0 {
			y.llen
		} else {
			y.wlen
		}
	};
	let mut len = one(x);
	let sub = if x.flags & clf::SUF != 0 {
		x.suffix
	} else {
		x.prefix
	};
	if x.olen != 0 && sub.is_none() {
		len += x.olen;
	} else {
		for head in [x.prefix, x.suffix] {
			let mut p = head;
			while let Some(y) = p {
				len += one(cl.get(y));
				p = cl.get(y).next;
			}
		}
	}
	len
}

/// zsh `cline_setlens`: set `min` (and with `both` `max`) of each cline.
pub fn cline_setlens(cl: &mut Clines, mut l: Option<Cl>, both: bool) {
	while let Some(x) = l {
		let m = cline_sublen(cl, x);
		let y = cl.get_mut(x);
		y.min = m;
		if both {
			y.max = m;
		}
		l = y.next;
	}
}

/// zsh `cline_matched`: set `CLF_MATCHED` in a cline list and its
/// sub-lists.
pub fn cline_matched(c: &mut Comp, mut p: Option<Cl>) {
	while let Some(x) = p {
		c.clines.get_mut(x).flags |= clf::MATCHED;
		let (a, b) = (c.clines.get(x).prefix, c.clines.get(x).suffix);
		cline_matched(c, a);
		cline_matched(c, b);
		p = c.clines.get(x).next;
	}
}

/// zsh `revert_cline`: reverse a cline list; the new head.
pub fn revert_cline(c: &mut Comp, mut p: Option<Cl>) -> Option<Cl> {
	let mut r = None;
	while let Some(x) = p {
		let n = c.clines.get(x).next;
		c.clines.get_mut(x).next = r;
		r = Some(x);
		p = n;
	}
	r
}

/// Set a cline's `llen`, keeping its `line` copy no longer than it.
fn set_llen(c: &mut Comp, x: Cl, v: i32) {
	let y = c.clines.get_mut(x);
	y.llen = v;
	if let Some(s) = &mut y.line {
		s.truncate(usize::try_from(v).unwrap_or(0));
	}
}

// ---- building the match
// ------------------------------------------------------

/// zsh `start_match`.
fn start_match(c: &mut Comp) {
	c.matcher.matchbuf.clear();
	c.matcher.matchbufadded = 0;
	c.matcher.matchparts = None;
	c.matcher.matchlastpart = None;
	c.matcher.matchsubs = None;
	c.matcher.matchlastsub = None;
}

/// zsh `abort_match`.
fn abort_match(c: &mut Comp) {
	let (p, s) = (c.matcher.matchparts, c.matcher.matchsubs);
	free_cline(c, p);
	free_cline(c, s);
	c.matcher.matchparts = None;
	c.matcher.matchsubs = None;
}

/// zsh `add_match_str`: add `wl` bytes of `w` (of `l` for a `CMF_LINE`
/// matcher) to `matchbuf`, in front with `sfx`.
fn add_match_str(c: &mut Comp, m: Option<&Cmatcher>, l: &[u8], w: &[u8], wl: i32, sfx: bool) {
	let (w, wl) = match m {
		Some(m) if m.flags & cmf::LINE != 0 => (l, m.llen),
		_ => (w, wl),
	};
	if wl != 0 {
		let st = &mut c.matcher;
		if st.matchbuflen - st.matchbufadded <= wl {
			st.matchbuflen += wl + 20;
		}
		let n = usize::try_from(wl).unwrap_or(0);
		let mut src = tail(w, 0)[..n.min(w.len())].to_vec();
		src.resize(n, 0);
		if sfx {
			st.matchbuf.splice(0..0, src);
		} else {
			st.matchbuf.extend_from_slice(&src);
		}
		st.matchbufadded += wl;
	}
}

/// zsh `add_match_part`: a part cline for an anchor (`l`, `w`, `wl`)
/// with the original line string `o`/`ol`, after the not yet added word
/// string `s`/`sl` (`osl` line characters).
#[allow(clippy::too_many_arguments, reason = "mirrors the zsh C function's parameters")]
fn add_match_part(
	c: &mut Comp,
	m: Option<&Cmatcher>,
	l: Option<&[u8]>,
	w: Option<&[u8]>,
	wl: i32,
	o: Option<&[u8]>,
	ol: i32,
	s: &[u8],
	sl: i32,
	osl: i32,
	sfx: bool,
) {
	let l = l.filter(|l| strncmp_ne(l, w.unwrap_or_default(), wl));
	let (mut p, mut lp, lprem) = bld_parts_in(c, s, sl, osl);
	if let Some(r) = lprem
		&& m.is_some_and(|m| m.flags & cmf::LEFT != 0)
	{
		let y = c.clines.get_mut(r);
		y.flags |= clf::SUF;
		y.suffix = y.prefix;
		y.prefix = None;
	}
	if sfx {
		lp = p;
		p = revert_cline(c, Some(p)).unwrap_or(p);
	}
	if let Some(subs) = c.matcher.matchsubs {
		let last = c.matcher.matchlastsub;
		if sfx {
			if let Some(mut q) = c.clines.get(lp).prefix {
				while let Some(n) = c.clines.get(q).next {
					q = n;
				}
				c.clines.get_mut(q).next = Some(subs);
			} else {
				c.clines.get_mut(lp).prefix = Some(subs);
			}
			if let Some(ls) = last {
				c.clines.get_mut(ls).next = None;
			}
		} else {
			let pp = c.clines.get(p).prefix;
			if let Some(ls) = last {
				c.clines.get_mut(ls).next = pp;
			}
			c.clines.get_mut(p).prefix = Some(subs);
		}
		c.matcher.matchsubs = None;
		c.matcher.matchlastsub = None;
	}
	if c.clines.get(lp).llen != 0 || c.clines.get(lp).wlen != 0 {
		let n = get_cline(c, l, wl, w, wl, o, ol, clf::NEW);
		c.clines.get_mut(lp).next = Some(n);
		lp = n;
	} else {
		let y = c.clines.get_mut(lp);
		y.line = l.map(|s| cut(s, wl));
		y.llen = wl;
		y.word = w.map(|s| cut(s, wl));
		y.wlen = wl;
		y.orig = o.map(|s| cut(s, ol));
		y.olen = ol;
	}
	if o.is_some() || ol != 0 {
		c.clines.get_mut(lp).flags &= !clf::NEW;
	}
	match c.matcher.matchlastpart {
		Some(x) => c.clines.get_mut(x).next = Some(p),
		None => c.matcher.matchparts = Some(p),
	}
	c.matcher.matchlastpart = Some(lp);
}

/// zsh `add_match_sub`: a sub-cline for `ll` line bytes `l` and `wl`
/// word bytes `w`.
fn add_match_sub(
	c: &mut Comp,
	m: Option<&Cmatcher>,
	l: Option<&[u8]>,
	ll: i32,
	w: Option<&[u8]>,
	wl: i32,
) {
	let (w, wl, flags) = if m.is_some_and(|m| m.flags & cmf::LINE != 0) {
		(None, 0, clf::LINE)
	} else {
		(w, wl, 0)
	};
	if wl != 0 || ll != 0 {
		let (n, lp, _) = bld_parts_in(c, w.unwrap_or_default(), wl, ll);
		if n == lp {
			let skip = if m.is_some_and(|m| m.wlen == -2) {
				clf::SKIP
			} else {
				0
			};
			let n = get_cline(c, l, ll, w, wl, None, 0, flags | skip);
			match c.matcher.matchlastsub {
				Some(x) => c.clines.get_mut(x).next = Some(n),
				None => c.matcher.matchsubs = Some(n),
			}
			c.matcher.matchlastsub = Some(n);
		} else {
			let mut p = n;
			while let Some(x) = c.clines.get(p).next
				&& x != lp
			{
				p = x;
			}
			if let Some(subs) = c.matcher.matchsubs {
				let np = c.clines.get(n).prefix;
				if let Some(ls) = c.matcher.matchlastsub {
					c.clines.get_mut(ls).next = np;
				}
				c.clines.get_mut(n).prefix = Some(subs);
			}
			c.matcher.matchsubs = Some(lp);
			c.matcher.matchlastsub = Some(lp);
			match c.matcher.matchlastpart {
				Some(x) => c.clines.get_mut(x).next = Some(n),
				None => c.matcher.matchparts = Some(n),
			}
			c.clines.get_mut(p).next = None;
			c.matcher.matchlastpart = Some(p);
		}
	}
}

// ---- match_str
// ----------------------------------------------------------------

/// zsh `match_str`: whether the line string `l` matches the word `w`
/// with the matchers in `mstack` (from the ends backwards with `sfx`).
///
/// With `test == 0` the match string (`matchbuf`) and the cline lists
/// (`matchparts`, `matchsubs`) are built, and `bpp` is the brace
/// cursor: an index into `c.tricky.brend` with `sfx`, else into
/// `c.tricky.brbeg` (`len()` = C `NULL`); `rwlp` gets the length of the
/// matched prefix/suffix of `w` before the last anchor. `test` 1 and 2
/// are zsh's recursive calls; with `part` a match of a part of `l` is
/// enough. Returns the number of characters of `w` matched (of `l` with
/// `part`), -1 if there is no match (`test`: 1/0).
#[allow(clippy::too_many_arguments, reason = "mirrors the zsh C function's parameters")]
pub fn match_str(
	c: &mut Comp,
	l: &[u8],
	w: &[u8],
	bpp: Option<&mut usize>,
	bc: i32,
	rwlp: Option<&mut i32>,
	sfx: bool,
	test: i32,
	part: bool,
) -> i32 {
	match_str_at(c, l, w, 0, bpp, bc, rwlp, sfx, test, part)
}

/// [`match_str`] of `l` against `w` from its byte `w0` (C's `w + mpl`).
#[allow(clippy::too_many_arguments, reason = "mirrors the zsh C function's parameters")]
fn match_str_at(
	c: &mut Comp,
	l: &[u8],
	w: &[u8],
	w0: usize,
	bpp: Option<&mut usize>,
	bc: i32,
	rwlp: Option<&mut i32>,
	sfx: bool,
	test: i32,
	part: bool,
) -> i32 {
	let mut lb = cstr(l);
	let mut wb = cstr(w);
	let mut brs = core::mem::take(if sfx {
		&mut c.tricky.brend
	} else {
		&mut c.tricky.brbeg
	});
	let r =
		match_str_core(c, &mut lb, 0, &mut wb, w0 as isize, &mut brs, bpp, bc, rwlp, sfx, test, part);
	*(if sfx {
		&mut c.tricky.brend
	} else {
		&mut c.tricky.brbeg
	}) = brs;
	r
}

/// The body of zsh `match_str` on buffers: `l` and `w` start at `l0`
/// and `w0` of `lb`/`wb` and end at their NULs.
#[allow(
	clippy::too_many_arguments,
	clippy::cognitive_complexity,
	reason = "a line-by-line port of zsh's match_str"
)]
fn match_str_core(
	c: &mut Comp,
	lb: &mut [u8],
	l0: isize,
	wb: &mut [u8],
	w0: isize,
	brs: &mut [Brinfo],
	bpp: Option<&mut usize>,
	mut bc: i32,
	rwlp: Option<&mut i32>,
	sfx: bool,
	test: i32,
	part: bool,
) -> i32 {
	let mut ll = strlen(tail(lb, l0)) as i32;
	let mut lw = strlen(tail(wb, w0)) as i32;
	let (mut il, mut iw, mut exact, mut wexact) = (0i32, 0i32, 0i32, 0i32);
	let mut he = false;
	let mut lm: *const Cmatcher = core::ptr::null();
	let mut bp = brs.len();
	let obc = bc;
	let ind: isize = if sfx { -1 } else { 0 };
	let add: isize = if sfx { -1 } else { 1 };
	let (original_ll, original_lw) = (ll, lw);
	let useqbr = c.core.useqbr != 0;
	let mstack = c.core.mstack.clone();
	let qp = |b: &Brinfo| if useqbr { b.qpos } else { b.pos };

	if test == 0 {
		start_match(c);
		if let Some(p) = &bpp {
			bp = (**p).min(brs.len());
		}
	}
	let (mut l, mut w) = (l0, w0);
	if sfx {
		l += ll as isize;
		w += lw as isize;
	}
	let mut ow = w;

	if test == 0 && bp < brs.len() && bc >= brs[bp].pos {
		brs[bp].curpos = bc;
		bp += 1;
	}
	'main: while ll != 0 {
		let mut bslash = false;
		if !sfx
			&& lw != 0
			&& (!part || test != 0)
			&& (at(lb, l + ind) == at(wb, w + ind) || {
				bslash = lw > 1 && at(wb, w + ind) == b'\\' && at(wb, w + ind + 1) == at(lb, l);
				bslash
			}) {
			let bs = i32::from(bslash);
			l += add;
			w += if bslash { add + add } else { add };
			il += 1;
			iw += 1 + bs;
			ll -= 1;
			lw -= 1 + bs;
			bc += 1;
			exact += 1;
			wexact += 1 + bs;
			if test == 0 {
				while bp < brs.len() && bc >= qp(&brs[bp]) {
					brs[bp].curpos = c.matcher.matchbufadded + (w - ow) as i32 + obc;
					bp += 1;
				}
			}
			lm = core::ptr::null();
			he = false;
			continue;
		}
		'retry: loop {
			let mut found = false;
			let mut ms = mstack.as_deref();
			while !found {
				let Some(msn) = ms else { break };
				ms = msn.next.as_deref();
				let mut mpo = msn.matcher.as_deref();
				while let Some(mp) = mpo {
					mpo = mp.next.as_deref();
					if core::ptr::eq(lm, mp)
						|| ((original_ll == ll || original_lw == lw)
							&& (test == 1 || (test != 0 && mp.left.is_empty() && mp.right.is_empty()))
							&& mp.wlen < 0)
					{
						continue;
					}
					if mp.wlen < 0 {
						// `*'-pattern.
						let mut llen = mp.llen;
						let left = mp.flags & cmf::LEFT != 0;
						let (mut alen, aol) = if left {
							(mp.lalen, mp.ralen)
						} else {
							(mp.ralen, mp.lalen)
						};
						if ll < llen + alen || lw < alen + aol {
							continue;
						}
						let (ap, moff, aop, both, loff, aoff): (
							&[Cpattern],
							i32,
							&[Cpattern],
							bool,
							i32,
							i32,
						) = if left {
							if sfx {
								(
									mp.left.as_slice(),
									alen,
									mp.right.as_slice(),
									false,
									-llen,
									-(llen + alen),
								)
							} else {
								(mp.left.as_slice(), alen, mp.right.as_slice(), true, alen, 0)
							}
						} else if sfx {
							(mp.right.as_slice(), 0, mp.left.as_slice(), true, -(llen + alen), -alen)
						} else {
							(mp.right.as_slice(), 0, mp.left.as_slice(), false, 0, llen)
						};
						let (loff, aoff, moffi) = (loff as isize, aoff as isize, moff as isize);
						if !pattern_match(&mp.line, tail(lb, l + loff)) {
							continue;
						}
						if !ap.is_empty() {
							if !pattern_match(ap, tail(lb, l + aoff))
								|| (both
									&& (!pattern_match(ap, tail(wb, w + aoff))
										|| (aol != 0
											&& aol <= aoff as i32 + iw
											&& !pattern_match(aop, tail(wb, w + aoff - aol as isize)))
										|| match_parts(c, lb, l + aoff, wb, w + aoff, alen, part) == 0))
							{
								continue;
							}
						} else if !both
							|| (if mp.flags & cmf::INTER != 0 {
								if mp.flags & cmf::LINE != 0 {
									iw != 0
								} else {
									il != 0
								}
							} else {
								il != 0 || iw != 0
							}) {
							continue;
						}
						// Find the string matched by the `*'.
						let sl = l - (llen + alen) as isize;
						let mut savl = 0;
						if sfx {
							savl = at(lb, sl);
							if savl != 0 {
								set(lb, sl, 0);
							}
						}
						let mut t = 0;
						let mut tp = w;
						let mut ct = 0i32;
						let mut ict = lw - alen + 1;
						while ict != 0 {
							let hit = if both {
								ap.is_empty()
									|| test == 0
									|| !pattern_match(ap, tail(wb, tp + aoff))
									|| (aol != 0
										&& aol <= aoff as i32 + ct + iw
										&& !pattern_match(aop, tail(wb, tp + aoff - aol as isize)))
							} else {
								pattern_match(ap, tail(wb, tp - moffi))
									&& (aol == 0
										|| (aol <= iw + ct - moff
											&& pattern_match(aop, tail(wb, tp - moffi - aol as isize))))
									&& (mp.wlen == -1
										|| match_parts(c, lb, l + aoff, wb, tp - moffi, alen, part) != 0)
							};
							if hit {
								if !both
									&& mp.wlen == -1
									&& match_parts(c, lb, l + aoff, wb, tp - moffi, alen, part) == 0
								{
									break;
								}
								if sfx {
									let si = tp - alen as isize;
									let savw = at(wb, si);
									if savw != 0 {
										set(wb, si, 0);
									}
									t = match_str_core(
										c,
										lb,
										l - ll as isize,
										wb,
										w - lw as isize,
										&mut [],
										None,
										0,
										None,
										sfx,
										2,
										part,
									);
									if savw != 0 {
										set(wb, si, savw);
									}
								} else {
									t = match_str_core(
										c,
										lb,
										l + llen as isize + moffi,
										wb,
										tp + moffi,
										&mut [],
										None,
										0,
										None,
										sfx,
										1,
										part,
									);
								}
								if t != 0 || (mp.wlen == -1 && !both) {
									break;
								}
							}
							tp += add;
							ct += 1;
							ict -= 1;
						}
						let ict = ct;
						if sfx && savl != 0 {
							set(lb, sl, savl);
						}
						if t == 0 {
							continue;
						}
						if test == 0 && (!he || llen + alen != 0) {
							let alenp = alen as isize;
							let (op, mut ol, lp, map, wap, wmp);
							if sfx {
								op = w;
								ol = (ow - w) as i32;
								lp = l - (llen + alen) as isize;
								map = tp - alenp;
								if left {
									wap = tp - alenp;
									wmp = tp;
								} else {
									wap = w - alenp;
									wmp = tp - alenp;
								}
							} else {
								op = ow;
								ol = (w - ow) as i32;
								lp = l;
								map = ow;
								if left {
									wap = w;
									wmp = w + alenp;
								} else {
									wap = tp;
									wmp = ow;
								}
							}
							if mp.flags & cmf::LINE != 0 {
								add_match_str(c, None, &[], tail(wb, op), ol, sfx);
								add_match_str(c, None, &[], tail(lb, lp), llen + alen, sfx);
								add_match_sub(c, None, None, ol, Some(tail(wb, op)), ol);
								add_match_sub(c, None, None, llen + alen, Some(tail(lb, lp)), llen + alen);
							} else if sfx {
								add_match_str(c, None, &[], tail(wb, map), ct + ol + alen, sfx);
								add_match_part(
									c,
									Some(mp),
									Some(tail(lb, l + aoff)),
									Some(tail(wb, wap)),
									alen,
									Some(tail(lb, l + loff)),
									llen,
									tail(wb, op),
									ol,
									ol,
									sfx,
								);
								add_match_sub(c, None, None, 0, Some(tail(wb, wmp)), ct);
							} else {
								add_match_str(c, None, &[], tail(wb, map), ct + ol + alen, sfx);
								let mut ctt = ct;
								if both {
									add_match_sub(c, None, None, ol, Some(tail(wb, op)), ol);
									ol = -1;
								} else {
									ctt += ol;
								}
								add_match_part(
									c,
									Some(mp),
									Some(tail(lb, l + aoff)),
									Some(tail(wb, wap)),
									alen,
									Some(tail(lb, l + loff)),
									llen,
									tail(wb, wmp),
									ctt,
									ol,
									sfx,
								);
							}
						}
						// Skip over the matched portion and the anchor.
						llen += alen;
						alen += ict;
						if sfx {
							l -= llen as isize;
							w -= alen as isize;
						} else {
							l += llen as isize;
							w += alen as isize;
						}
						ll -= llen;
						il += llen;
						lw -= alen;
						iw += alen;
						bc += llen;
						exact = 0;
						if test == 0 {
							while bp < brs.len() && bc >= qp(&brs[bp]) {
								let bpc = qp(&brs[bp]);
								brs[bp].curpos = c.matcher.matchbufadded + bpc - bc + obc;
								bp += 1;
							}
						}
						ow = w;
						if llen == 0 && alen == 0 {
							lm = mp;
							if he {
								// zsh sets `mp = NULL`: the outer loop goes on.
							} else {
								he = true;
								found = true;
							}
						} else {
							lm = core::ptr::null();
							he = false;
							found = true;
						}
						break;
					} else if ll >= mp.llen && lw >= mp.wlen {
						// Non-`*'-pattern.
						let mut t = true;
						let (ml, mw) = (mp.llen as isize, mp.wlen as isize);
						if mp.flags & (cmf::LEFT | cmf::RIGHT) == 0
							&& mp.llen == mp.wlen
							&& !(if sfx {
								strncmp_ne(tail(lb, l - ml), tail(wb, w - mw), mp.llen)
							} else {
								strncmp_ne(tail(lb, l), tail(wb, w), mp.llen)
							}) {
							continue;
						}
						let (tl, tw, til, tiw, tll, tlw) = if sfx {
							(l - ml, w - mw, ll - mp.llen, lw - mp.wlen, il + mp.llen, iw + mp.wlen)
						} else {
							(l, w, il, iw, ll, lw)
						};
						let (la, ra) = (mp.lalen as isize, mp.ralen as isize);
						let inter_used = || {
							if mp.flags & cmf::INTER != 0 {
								if mp.flags & cmf::LINE != 0 {
									iw != 0
								} else {
									il != 0
								}
							} else {
								il != 0 || iw != 0
							}
						};
						if mp.flags & cmf::LEFT != 0 {
							if til < mp.lalen || tiw < mp.lalen + mp.ralen {
								continue;
							} else if !mp.left.is_empty() {
								t = pattern_match(&mp.left, tail(lb, tl - la))
									&& pattern_match(&mp.left, tail(wb, tw - la))
									&& (mp.ralen == 0 || pattern_match(&mp.right, tail(wb, tw - la - ra)));
							} else {
								t = !sfx && !inter_used();
							}
						}
						if mp.flags & cmf::RIGHT != 0 {
							if tll < mp.llen + mp.ralen || tlw < mp.wlen + mp.ralen + mp.lalen {
								continue;
							} else if !mp.right.is_empty() {
								t = pattern_match(&mp.right, tail(lb, tl + ml))
									&& pattern_match(&mp.right, tail(wb, tw + mw))
									&& (mp.lalen == 0
										|| pattern_match(&mp.left, tail(wb, tw + mw - ra - la)));
							} else {
								t = sfx && !inter_used();
							}
						}
						if !t || !pattern_match_full(&mp.line, tail(lb, tl), &mp.word, tail(wb, tw)) {
							continue;
						}
						if test == 0 {
							if sfx {
								if ow >= w {
									add_match_str(c, None, &[], tail(wb, w), (ow - w) as i32, sfx);
								}
							} else if w >= ow {
								add_match_str(c, None, &[], tail(wb, ow), (w - ow) as i32, sfx);
							}
							add_match_str(c, Some(mp), tail(lb, tl), tail(wb, tw), mp.wlen, sfx);
							if sfx {
								if ow >= w {
									add_match_sub(c, None, None, 0, Some(tail(wb, w)), (ow - w) as i32);
								}
							} else if w >= ow {
								add_match_sub(c, None, None, 0, Some(tail(wb, ow)), (w - ow) as i32);
							}
							add_match_sub(
								c,
								Some(mp),
								Some(tail(lb, tl)),
								mp.llen,
								Some(tail(wb, tw)),
								mp.wlen,
							);
						}
						if sfx {
							l = tl;
							w = tw;
						} else {
							l += ml;
							w += mw;
						}
						il += mp.llen;
						iw += mp.wlen;
						ll -= mp.llen;
						lw -= mp.wlen;
						bc += mp.llen;
						exact = 0;
						if test == 0 {
							while bp < brs.len() && bc >= qp(&brs[bp]) {
								let bpc = qp(&brs[bp]);
								brs[bp].curpos = c.matcher.matchbufadded + bpc - bc + obc;
								bp += 1;
							}
						}
						ow = w;
						lm = core::ptr::null();
						he = false;
						found = true;
						break;
					}
				}
			}
			if found {
				continue 'main;
			}
			// Same code as at the beginning, used in top-level calls.
			let mut bslash = false;
			if (test == 0 || sfx)
				&& lw != 0
				&& (at(lb, l + ind) == at(wb, w + ind) || {
					bslash = lw > 1 && at(wb, w + ind) == b'\\' && at(wb, w + ind + 1) == at(lb, l);
					bslash
				}) {
				let bs = i32::from(bslash);
				l += add;
				w += if bslash { add + add } else { add };
				il += 1;
				iw += 1 + bs;
				ll -= 1;
				lw -= 1 + bs;
				bc += 1;
				if test == 0 {
					while bp < brs.len() && bc >= qp(&brs[bp]) {
						brs[bp].curpos =
							c.matcher.matchbufadded + (if sfx { ow - w } else { w - ow }) as i32 + obc;
						bp += 1;
					}
				}
				lm = core::ptr::null();
				he = false;
				continue 'main;
			}
			if lw == 0 {
				break 'main;
			}
			if exact != 0 && !part {
				// Go back before the characters accepted directly and try
				// again, preferring match specs.
				il -= exact;
				iw -= wexact;
				ll += exact;
				lw += wexact;
				bc -= exact;
				l -= add * exact as isize;
				w -= add * wexact as isize;
				exact = 0;
				wexact = 0;
				continue 'retry;
			}
			if test != 0 {
				return 0;
			}
			abort_match(c);
			return -1;
		}
	}
	if test != 0 {
		return i32::from(part || ll == 0);
	}
	if !part && ll != 0 {
		abort_match(c);
		return -1;
	}
	if let Some(r) = rwlp {
		*r = iw - (if sfx { ow - w } else { w - ow }) as i32;
	}
	// Matching a suffix leaves the anchors in the top clines shifted by
	// one: move them.
	if sfx && let Some(mp0) = c.matcher.matchparts {
		/// zsh's `(Cline) 1`: a non-NULL marker, always overwritten.
		const MARK: Cl = Cl(u32::MAX);
		if c.clines.get(mp0).prefix.is_some() || c.clines.get(mp0).suffix.is_some() {
			let t = get_cline(c, None, 0, None, 0, None, 0, 0);
			let has_prefix = c.clines.get(mp0).prefix.is_some();
			let y = c.clines.get_mut(t);
			y.next = Some(mp0);
			if has_prefix {
				y.prefix = Some(MARK);
			} else {
				y.suffix = Some(MARK);
			}
			c.matcher.matchparts = Some(t);
		}
		let mut t = c.matcher.matchparts.unwrap_or(mp0);
		while let Some(tn) = c.clines.get(t).next {
			let s = c.clines.get(tn).prefix.or_else(|| c.clines.get(tn).suffix);
			let y = c.clines.get_mut(t);
			if y.suffix.is_some() {
				y.suffix = s;
			} else {
				y.prefix = s;
			}
			t = tn;
		}
		let y = c.clines.get_mut(t);
		y.prefix = None;
		y.suffix = None;
	}
	if let Some(p) = bpp {
		*p = bp;
	}
	if part { il } else { iw }
}

/// zsh `match_parts`: [`match_str`] test of the first `n` bytes of `l`
/// against the first `n` of `w`.
fn match_parts(
	c: &mut Comp,
	lb: &mut [u8],
	l: isize,
	wb: &mut [u8],
	w: isize,
	n: i32,
	part: bool,
) -> i32 {
	let (li, wi) = (l + n as isize, w + n as isize);
	let (lsav, wsav) = (at(lb, li), at(wb, wi));
	if lsav != 0 {
		set(lb, li, 0);
	}
	if wsav != 0 {
		set(wb, wi, 0);
	}
	let ret = match_str_core(c, lb, l, wb, w, &mut [], None, 0, None, false, 1, part);
	if lsav != 0 {
		set(lb, li, lsav);
	}
	if wsav != 0 {
		set(wb, wi, wsav);
	}
	ret
}

/// zsh `comp_match`: whether the word `w` matches the prefix `pfx` and
/// suffix `sfx` from the line (or the `globcomplete` pattern `cp`).
/// `clp` gets the cline list for `w`; `qu` says how to quote `w` (0: it
/// is quoted already, 2: file quoting); `bpl`/`bsl` are the brace
/// cursors into `c.tricky.brbeg`/`brend` with the offsets `bcp`/`bcs`;
/// `exact` says whether the string built equals the line's. Returns the
/// string to use as the completion, `None` if `w` doesn't match.
/// A pattern comes with the character-class environment shared by the
/// candidates of this compadd call.
#[allow(clippy::too_many_arguments, reason = "mirrors the zsh C function's parameters")]
pub fn comp_match(
	ex: &mut Expander<'_, '_>,
	c: &mut Comp,
	pfx: &[u8],
	sfx: Option<&[u8]>,
	w: &[u8],
	cp: Option<(&Pattern, CharEnv<'_>)>,
	clp: &mut Option<Cl>,
	qu: i32,
	bpl: &mut usize,
	bcp: i32,
	bsl: &mut usize,
	bcs: i32,
	exact: &mut i32,
) -> Option<BString> {
	let r;
	if let Some((cp, env)) = cp {
		let teststr: Vec<u8> = if qu == 0 {
			let mut t = w.to_vec();
			tokenize(&mut t);
			match parse_subst_string(&t) {
				Err(_) => w.to_vec(),
				Ok(mut v) => {
					remnulargs(&mut v);
					tok::untokenize(&mut v);
					v
				},
			}
		} else {
			w.to_vec()
		};
		if !cp.matches(&teststr, &env) {
			return None;
		}
		r = if qu == 2 {
			super::compcore::tildequote(ex, c, w, false)
		} else {
			super::compcore::multiquote(ex, c, w, qu == 0)
		};
		let wl = strlen(w) as i32;
		*clp = Some(bld_parts(c, w, wl, wl, None, None));
		*exact = 0;
	} else {
		let wq = if qu == 2 {
			super::compcore::tildequote(ex, c, w, false)
		} else {
			super::compcore::multiquote(ex, c, w, qu == 0)
		};
		r = comp_match_word(c, pfx, sfx, &wq, clp, qu, bpl, bcp, bsl, bcs, exact)?;
	}
	if qu == 0 {
		c.core.hasunqu = 1;
	}
	Some(r)
}

/// The matcher half of [`comp_match`] (no pattern), on the quoted word
/// `w`; leaves `hasunqu` to the caller.
#[allow(clippy::too_many_arguments, reason = "mirrors the zsh C function's parameters")]
pub(crate) fn comp_match_word(
	c: &mut Comp,
	pfx: &[u8],
	sfx: Option<&[u8]>,
	w: &[u8],
	clp: &mut Option<Cl>,
	qu: i32,
	bpl: &mut usize,
	bcp: i32,
	bsl: &mut usize,
	bcs: i32,
	exact: &mut i32,
) -> Option<BString> {
	let wl = strlen(w) as i32;
	let mut rpl = 0;
	c.core.useqbr = qu;
	let mpl = match_str(c, pfx, w, Some(bpl), bcp, Some(&mut rpl), false, 0, false);
	if mpl < 0 {
		return None;
	}
	let pli = if let Some(sfx) = sfx.filter(|s| at(s, 0) != 0) {
		let wpl = c.matcher.matchbufadded;
		let wpfx = c.matcher.matchbuf.clone();
		if let Some(subs) = c.matcher.matchsubs {
			let tmp = get_cline(c, None, 0, None, 0, None, 0, 0);
			c.clines.get_mut(tmp).prefix = Some(subs);
			match c.matcher.matchlastpart {
				Some(x) => c.clines.get_mut(x).next = Some(tmp),
				None => c.matcher.matchparts = Some(tmp),
			}
		}
		let mut pl = c.matcher.matchparts;
		let plil = c.matcher.matchlastpart;
		let mut rsl = 0;
		let msl = match_str_at(
			c,
			sfx,
			w,
			mpl.max(0) as usize,
			Some(bsl),
			bcs,
			Some(&mut rsl),
			true,
			0,
			false,
		);
		if msl < 0 {
			free_cline(c, pl);
			return None;
		}
		if let Some(subs) = c.matcher.matchsubs {
			let tmp = get_cline(c, None, 0, None, 0, None, 0, clf::SUF);
			c.clines.get_mut(tmp).suffix = Some(subs);
			match c.matcher.matchlastpart {
				Some(x) => c.clines.get_mut(x).next = Some(tmp),
				None => c.matcher.matchparts = Some(tmp),
			}
		}
		add_match_str(c, None, &[], tail(w, rpl as isize), wl - rpl - rsl, true);
		add_match_str(c, None, &[], &wpfx, wpl, true);
		let (mli, mlil, _) =
			bld_parts_in(c, tail(w, rpl as isize), wl - rpl - rsl, (mpl - rpl) + (msl - rsl));
		let parts = c.matcher.matchparts;
		let rev = revert_cline(c, parts);
		let y = c.clines.get_mut(mlil);
		y.flags |= clf::MID;
		y.slen = msl - rsl;
		y.next = rev;
		match plil {
			Some(x) => c.clines.get_mut(x).next = Some(mli),
			None => pl = Some(mli),
		}
		pl
	} else {
		add_match_str(c, None, &[], tail(w, rpl as isize), wl - rpl, false);
		add_match_part(
			c,
			None,
			None,
			None,
			0,
			None,
			0,
			tail(w, rpl as isize),
			wl - rpl,
			mpl - rpl,
			false,
		);
		c.matcher.matchparts
	};
	let mb = &c.matcher.matchbuf;
	let r = BString::from(&mb[..strlen(mb)]);
	*clp = pli;
	*exact = i32::from(match sfx.filter(|s| at(s, 0) != 0) {
		Some(sfx) => {
			let pl = strlen(pfx);
			!strncmp_ne(pfx, w, pl as i32)
				&& tail(w, pl as isize)[..strlen(tail(w, pl as isize))] == sfx[..strlen(sfx)]
		},
		None => pfx[..strlen(pfx)] == w[..strlen(w)],
	});
	Some(r)
}

// ---- pattern matching
// -----------------------------------------------------------

/// zsh `pattern_match1`: whether `p` matches the character `c`; for an
/// equivalence class 1 + the index into it. `mtp` gets the match type
/// (0 or a `PP_*` code).
pub fn pattern_match1_ind(p: &Cpattern, c: u32, mtp: &mut i32) -> u32 {
	*mtp = 0;
	match p {
		Cpattern::CClass(s) => u32::from(mb_patmatchrange(s, c, None, None)),
		Cpattern::NClass(s) => u32::from(!mb_patmatchrange(s, c, None, None)),
		Cpattern::Equiv(s) => {
			let mut ind = 0;
			if mb_patmatchrange(s, c, Some(&mut ind), Some(mtp)) {
				ind.wrapping_add(1)
			} else {
				0
			}
		},
		Cpattern::Any => 1,
		Cpattern::Char(ch) => u32::from(*ch as u32 == c),
	}
}

/// zsh `pattern_match1` as a test.
pub fn pattern_match1(p: &Cpattern, c: char, mtp: &mut i32) -> bool {
	pattern_match1_ind(p, c as u32, mtp) != 0
}

/// zsh `pattern_match_equivalence`: the line character for the word
/// character `wchr` that matched the word's equivalence class at
/// `wind` with match type `wmtp`, from the line class `lp`;
/// [`CHR_INVALID`] if there is none.
pub fn pattern_match_equivalence_ind(lp: &Cpattern, wind: u32, wmtp: i32, wchr: u32) -> u32 {
	let Cpattern::Equiv(s) = lp else {
		return CHR_INVALID;
	};
	let mut lchr = CHR_INVALID;
	let mut lmtp = 0;
	if !mb_patmatchindex(s, wind, &mut lchr, &mut lmtp) {
		return CHR_INVALID;
	}
	if lchr != CHR_INVALID {
		return lchr;
	}
	if wmtp == PP_UPPER && lmtp == PP_LOWER {
		zc_tolower(wchr)
	} else if wmtp == PP_LOWER && lmtp == PP_UPPER {
		zc_toupper(wchr)
	} else if wmtp == lmtp {
		wchr
	} else {
		CHR_INVALID
	}
}

/// [`pattern_match_equivalence_ind`] on `char`s (`None` = `CHR_INVALID`
/// or no character).
pub fn pattern_match_equivalence(p: &Cpattern, ind: u32, mt: i32, c: char) -> Option<char> {
	match pattern_match_equivalence_ind(p, ind, mt, c as u32) {
		CHR_INVALID => None,
		x => char::from_u32(x),
	}
}

/// zsh `pattern_match(p, s, NULL, NULL)`: whether the metafied `s`
/// starts with characters matching `p` (or ends first).
pub fn pattern_match(p: &[Cpattern], s: &[u8]) -> bool {
	pattern_match_full(p, s, &[], &[])
}

/// zsh `pattern_match(p, s, wp, ws)`: `p` against the line string `s`
/// and `wp` against the word string `ws`, equivalence classes matching
/// at the same positions.
pub fn pattern_match_full(p: &[Cpattern], s: &[u8], wp: &[Cpattern], ws: &[u8]) -> bool {
	let (mut pi, mut wi) = (0usize, 0usize);
	let (mut si, mut wsi) = (0usize, 0usize);
	let (mut mt, mut wmt) = (0i32, 0i32);
	while pi < p.len() && wi < wp.len() && tok::at(s, si) != 0 && tok::at(ws, wsi) != 0 {
		let (wc, wlen) = unmeta_one(tok::tail(ws, wsi));
		let wind = pattern_match1_ind(&wp[wi], wc, &mut wmt);
		if wind == 0 {
			return false;
		}
		let (c, len) = unmeta_one(tok::tail(s, si));
		if !matches!(p[pi], Cpattern::Any) || !matches!(wp[wi], Cpattern::Any) {
			let ind = pattern_match1_ind(&p[pi], c, &mut mt);
			if ind == 0 || ind != wind {
				return false;
			}
			if mt != wmt {
				if (mt == PP_LOWER || mt == PP_UPPER) && (wmt == PP_LOWER || wmt == PP_UPPER) {
					if zc_tolower(c) != zc_tolower(wc) {
						return false;
					}
				} else {
					return false;
				}
			}
		}
		si += len;
		wsi += wlen;
		pi += 1;
		wi += 1;
	}
	while pi < p.len() && tok::at(s, si) != 0 {
		let (c, len) = unmeta_one(tok::tail(s, si));
		if pattern_match1_ind(&p[pi], c, &mut mt) == 0 {
			return false;
		}
		pi += 1;
		si += len;
	}
	while wi < wp.len() && tok::at(ws, wsi) != 0 {
		let (wc, wlen) = unmeta_one(tok::tail(ws, wsi));
		if pattern_match1_ind(&wp[wi], wc, &mut wmt) == 0 {
			return false;
		}
		wi += 1;
		wsi += wlen;
	}
	true
}

// ---- bld_parts
// --------------------------------------------------------------------

/// zsh `bld_parts`: split the `len` bytes of `s` into clines at the
/// anchors of `r:|x=*`-like `bmatchers`; `plen` line characters matched
/// the string. Returns the list, its last cline, and that cline again if
/// it holds the remainder after the last anchor (`lprem`).
fn bld_parts_in(c: &mut Comp, s: &[u8], len: i32, plen: i32) -> (Cl, Cl, Option<Cl>) {
	let bm = c.core.bmatchers.clone();
	let mut ret: Option<Cl> = None;
	let mut last: Option<Cl> = None;
	let mut n: Option<Cl> = None;
	let (mut str, mut p) = (0isize, 0isize);
	let (mut len, mut plen, mut op) = (len, plen, plen);
	let link = |c: &mut Comp, ret: &mut Option<Cl>, last: Option<Cl>, x: Cl| match last {
		Some(l) => c.clines.get_mut(l).next = Some(x),
		None => *ret = Some(x),
	};
	while len > 0 {
		let mut t = false;
		let mut ms = bm.as_deref();
		while let Some(m) = ms
			&& !t
		{
			ms = m.next.as_deref();
			let Some(mp) = m.matcher.as_deref() else {
				continue;
			};
			if mp.flags == cmf::RIGHT
				&& mp.wlen < 0
				&& mp.ralen != 0
				&& mp.llen == 0
				&& len >= mp.ralen
				&& str as i32 >= mp.lalen
				&& pattern_match(&mp.right, tail(s, str))
				&& (mp.lalen == 0
					|| (str as i32 >= mp.lalen
						&& pattern_match(&mp.left, tail(s, str - mp.lalen as isize))))
			{
				let olen = (str - p) as i32;
				let nn = get_cline(
					c,
					None,
					mp.ralen,
					Some(tail(s, str)),
					mp.ralen,
					None,
					0,
					if plen <= 0 { clf::NEW } else { 0 },
				);
				link(c, &mut ret, last, nn);
				n = Some(nn);
				if p != str {
					let llen = op.max(0).min(olen);
					let pre = get_cline(c, None, llen, Some(tail(s, p)), olen, None, 0, 0);
					c.clines.get_mut(nn).prefix = Some(pre);
				}
				last = Some(nn);
				str += mp.ralen as isize;
				len -= mp.ralen;
				plen -= mp.ralen;
				op -= olen;
				p = str;
				t = true;
			}
		}
		if !t {
			str += 1;
			len -= 1;
			plen -= 1;
		}
	}
	let mut lprem = None;
	if p != str {
		let olen = (str - p) as i32;
		let llen = op.max(0).min(olen);
		let nn = get_cline(c, None, 0, None, 0, None, 0, if plen <= 0 { clf::NEW } else { 0 });
		link(c, &mut ret, last, nn);
		n = Some(nn);
		let pre = get_cline(c, None, llen, Some(tail(s, p)), olen, None, 0, 0);
		c.clines.get_mut(nn).prefix = Some(pre);
		lprem = Some(nn);
	} else if ret.is_none() {
		let nn = get_cline(c, None, 0, None, 0, None, 0, if plen <= 0 { clf::NEW } else { 0 });
		ret = Some(nn);
		n = Some(nn);
		lprem = Some(nn);
	}
	// `ret` and `n` are set on every path above.
	let n = n.unwrap_or(Cl(u32::MAX));
	c.clines.get_mut(n).next = None;
	(ret.unwrap_or(n), n, lprem)
}

/// zsh `bld_parts`: see [`bld_parts_in`]; `lp`/`lprem` get the last
/// cline and the remainder cline when given.
pub fn bld_parts(
	c: &mut Comp,
	s: &[u8],
	len: i32,
	plen: i32,
	lp: Option<&mut Option<Cl>>,
	lprem: Option<&mut Option<Cl>>,
) -> Cl {
	let (r, n, rem) = bld_parts_in(c, s, len, plen);
	if let Some(lp) = lp {
		*lp = Some(n);
	}
	if let Some(x) = lprem {
		*x = rem;
	}
	r
}

/// The class environment matcher patterns are tested with.
const fn class_env() -> CharEnv<'static> {
	CharEnv::DEFAULT
}
