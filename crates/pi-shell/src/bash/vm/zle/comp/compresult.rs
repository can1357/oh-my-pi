//! zsh 5.9 `Src/Zle/compresult.c`: what a completion does with its
//! matches: the unambiguous string (`cline_str`, `unambig_data`),
//! inserting a match (`instmatch`, `do_single`), ambiguous completion
//! (`do_ambiguous`), the menu-completion state machine (`do_menucmp`,
//! `accept_last`, `do_ambig_menu`, `do_allmatches`), and listing
//! ([`list`]: `calclist`, `asklist`, `printlist`, `ilistmatches`).
//!
//! The suffix code of `zle_misc.c` the insertion uses is [`suffix`].
//!
//! Functions that may wait (a `stat` of a file through the host, the
//! `zle-line-pre-redraw` hook, a suffix-removal shell function, the
//! listing question) take their caller's rest as a [`K`].
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

pub mod list;
pub mod suffix;

use bstr::BString;
pub use list::{
	Pr, asklist, bld_all_str, calclist, ilistmatches, list_lines, printfmt_in, skipnolist,
};

use super::{
	Comp, K, compcore, compmatch,
	types::{Cl, Cmatch, GId, MRef, clf, cmf, fc},
};
use crate::bash::{
	fs::{Stat, StatKind},
	syntax::zsh::{parsestr, tok},
	vm::{
		expand::Expander,
		probe::{self, absolute},
		proc::{Probe, ProbeResult, Scratch},
		zle::{
			display,
			exec::{Await, WResult, Zw, then},
		},
		zsh::{params, subst::singsub},
	},
	zshopt::ZshOpt,
};

/// zsh `COMP_LIST_COMPLETE` (zle.h).
pub const COMP_LIST_COMPLETE: i32 = 1;

/// compresult.c's globals (and its function statics).
#[derive(Clone, Debug, Default)]
pub struct State {
	/// zsh `invcount`: bumped by every `invalidate_list`.
	pub invcount:     i32,
	/// `calclist`'s static `lastinvcount` (`None`: zsh's `-1`).
	pub lastinvcount: Option<i32>,
	/// `unambig_data`'s static `scache`.
	pub scache:       Option<BString>,
	/// `unambig_data`'s static `pcache`.
	pub pcache:       Option<BString>,
	/// `unambig_data`'s static `icache`.
	pub icache:       Option<BString>,
	/// `unambig_data`'s static `ccache`.
	pub ccache:       i32,
	/// `zle_misc.c`'s suffix state.
	pub suffix:       suffix::Suffix,
}

// ---- line helpers
// ------------------------------------------------------------

/// zsh `zlemetacs`.
fn cs(c: &Comp) -> i32 {
	i32::try_from(c.line.cs).unwrap_or(i32::MAX)
}

/// `zlemetacs = v`.
fn set_cs(c: &mut Comp, v: i32) {
	c.line.cs = usize::try_from(v).unwrap_or(0);
}

/// zsh `zlemetall`.
fn ll(c: &Comp) -> i32 {
	i32::try_from(c.line.ll()).unwrap_or(i32::MAX)
}

/// zsh `inststrlen(s, mv, -1)`: the length inserted.
fn ins(c: &mut Comp, s: &[u8], mv: bool) -> i32 {
	i32::try_from(c.line.inststrlen(s, mv)).unwrap_or(i32::MAX)
}

/// zsh `foredel(n, CUT_RAW)`.
fn foredel(c: &mut Comp, n: i32) {
	c.line.foredel(usize::try_from(n).unwrap_or(0));
}

/// `zlemetaline[a..b]`.
fn line_part(c: &Comp, a: i32, b: i32) -> BString {
	let l = c.line.bytes();
	let a = usize::try_from(a).unwrap_or(0).min(l.len());
	let b = usize::try_from(b).unwrap_or(0).clamp(a, l.len());
	BString::from(&l[a..b])
}

/// The first `len` bytes of a cline string (C's pointer and length).
fn clstr(s: Option<&BString>, len: i32) -> Vec<u8> {
	let s = s.map_or(&[][..], |s| s.as_slice());
	s[..usize::try_from(len).unwrap_or(0).min(s.len())].to_vec()
}

/// Length of a string as C's `strlen`.
fn slen(s: &[u8]) -> i32 {
	i32::try_from(s.len()).unwrap_or(i32::MAX)
}

// ---- the unambiguous string
// ----------------------------------------------------

/// zsh `cut_cline`: the cline list cut before the parts not worth
/// inserting.
fn cut_cline(c: &mut Comp, l: Option<Cl>) -> Option<Cl> {
	use compmatch::{cline_setlens, cline_sublen, cp_cline};
	// Without matching we cannot know which parts are worth keeping.
	if c.core.hasmatched == 0 {
		cline_setlens(&mut c.clines, l, false);
		return l;
	}
	let l = cp_cline(c, l, false);
	let mut e = l;
	let mut ls = false;
	let mut miss = false;

	// The last struct with something on the line: everything before it is
	// kept.
	let mut q = None;
	let mut p = l;
	while let Some(pi) = p {
		let n = c.clines.get(pi);
		if n.orig.is_some() || n.olen != 0 || n.flags & clf::NEW == 0 {
			e = n.next;
		}
		if n.suffix.is_none() && (n.wlen != 0 || n.llen != 0 || n.prefix.is_some()) {
			q = Some(pi);
		}
		p = n.next;
	}
	if e.is_none()
		&& let Some(qi) = q
	{
		let n = c.clines.get_mut(qi);
		if n.orig.is_none()
			&& n.olen == 0
			&& n.flags & clf::MISS != 0
			&& (n.flags & clf::MATCHED == 0 || (n.prefix.is_none() && n.suffix.is_none()))
			&& (if n.word.is_some() { n.wlen } else { n.llen }) < 3
		{
			n.word = None;
			n.line = None;
			n.wlen = 0;
			n.llen = 0;
		}
	}
	// Then keep all structs without missing characters.
	while let Some(ei) = e
		&& c.clines.get(ei).flags & clf::MISS == 0
	{
		e = c.clines.get(ei).next;
	}
	'end: {
		let Some(ei) = e else {
			break 'end;
		};
		// Another struct with missing characters? If not, keep the list.
		let mut p = c.clines.get(ei).next;
		while let Some(pi) = p
			&& c.clines.get(pi).flags & clf::MISS == 0
		{
			p = c.clines.get(pi).next;
		}
		if p.is_none() {
			break 'end;
		}
		let (mut sum, mut max, mut maxp) = (0i32, 0i32, None);
		let mut p = e;
		while let Some(pi) = p {
			let n = c.clines.get(pi);
			if n.flags & clf::MISS == 0 {
				sum += n.max;
			} else {
				let tmp = cline_sublen(&c.clines, pi);
				if tmp > 2 && tmp > ((n.max + n.min) >> 1) {
					sum += tmp - (n.max - tmp);
				} else if tmp < n.min {
					sum -= (((n.max + n.min) >> 1) - tmp) << i32::from(tmp < 2);
				}
			}
			if sum > max {
				max = sum;
				maxp = Some(pi);
			}
			p = n.next;
		}
		let cut = if max != 0 {
			maxp.unwrap_or(ei)
		} else {
			cline_setlens(&mut c.clines, l, false);
			ls = true;
			let mut len = 0;
			let mut p = e;
			while let Some(pi) = p {
				len += c.clines.get(pi).min;
				p = c.clines.get(pi).next;
			}
			if len > ((c.core.minmlen << 1) / 3) {
				break 'end;
			}
			ei
		};
		let n = c.clines.get_mut(cut);
		n.line = None;
		n.word = None;
		n.llen = 0;
		n.wlen = 0;
		n.olen = 0;
		n.next = None;
	}
	// Sanity check: without parts with missing characters, parts with
	// joined substrings go.
	let mut e = None;
	let mut tmp = false;
	let mut p = l;
	while let Some(pi) = p {
		let n = c.clines.get(pi);
		if n.flags & (clf::MISS | clf::DIFF) != 0 {
			miss = true;
		}
		let mut q = n.prefix;
		while let Some(qi) = q {
			if c.clines.get(qi).flags & clf::JOIN != 0 {
				e = Some(pi);
				tmp = false;
				break;
			}
			q = c.clines.get(qi).next;
		}
		let mut q = n.suffix;
		while let Some(qi) = q {
			if c.clines.get(qi).flags & clf::JOIN != 0 {
				e = Some(pi);
				tmp = true;
				break;
			}
			q = c.clines.get(qi).next;
		}
		p = n.next;
	}
	if let Some(ei) = e
		&& (!miss || cline_sublen(&c.clines, ei) == c.clines.get(ei).min)
	{
		let mut p = if tmp {
			c.clines.get(ei).suffix
		} else {
			c.clines.get(ei).prefix
		};
		while let Some(pi) = p
			&& let Some(nx) = c.clines.get(pi).next
			&& c.clines.get(nx).flags & clf::JOIN == 0
		{
			p = Some(nx);
		}
		if let Some(pi) = p {
			c.clines.get_mut(pi).next = None;
		}
	}
	if !ls {
		cline_setlens(&mut c.clines, l, false);
	}
	l
}

