//! Listing matches, from zsh 5.9 `Src/Zle/compresult.c` (`list_lines`,
//! `skipnolist`, `calclist`, `asklist`, `printlist`, `bld_all_str`,
//! `iprintm`, `ilistmatches`) and `zle_tricky.c`'s `printfmt`.
//!
//! The layout (`calclist`) is computed from a [`ListEnv`] (zsh's
//! `zterm_columns`/`zterm_lines` and the `LIST_*` options); output goes
//! into a [`Pr`] that is then queued on the editor's terminal (zsh's
//! `shout`).
//!
//! One difference from zsh: `printfmt` in counting mode (from
//! `calclist`) does not write the colour sequences of `%F`/`%K`, which
//! zsh writes to the terminal even then.

use std::{collections::HashMap, sync::Arc};

use bstr::ByteSlice;

use super::{super::Comp, hasbrpsfx};
use crate::bash::{
	syntax::zsh::tok::{self, META},
	vm::{
		builtins::{
			zsh_module,
			zsh_prompt::{
				self as zp, Cap, ColourSeqs, NearColour, TXT_ERROR, TXTNOBGCOLOUR, TXTNOFGCOLOUR,
				TermCaps,
			},
			zsh_quote::{Charset, niceformat},
		},
		expand::Expander,
		locale,
		zle::{
			comp::{
				self, K,
				types::{CM_SPACE, GId, MRef, cgf, cmf},
			},
			display,
			exec::{WResult, Zw},
			refresh::Display,
			utils,
		},
		zsh::wcwidth::wcwidth,
	},
	zshopt::ZshOpt,
};

/// What the list layout depends on besides the matches.
#[derive(Clone, Copy, Debug, Default)]
pub struct ListEnv {
	/// zsh `zterm_columns`.
	pub columns:       i32,
	/// zsh `zterm_lines`.
	pub lines:         i32,
	/// `LIST_PACKED`.
	pub listpacked:    bool,
	/// `LIST_ROWS_FIRST`.
	pub listrowsfirst: bool,
	/// `LIST_TYPES`.
	pub listtypes:     bool,
	/// Characters (`MULTIBYTE` in a UTF-8 locale, `PRINT_EIGHT_BIT`).
	pub cs:            Charset,
}

impl ListEnv {
	/// Read the environment from the shell.
	pub fn get(ex: &mut Expander<'_, '_>) -> Self {
		let (columns, lines) = comp::zterm_size(ex);
		let utf8 = comp::isset(ex, ZshOpt::Multibyte) && locale::is_utf8(ex.k, ex.cx.store, ex.vp);
		Self {
			columns,
			lines,
			listpacked: comp::isset(ex, ZshOpt::Listpacked),
			listrowsfirst: comp::isset(ex, ZshOpt::Listrowsfirst),
			listtypes: comp::isset(ex, ZshOpt::Listtypes),
			cs: Charset {
				utf8,
				print_eight: comp::isset(ex, ZshOpt::Printeightbit),
				..Charset::default()
			},
		}
	}

	/// [`Self::get`] from a native widget.
	pub fn of(zw: &mut Zw<'_, '_>) -> Self {
		comp::with_ex(zw, |ex, _| Self::get(ex))
	}
}

/// Where listing output goes (zsh `shout`) and what it needs of the
/// terminal.
pub struct Pr {
	/// The bytes written.
	pub out:       Vec<u8>,
	/// The terminal's capabilities.
	pub caps:      Arc<TermCaps>,
	/// The colour sequences (`zle_highlight`).
	pub colseqs:   ColourSeqs,
	/// zsh/nearcolor's hook, when loaded.
	pub nearcolor: Option<NearColour>,
}

impl Pr {
	/// Output for the editor's terminal.
	pub fn new(zw: &mut Zw<'_, '_>) -> Self {
		let caps = display::term_caps(zw);
		let nearcolor = zsh_module::loaded(zw.cx.store, zw.vp, b"zsh/nearcolor")
			.unwrap_or(false)
			.then_some(crate::bash::vm::builtins::zsh_mod_nearcolor::getnearestcolor as NearColour);
		Self { out: Vec::new(), caps, colseqs: zw.zle.display.colseqs.clone(), nearcolor }
	}

	/// zsh `tcout(cap)`.
	fn tcout(&mut self, cap: Cap) {
		if self.caps.tccan(cap) {
			let s = self.caps.tputs(cap);
			self.out.extend_from_slice(&s);
		}
	}

	/// zsh `tcmultout(cap, multcap, ct)`.
	fn tcmultout(&mut self, cap: Cap, multcap: Cap, ct: i32) {
		let caps = Arc::clone(&self.caps);
		display::tcmultout(&caps, &mut self.out, cap, multcap, i64::from(ct));
	}

	/// zsh `zputs(s, shout)`: metafied `s`, tokens skipped.
	fn zputs(&mut self, s: &[u8]) {
		let mut i = 0;
		while i < s.len() {
			let c = s[i];
			if c == META && i + 1 < s.len() {
				i += 1;
				self.out.push(s[i] ^ 32);
			} else if !tok::is_tok(c) {
				self.out.push(c);
			}
			i += 1;
		}
	}

	/// Queue the output on the editor's terminal.
	pub fn flush_to(self, zw: &mut Zw<'_, '_>) {
		if let Some(t) = zw.zle.tty.as_mut() {
			t.put(&self.out);
		}
	}
}

/// zsh `MB_METASTRWIDTH(s)`: the columns of metafied `s` (characters that
/// do not print count 0, bytes that are not characters 1).
pub fn metastrwidth(s: &[u8], cs: Charset) -> i32 {
	let raw = tok::unmetafy(s);
	if !cs.utf8 {
		return i32::try_from(raw.len()).unwrap_or(i32::MAX);
	}
	let mut w = 0i32;
	let mut i = 0;
	while i < raw.len() {
		let (ch, n) = bstr::decode_utf8(&raw[i..]);
		if let Some(ch) = ch {
			w += wcwidth(ch).max(0);
			i += n;
		} else {
			w += 1;
			i += 1;
		}
	}
	w
}