/// Brace re-insertion state of [`cline_str`]: indexes into `brbeg`
/// (forwards, zsh `next`) and `brend` (backwards from `lastbrend`, zsh
/// `prev`).
struct Br {
	brp: Option<usize>,
	brs: Option<usize>,
}

impl Br {
	fn brp_curpos(&self, c: &Comp) -> Option<i32> {
		self.brp.map(|i| c.tricky.brbeg[i].curpos)
	}

	fn brs_curpos(&self, c: &Comp) -> Option<i32> {
		self.brs.map(|i| c.tricky.brend[i].curpos)
	}

	fn next_brp(&mut self, c: &Comp) {
		self.brp = self
			.brp
			.map(|i| i + 1)
			.filter(|&i| i < c.tricky.brbeg.len());
	}

	fn prev_brs(&mut self) {
		self.brs = self.brs.and_then(|i| i.checked_sub(1));
	}
}

/// Insert brace string `s` at `at`, leaving the cursor `bl` after where
/// it was (`ocs = zlemetacs; zlemetacs = at; inststrlen(…); zlemetacs =
/// ocs + bl;`): `bl`.
fn put_br(c: &mut Comp, at: i32, s: &[u8]) -> i32 {
	let ocs = cs(c);
	let bl = slen(s);
	set_cs(c, at);
	ins(c, s, true);
	set_cs(c, ocs + bl);
	bl
}

/// zsh `cline_str(l, ins, csp, posl)`: build the unambiguous string. With
/// `ins == 1` it is inserted into the line (`None` returned); otherwise
/// it is returned, `csp` gets the cursor position in it and `posl` the
/// positions with missing or ambiguous characters (with `ins == 2` as
/// line positions, braces included).
#[expect(clippy::too_many_lines, reason = "a faithful port of one C function")]
pub fn cline_str(
	c: &mut Comp,
	l: Option<Cl>,
	insm: i32,
	csp: Option<&mut i32>,
	mut posl: Option<&mut Vec<i64>>,
) -> Option<BString> {
	let ocs = cs(c);
	let (wb, we) = (c.tricky.wb, c.tricky.we);
	let padd = if insm != 0 { wb - ocs } else { -ocs };
	let mut l = cut_cline(c, l);

	let (mut pmm, mut pma, mut smm, mut sma, mut dm, mut pcs, mut scs) =
		(0u32, false, 0u32, false, 0u32, 0i32, 0i32);
	let (mut pm, mut pmax, mut sm, mut smax, mut d, mut mid, mut cbr) =
		(-1i32, -1i32, -1i32, -1i32, -1i32, -1i32, -1i32);
	let mut li = 0i32;
	let mut opos: i64 = -1;
	let mut br = Br { brp: None, brs: None };
	let hasunqu = c.core.hasunqu != 0;

	let addpos = |posl: &mut Option<&mut Vec<i64>>, npos: i64, opos: &mut i64| {
		if let Some(pl) = posl.as_deref_mut()
			&& npos != *opos
		{
			*opos = npos;
			pl.push(npos);
		}
	};

	// The brace beginnings and ends to re-insert.
	if insm != 0 {
		let mut olen = we - wb;
		if !c.tricky.brbeg.is_empty() {
			br.brp = Some(0);
			for bp in &mut c.tricky.brbeg {
				bp.curpos = if hasunqu { bp.pos } else { bp.qpos };
				olen -= slen(&bp.str);
			}
		}
		if !c.tricky.brend.is_empty() {
			br.brs = Some(c.tricky.brend.len() - 1);
			for bp in &c.tricky.brend {
				olen -= slen(&bp.str);
			}
			for bp in &mut c.tricky.brend {
				bp.curpos = olen - if hasunqu { bp.pos } else { bp.qpos };
			}
		}
		while let Some(i) = br.brp
			&& c.tricky.brbeg[i].curpos == 0
		{
			let s = c.tricky.brbeg[i].str.clone();
			ins(c, &s, true);
			br.next_brp(c);
		}
		while let Some(i) = br.brs
			&& c.tricky.brend[i].curpos == 0
		{
			if cbr < 0 {
				cbr = cs(c);
			}
			let s = c.tricky.brend[i].str.clone();
			ins(c, &s, true);
			br.prev_brs();
		}
	}
	// Walk the top-level cline list.
	while let Some(li_) = l {
		let n = c.clines.get(li_).clone();
		// The original string if there is no prefix, else the prefix.
		if n.olen != 0 && n.flags & clf::SUF == 0 && n.prefix.is_none() {
			pcs = cs(c) + n.olen;
			ins(c, &clstr(n.orig.as_ref(), n.olen), true);
		} else {
			let mut s = n.prefix;
			while let Some(si) = s {
				let sn = c.clines.get(si).clone();
				pcs = cs(c) + sn.llen;
				if sn.flags & clf::LINE != 0 {
					ins(c, &clstr(sn.line.as_ref(), sn.llen), true);
				} else {
					ins(c, &clstr(sn.word.as_ref(), sn.wlen), true);
				}
				scs = cs(c);
				if sn.flags & clf::DIFF != 0 && (dm == 0 || sn.flags & clf::MATCHED != 0) {
					d = cs(c);
					dm = sn.flags & clf::MATCHED;
					addpos(&mut posl, i64::from(cs(c) + padd), &mut opos);
				}
				li += sn.llen;
				s = sn.next;
			}
		}
		if insm != 0 {
			while let Some(cp) = br.brp_curpos(c)
				&& li >= cp
			{
				let s = c.tricky.brbeg[br.brp.unwrap_or(0)].str.clone();
				let bl = put_br(c, pcs - (li - cp), &s);
				pcs += bl;
				scs += bl;
				br.next_brp(c);
			}
		}
		// The first prefix with missing characters.
		if n.flags & clf::MISS != 0 && n.flags & clf::SUF == 0 {
			addpos(&mut posl, i64::from(cs(c) + padd), &mut opos);
			if ((pmax <= (n.max - n.min) || (pma && n.max != n.min))
				&& (pmm == 0 || n.flags & clf::MATCHED != 0))
				|| (n.flags & clf::MATCHED != 0 && pmm == 0)
			{
				pm = cs(c);
				pmax = n.max - n.min;
				pmm = n.flags & clf::MATCHED;
				pma = (n.prefix.is_some() || n.suffix.is_some())
					&& n.min == compmatch::cline_sublen(&c.clines, li_);
			}
		}
		if insm != 0 {
			while let Some(cp) = br.brs_curpos(c)
				&& li >= cp
			{
				let at = scs - (li - cp);
				if cbr < 0 {
					cbr = at;
				}
				let s = c.tricky.brend[br.brs.unwrap_or(0)].str.clone();
				// zsh's `pcs += bl` here is overwritten right after.
				put_br(c, at, &s);
				br.prev_brs();
			}
		}
		pcs = cs(c);
		// The anchor.
		if n.flags & clf::LINE != 0 {
			ins(c, &clstr(n.line.as_ref(), n.llen), true);
		} else {
			ins(c, &clstr(n.word.as_ref(), n.wlen), true);
		}
		scs = cs(c);
		if insm != 0 {
			li += n.llen;
			while let Some(cp) = br.brp_curpos(c)
				&& li >= cp
			{
				let s = c.tricky.brbeg[br.brp.unwrap_or(0)].str.clone();
				let bl = put_br(c, pcs + n.llen - (li - cp), &s);
				pcs += bl;
				scs += bl;
				br.next_brp(c);
			}
		}
		// The cursor position for suffixes and mids.
		if n.flags & clf::MISS != 0 {
			if n.flags & clf::MID != 0 {
				mid = cs(c);
			} else if n.flags & clf::SUF != 0 {
				addpos(&mut posl, i64::from(cs(c) + padd), &mut opos);
				if ((smax <= (n.min - n.max) || (sma && n.max != n.min))
					&& (smm == 0 || n.flags & clf::MATCHED != 0))
					|| (n.flags & clf::MATCHED != 0 && smm == 0)
				{
					sm = cs(c);
					smax = n.min - n.max;
					smm = n.flags & clf::MATCHED;
					sma = (n.prefix.is_some() || n.suffix.is_some())
						&& n.min == compmatch::cline_sublen(&c.clines, li_);
				}
			}
		}
		if insm != 0 {
			while let Some(cp) = br.brs_curpos(c)
				&& li >= cp
			{
				let at = scs - (li - cp);
				if cbr < 0 {
					cbr = at;
				}
				let s = c.tricky.brend[br.brs.unwrap_or(0)].str.clone();
				let bl = put_br(c, at, &s);
				pcs += bl;
				br.prev_brs();
			}
		}
		// The suffix or the original string.
		if n.olen != 0 && n.flags & clf::SUF != 0 && n.suffix.is_none() {
			pcs = cs(c);
			ins(c, &clstr(n.orig.as_ref(), n.olen), true);
			if insm != 0 {
				li += n.olen;
				while let Some(cp) = br.brp_curpos(c)
					&& li >= cp
				{
					let s = c.tricky.brbeg[br.brp.unwrap_or(0)].str.clone();
					let bl = put_br(c, pcs + n.olen - (li - cp), &s);
					pcs += bl;
					br.next_brp(c);
				}
				while let Some(cp) = br.brs_curpos(c)
					&& li >= cp
				{
					let at = pcs + n.olen - (li - cp);
					if cbr < 0 {
						cbr = at;
					}
					let s = c.tricky.brend[br.brs.unwrap_or(0)].str.clone();
					let bl = put_br(c, at, &s);
					pcs += bl;
					br.prev_brs();
				}
			}
		} else {
			let (mut j, mut i) = (-1i32, 0i32);
			let mut js_flags = 0u32;
			let mut s = n.suffix;
			while let Some(si) = s {
				let sn = c.clines.get(si).clone();
				if j < 0 && sn.flags & clf::DIFF != 0 {
					j = i;
					js_flags = sn.flags;
				}
				pcs = cs(c);
				if sn.flags & clf::LINE != 0 {
					ins(c, &clstr(sn.line.as_ref(), sn.llen), false);
					i += sn.llen;
					scs = cs(c) + sn.llen;
				} else {
					ins(c, &clstr(sn.word.as_ref(), sn.wlen), false);
					i += sn.wlen;
					scs = cs(c) + sn.wlen;
				}
				if insm != 0 {
					li += sn.llen;
					while let Some(cp) = br.brp_curpos(c)
						&& li >= cp
					{
						let s = c.tricky.brbeg[br.brp.unwrap_or(0)].str.clone();
						let bl = put_br(c, pcs + (li - cp), &s);
						pcs += bl;
						scs += bl;
						br.next_brp(c);
					}
					while let Some(cp) = br.brs_curpos(c)
						&& li >= cp
					{
						let at = scs - (li - cp);
						if cbr < 0 {
							cbr = at;
						}
						let s = c.tricky.brend[br.brs.unwrap_or(0)].str.clone();
						let bl = put_br(c, at, &s);
						pcs += bl;
						br.prev_brs();
					}
				}
				s = sn.next;
			}
			set_cs(c, cs(c) + i);
			if j >= 0 && (dm == 0 || js_flags & clf::MATCHED != 0) {
				d = cs(c) - j;
				dm = js_flags & clf::MATCHED;
				addpos(&mut posl, i64::from(cs(c) - j + padd), &mut opos);
			}
		}
		l = n.next;
	}
	addpos(&mut posl, i64::from(cs(c) + padd), &mut opos);

	if insm != 0 {
		let ocs = cs(c);
		while let Some(i) = br.brp {
			let s = c.tricky.brbeg[i].str.clone();
			ins(c, &s, true);
			br.next_brp(c);
		}
		while let Some(i) = br.brs {
			if cbr < 0 {
				cbr = cs(c);
			}
			let s = c.tricky.brend[i].str.clone();
			ins(c, &s, true);
			br.prev_brs();
		}
		let add = cs(c) - ocs;
		for v in [&mut mid, &mut pm, &mut sm, &mut d] {
			if *v >= ocs {
				*v += add;
			}
		}
		if let Some(pl) = posl {
			for p in pl.iter_mut() {
				if *p >= i64::from(ocs) {
					*p += i64::from(add);
				}
			}
		}
	}
	// The new cursor: a mid cline with missing characters, else a
	// brace end, a prefix with missing characters, a suffix, a place
	// where the matches differ.
	let ncs = if mid >= 0 {
		mid
	} else if cbr >= 0 {
		cbr
	} else if pm >= 0 {
		pm
	} else if sm >= 0 {
		sm
	} else if d >= 0 {
		d
	} else {
		cs(c)
	};
	if insm != 1 {
		// Always inserted in the line: copy it out and remove it.
		let r = line_part(c, ocs, cs(c));
		let n = cs(c) - ocs;
		set_cs(c, ocs);
		foredel(c, n);
		if let Some(csp) = csp {
			*csp = ncs - ocs;
		}
		return Some(r);
	}
	c.core.lastend = cs(c);
	set_cs(c, ncs);
	None
}

/// zsh `build_pos_string`: positions as a colon-separated string.
fn build_pos_string(list: &[i64]) -> BString {
	let parts: Vec<String> = list.iter().map(ToString::to_string).collect();
	BString::from(parts.join(":"))
}

/// zsh `unambig_data(cp, pp, ip)`: the unambiguous string (compstate's
/// `unambiguous`), with the cursor position in it (`cp`, 1-based), the
/// positions of missing characters (`pp`) and those as line positions
/// (`ip`). Cached until the matches change.
pub fn unambig_data(
	c: &mut Comp,
	cp: Option<&mut i32>,
	pp: Option<&mut BString>,
	ip: Option<&mut BString>,
) -> BString {
	if c.core.mnum != 0 && c.core.ainfo.is_some() {
		if c.core.mnum != c.core.unambig_mnum {
			let line = match (&c.core.ainfo, &c.core.fainfo) {
				(Some(a), _) if a.count != 0 => a.line,
				(_, Some(f)) => f.line,
				(Some(a), None) => a.line,
				(None, None) => None,
			};
			let mut list = Vec::new();
			let mut cc = 0;
			c.result.scache = cline_str(c, line, 0, Some(&mut cc), Some(&mut list));
			c.result.ccache = cc;
			c.result.pcache = Some(build_pos_string(&list));
			let mut list = Vec::new();
			cline_str(c, line, 2, None, Some(&mut list));
			c.result.icache = Some(build_pos_string(&list));
		}
	} else if c.core.mnum != c.core.unambig_mnum
		|| c.core.ainfo.is_none()
		|| c.result.scache.is_none()
	{
		c.result.scache = Some(BString::default());
		c.result.pcache = Some(BString::default());
		c.result.icache = Some(BString::default());
		c.result.ccache = 0;
	}
	c.core.unambig_mnum = c.core.mnum;
	if let Some(cp) = cp {
		*cp = c.result.ccache + 1;
	}
	if let Some(pp) = pp {
		*pp = c.result.pcache.clone().unwrap_or_default();
	}
	if let Some(ip) = ip {
		*ip = c.result.icache.clone().unwrap_or_default();
	}
	c.result.scache.clone().unwrap_or_default()
}