/// zsh `mb_niceformat(s, …)`'s output and width for metafied `s`.
fn niceformatted(s: &[u8], cs: Charset) -> (Vec<u8>, i32) {
	let shown = niceformat(&tok::unmetafy(s), false, cs);
	let w = if cs.utf8 {
		shown.chars().map(|c| wcwidth(c).max(0)).sum()
	} else {
		i32::try_from(shown.len()).unwrap_or(i32::MAX)
	};
	(shown, w)
}

/// zsh `ZMB_nicewidth(s)`.
pub fn nicewidth(s: &[u8], cs: Charset) -> i32 {
	niceformatted(s, cs).1
}

/// The text of a colour `match_colour` would consume (for counting mode,
/// where nothing is written): `#hex`, a name, or a number.
fn skip_colour(s: &[u8]) -> usize {
	match s.first() {
		Some(b'#') if s.get(1).is_some_and(u8::is_ascii_hexdigit) => {
			1 + s[1..].iter().take_while(|c| c.is_ascii_hexdigit()).count()
		},
		Some(c) if c.is_ascii_alphabetic() => {
			s.iter().take_while(|c| c.is_ascii_alphabetic()).count()
		},
		_ => {
			let sign = usize::from(matches!(s.first(), Some(b'-' | b'+')));
			sign + s[sign..].iter().take_while(|c| c.is_ascii_digit()).count()
		},
	}
}

/// zsh `printfmt(fmt, n, dopr, doesc)` (`zle_tricky.c)`: print (into `pr`
/// when given) or measure the explanation `fmt` (metafied; with `doesc`
/// its `%` escapes: `%n` is `n`, `%B`/`%S`/`%U` and their ends, `%F`/`%K`
/// colours, `%{…%}`); the screen lines it takes at `columns`.
#[expect(clippy::too_many_lines, reason = "a faithful port of one C function")]
pub fn printfmt_in(
	fmt: &[u8],
	n: i32,
	mut pr: Option<&mut Pr>,
	doesc: bool,
	columns: i32,
	cs: Charset,
) -> i32 {
	let cols = columns.max(1);
	// Meta bytes never look like `%`, so the escapes read the same in the
	// unmetafied text.
	let p = tok::unmetafy(fmt);
	let (mut l, mut cc) = (0i32, 0i32);
	let (mut b, mut s, mut u) = (false, false, false);
	let mut i = 0;
	while i < p.len() {
		if doesc && p[i] == b'%' {
			i += 1;
			let mut arg = 0i64;
			if p.get(i).is_some_and(u8::is_ascii_digit) {
				let d = p[i..].iter().take_while(|c| c.is_ascii_digit()).count();
				arg = std::str::from_utf8(&p[i..i + d])
					.ok()
					.and_then(|t| t.parse().ok())
					.unwrap_or(i64::MAX);
				i += d;
			}
			let Some(&e) = p.get(i) else {
				break;
			};
			let mut m = false;
			match e {
				b'%' => {
					if let Some(pr) = pr.as_deref_mut() {
						pr.out.push(b'%');
					}
					cc += 1;
				},
				b'n' => {
					let nc = n.to_string();
					if let Some(pr) = pr.as_deref_mut() {
						pr.out.extend_from_slice(nc.as_bytes());
					}
					cc += i32::try_from(nc.len()).unwrap_or(0);
				},
				b'B' => {
					b = true;
					if let Some(pr) = pr.as_deref_mut() {
						pr.tcout(Cap::BoldBeg);
					}
				},
				b'b' => {
					b = false;
					m = true;
					if let Some(pr) = pr.as_deref_mut() {
						pr.tcout(Cap::AllAttrsOff);
					}
				},
				b'S' => {
					s = true;
					if let Some(pr) = pr.as_deref_mut() {
						pr.tcout(Cap::StandoutBeg);
					}
				},
				b's' => {
					s = false;
					m = true;
					if let Some(pr) = pr.as_deref_mut() {
						pr.tcout(Cap::StandoutEnd);
					}
				},
				b'U' => {
					u = true;
					if let Some(pr) = pr.as_deref_mut() {
						pr.tcout(Cap::UnderlineBeg);
					}
				},
				b'u' => {
					u = false;
					m = true;
					if let Some(pr) = pr.as_deref_mut() {
						pr.tcout(Cap::UnderlineEnd);
					}
				},
				b'F' | b'K' => {
					let fg = e == b'F';
					let atr = if p.get(i + 1) == Some(&b'{') {
						i += 2;
						let atr = if let Some(pr) = pr.as_deref() {
							let mut t: &[u8] = &p[i..];
							let before = t.len();
							let atr = zp::match_colour(Some(&mut t), fg, 0, &pr.caps, pr.nearcolor);
							i += before - t.len();
							Some(atr)
						} else {
							i += skip_colour(&p[i..]);
							None
						};
						if p.get(i) != Some(&b'}') {
							i -= 1;
						}
						atr
					} else {
						pr.as_deref()
							.map(|pr| zp::match_colour(None, fg, arg, &pr.caps, pr.nearcolor))
					};
					if let (Some(pr), Some(atr)) = (pr.as_deref_mut(), atr)
						&& atr != TXT_ERROR
						&& let Some(seq) = zp::colour_sequence(&pr.caps, &pr.colseqs, atr, fg)
					{
						pr.out.extend_from_slice(&seq);
					}
				},
				b'f' | b'k' => {
					let fg = e == b'f';
					if let Some(pr) = pr.as_deref_mut()
						&& let Some(seq) = zp::colour_sequence(
							&pr.caps,
							&pr.colseqs,
							if fg { TXTNOFGCOLOUR } else { TXTNOBGCOLOUR },
							fg,
						) {
						pr.out.extend_from_slice(&seq);
					}
				},
				b'{' => {
					if arg != 0 {
						cc = cc.wrapping_add(i32::try_from(arg).unwrap_or(i32::MAX));
					}
					i += 1;
					while i < p.len() && !(p[i] == b'%' && p.get(i + 1) == Some(&b'}')) {
						if let Some(pr) = pr.as_deref_mut() {
							pr.out.push(p[i]);
						}
						i += 1;
					}
					if i < p.len() {
						i += 1;
					} else {
						i -= 1;
					}
				},
				_ => {},
			}
			if m && let Some(pr) = pr.as_deref_mut() {
				if b {
					pr.tcout(Cap::BoldBeg);
				}
				if s {
					pr.tcout(Cap::StandoutBeg);
				}
				if u {
					pr.tcout(Cap::UnderlineBeg);
				}
			}
			i += 1;
		} else if p[i] == b'\n' {
			cc += 1;
			if let Some(pr) = pr.as_deref_mut() {
				if pr.caps.tccan(Cap::ClearEol) {
					pr.tcout(Cap::ClearEol);
				} else {
					for _ in 0..(cols - 1 - (cc % cols)).max(0) {
						pr.out.push(b' ');
					}
				}
			}
			l += 1 + ((cc - 1) / cols);
			cc = 0;
			if let Some(pr) = pr.as_deref_mut() {
				pr.out.push(b'\n');
			}
			i += 1;
		} else {
			let (clen, w) = if cs.utf8 {
				match bstr::decode_utf8(&p[i..]) {
					(Some(ch), n) => (n, wcwidth(ch)),
					(None, _) => (1, 1),
				}
			} else {
				(1, 1)
			};
			if let Some(pr) = pr.as_deref_mut() {
				pr.out.extend_from_slice(&p[i..i + clen]);
			}
			i += clen;
			cc += w;
			if let Some(pr) = pr.as_deref_mut()
				&& cc % cols == 0
			{
				pr.out.extend_from_slice(b" \x08");
			}
		}
	}
	if let Some(pr) = pr {
		if cc % cols == 0 {
			pr.out.extend_from_slice(b" \x08");
		}
		if pr.caps.tccan(Cap::ClearEol) {
			pr.tcout(Cap::ClearEol);
		} else {
			for _ in 0..(cols - 1 - (cc % cols)).max(0) {
				pr.out.push(b' ');
			}
		}
	}
	l + (cc / cols)
}