// ---- inserting a match
// ----------------------------------------------------------

/// zsh `instmatch(m, scs)`: insert `m` at the cursor; the bytes
/// inserted. `scs` gets where an automatic suffix goes.
fn instmatch(c: &mut Comp, m: &Cmatch, scsp: Option<&mut i32>) -> i32 {
	let mut r = 0;
	let mut a = cs(c);
	let mut brb = 0;
	c.tricky.lastprebr = None;
	c.tricky.lastpostbr = None;

	// Ignored prefix.
	if let Some(ipre) = &m.ipre {
		let skip = if c.core.menuacc != 0 {
			usize::try_from(m.qipl).unwrap_or(0).min(ipre.len())
		} else {
			0
		};
		let p = ipre[skip..].to_vec();
		r += ins(c, &p, true);
	}
	for s in [&m.pre, &m.ppre].into_iter().flatten() {
		r += ins(c, s, true);
	}
	r += ins(c, &m.str, true);
	let mut ocs = cs(c);
	// The brace beginnings.
	if !c.tricky.brbeg.is_empty() {
		let mut pcs = cs(c);
		let mut bradd = m.pre.as_ref().map_or(0, |p| slen(p));
		if let Some(brpl) = &m.brpl {
			let n = c.tricky.brbeg.len().min(brpl.len());
			for (i, &pos) in brpl.iter().enumerate().take(n) {
				set_cs(c, a + pos + bradd);
				pcs = cs(c);
				let s = c.tricky.brbeg[i].str.clone();
				let l = slen(&s);
				bradd += l;
				c.core.brpcs = cs(c);
				ins(c, &s, true);
				r += l;
				ocs += l;
			}
		}
		c.tricky.lastprebr = Some(line_part(c, a, pcs));
		set_cs(c, ocs);
	}
	if let Some(psuf) = &m.psuf {
		r += ins(c, psuf, true);
	}
	// The brace ends.
	if c.tricky.brend.is_empty() {
		c.core.brscs = -1;
		if let Some(scsp) = scsp {
			*scsp = cs(c);
		}
	} else {
		a = cs(c);
		let mut bradd = 0;
		for i in 0..c.tricky.brend.len() {
			let pos = m.brsl.as_ref().and_then(|b| b.get(i).copied()).unwrap_or(0);
			set_cs(c, a - pos);
			ocs = cs(c);
			c.core.brscs = ocs;
			let s = c.tricky.brend[i].str.clone();
			let l = slen(&s);
			bradd += l;
			ins(c, &s, true);
			brb = cs(c);
			r += l;
		}
		set_cs(c, a + bradd);
		if let Some(scsp) = scsp {
			*scsp = ocs;
		}
	}
	for s in [&m.suf, &m.isuf].into_iter().flatten() {
		r += ins(c, s, true);
	}
	if !c.tricky.brend.is_empty() {
		c.tricky.lastpostbr = Some(line_part(c, brb, cs(c)));
	}
	c.core.lastend = cs(c);
	set_cs(c, ocs);
	r
}

/// zsh `hasbrpsfx(m, pre, suf)`: whether `m` has prefix `pre` before and
/// suffix `suf` after the braces. The match is inserted into the line
/// and the line restored. zsh metafies an unmetafied line first; callers
/// here have it metafied, and an unmetafied line is taken as empty
/// (the brace strings do not depend on the text around the match).
pub fn hasbrpsfx(c: &mut Comp, m: &Cmatch, pre: Option<&[u8]>, suf: Option<&[u8]>) -> bool {
	if m.flags & cmf::ALL != 0 {
		return true;
	}
	let was_meta = c.line.s.is_some();
	if !was_meta {
		c.line.s = Some(Vec::new());
		c.line.cs = 0;
	}
	let op = c.tricky.lastprebr.take();
	let os = c.tricky.lastpostbr.take();
	let saved = c.line.clone();
	let (ole, opcs, oscs) = (c.core.lastend, c.core.brpcs, c.core.brscs);

	instmatch(c, m, None);

	c.line = saved;
	c.core.lastend = ole;
	c.core.brpcs = opcs;
	c.core.brscs = oscs;
	let lp = c.tricky.lastprebr.take();
	let ls = c.tricky.lastpostbr.take();
	let ret =
		pre.map(<[u8]>::to_vec) == lp.map(Vec::from) && suf.map(<[u8]>::to_vec) == ls.map(Vec::from);
	c.tricky.lastprebr = op;
	c.tricky.lastpostbr = os;
	if !was_meta {
		c.line.s = None;
	}
	ret
}

/// zsh `zrefresh()` from completion code: the line is unmetafied for the
/// display and metafied again (zsh's `remetafy`).
fn zrefresh(zw: &mut Zw<'_, '_>) {
	let meta = zw.zle.comp.line.s.is_some();
	if meta {
		zw.zle.comp.line.unmetafy(zw.ed);
	}
	display::refresh(zw);
	if meta {
		zw.zle.comp.line.metafy(zw.ed);
	}
}

/// zsh `do_ambiguous()`: more than one match. `k` gets the return value
/// (1: beep for `LIST_BEEP`).
pub fn do_ambiguous(zw: &mut Zw<'_, '_>, k: K<i32>) -> WResult {
	{
		let c = &mut zw.zle.comp;
		c.tricky.menucmp = 0;
		c.core.menuacc = 0;
	}
	// Insert the exact match as the only one (REC_EXACT).
	let exact = zw
		.zle
		.comp
		.core
		.ainfo
		.as_ref()
		.filter(|a| a.exact == 1)
		.and_then(|a| a.exactm.as_deref().cloned());
	if let Some(m) = exact
		&& zw.zle.comp.core.fromcomp as u32 & fc::LINE == 0
	{
		zw.zle.comp.core.minfo.cur = None;
		return do_single(
			zw,
			m,
			Box::new(move |zw, ()| {
				invalidate_list(zw);
				k(zw, 0)
			}),
		);
	}
	// Ambiguous: AUTO_MENU may start a menu next time, unless an
	// unambiguous prefix is inserted below.
	zw.zle.comp.tricky.lastambig = 1;

	let c = &zw.zle.comp;
	let patmenu = c.core.haspattern != 0
		&& c
			.complete
			.comppatinsert
			.as_ref()
			.is_some_and(|s| s.as_slice() == b"menu");
	if c.core.iforcemenu != -1 && (c.tricky.usemenu != 0 || patmenu) {
		// Menu completion from the options, menu-complete-word, or
		// GLOB_COMPLETE.
		return do_ambig_menu(zw, Box::new(move |zw, ()| ambig_list(zw, k)));
	}
	if zw.zle.comp.core.ainfo.is_none() {
		return k(zw, 0);
	}
	let automenu = zw.isset(ZshOpt::Automenu);
	let bashautolist = zw.isset(ZshOpt::Bashautolist);
	let listambiguous = zw.isset(ZshOpt::Listambiguous);
	let c = &mut zw.zle.comp;
	let (wb, we) = (c.tricky.wb, c.tricky.we);
	let atend = cs(c) == we;
	c.core.minfo.cur = None;
	c.core.minfo.asked = 0;
	suffix::fixsuffix(&mut zw.zle.comp, zw.ed);
	let c = &mut zw.zle.comp;

	// Remove the old string from the line.
	let mut tcs = cs(c);
	set_cs(c, wb);
	let old = line_part(c, wb, we);
	foredel(c, we - wb);

	// The unambiguous string into the line.
	let line = c.core.ainfo.as_ref().and_then(|a| a.line);
	cline_str(c, line, 1, None, None);

	// Match specs may give an empty string: re-insert the old one
	// (unless there were matches added with -U).
	if c.core.lastend < we && c.core.lenchanged == 0 && c.core.hasunmatched == 0 {
		set_cs(c, wb);
		let n = c.core.lastend - wb;
		foredel(c, n);
		ins(c, &old, false);
		c.core.lastend = we;
		set_cs(c, tcs);
	}
	if c.core.eparq != 0 {
		tcs = cs(c);
		set_cs(c, c.core.lastend);
		for _ in 0..c.core.eparq {
			ins(c, b"\"", false);
		}
		set_cs(c, tcs);
	}
	// May LIST_AMBIGUOUS be used: did the line change?
	let la = ll(c) != c.tricky.origll
		|| c.tricky.origline.as_ref().map(|o| o.as_slice()) != Some(c.line.bytes());

	// With REC_EXACT and AUTO_MENU, menu completion next time; remember
	// moving the cursor into the word.
	c.core.fromcomp = i32::try_from(
		(if automenu { fc::LINE } else { 0 })
			| (if atend && cs(c) != c.core.lastend {
				fc::INWORD
			} else {
				0
			}),
	)
	.unwrap_or(0);

	if c.core.movetoend == 3 {
		set_cs(c, c.core.lastend);
	}
	// LIST_AMBIGUOUS: something was inserted, so no list now.
	if (c.core.uselist == 3 || (c.core.uselist == 0 && bashautolist && listambiguous))
		&& la
		&& c.core.iforcemenu != -1
	{
		let fcm = c.core.fromcomp;
		invalidate_list(zw);
		let c = &mut zw.zle.comp;
		c.core.fromcomp = fcm;
		c.tricky.lastambig = 0;
		zw.ed.clearlist = true;
		return k(zw, 0);
	}
	ambig_list(zw, k)
}