/// zsh `list_lines()`: the screen lines the list of all matches takes
/// (`compstate[list_lines]`).
pub fn list_lines(ex: &mut Expander<'_, '_>, c: &mut Comp) -> i32 {
	super::compcore::permmatches(ex, c, 0);
	let oam = c.core.amatches;
	c.core.amatches = c.core.pmatches;
	c.core.listdat.valid = false;
	calclist(ex, c, false);
	c.core.listdat.valid = false;
	c.core.amatches = oam;
	c.core.listdat.nlines
}

/// zsh `skipnolist(p, showall)`: from match `i` of group `g`, the index
/// of the first match to list (`matches.len()`: none).
pub fn skipnolist(c: &Comp, g: GId, i: usize, showall: bool) -> usize {
	let mask = (if showall { 0 } else { cmf::NOLIST | cmf::MULT }) | cmf::HIDE;
	let ms = &c.groups.get(g).matches;
	let mut i = i;
	while let Some(m) = ms.get(i)
		&& (m.flags & mask != 0 || (m.disp.is_some() && m.flags & (cmf::DISPLINE | cmf::HIDE) != 0))
	{
		i += 1;
	}
	i.min(ms.len())
}

/// zsh `calclist(showall)`: compute the list layout into the groups
/// (`cols`, `lins`, `width`, `widths`, …) and `listdat`; false when it is
/// still valid.
pub fn calclist(ex: &mut Expander<'_, '_>, c: &mut Comp, showall: bool) -> bool {
	let e = ListEnv::get(ex);
	calclist_env(c, showall, &e)
}