/// The end of [`do_ambiguous`]: maybe show a list.
fn ambig_list(zw: &mut Zw<'_, '_>, k: K<i32>) -> WResult {
	let listbeep = zw.isset(ZshOpt::Listbeep);
	let c = &zw.zle.comp;
	let d = &mut zw.zle.display;
	let ret = i32::from(listbeep && c.core.oldlist == 0);
	if c.core.uselist != 0
		&& (c.tricky.usemenu != 2 || (d.listshown == 0 && c.core.oldlist == 0))
		&& ((d.showinglist == 0 && (d.listshown == 0 || c.core.oldlist == 0))
			|| (c.tricky.usemenu == 3 && c.core.oldlist == 0))
		&& (c.core.smatches >= 2 || c.core.forcelist != 0)
	{
		d.showinglist = -2;
	}
	k(zw, ret)
}

/// Run `k` with the stat of the host path `path` (unmetafied, relative to
/// the shell's directory), waiting for the host as needed.
fn stat_k<F>(
	zw: &mut Zw<'_, '_>,
	path: Vec<u8>,
	follow: bool,
	mut sc: Box<Scratch>,
	k: F,
) -> WResult
where
	F: FnOnce(&mut Zw<'_, '_>, Option<Stat>) -> WResult + Send + 'static,
{
	if path.is_empty() {
		return k(zw, None);
	}
	let probe = Probe::Stat { path: absolute(&zw.vp.cwd, &path), follow };
	match probe::perform(zw.k, zw.cx, zw.vp, &mut sc, &probe) {
		Err(key) => then(Await::Wait(key), move |zw, _| stat_k(zw, path, follow, sc, k)),
		Ok(ProbeResult::Stat(st)) => {
			sc.recycle();
			k(zw, st)
		},
		Ok(_) => {
			sc.recycle();
			k(zw, None)
		},
	}
}

/// zsh `ztat(nam, buf, ls)`: `stat` (`lstat` with `ls`) of the metafied
/// `nam`, again with backslashes removed when that fails; `k` gets the
/// result (`None`: zsh's non-zero return).
pub fn ztat<F>(zw: &mut Zw<'_, '_>, nam: &[u8], ls: bool, k: F) -> WResult
where
	F: FnOnce(&mut Zw<'_, '_>, Option<Stat>) -> WResult + Send + 'static,
{
	let raw = tok::unmetafy(nam);
	let mut p = Vec::with_capacity(raw.len());
	let mut q = 0;
	while q < raw.len() {
		if raw[q] == b'\\' && q + 1 < raw.len() {
			q += 1;
		}
		p.push(raw[q]);
		q += 1;
	}
	stat_k(zw, raw, !ls, Box::default(), move |zw, st| {
		if st.is_some() {
			return k(zw, st);
		}
		stat_k(zw, p, !ls, Box::default(), k)
	})
}

/// The first group with matches starting at `g` (following `next`).
fn first_with_matches(c: &Comp, mut g: Option<GId>) -> Option<GId> {
	while let Some(gi) = g {
		if c.groups.get(gi).mcount != 0 {
			return Some(gi);
		}
		g = c.groups.get(gi).next;
	}
	None
}

/// What [`do_allmatches`] carries through its loop.
struct AllMatches {
	first: bool,
	nm:    i32,
	omc:   i32,
	oma:   i32,
	mi:    super::types::Menuinfo,
	p:     Option<BString>,
}

/// zsh `do_allmatches(end)`: insert all matches into the line.
pub fn do_allmatches(zw: &mut Zw<'_, '_>, _end: i32, k: K<()>) -> WResult {
	let c = &mut zw.zle.comp;
	let st = AllMatches {
		first: true,
		nm:    c.core.nmatches - 1,
		omc:   c.tricky.menucmp,
		oma:   c.core.menuacc,
		mi:    c.core.minfo.clone(),
		p:     c.tricky.brbeg.last().map(|b| b.str.clone()),
	};
	c.tricky.menucmp = 1;
	c.core.menuacc = 0;
	c.core.minfo.group = first_with_matches(c, c.core.amatches);
	let Some(g) = c.core.minfo.group else {
		return allmatches_end(zw, st, k);
	};
	allmatches_step(zw, st, MRef { g, i: 0 }, k)
}

/// One match of [`do_allmatches`]'s loop.
fn allmatches_step(zw: &mut Zw<'_, '_>, mut st: AllMatches, mc: MRef, k: K<()>) -> WResult {
	let Some(m) = zw.zle.comp.groups.mat(mc).cloned() else {
		return allmatches_end(zw, st, k);
	};
	if m.flags & cmf::ALL != 0 {
		return allmatches_next(zw, st, mc, k);
	}
	let first = st.first;
	st.first = false;
	let go = move |zw: &mut Zw<'_, '_>| {
		let c = &mut zw.zle.comp;
		if st.omc == 0 {
			st.nm -= 1;
			if st.nm == 0 {
				c.tricky.menucmp = 0;
			}
		}
		do_single(zw, m, Box::new(move |zw, ()| allmatches_next(zw, st, mc, k)))
	};
	if first {
		go(zw)
	} else {
		accept_last(zw, Box::new(move |zw, _| go(zw)))
	}
}

/// [`do_allmatches`]: on to the match after `mc`.
fn allmatches_next(zw: &mut Zw<'_, '_>, st: AllMatches, mc: MRef, k: K<()>) -> WResult {
	let c = &mut zw.zle.comp;
	c.core.minfo.cur = Some(mc);
	let mut cur = MRef { g: mc.g, i: mc.i + 1 };
	if cur.i >= c.groups.get(cur.g).matches.len() {
		let next = c.groups.get(cur.g).next;
		c.core.minfo.group = first_with_matches(c, next);
		let Some(g) = c.core.minfo.group else {
			return allmatches_end(zw, st, k);
		};
		cur = MRef { g, i: 0 };
		c.core.minfo.cur = Some(cur);
	}
	allmatches_step(zw, st, cur, k)
}

/// The end of [`do_allmatches`].
fn allmatches_end(zw: &mut Zw<'_, '_>, st: AllMatches, k: K<()>) -> WResult {
	let c = &mut zw.zle.comp;
	c.tricky.menucmp = st.omc;
	c.core.menuacc = st.oma;
	let e = c.core.minfo.end;
	c.core.minfo = st.mi;
	c.core.minfo.end = e;
	c.core.minfo.len = e - c.core.minfo.pos;
	if let Some(p) = st.p
		&& let Some(b) = c.tricky.brbeg.last_mut()
	{
		b.str = p;
	}
	k(zw, ())
}

/// What [`do_single`] carries past the `stat`.
struct Single {
	m:        Cmatch,
	havesuff: bool,
	scs:      i32,
	partest:  bool,
	sr:       bool,
}

/// zsh `do_single(m)`: insert match `m` into the line (with the
/// automatic suffixes: `/` after directories, `}` after `${name`, `,` in
/// braces, a space), then run the `zle-line-pre-redraw` hook (zsh's
/// `redrawhook()`; the `insert_match` hook it runs first has no
/// functions in zsh).
pub fn do_single(zw: &mut Zw<'_, '_>, m: Cmatch, k: K<()>) -> WResult {
	let autoparamslash = zw.isset(ZshOpt::Autoparamslash);
	let c = &mut zw.zle.comp;
	let partest = m.ripre.is_some() || (m.flags & cmf::ISPAR != 0 && c.core.parpre.is_some());
	suffix::fixsuffix(&mut zw.zle.comp, zw.ed);
	let c = &mut zw.zle.comp;

	if c.core.minfo.cur.is_none() {
		// Not in a menu completion: set the positions.
		let mte = c.core.movetoend;
		c.core.minfo.pos = c.tricky.wb;
		c.core.minfo.we =
			mte >= 2 || (mte == 1 && c.tricky.menucmp == 0) || (mte == 0 && cs(c) == c.tricky.we);
		c.core.minfo.end = c.tricky.we;
	}
	// Delete what a menu completion or glob completion inserted.
	let l = if c.core.minfo.cur.is_some() {
		c.core.minfo.len + c.core.minfo.insc
	} else {
		c.tricky.we - c.tricky.wb
	};
	c.core.minfo.insc = 0;
	set_cs(c, c.core.minfo.pos);
	foredel(c, l);

	if m.flags & cmf::ALL != 0 {
		return do_allmatches(zw, 0, k);
	}
	// The new string.
	let mut scs = 0;
	c.core.minfo.len = instmatch(c, &m, Some(&mut scs));
	c.core.minfo.end = cs(c);
	set_cs(c, c.core.minfo.pos + c.core.minfo.len);

	let mut st = Single { m, havesuff: false, scs, partest, sr: false };
	if let Some(suf) = st.m.suf.clone() {
		st.havesuff = true;
		c.core.minfo.insc = slen(&suf);
		c.core.minfo.len -= c.core.minfo.insc;
		if c.core.minfo.we {
			c.core.minfo.end += c.core.minfo.insc;
			if st.m.flags & cmf::REMOVE != 0 {
				// Character counts, not bytes.
				let wsuf = crate::bash::vm::zle::to_line(&tok::unmetafy(&suf));
				let len = i32::try_from(wsuf.len()).unwrap_or(i32::MAX);
				let (remf, rems) = (st.m.remf.clone(), st.m.rems.clone());
				suffix::makesuffixstr(
					zw,
					remf.as_ref().map(|s| s.as_slice()),
					rems.as_ref().map(|s| s.as_slice()),
					len,
				);
				if len == 1 {
					suffix::addsuffix(&mut zw.zle.comp, suffix::Suftyp::PosStr, 0, &wsuf, 1);
				}
			}
		}
		return single_rest(zw, st, k);
	}
	// No user suffix: make one up.
	set_cs(c, st.scs);
	if partest && st.m.flags & cmf::PARBR != 0 {
		// A parameter in braces: a removable `}`.
		set_cs(c, cs(c) + c.core.eparq);
		for _ in 0..c.core.parq {
			ins(c, b"\"", true);
		}
		c.core.minfo.insc += c.core.parq;
		ins(c, b"}", true);
		c.core.minfo.insc += 1;
		if c.core.minfo.we {
			c.core.minfo.end += c.core.minfo.insc;
		}
		if st.m.flags & cmf::PARNEST != 0 {
			st.havesuff = true;
		}
	}
	let at = c.line.cs;
	if (st.m.flags & cmf::FILE != 0 || (partest && autoparamslash))
		&& at > 0
		&& c.line.bytes().get(at - 1) != Some(&b'/')
	{
		// A file, or a parameter name with AUTO_PARAM_SLASH: a slash if
		// it names a directory.
		if st.m.ipre.as_ref().is_some_and(|p| p.as_slice() == b"~") {
			return single_slash(zw, st, true, k);
		}
		let str_ = st.m.orig.clone().unwrap_or_default();
		let psuf = st.m.psuf.clone().unwrap_or_default();
		let p = if partest && psuf.is_empty() && st.m.flags & cmf::PARNEST == 0 {
			let mut p: Vec<u8> = if st.m.flags & cmf::ISPAR != 0 {
				c.core.parpre.clone().unwrap_or_default().into()
			} else {
				st.m.ripre.clone().unwrap_or_default().into()
			};
			p.extend_from_slice(&str_);
			if st.m.flags & cmf::PARBR != 0 {
				p.push(b'}');
			}
			super::with_ex(zw, |ex, _| param_path(ex, p))
		} else {
			let prpre = st.m.prpre.clone().unwrap_or_default();
			let mut p: Vec<u8> = if prpre.is_empty() {
				b"./".to_vec()
			} else {
				prpre.into()
			};
			p.extend_from_slice(&str_);
			p.extend_from_slice(&psuf);
			p
		};
		return ztat(zw, &p, false, move |zw, sb| {
			st.sr = sb.is_none();
			let t = sb.is_some_and(|s| s.kind == StatKind::Dir);
			single_slash(zw, st, t, k)
		});
	}
	single_noinsc(zw, st, k)
}

/// The path `do_single` stats for a parameter (`$name`, `${name}`):
/// expanded unless it names a non-scalar parameter.
fn param_path(ex: &mut Expander<'_, '_>, p: Vec<u8>) -> Vec<u8> {
	let mut tryit = true;
	if p.first() == Some(&b'$') {
		let n: Vec<u8> = if p.get(1) == Some(&b'{') {
			let mut n = p[2..].to_vec();
			if n.last() == Some(&b'}') {
				n.pop();
			}
			n
		} else {
			p[1..].to_vec()
		};
		if let Ok(Some(pm)) = params::getparam(ex, &n)
			&& pm.flags.type_bits() != params::PmFlags::SCALAR
		{
			tryit = false;
		}
	}
	if !tryit {
		return p;
	}
	// zsh: noerrs = 1; parsestr; singsub; errors cleared.
	let parsed = parsestr(&p).unwrap_or_else(|_| p.clone());
	match singsub(ex, parsed) {
		Ok(mut v) => {
			tok::untokenize(&mut v);
			v
		},
		Err(_) => p,
	}
}