/// [`calclist`] with the environment given.
#[expect(clippy::too_many_lines, reason = "a faithful port of one C function")]
pub fn calclist_env(c: &mut Comp, showall: bool, e: &ListEnv) -> bool {
	let zcols = e.columns.max(1);
	let ld = c.core.listdat;
	if c.result.lastinvcount == Some(c.result.invcount)
		&& ld.valid
		&& c.core.onlyexpl == ld.onlyexpl
		&& c.core.menuacc == ld.menuacc
		&& showall == ld.showall
		&& e.lines == ld.zterm_lines
		&& e.columns == ld.zterm_columns
	{
		return false;
	}
	c.result.lastinvcount = Some(c.result.invcount);
	let onlyexpl = c.core.onlyexpl;
	let (mut hidden, mut nlist, mut nlines, mut max) = (false, 0i32, 0i32, 0i32);
	let mut mlens: HashMap<i32, i32> = HashMap::new();
	let gs: Vec<GId> = c.groups.list(c.core.amatches).collect();
	let (prebr, postbr) = (c.core.minfo.prebr.clone(), c.core.minfo.postbr.clone());
	let w = |s: &[u8]| metastrwidth(s, e.cs);

	for &g in &gs {
		let (mut glong, mut gshort, mut ndisp, mut totl) = (1i32, zcols, 0i32, 0i32);
		let mut hasf = false;
		c.groups.get_mut(g).flags |= cgf::PACKED | cgf::ROWS;
		let ylist = c.groups.get(g).ylist.clone();
		if onlyexpl == 0
			&& let Some(pp) = ylist
		{
			let gr = c.groups.get_mut(g);
			if !pp.is_empty() {
				if !e.listpacked {
					gr.flags &= !cgf::PACKED;
				}
				if !e.listrowsfirst {
					gr.flags &= !cgf::ROWS;
				}
			}
			// Does it contain newlines (or lines as wide as the screen)?
			hidden = true;
			let mut nl = false;
			let mut k = 0;
			while !nl && k < pp.len() {
				if w(&pp[k]) >= zcols {
					nl = true;
				} else {
					nl = pp[k].contains(&b'\n');
					k += 1;
				}
			}
			if nl || pp.len() < 2 {
				// Count the lines.
				gr.flags |= cgf::LINES;
				for s in &pp {
					let mut sp: &[u8] = s;
					while !sp.is_empty() {
						if let Some(at) = sp.iter().position(|&ch| ch == b'\n') {
							nlines += 1 + (w(&sp[..at]) - 1) / zcols;
							sp = &sp[at + 1..];
						} else {
							nlines += (w(sp) - 1) / zcols;
							break;
						}
					}
					nlines += 1;
				}
			} else {
				for s in &pp {
					let l = w(s);
					ndisp += 1;
					glong = glong.max(l);
					gshort = gshort.min(l);
					totl += l;
					nlist += 1;
				}
			}
		} else if onlyexpl == 0 {
			for i in 0..c.groups.get(g).matches.len() {
				let m = c.groups.get(g).matches[i].clone();
				if m.flags & cmf::FILE != 0 {
					hasf = true;
				}
				if c.core.menuacc != 0
					&& !hasbrpsfx(
						c,
						&m,
						prebr.as_ref().map(|s| s.as_slice()),
						postbr.as_ref().map(|s| s.as_slice()),
					) {
					c.groups.get_mut(g).matches[i].flags |= cmf::HIDE;
					continue;
				}
				c.groups.get_mut(g).matches[i].flags &= !cmf::HIDE;
				if showall || m.flags & (cmf::NOLIST | cmf::MULT) == 0 {
					if m.flags & (cmf::NOLIST | cmf::MULT) != 0 && m.str.is_empty() {
						c.groups.get_mut(g).matches[i].flags |= cmf::HIDE;
						continue;
					}
					let gr = c.groups.get_mut(g);
					if let Some(disp) = &m.disp
						&& m.flags & cmf::DISPLINE != 0
					{
						nlines += 1 + printfmt_in(disp, 0, None, false, zcols, e.cs);
						gr.flags |= cgf::HASDL;
					} else {
						let l =
							nicewidth(m.disp.as_ref().unwrap_or(&m.str), e.cs) + i32::from(m.modec != 0);
						ndisp += 1;
						glong = glong.max(l);
						gshort = gshort.min(l);
						totl += l;
						mlens.insert(m.gnum, l);
					}
					nlist += 1;
					if m.flags & cmf::PACKED == 0 {
						gr.flags &= !cgf::PACKED;
					}
					if m.flags & cmf::ROWS == 0 {
						gr.flags &= !cgf::ROWS;
					}
				} else {
					hidden = true;
				}
			}
		}
		for ex in &c.groups.get(g).expls {
			if (ex.count != 0 || ex.always)
				&& (onlyexpl == 0 || onlyexpl & (if ex.always { 2 } else { 1 }) != 0)
			{
				nlines += 1
					+ printfmt_in(
						&ex.str,
						if ex.always { -1 } else { ex.count },
						None,
						true,
						zcols,
						e.cs,
					);
			}
		}
		let gr = c.groups.get_mut(g);
		if e.listtypes && hasf {
			gr.flags |= cgf::FILES;
		}
		gr.totl = totl + ndisp * CM_SPACE;
		gr.dcount = ndisp;
		gr.width = glong + CM_SPACE;
		gr.shortest = gshort + CM_SPACE;
		gr.cols = (zcols / gr.width).min(gr.dcount);
		if gr.cols != 0 {
			max = max.max(gr.cols * gr.width - CM_SPACE);
		}
	}
	if onlyexpl == 0 {
		for &g in &gs {
			let mut glines = 0;
			let gr = c.groups.get_mut(g);
			gr.widths = None;
			if let Some(pp) = &gr.ylist {
				if gr.flags & cgf::LINES == 0 {
					if gr.cols != 0 {
						glines += (i32::try_from(pp.len()).unwrap_or(0) + gr.cols - 1) / gr.cols;
						if gr.cols > 1 {
							gr.width += (max - (gr.width * gr.cols - CM_SPACE)) / gr.cols;
						}
					} else {
						gr.cols = 1;
						gr.width = 1;
						for s in pp {
							glines += 1 + w(s) / zcols;
						}
					}
				}
			} else if gr.cols != 0 {
				glines += (gr.dcount + gr.cols - 1) / gr.cols;
				if gr.cols > 1 {
					gr.width += (max - (gr.width * gr.cols - CM_SPACE)) / gr.cols;
				}
			} else if gr.flags & cgf::LINES == 0 {
				gr.cols = 1;
				gr.width = 0;
				for m in &gr.matches {
					if m.flags & cmf::HIDE == 0 {
						let ml = mlens.get(&m.gnum).copied().unwrap_or(0);
						if m.disp.is_some() {
							if m.flags & cmf::DISPLINE == 0 {
								glines += 1 + (ml - 1) / zcols;
							}
						} else if showall || m.flags & (cmf::NOLIST | cmf::MULT) == 0 {
							glines += 1 + (ml - 1) / zcols;
						}
					}
				}
			}
			gr.lins = glines;
			nlines += glines;
		}
		for &g in &gs {
			if c.groups.get(g).flags & cgf::PACKED == 0 {
				continue;
			}
			let ucols = usize::try_from(zcols).unwrap_or(1);
			let mut ws = vec![0i32; ucols];
			let gr = c.groups.get(g);
			let (gcols, glins, dcount, shortest, gflags) =
				(gr.cols, gr.lins, gr.dcount, gr.shortest, gr.flags);
			let mut tlines = glins;
			let mut tcols = gcols;
			let mut width = 0i32;
			let rows = gflags & cgf::ROWS != 0;
			// The lengths of the things listed, in order.
			let lens: Option<Vec<i32>> = if let Some(pp) = &gr.ylist {
				(gflags & cgf::LINES == 0).then(|| pp.iter().map(|s| w(s) + CM_SPACE).collect())
			} else if gr.width != 0 {
				let mut v = Vec::new();
				let mut p = skipnolist(c, g, 0, showall);
				while p < gr.matches.len() {
					v.push(mlens.get(&gr.matches[p].gnum).copied().unwrap_or(0));
					p = skipnolist(c, g, p + 1, showall);
				}
				Some(v)
			} else {
				None
			};
			let ylist = gr.ylist.is_some();
			if let Some(lens) = lens {
				tcols = zcols / (shortest + CM_SPACE);
				while tcols > gcols {
					let ut = usize::try_from(tcols).unwrap_or(0).min(ucols);
					ws[..ut].fill(0);
					let mut nth = 0usize;
					let mut tcol = 0i32;
					width = 0;
					let fits;
					if rows {
						tlines = 1;
						while width < zcols
							&& nth < lens.len()
							&& i32::try_from(nth).unwrap_or(i32::MAX) < dcount
						{
							if tcol == tcols {
								tcol = 0;
								tlines += 1;
							}
							let len = if ylist {
								lens[nth]
							} else {
								lens[nth] + if tcol == tcols - 1 { 0 } else { CM_SPACE }
							};
							let wc = &mut ws[usize::try_from(tcol).unwrap_or(0)];
							if len > *wc {
								width += len - *wc;
								*wc = len;
							}
							nth += 1;
							tcol += 1;
						}
						fits = width < zcols;
					} else {
						tlines = ((dcount + tcols - 1) / tcols).max(1);
						let mut tline = 0;
						while width < zcols
							&& nth < lens.len()
							&& i32::try_from(nth).unwrap_or(i32::MAX) < dcount
						{
							if tline == tlines {
								tcol += 1;
								tline = 0;
							}
							if tcol == tcols {
								tcol = 0;
								tlines += 1;
							}
							let len = if ylist {
								lens[nth]
							} else {
								lens[nth] + if tcol == tcols - 1 { 0 } else { CM_SPACE }
							};
							let wc = &mut ws[usize::try_from(tcol).unwrap_or(0)];
							if len > *wc {
								width += len - *wc;
								*wc = len;
							}
							nth += 1;
							tline += 1;
						}
						fits = width < zcols;
						if fits && !ylist {
							tcol += 1;
							if tcol < tcols {
								tcols = tcol;
							}
						}
					}
					if fits {
						break;
					}
					tcols -= 1;
				}
			}
			if tcols <= gcols {
				tlines = glins;
			}
			let gr = c.groups.get_mut(g);
			if tlines != gr.lins {
				nlines += tlines - gr.lins;
				gr.lins = tlines;
				gr.cols = tcols;
				gr.totl = width;
				width -= CM_SPACE;
				max = max.max(width);
				gr.widths = Some(ws);
			}
		}
		for &g in &gs {
			let gr = c.groups.get_mut(g);
			if let Some(ws) = gr.widths.as_mut() {
				let a = (max - gr.totl + CM_SPACE) / gr.cols;
				for x in ws.iter_mut().take(usize::try_from(gr.cols).unwrap_or(0)) {
					*x += a;
				}
			} else if gr.width != 0 && gr.cols > 1 {
				gr.width += (max - (gr.width * gr.cols - CM_SPACE)) / gr.cols;
			}
		}
	} else {
		for &g in &gs {
			c.groups.get_mut(g).widths = None;
		}
	}
	let ld = &mut c.core.listdat;
	ld.valid = true;
	ld.hidden = hidden;
	ld.nlist = nlist;
	ld.nlines = nlines;
	ld.menuacc = c.core.menuacc;
	ld.onlyexpl = onlyexpl;
	ld.zterm_columns = e.columns;
	ld.zterm_lines = e.lines;
	ld.showall = showall;
	true
}