/// [`do_single`] after the directory test: `t` says it is one.
fn single_slash(zw: &mut Zw<'_, '_>, mut st: Single, t: bool, k: K<()>) -> WResult {
	if t {
		let autoremoveslash = zw.isset(ZshOpt::Autoremoveslash);
		let c = &mut zw.zle.comp;
		st.havesuff = true;
		ins(c, b"/", true);
		c.core.minfo.insc += 1;
		if c.core.minfo.we {
			c.core.minfo.end += 1;
		}
		if c.tricky.menucmp == 0 || c.core.minfo.we {
			if st.m.remf.is_some() || st.m.rems.is_some() {
				let (remf, rems) = (st.m.remf.clone(), st.m.rems.clone());
				suffix::makesuffixstr(
					zw,
					remf.as_ref().map(|s| s.as_slice()),
					rems.as_ref().map(|s| s.as_slice()),
					1,
				);
			} else if autoremoveslash {
				suffix::makesuffix(zw, 1);
				suffix::addsuffix(&mut zw.zle.comp, suffix::Suftyp::PosStr, 0, &['/'], 1);
			}
		}
	}
	single_noinsc(zw, st, k)
}

/// [`do_single`]: the cursor when no suffix was made up.
fn single_noinsc(zw: &mut Zw<'_, '_>, st: Single, k: K<()>) -> WResult {
	let c = &mut zw.zle.comp;
	if c.core.minfo.insc == 0 {
		set_cs(c, c.core.minfo.pos + c.core.minfo.len - st.m.qisl);
	}
	single_rest(zw, st, k)
}

/// The rest of [`do_single`]: brace and space suffixes, the cursor, the
/// redraw hook.
fn single_rest(zw: &mut Zw<'_, '_>, mut st: Single, k: K<()>) -> WResult {
	let autoparamkeys = zw.isset(ZshOpt::Autoparamkeys);
	let m = &st.m;
	let c = &mut zw.zle.comp;
	if !c.tricky.brbeg.is_empty() {
		if st.havesuff {
			// A removable suffix: `,` and `}` remove it.
			if autoparamkeys {
				let sl = i32::try_from(zw.ed.ls.suffixlen).unwrap_or(0);
				suffix::addsuffix(c, suffix::Suftyp::PosStr, 0, &[',', '}'], sl);
			}
		} else if c.tricky.menucmp == 0 {
			// Otherwise a `,` suffix that `}` removes.
			set_cs(c, st.scs);
			st.havesuff = true;
			ins(c, b",", true);
			c.core.minfo.insc += 1;
			suffix::makesuffix(zw, 1);
			let c = &mut zw.zle.comp;
			if (c.tricky.menucmp == 0 || c.core.minfo.we) && autoparamkeys {
				suffix::addsuffix(c, suffix::Suftyp::PosStr, 0, &[',', '}'], 1);
			}
		}
	} else if !st.havesuff && (m.flags & cmf::FILE == 0 || !st.sr) {
		// A space, unless menu completing or completing a file name that
		// does not exist.
		if let Some(autoq) = &m.autoq
			&& m.isuf.as_ref().is_none_or(|isuf| !isuf.starts_with(autoq))
		{
			let al = ins(c, autoq, true);
			c.core.minfo.insc += al;
		}
		if c.tricky.menucmp == 0
			&& m.flags & cmf::NOSPACE == 0
			&& (c.tricky.usemenu != 3 || c.core.insspace != 0)
		{
			ins(c, b" ", true);
			c.core.minfo.insc += 1;
			if c.core.minfo.we {
				let (remf, rems) = (m.remf.clone(), m.rems.clone());
				suffix::makesuffixstr(
					zw,
					remf.as_ref().map(|s| s.as_slice()),
					rems.as_ref().map(|s| s.as_slice()),
					1,
				);
			}
		}
	}
	let c = &mut zw.zle.comp;
	if c.core.minfo.we && st.partest && autoparamkeys && c.core.minfo.insc - c.core.parq > 0 {
		// The suffix code counts characters, not bytes.
		let a = usize::try_from(c.core.parq).unwrap_or(0);
		let n = usize::try_from(c.core.minfo.insc - c.core.parq).unwrap_or(0);
		let line = c.line.bytes();
		let part = &line[a.min(line.len())..(a + n).min(line.len())];
		let outlen =
			i32::try_from(crate::bash::vm::zle::to_line(&tok::unmetafy(part)).len()).unwrap_or(0);
		suffix::makeparamsuffix(zw, st.m.flags & cmf::PARBR != 0, outlen);
	}
	let c = &mut zw.zle.comp;
	if (c.tricky.menucmp != 0 && !c.core.minfo.we) || c.core.movetoend == 0 {
		set_cs(c, c.core.minfo.end);
		if cs(c) + st.m.qisl == c.core.lastend {
			set_cs(c, cs(c) + c.core.minfo.insc);
		}
		// Past compadd -s/-S suffixes.
		let adv =
			st.m.psuf.as_ref().map_or(0, |s| slen(s)) + st.m.suf.as_ref().map_or(0, |s| slen(s));
		set_cs(c, cs(c) + adv);
	}
	// zsh `redrawhook()`, with the line unmetafied for the hook widget.
	let meta = zw.zle.comp.line.s.is_some();
	if meta {
		zw.zle.comp.line.unmetafy(zw.ed);
	}
	then(Await::RedrawHook, move |zw, _| {
		if meta {
			zw.zle.comp.line.metafy(zw.ed);
		}
		k(zw, ())
	})
}

/// zsh `do_menucmp(lst)`: in a menu completion, list (`lst ==
/// COMP_LIST_COMPLETE`) or insert the next (`zmult` > 0) or previous
/// match.
pub fn do_menucmp(zw: &mut Zw<'_, '_>, lst: i32, k: K<()>) -> WResult {
	if lst == COMP_LIST_COMPLETE {
		zw.zle.display.showinglist = -2;
		return k(zw, ());
	}
	// Already metafied when called from menu selection.
	let was_meta = zw.zle.comp.line.s.is_some();
	if !was_meta {
		zw.zle.comp.line.metafy(zw.ed);
	}
	let c = &mut zw.zle.comp;
	let (Some(mut g), Some(mut cur)) = (c.core.minfo.group, c.core.minfo.cur) else {
		if !was_meta {
			zw.zle.comp.line.unmetafy(zw.ed);
		}
		return k(zw, ());
	};
	while zw.ed.zmod.mult != 0 {
		let zmult = zw.ed.zmod.mult;
		loop {
			if zmult > 0 {
				cur.i += 1;
				if cur.i >= c.groups.get(g).matches.len() {
					loop {
						g = match c.groups.get(g).next {
							Some(n) => n,
							None => match c.core.amatches {
								Some(a) => a,
								None => break,
							},
						};
						if c.groups.get(g).mcount != 0 {
							break;
						}
					}
					cur = MRef { g, i: 0 };
				}
			} else if cur.i == 0 {
				loop {
					g = match c.groups.get(g).prev {
						Some(p) => p,
						None => match c.core.lmatches {
							Some(l) => l,
							None => break,
						},
					};
					if c.groups.get(g).mcount != 0 {
						break;
					}
				}
				cur = MRef { g, i: usize::try_from(c.groups.get(g).mcount - 1).unwrap_or(0) };
			} else {
				cur.i -= 1;
			}
			c.core.minfo.group = Some(g);
			c.core.minfo.cur = Some(cur);
			let Some(m) = c.groups.mat(cur).cloned() else {
				break;
			};
			let (prebr, postbr) = (c.core.minfo.prebr.clone(), c.core.minfo.postbr.clone());
			let skip = (c.core.menuacc != 0
				&& !hasbrpsfx(
					c,
					&m,
					prebr.as_ref().map(|s| s.as_slice()),
					postbr.as_ref().map(|s| s.as_slice()),
				))
				|| m.flags & cmf::DUMMY != 0
				|| (m.flags & (cmf::NOLIST | cmf::MULT) != 0 && m.str.is_empty());
			if !skip {
				break;
			}
		}
		zw.ed.zmod.mult -= i64::from(0 < zmult) - i64::from(zmult < 0);
	}
	let Some(m) = c.groups.mat(cur).cloned() else {
		if !was_meta {
			zw.zle.comp.line.unmetafy(zw.ed);
		}
		return k(zw, ());
	};
	do_single(
		zw,
		m,
		Box::new(move |zw, ()| {
			if !was_meta {
				zw.zle.comp.line.unmetafy(zw.ed);
			}
			k(zw, ())
		}),
	)
}

/// zsh `accept_last()`: accept the current match and start a new word
/// with the next ones (accept-and-menu-complete). `k` gets 0.
pub fn accept_last(zw: &mut Zw<'_, '_>, k: K<i32>) -> WResult {
	let wasmeta = zw.zle.comp.line.s.is_some();
	if !wasmeta {
		zw.zle.comp.line.metafy(zw.ed);
	}
	let listshown = zw.zle.display.listshown;
	let c = &mut zw.zle.comp;
	if c.core.menuacc == 0 {
		c.core.minfo.prebr.clone_from(&c.tricky.lastprebr);
		c.core.minfo.postbr.clone_from(&c.tricky.lastpostbr);
		if listshown != 0 && (c.tricky.lastprebr.is_some() || c.tricky.lastpostbr.is_some()) {
			let (pre, post) = (c.core.minfo.prebr.clone(), c.core.minfo.postbr.clone());
			let gs: Vec<GId> = c.groups.list(c.core.amatches).collect();
			'groups: for g in gs {
				for i in 0..c.groups.get(g).matches.len() {
					let m = c.groups.get(g).matches[i].clone();
					if !hasbrpsfx(
						c,
						&m,
						pre.as_ref().map(|s| s.as_slice()),
						post.as_ref().map(|s| s.as_slice()),
					) {
						zw.zle.display.showinglist = -2;
						break 'groups;
					}
				}
			}
		}
	}
	let c = &mut zw.zle.comp;
	c.core.menuacc += 1;

	if c.tricky.brbeg.is_empty() {
		set_cs(c, c.core.minfo.pos + c.core.minfo.len + c.core.minfo.insc);
		suffix::iremovesuffix(
			zw,
			Some(' '),
			true,
			Box::new(move |zw, ()| {
				let c = &mut zw.zle.comp;
				let l = cs(c);
				let qisl = c
					.core
					.minfo
					.cur
					.and_then(|r| c.groups.mat(r))
					.map_or(0, |m| m.qisl);
				set_cs(c, c.core.minfo.pos + c.core.minfo.len + c.core.minfo.insc - qisl);
				if cs(c) < l {
					let n = l - cs(c);
					foredel(c, n);
				} else if cs(c) > ll(c) {
					set_cs(c, ll(c));
				}
				ins(c, b" ", true);
				c.core.minfo.insc = 0;
				c.core.minfo.len = 0;
				c.core.minfo.pos = cs(c);
				c.core.minfo.we = true;
				accept_last_end(zw, wasmeta, k)
			}),
		)
	} else {
		suffix::iremovesuffix(
			zw,
			Some(','),
			true,
			Box::new(move |zw, ()| {
				let c = &mut zw.zle.comp;
				let end = if c.core.brscs >= 0 {
					c.core.brscs
				} else {
					cs(c)
				};
				let mut s = line_part(c, c.core.brpcs, end);
				s.push(b',');
				if let Some(b) = c.tricky.brbeg.last_mut() {
					b.str = s;
				}
				accept_last_end(zw, wasmeta, k)
			}),
		)
	}
}

/// The end of [`accept_last`].
fn accept_last_end(zw: &mut Zw<'_, '_>, wasmeta: bool, k: K<i32>) -> WResult {
	if !wasmeta {
		zw.zle.comp.line.unmetafy(zw.ed);
	}
	k(zw, 0)
}

/// zsh `comp_mod(v, m)`: `v` into `[0, m-1]` (decremented when
/// non-negative; negative values count backwards).
const fn comp_mod(v: i32, m: i32) -> i32 {
	let mut v = v;
	if v >= 0 {
		v -= 1;
	}
	if v >= 0 {
		if m == 0 { 0 } else { v % m }
	} else {
		if m <= 0 {
			return 0;
		}
		while v < 0 {
			v += m;
		}
		v
	}
}

/// zsh `do_ambig_menu()`: start a menu completion.
pub fn do_ambig_menu(zw: &mut Zw<'_, '_>, k: K<()>) -> WResult {
	if zw.zle.comp.core.iforcemenu == -1 {
		return do_ambiguous(zw, Box::new(move |zw, _| ambig_menu_start(zw, k)));
	}
	ambig_menu_start(zw, k)
}

/// [`do_ambig_menu`] after the optional `do_ambiguous`.
fn ambig_menu_start(zw: &mut Zw<'_, '_>, k: K<()>) -> WResult {
	let c = &mut zw.zle.comp;
	if c.tricky.usemenu != 3 {
		c.tricky.menucmp = 1;
		c.core.menuacc = 0;
		c.core.minfo.cur = None;
	} else if c.core.oldlist != 0 {
		if c.core.oldins != 0 && c.core.minfo.cur.is_some() {
			return accept_last(zw, Box::new(move |zw, _| ambig_menu_pick(zw, k)));
		}
	} else {
		c.core.minfo.cur = None;
	}
	ambig_menu_pick(zw, k)
}

/// [`do_ambig_menu`]: the match `compstate[insert]` names.
fn ambig_menu_pick(zw: &mut Zw<'_, '_>, k: K<()>) -> WResult {
	let c = &mut zw.zle.comp;
	c.core.insmnum = comp_mod(c.core.insmnum, c.core.lastpermmnum);
	let mut g = c.core.amatches;
	while let Some(gi) = g
		&& c.groups.get(gi).mcount <= c.core.insmnum
	{
		c.core.insmnum -= c.groups.get(gi).mcount;
		g = c.groups.get(gi).next;
	}
	c.core.minfo.group = g;
	let Some(g) = g else {
		c.core.minfo.cur = None;
		c.core.minfo.asked = 0;
		return k(zw, ());
	};
	let mc = MRef { g, i: usize::try_from(c.core.insmnum).unwrap_or(0) };
	if c.core.iforcemenu != -1
		&& let Some(m) = c.groups.mat(mc).cloned()
	{
		return do_single(
			zw,
			m,
			Box::new(move |zw, ()| {
				zw.zle.comp.core.minfo.cur = Some(mc);
				k(zw, ())
			}),
		);
	}
	c.core.minfo.cur = Some(mc);
	k(zw, ())
}

/// zsh `comp_list(v)`: set `compstate[list]` (and `onlyexpl` from its
/// `expl`/`messages` words).
pub fn comp_list(c: &mut Comp, v: Option<&[u8]>) {
	c.complete.complist = v.map(BString::from);
	c.core.onlyexpl = v.map_or(0, |v| {
		let has = |w: &[u8]| v.windows(w.len()).any(|x| x == w);
		i32::from(has(b"expl")) | (i32::from(has(b"messages")) << 1)
	});
}

/// zsh `invalidate_list()`: forget the list of matches (redisplaying a
/// list still to be shown first).
pub fn invalidate_list(zw: &mut Zw<'_, '_>) {
	zw.zle.comp.result.invcount += 1;
	if zw.zle.comp.tricky.validlist != 0 {
		if zw.zle.display.showinglist == -2 {
			zrefresh(zw);
		}
		let c = &mut zw.zle.comp;
		let lm = c.core.lastmatches;
		compcore::freematches(c, lm, true);
		c.core.lastmatches = None;
		c.core.hasoldlist = 0;
	}
	let c = &mut zw.zle.comp;
	c.tricky.lastambig = 0;
	c.tricky.menucmp = 0;
	c.core.menuacc = 0;
	c.tricky.validlist = 0;
	c.core.fromcomp = 0;
	zw.zle.display.showinglist = 0;
	c.core.listdat.valid = false;
	if zw.zle.display.listshown < 0 {
		zw.zle.display.listshown = 0;
	}
	c.core.minfo.cur = None;
	c.core.minfo.asked = 0;
	c.core.minfo.prebr = None;
	c.core.minfo.postbr = None;
	c.compwidget = None;
	c.core.nmatches = 0;
	c.core.amatches = None;
}