/// Run `f` with the line unmetafied (display code reads the editor's
/// line), metafying it again after.
fn unmetafied(zw: &mut Zw<'_, '_>, f: impl FnOnce(&mut Zw<'_, '_>)) {
	let meta = zw.zle.comp.line.s.is_some();
	if meta {
		zw.zle.comp.line.unmetafy(zw.ed);
	}
	f(zw);
	if meta {
		zw.zle.comp.line.metafy(zw.ed);
	}
}

/// zsh `asklist()`: put the cursor below the line and, for a long list,
/// ask `zsh: do you wish to see all N possibilities (M lines)? `. `k`
/// gets non-zero when the list is not to be shown.
pub fn asklist(zw: &mut Zw<'_, '_>, k: K<i32>) -> WResult {
	unmetafied(zw, display::trashzle);
	let e = ListEnv::of(zw);
	let usezle = zw.isset(ZshOpt::Zle);
	let flow = zw.isset(ZshOpt::Flowcontrol);
	let mut pr = Pr::new(zw);
	let d = &mut zw.zle.display;
	d.showinglist = 0;
	d.listshown = 0;
	d.clearflag = usezle && pr.caps.termflags == 0 && zw.zle.comp.core.dolastprompt != 0;
	d.lastlistlen = 0;
	let c = &zw.zle.comp;
	let ld = c.core.listdat;
	let max = c.complete.complistmax;
	let nlnct = zw.zle.display.nlnct;
	if (c.core.minfo.cur.is_none() || c.core.minfo.asked == 0)
		&& ((max > 0 && i64::from(ld.nlist) >= max)
			|| (max < 0 && i64::from(ld.nlines) <= -max)
			|| (max == 0 && ld.nlines >= e.lines))
	{
		if let Some(t) = zw.zle.tty.as_mut() {
			t.zsetterm(zw.k, zw.cx, flow);
		}
		let q = if ld.nlist > 0 {
			format!("zsh: do you wish to see all {} possibilities ({} lines)? ", ld.nlist, ld.nlines)
		} else {
			format!("zsh: do you wish to see all {} lines? ", ld.nlines)
		};
		let l = i32::try_from(q.len()).unwrap_or(0);
		let cols = e.columns.max(1);
		let qup = ((l + cols - 1) / cols) - 1;
		pr.out.extend_from_slice(q.as_bytes());
		pr.flush_to(zw);
		return utils::getzlequery(move |zw, yes, echo| {
			let mut pr = Pr::new(zw);
			let mut b = [0u8; 4];
			pr.out
				.extend_from_slice(echo.encode_utf8(&mut b).as_bytes());
			let clearflag = zw.zle.display.clearflag;
			if clearflag {
				pr.out.push(b'\r');
				pr.tcmultout(Cap::Up, Cap::MultUp, qup);
				pr.tcout(Cap::ClearEod);
			} else {
				pr.out.push(b'\n');
			}
			if !yes {
				if clearflag {
					let nl = zw.zle.display.nlnct;
					pr.tcmultout(Cap::Up, Cap::MultUp, nl);
				}
				pr.flush_to(zw);
				zw.zle.comp.core.minfo.asked = 2;
				return k(zw, 1);
			}
			pr.flush_to(zw);
			if let Some(t) = zw.zle.tty.as_mut() {
				t.settyinfo(zw.k, zw.cx);
			}
			zw.zle.comp.core.minfo.asked = 1;
			k(zw, 0)
		});
	} else if c.core.minfo.asked == 2 {
		pr.tcmultout(Cap::Up, Cap::MultUp, nlnct);
	}
	let asked = zw.zle.comp.core.minfo.asked;
	pr.flush_to(zw);
	k(zw, if asked != 0 { asked - 1 } else { 0 })
}

/// The printer of one list entry (zsh `CLPrintFunc`): group, match index
/// (`None`: an empty slot), column, line, last in its row, column width.
pub type PrintM<'a> =
	&'a mut dyn FnMut(&mut Comp, &mut Pr, &ListEnv, GId, Option<usize>, i32, i32, bool, i32);

/// zsh's "newline, count the line, clear below when near the end" in
/// `printlist`.
fn list_nl(pr: &mut Pr, ml: &mut i32, cl: &mut i32) {
	pr.out.push(b'\n');
	*ml += 1;
	if *cl >= 0 {
		*cl -= 1;
		if *cl <= 1 {
			*cl = -1;
			pr.tcout(Cap::ClearEod);
		}
	}
}

/// zsh `printlist(over, printm, showall)`: print the list below the
/// line (explanations, `compadd -l` lists, matches in columns); the
/// matches printed.
#[expect(clippy::too_many_lines, reason = "a faithful port of one C function")]
pub fn printlist(
	c: &mut Comp,
	d: &mut Display,
	pr: &mut Pr,
	e: &ListEnv,
	over: bool,
	printm: PrintM<'_>,
	showall: bool,
) -> i32 {
	let ld = c.core.listdat;
	let zcols = e.columns.max(1);
	let mut pnl = false;
	let mut cl = if over { ld.nlines } else { -1 };
	let (mut ml, mut printed) = (0i32, 0i32);
	if cl < 2 {
		cl = -1;
		pr.tcout(Cap::ClearEod);
	}
	let gs: Vec<GId> = c.groups.list(c.core.amatches).collect();
	for g in gs {
		let expls = c.groups.get(g).expls.clone();
		for ex in &expls {
			if (ex.count != 0 || ex.always)
				&& (ld.onlyexpl == 0 || ld.onlyexpl & (if ex.always { 2 } else { 1 }) != 0)
			{
				if pnl {
					list_nl(pr, &mut ml, &mut cl);
				}
				let l = printfmt_in(
					&ex.str,
					if ex.always { -1 } else { ex.count },
					Some(pr),
					true,
					zcols,
					e.cs,
				);
				ml += l;
				if cl >= 0 {
					cl -= l;
					if cl <= 1 {
						cl = -1;
						pr.tcout(Cap::ClearEod);
					}
				}
				pnl = true;
			}
		}
		let gr = c.groups.get(g);
		let (gflags, gcols, gwidth, glins, lcount, mcount, dcount) =
			(gr.flags, gr.cols, gr.width, gr.lins, gr.lcount, gr.mcount, gr.dcount);
		let widths = gr.widths.clone();
		let wid_at = |mc: i32| -> i32 {
			widths.as_ref().map_or(gwidth, |ws| {
				ws.get(usize::try_from(mc).unwrap_or(0))
					.copied()
					.unwrap_or(0)
			})
		};
		if ld.onlyexpl == 0
			&& let Some(pp) = gr.ylist.clone().filter(|p| !p.is_empty())
		{
			if pnl {
				list_nl(pr, &mut ml, &mut cl);
				pnl = false;
			}
			if gflags & cgf::LINES != 0 {
				for (k, p) in pp.iter().enumerate() {
					pr.zputs(p);
					if k + 1 < pp.len() {
						if metastrwidth(p, e.cs) % zcols != 0 {
							pr.out.push(b'\n');
						} else {
							pr.out.extend_from_slice(b" \x08");
						}
					}
				}
			} else {
				let mut n = lcount;
				let nc = usize::try_from(glins).unwrap_or(0);
				let mut nl = glins;
				let mut pp_i = 0usize;
				let rows = gflags & cgf::ROWS != 0;
				while n != 0 {
					if nl == 0 {
						break;
					}
					nl -= 1;
					let mut i = gcols;
					let mut mc = 0;
					let mut pq = pp_i;
					loop {
						if n == 0 {
							break;
						}
						let t = i;
						i -= 1;
						if t == 0 {
							break;
						}
						if i32::try_from(pq).unwrap_or(i32::MAX) >= lcount || pq >= pp.len() {
							break;
						}
						pr.zputs(&pp[pq]);
						if i != 0 {
							let a = wid_at(mc) - metastrwidth(&pp[pq], e.cs);
							for _ in 0..a.max(0) {
								pr.out.push(b' ');
							}
						}
						pq += if rows { 1 } else { nc };
						mc += 1;
						n -= 1;
					}
					if n != 0 {
						list_nl(pr, &mut ml, &mut cl);
					}
					pp_i += if rows {
						usize::try_from(gcols).unwrap_or(0)
					} else {
						1
					};
				}
			}
		} else if ld.onlyexpl == 0 && (lcount != 0 || (showall && mcount != 0)) {
			let mut n = dcount;
			let nc = glins;
			let mut nl = glins;
			let rows = gflags & cgf::ROWS != 0;
			let len = c.groups.get(g).matches.len();
			if gflags & cgf::HASDL != 0 {
				for i in 0..len {
					let m = &c.groups.get(g).matches[i];
					if m.disp.is_some()
						&& m.flags & cmf::DISPLINE != 0
						&& (showall || m.flags & (cmf::HIDE | cmf::NOLIST) == 0)
					{
						if pnl {
							list_nl(pr, &mut ml, &mut cl);
						}
						printed += 1;
						printm(c, pr, e, g, Some(i), 0, ml, true, 0);
						pnl = true;
					}
				}
			}
			if n != 0 && pnl {
				list_nl(pr, &mut ml, &mut cl);
				pnl = false;
			}
			let mut p = skipnolist(c, g, 0, showall);
			while n != 0 {
				if nl == 0 {
					break;
				}
				nl -= 1;
				let mut i = gcols;
				let mut mc = 0;
				let mut q = p;
				loop {
					if n == 0 {
						break;
					}
					let t = i;
					i -= 1;
					if t == 0 {
						break;
					}
					let wid = wid_at(mc);
					if q >= len {
						printm(c, pr, e, g, None, mc, ml, i == 0, wid);
						break;
					}
					printm(c, pr, e, g, Some(q), mc, ml, i == 0, wid);
					printed += 1;
					n -= 1;
					if n != 0 {
						let mut j = if rows { 1 } else { nc };
						while j != 0 && q < len {
							q = skipnolist(c, g, q + 1, showall);
							j -= 1;
						}
					}
					mc += 1;
				}
				loop {
					let t = i;
					i -= 1;
					if t <= 0 {
						break;
					}
					printm(c, pr, e, g, None, mc, ml, i == 0, wid_at(mc));
					mc += 1;
				}
				if n != 0 {
					list_nl(pr, &mut ml, &mut cl);
					if nl != 0 {
						let mut j = if rows { gcols } else { 1 };
						while j != 0 && p < len {
							p = skipnolist(c, g, p + 1, showall);
							j -= 1;
						}
					}
				}
			}
		} else {
			continue;
		}
		if lcount != 0 || (showall && mcount != 0) {
			pnl = true;
		}
	}
	d.lastlistlen = 0;
	if d.clearflag {
		// Back up to the prompt (ALWAYS_LAST_PROMPT).
		let ml = ld.nlines + d.nlnct - 1;
		if ml < e.lines {
			pr.tcmultout(Cap::Up, Cap::MultUp, ml);
			d.showinglist = -1;
			d.lastlistlen = ld.nlines;
		} else {
			d.clearflag = false;
			pr.out.push(b'\n');
		}
	} else {
		pr.out.push(b'\n');
	}
	d.listshown = if d.clearflag { 1 } else { -1 };
	printed
}

/// zsh `bld_all_str(all)`: the display string of the `_all_matches`
/// match (the others, shortened with `...` to the screen width).
pub fn bld_all_str(c: &mut Comp, all: MRef, columns: i32) {
	let mut len = columns - 5;
	let mut add = 0i32;
	let mut buf: Vec<u8> = Vec::new();
	let mut g = c.core.amatches;
	while let Some(gi) = g
		&& c.groups.get(gi).mcount == 0
	{
		g = c.groups.get(gi).next;
	}
	'outer: while let Some(gi) = g {
		for m in &c.groups.get(gi).matches {
			if m.flags & (cmf::ALL | cmf::HIDE) == 0 {
				let t = i32::try_from(m.str.len()).unwrap_or(i32::MAX) + add;
				if len >= t {
					if add != 0 {
						buf.push(b' ');
					}
					buf.extend_from_slice(&m.str);
					len -= t;
					add = 1;
				} else {
					if len > add + 2 {
						if add != 0 {
							buf.push(b' ');
						}
						let n = usize::try_from(len).unwrap_or(0).min(m.str.len());
						buf.extend_from_slice(&m.str[..n]);
					}
					buf.extend_from_slice(b"...");
					break 'outer;
				}
			}
		}
		g = c.groups.get(gi).next;
		while let Some(gi) = g
			&& c.groups.get(gi).mcount == 0
		{
			g = c.groups.get(gi).next;
		}
	}
	if let Some(m) = c.groups.mat_mut(all) {
		m.disp = Some(buf.into());
	}
}

/// zsh `iprintm`: print one match of the list (without complist).
#[expect(clippy::too_many_arguments, reason = "zsh's CLPrintFunc")]
pub fn iprintm(
	c: &mut Comp,
	pr: &mut Pr,
	e: &ListEnv,
	g: GId,
	mp: Option<usize>,
	_mc: i32,
	_ml: i32,
	lastc: bool,
	width: i32,
) {
	let Some(i) = mp else {
		return;
	};
	let r = MRef { g, i };
	let Some(m) = c.groups.mat(r) else {
		return;
	};
	if m.flags & cmf::ALL != 0 && m.disp.as_ref().is_none_or(|d| d.is_empty()) {
		bld_all_str(c, r, e.columns);
	}
	let gflags = c.groups.get(g).flags;
	let Some(m) = c.groups.mat(r) else {
		return;
	};
	let mut len;
	if let Some(disp) = &m.disp {
		if m.flags & cmf::DISPLINE != 0 {
			let disp = disp.clone();
			printfmt_in(&disp, 0, Some(pr), false, e.columns, e.cs);
			return;
		}
		let (out, w) = niceformatted(disp, e.cs);
		pr.out.extend_from_slice(&out);
		len = w;
	} else {
		let (out, w) = niceformatted(&m.str, e.cs);
		pr.out.extend_from_slice(&out);
		len = w;
		if gflags & cgf::FILES != 0 && m.modec != 0 {
			pr.out.push(m.modec);
			len += 1;
		}
	}
	if !lastc {
		for _ in 0..(width - len).max(0) {
			pr.out.push(b' ');
		}
	}
}

/// zsh `ilistmatches()`: list the matches (the listing without
/// zsh/complist), asking first for a long list. The line is metafied
/// around it as zsh's `zrefresh` does before `listmatches()`.
pub fn ilistmatches(zw: &mut Zw<'_, '_>) -> WResult {
	let was = zw.zle.comp.line.s.is_some();
	if !was {
		zw.zle.comp.line.metafy(zw.ed);
	}
	let fin = move |zw: &mut Zw<'_, '_>, r: i32| {
		if !was {
			zw.zle.comp.line.unmetafy(zw.ed);
		}
		WResult::Done(r)
	};
	let e = ListEnv::of(zw);
	calclist_env(&mut zw.zle.comp, false, &e);
	if zw.zle.comp.core.listdat.nlines == 0 {
		zw.zle.display.showinglist = 0;
		zw.zle.display.listshown = 0;
		return fin(zw, 1);
	}
	asklist(
		zw,
		Box::new(move |zw, r| {
			if r != 0 {
				return fin(zw, 0);
			}
			let mut pr = Pr::new(zw);
			let zle = &mut *zw.zle;
			printlist(&mut zle.comp, &mut zle.display, &mut pr, &e, false, &mut iprintm, false);
			pr.flush_to(zw);
			fin(zw, 0)
		}),
	)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::vm::zle::comp::types::{Cmatch, Cmgroup};

	fn comp_with(lens: &[usize], flags: u32) -> (Comp, GId) {
		let mut c = Comp::default();
		let matches: Vec<Cmatch> = lens
			.iter()
			.enumerate()
			.map(|(i, &l)| Cmatch {
				str: "x".repeat(l).into(),
				gnum: i32::try_from(i).unwrap(),
				flags,
				..Cmatch::default()
			})
			.collect();
		let n = i32::try_from(matches.len()).unwrap();
		let g = c
			.groups
			.alloc(Cmgroup { mcount: n, lcount: n, matches, ..Cmgroup::default() });
		c.core.amatches = Some(g);
		c.core.nmatches = n;
		(c, g)
	}

	fn env(columns: i32) -> ListEnv {
		ListEnv { columns, lines: 24, ..ListEnv::default() }
	}

	#[test]
	fn one_row_of_ten() {
		// glong 2 → width 4; 80/4 = 20 columns, capped at 10 matches.
		let (mut c, g) = comp_with(&[2; 10], 0);
		assert!(calclist_env(&mut c, false, &env(80)));
		let gr = c.groups.get(g);
		assert_eq!((gr.cols, gr.lins, gr.width), (10, 1, 4));
		assert_eq!((c.core.listdat.nlines, c.core.listdat.nlist), (1, 10));
		// Still valid: not computed again.
		assert!(!calclist_env(&mut c, false, &env(80)));
	}

	#[test]
	fn columns_first_wrap() {
		// Width 32: 2 columns of 3 matches take 2 lines.
		let (mut c, g) = comp_with(&[30, 30, 30], 0);
		calclist_env(&mut c, false, &env(80));
		let gr = c.groups.get(g);
		assert_eq!((gr.cols, gr.lins, gr.width), (2, 2, 32));
		assert!(gr.widths.is_none());
	}

	#[test]
	fn packed_columns_first() {
		// Unpacked: 40/22 = 1 column, 4 lines. Packed: try 40/(4+2) = 6
		// columns; one line of widths 22+4+4+4 = 34 fits, shrunk to the 4
		// columns used.
		let (mut c, g) = comp_with(&[20, 2, 2, 2], cmf::PACKED);
		calclist_env(&mut c, false, &env(40));
		let gr = c.groups.get(g);
		assert_eq!((gr.cols, gr.lins), (4, 1));
		assert_eq!(&gr.widths.as_ref().unwrap()[..4], &[22, 4, 4, 4]);
		assert_eq!(c.core.listdat.nlines, 1);
	}

	#[test]
	fn packed_rows_first() {
		// Rows first keeps the 6 columns tried.
		let (mut c, g) = comp_with(&[20, 2, 2, 2], cmf::PACKED | cmf::ROWS);
		calclist_env(&mut c, false, &env(40));
		let gr = c.groups.get(g);
		assert_ne!(gr.flags & cgf::ROWS, 0);
		assert_eq!((gr.cols, gr.lins), (6, 1));
		assert_eq!(&gr.widths.as_ref().unwrap()[..6], &[22, 4, 4, 4, 0, 0]);
	}

	#[test]
	fn printfmt_counts_lines() {
		let cs = Charset::default();
		assert_eq!(printfmt_in(b"abc", 0, None, true, 80, cs), 0);
		assert_eq!(printfmt_in(b"a\nb", 0, None, true, 80, cs), 1);
		assert_eq!(printfmt_in(&[b'x'; 80], 0, None, true, 80, cs), 1);
		assert_eq!(printfmt_in(b"%n matches%B", 12, None, true, 10, cs), 1);
	}
}
