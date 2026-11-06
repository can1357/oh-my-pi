//! compmatch.c's joining of cline lists: building the unambiguous string
//! from the clines of all matches (`join_clines` and its helpers
//! `bld_line`, `join_strs`, `cmp_anchors`, `join_sub`, `sub_match`,
//! `join_psfx`, `join_mid`, `sub_join`).

use bstr::BString;

use super::{
	CHR_INVALID, PP_LOWER, PP_UPPER, at, cline_setlens, cp_cline, free_cline, get_cline,
	mb_metacharlenconv, pattern_match, pattern_match_equivalence_ind, pattern_match_full,
	pattern_match1_ind, revert_cline, set_llen, strlen, strncmp_ne, tail, zc_tolower,
	zlelineasstring,
};
use crate::bash::{
	syntax::zsh::tok::META,
	vm::zle::comp::{
		Comp,
		types::{Cl, Cmatcher, Cmlist, Cpattern, clf},
	},
};

/// One element of `bld_line`'s `genpatarr`: a fixed character or a
/// line pattern element.
#[derive(Clone, Copy)]
enum Gp<'a> {
	Char(u32),
	P(&'a Cpattern),
}

/// [`pattern_match1_ind`] on a [`Gp`].
fn gp_match1(g: Gp<'_>, c: u32, mt: &mut i32) -> u32 {
	match g {
		Gp::Char(ch) => {
			*mt = 0;
			u32::from(ch == c)
		},
		Gp::P(p) => pattern_match1_ind(p, c, mt),
	}
}

/// zsh `pattern_match_restrict`: `p` against the line being built under
/// the restrictions `prestrict` (from `pi`), `wp` against the word
/// characters `wsc[wsi..]` (`wsclen` of them); the line characters
/// deduced go to `new_line[ni..]`.
#[allow(clippy::too_many_arguments, reason = "mirrors zsh's C signature")]
fn pattern_match_restrict(
	p: &[Cpattern],
	wp: &[Cpattern],
	wsc: &[u32],
	wsi: isize,
	mut wsclen: i32,
	prestrict: &[Gp<'_>],
	pi: isize,
	new_line: &mut [u32],
	ni: isize,
) -> bool {
	let get = |v: &[u32], i: isize| usize::try_from(i).ok().and_then(|i| v.get(i).copied());
	let pr = |i: isize| {
		usize::try_from(i)
			.ok()
			.and_then(|i| prestrict.get(i).copied())
	};
	let (mut k, mut wk, mut ws, mut pri, mut nl) = (0usize, 0usize, wsi, pi, ni);
	let (mut mt, mut wmt) = (0i32, 0i32);
	let mut put = |nl: &mut isize, c: u32| -> bool {
		match usize::try_from(*nl).ok().and_then(|i| new_line.get_mut(i)) {
			Some(x) => {
				*x = c;
				*nl += 1;
				true
			},
			None => false,
		}
	};
	while k < p.len() && wk < wp.len() && wsclen != 0 {
		let Some(prs) = pr(pri) else { break };
		let Some(wc) = get(wsc, ws) else { return false };
		let wind = pattern_match1_ind(&wp[wk], wc, &mut wmt);
		if wind == 0 {
			return false;
		}
		let c = if let Gp::Char(ch) = prs {
			ch
		} else {
			let c = match &p[k] {
				Cpattern::Char(ch) => *ch as u32,
				eq @ Cpattern::Equiv(_) => {
					let c = pattern_match_equivalence_ind(eq, wind, wmt, wc);
					if c == CHR_INVALID {
						return false;
					}
					c
				},
				_ => wc,
			};
			if gp_match1(prs, c, &mut mt) == 0 {
				return false;
			}
			c
		};
		if !matches!(p[k], Cpattern::Any) || !matches!(wp[wk], Cpattern::Any) {
			let ind = pattern_match1_ind(&p[k], c, &mut mt);
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
		if !put(&mut nl, c) {
			return false;
		}
		pri += 1;
		ws += 1;
		wsclen -= 1;
		k += 1;
		wk += 1;
	}
	while k < p.len() {
		let Some(prs) = pr(pri) else { break };
		let c = if let Gp::Char(ch) = prs {
			ch
		} else {
			let Cpattern::Char(ch) = p[k] else {
				return false;
			};
			let c = ch as u32;
			if gp_match1(prs, c, &mut mt) == 0 {
				return false;
			}
			c
		};
		if pattern_match1_ind(&p[k], c, &mut mt) == 0 {
			return false;
		}
		k += 1;
		if !put(&mut nl, c) {
			return false;
		}
		pri += 1;
	}
	if pr(pri).is_some() {
		return false;
	}
	while wk < wp.len() && wsclen != 0 {
		let Some(wc) = get(wsc, ws) else { return false };
		if pattern_match1_ind(&wp[wk], wc, &mut wmt) == 0 {
			return false;
		}
		wk += 1;
		ws += 1;
		wsclen -= 1;
	}
	true
}

/// zsh `bld_line`: build in `line` (`mp.llen` wide characters) a line
/// string for the matcher `mp` that matches the `wlen` characters of
/// `word`, using `mword` (which matched `mp`'s word pattern) for the
/// equivalence classes. Returns the number of word characters matched,
/// 0 if no line could be built.
fn bld_line(
	bm: Option<&Cmlist>,
	mp: &Cmatcher,
	line: &mut [u32],
	mword: &[u8],
	word: &[u8],
	mut wlen: i32,
	sfx: bool,
) -> i32 {
	let mut wordchars = Vec::with_capacity(usize::try_from(wlen).unwrap_or(0));
	let mut wp = 0isize;
	for _ in 0..wlen.max(0) {
		let (n, mut ch) = mb_metacharlenconv(tail(word, wp));
		if ch == CHR_INVALID {
			let b = if at(word, wp) == META {
				at(word, wp + 1) ^ 32
			} else {
				at(word, wp)
			};
			ch = i32::from(b as i8) as u32;
		}
		wordchars.push(ch);
		wp += n.max(1) as isize;
	}
	let mut gp: Vec<Gp<'_>> = Vec::with_capacity(mp.line.len());
	let mut wpi = 0usize;
	let mut mw = 0isize;
	for lpat in &mp.line {
		let (mut wind, mut wchr, mut wmtp) = (0u32, 0u32, 0i32);
		if matches!(lpat, Cpattern::Equiv(_)) && wpi < mp.word.len() && at(mword, mw) != 0 {
			let (n, ch) = mb_metacharlenconv(tail(mword, mw));
			wchr = ch;
			wind = pattern_match1_ind(&mp.word[wpi], wchr, &mut wmtp);
			wpi += 1;
			mw += n as isize;
		}
		if wind != 0 {
			let lchr = pattern_match_equivalence_ind(lpat, wind, wmtp, wchr);
			if lchr == CHR_INVALID {
				return 0;
			}
			gp.push(Gp::Char(lchr));
		} else {
			gp.push(match lpat {
				Cpattern::Char(c) => Gp::Char(*c as u32),
				p => Gp::P(p),
			});
		}
	}
	let mut llen = mp.llen;
	let mut rl = 0;
	let (mut wordcp, mut curgen, mut linep): (isize, isize, isize) = if sfx {
		(wlen as isize, llen as isize, llen as isize)
	} else {
		(0, 0, 0)
	};
	let gpat = |i: isize| usize::try_from(i).ok().and_then(|i| gp.get(i).copied());
	while llen != 0 && wlen != 0 {
		let (wpx, tg) = if sfx {
			(wordcp - 1, curgen - 1)
		} else {
			(wordcp, curgen)
		};
		let mut wmtp = 0;
		let wc = usize::try_from(wpx)
			.ok()
			.and_then(|i| wordchars.get(i).copied());
		let g = gpat(tg);
		if let (Some(wc), Some(g)) = (wc, g)
			&& gp_match1(g, wc, &mut wmtp) != 0
		{
			let lchr = if let Gp::Char(ch) = g { ch } else { wc };
			if sfx {
				linep -= 1;
			}
			if let Some(x) = usize::try_from(linep).ok().and_then(|i| line.get_mut(i)) {
				*x = lchr;
			}
			if !sfx {
				linep += 1;
			}
			llen -= 1;
			wlen -= 1;
			rl += 1;
			if sfx {
				wordcp = wpx;
				curgen = tg;
			} else {
				if llen != 0 {
					curgen += 1;
				}
				wordcp += 1;
			}
		} else {
			let mut matched = false;
			let mut ms = bm;
			while let Some(m) = ms {
				ms = m.next.as_deref();
				let Some(mp2) = m.matcher.as_deref() else {
					continue;
				};
				if mp2.flags == 0 && mp2.wlen <= wlen && mp2.llen <= llen {
					let (mut lp, mut wq, mut tg2) = (linep, wordcp, curgen);
					if sfx {
						lp -= mp2.llen as isize;
						wq -= mp2.wlen as isize;
						tg2 -= mp2.llen as isize;
					}
					if pattern_match_restrict(
						&mp2.line,
						&mp2.word,
						&wordchars,
						wq,
						wlen - wq as i32,
						&gp,
						tg2,
						line,
						lp,
					) {
						if sfx {
							linep = lp;
							wordcp = wq;
							curgen = tg2;
						} else {
							linep += mp2.llen as isize;
							wordcp += mp2.wlen as isize;
							curgen += mp2.llen as isize;
						}
						llen -= mp2.llen;
						wlen -= mp2.wlen;
						rl += mp2.wlen;
						matched = true;
						break;
					}
				}
			}
			if !matched {
				return 0;
			}
		}
	}
	if llen == 0 { rl } else { 0 }
}

/// zsh `join_strs`: a string for the line that matches both the `la`
/// bytes of `sa` and the `lb` of `sb`, or `None`.
fn join_strs(
	bm: Option<&Cmlist>,
	mut la: i32,
	sa: &[u8],
	mut lb: i32,
	sb: &[u8],
) -> Option<Vec<u8>> {
	let (mut ia, mut ib) = (0isize, 0isize);
	let mut rs = Vec::new();
	while la != 0 && lb != 0 {
		if at(sa, ia) == at(sb, ib) {
			rs.push(at(sa, ia));
			ia += 1;
			ib += 1;
			la -= 1;
			lb -= 1;
		} else {
			let mut t = false;
			let mut ms = bm;
			while let Some(m) = ms
				&& !t
			{
				ms = m.next.as_deref();
				let Some(mp) = m.matcher.as_deref() else {
					continue;
				};
				if mp.flags == 0 && mp.wlen > 0 && mp.llen > 0 && mp.wlen <= la && mp.wlen <= lb {
					let ta = pattern_match(&mp.word, tail(sa, ia));
					if ta || pattern_match(&mp.word, tail(sb, ib)) {
						let mut line = vec![0u32; mp.llen as usize];
						let bl = if ta {
							bld_line(bm, mp, &mut line, tail(sa, ia), tail(sb, ib), lb, false)
						} else {
							bld_line(bm, mp, &mut line, tail(sb, ib), tail(sa, ia), la, false)
						};
						if bl != 0 {
							rs.extend_from_slice(&zlelineasstring(&line));
							if ta {
								ia += mp.wlen as isize;
								la -= mp.wlen;
								ib += bl as isize;
								lb -= bl;
							} else {
								ib += mp.wlen as isize;
								lb -= mp.wlen;
								ia += bl as isize;
								la -= bl;
							}
							t = true;
						}
					}
				}
			}
			if !t {
				break;
			}
		}
	}
	if la != 0 || lb != 0 { None } else { Some(rs) }
}

/// zsh `cmp_anchors`: 1 if the anchors of `o` and `n` are the same, 2
/// if they could be joined (into `o`), 0 otherwise.
fn cmp_anchors(c: &mut Comp, o: Cl, n: Cl, join: bool) -> i32 {
	let (oc, nc) = (c.clines.get(o), c.clines.get(n));
	let empty = BString::default();
	let ow = oc.word.as_ref();
	let nw = nc.word.as_ref().unwrap_or(&empty);
	let same_word = oc.flags & clf::LINE == 0
		&& oc.wlen == nc.wlen
		&& ow.is_none_or(|w| !strncmp_ne(w, nw, oc.wlen));
	let line = !same_word
		&& ((oc.line.is_none() && nc.line.is_none() && oc.wlen == 0 && nc.wlen == 0)
			|| (oc.llen == nc.llen
				&& oc.line.is_some()
				&& nc.line.is_some()
				&& !strncmp_ne(
					oc.line.as_ref().map_or(&[][..], |s| s.as_slice()),
					nc.line.as_ref().map_or(&[][..], |s| s.as_slice()),
					oc.llen,
				)));
	if same_word || line {
		if line {
			let y = c.clines.get_mut(o);
			y.flags |= clf::LINE;
			y.word = None;
			y.wlen = 0;
		}
		return 1;
	}
	if join
		&& oc.flags & clf::JOIN == 0
		&& let (Some(a), Some(b)) = (&oc.word, &nc.word)
		&& let Some(j) = join_strs(c.core.bmatchers.as_deref(), oc.wlen, a, nc.wlen, b)
	{
		let j = BString::from(&j[..strlen(&j)]);
		let y = c.clines.get_mut(o);
		y.flags |= clf::JOIN;
		y.wlen = j.len() as i32;
		y.word = Some(j);
		return 2;
	}
	0
}

/// zsh `struct cmdata`: a walk through a sub-list (`str` positions are
/// in the owned copy `str`).
#[derive(Clone, Debug, Default)]
struct Cmdata {
	cl:   Option<Cl>,
	pcl:  Option<Cl>,
	str:  Option<BString>,
	sp:   isize,
	astr: Option<BString>,
	ap:   isize,
	len:  i32,
	alen: i32,
	olen: i32,
	line: bool,
}

impl Cmdata {
	fn at(&self, i: isize) -> u8 {
		at(self.str.as_ref().map_or(&[][..], |s| s.as_slice()), self.sp + i)
	}

	fn tail(&self, i: isize) -> &[u8] {
		tail(self.str.as_ref().map_or(&[][..], |s| s.as_slice()), self.sp + i)
	}
}

/// zsh `check_cmdata`: load the next cline's string when the current one
/// is used up; true at the end.
fn check_cmdata(c: &Comp, md: &mut Cmdata, sfx: bool) -> bool {
	if md.len == 0 {
		let Some(cl) = md.cl else { return true };
		let x = c.clines.get(cl);
		if x.flags & clf::LINE != 0 {
			md.line = true;
			md.len = x.llen;
			md.str.clone_from(&x.line);
			md.sp = 0;
		} else {
			md.line = false;
			md.len = x.wlen;
			md.olen = x.wlen;
			md.str.clone_from(&x.word);
			md.sp = if md.str.is_some() && sfx {
				md.len as isize
			} else {
				0
			};
			md.alen = x.llen;
			md.astr.clone_from(&x.line);
			md.ap = if md.astr.is_some() && sfx {
				md.alen as isize
			} else {
				0
			};
		}
		md.pcl = Some(cl);
		md.cl = x.next;
	}
	false
}

/// The `len` bytes of `s` from `p` (C `p` with length `len`).
fn sub(s: &BString, p: isize, len: i32) -> BString {
	super::cut(tail(s, p), len)
}

/// zsh `undo_cmdata`: put the unmatched rest back into the last cline.
fn undo_cmdata(c: &mut Comp, md: &Cmdata, sfx: bool) -> Option<Cl> {
	let r = md.pcl?;
	let start = md.sp - if sfx { md.len as isize } else { 0 };
	if md.line {
		let y = c.clines.get_mut(r);
		y.word = None;
		y.wlen = 0;
		y.flags |= clf::LINE;
		y.llen = md.len;
		y.line = md.str.as_ref().map(|s| sub(s, start, md.len));
	} else if md.len != md.olen {
		let y = c.clines.get_mut(r);
		y.wlen = md.len;
		y.word = md.str.as_ref().map(|s| sub(s, start, md.len));
	}
	Some(r)
}

/// zsh `join_sub`: a cline for a string matching both the `len` bytes of
/// `s` and the next part of `md`; `mlen` gets the length used of `s`.
fn join_sub(
	c: &mut Comp,
	md: &mut Cmdata,
	s: &[u8],
	len: i32,
	mlen: &mut i32,
	sfx: bool,
	join: bool,
) -> Option<Cl> {
	if check_cmdata(c, md, sfx) {
		return None;
	}
	let (ol, nl) = (len, md.len);
	let ow: isize = if sfx { ol as isize } else { 0 };
	let nw: isize = if sfx { nl as isize } else { 0 };
	let bm = c.core.bmatchers.clone();
	let mut t = false;
	let mut ms = bm.as_deref();
	while let Some(m) = ms
		&& !t
	{
		ms = m.next.as_deref();
		let Some(mp) = m.matcher.as_deref() else {
			continue;
		};
		if mp.flags == 0 && mp.wlen > 0 && mp.llen > 0 {
			let (lo, wo) = if sfx {
				(mp.llen as isize, mp.wlen as isize)
			} else {
				(0, 0)
			};
			if mp.llen <= ol
				&& mp.wlen <= nl
				&& pattern_match_full(&mp.line, tail(s, ow - lo), &mp.word, md.tail(nw - wo))
			{
				if sfx {
					md.sp -= mp.wlen as isize;
				} else {
					md.sp += mp.wlen as isize;
				}
				md.len -= mp.wlen;
				*mlen = mp.llen;
				return Some(get_cline(c, None, 0, Some(tail(s, ow - lo)), mp.llen, None, 0, 0));
			}
			if join && mp.wlen <= ol && mp.wlen <= nl && {
				t = pattern_match(&mp.word, tail(s, ow - wo));
				t || pattern_match(&mp.word, md.tail(nw - wo))
			} {
				let mut line = vec![0u32; mp.llen as usize];
				let bl = if t {
					bld_line(bm.as_deref(), mp, &mut line, tail(s, ow - wo), md.tail(nw), nl, sfx)
				} else {
					bld_line(bm.as_deref(), mp, &mut line, md.tail(nw - wo), tail(s, ow), ol, sfx)
				};
				if bl != 0 {
					let (ol2, nl2) = if t { (mp.wlen, bl) } else { (bl, mp.wlen) };
					if sfx {
						md.sp -= nl2 as isize;
					} else {
						md.sp += nl2 as isize;
					}
					md.len -= nl2;
					*mlen = ol2;
					let w = zlelineasstring(&line);
					return Some(get_cline(c, None, 0, Some(&w), mp.llen, None, 0, clf::JOIN));
				}
			}
		}
	}
	None
}

/// zsh `sub_match`: the length of the common prefix (suffix) of the `len`
/// bytes of `s` and the strings in `md`, not ending inside a metafied
/// or multibyte character.
fn sub_match(c: &Comp, md: &mut Cmdata, s: &[u8], mut len: i32, sfx: bool) -> i32 {
	let mut ret = 0;
	let fulllen = len as isize;
	let (ind, add): (isize, isize) = if sfx { (-1, -1) } else { (0, 1) };
	let mut str: isize = if sfx { len as isize } else { 0 };
	while len != 0 {
		if check_cmdata(c, md, sfx) {
			return ret;
		}
		let mut l = 0i32;
		let (mut p, mut q) = (str, 0isize);
		while l < len && l < md.len && at(s, p + ind) == md.at(q + ind) {
			l += 1;
			p += add;
			q += add;
		}
		if add == 1 {
			if l != 0 && at(s, p - 1) == META {
				l -= 1;
			}
		} else if l != 0
			&& ((l < len && at(s, p - 1) == META) || (l < md.len && md.at(q - 1) == META))
		{
			l -= 1;
		}
		// Don't end in the middle of a multibyte character.
		let qm = if sfx {
			str - l as isize
		} else {
			str + l as isize
		};
		if qm != 0 {
			let mut p = 0isize;
			while p < fulllen {
				let mut buf = [0u8; 4];
				let mut n = 0;
				let mut cnt = super::Mb::Invalid;
				let mut p2 = p;
				while p2 < fulllen {
					let cur = if at(s, p2) == META {
						p2 += 1;
						at(s, p2) ^ 32
					} else {
						at(s, p2)
					};
					if n == buf.len() {
						cnt = super::Mb::Invalid;
						break;
					}
					buf[n] = cur;
					n += 1;
					cnt = super::mbdecode(&buf[..n]);
					if !matches!(cnt, super::Mb::Incomplete) {
						break;
					}
					p2 += 1;
				}
				if !matches!(cnt, super::Mb::Valid(_)) {
					break;
				}
				p2 += 1;
				let diff = p2 - qm;
				if diff == 0 {
					break;
				} else if diff > 0 {
					if sfx {
						l -= diff as i32;
					} else {
						l -= (qm - p) as i32;
					}
					break;
				}
				p = p2;
			}
		}
		if l != 0 {
			md.len -= l;
			len -= l;
			if sfx {
				md.sp -= l as isize;
				str -= l as isize;
			} else {
				md.sp += l as isize;
				str += l as isize;
			}
			ret += l;
		} else if md.line || md.len != md.olen || md.astr.is_none() {
			return ret;
		} else {
			md.line = true;
			md.len = md.alen;
			md.str = md.astr.clone();
			md.sp = md.ap;
		}
	}
	ret
}

/// Which string of a cline `join_psfx` works on (C's `sstr`/`slen`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum F {
	Line,
	Word,
}

fn field(c: &Comp, o: Cl, f: F) -> (BString, i32) {
	let y = c.clines.get(o);
	match f {
		F::Line => (y.line.clone().unwrap_or_default(), y.llen),
		F::Word => (y.word.clone().unwrap_or_default(), y.wlen),
	}
}

/// C `*sstr += off; *slen = len`.
fn set_field(c: &mut Comp, o: Cl, f: F, off: i32, len: i32) {
	let y = c.clines.get_mut(o);
	let (s, l) = match f {
		F::Line => (&mut y.line, &mut y.llen),
		F::Word => (&mut y.word, &mut y.wlen),
	};
	*s = s.as_ref().map(|s| sub(s, off as isize, len));
	*l = len;
}

fn set_sub(c: &mut Comp, ot: Cl, sfx: bool, v: Option<Cl>) {
	let y = c.clines.get_mut(ot);
	if sfx {
		y.suffix = v;
	} else {
		y.prefix = v;
	}
}

/// zsh `join_psfx`: the common prefix (suffix with `sfx`) sub-list of
/// `ot` and `nt`; the unmatched rests go to `orest`/`nrest` when given.
fn join_psfx(
	c: &mut Comp,
	ot: Cl,
	nt: Cl,
	mut orest: Option<&mut Option<Cl>>,
	mut nrest: Option<&mut Option<Cl>>,
	sfx: bool,
) {
	let (mut o, n) = if sfx {
		(c.clines.get(ot).suffix, c.clines.get(nt).suffix)
	} else {
		(c.clines.get(ot).prefix, c.clines.get(nt).prefix)
	};
	if o.is_none() {
		if let Some(r) = orest.as_deref_mut() {
			*r = None;
		}
		if let Some(r) = nrest.as_deref_mut() {
			*r = n;
		}
		if let Some(n) = n
			&& c.clines.get(n).wlen != 0
		{
			c.clines.get_mut(ot).flags |= clf::MISS;
		}
		return;
	}
	if n.is_none() {
		set_sub(c, ot, sfx, None);
		match orest.as_deref_mut() {
			Some(r) => *r = o,
			None => free_cline(c, o),
		}
		if let Some(r) = nrest.as_deref_mut() {
			*r = None;
		}
		return;
	}
	let mut md = Cmdata { cl: n, len: 0, ..Cmdata::default() };
	let mut p: Option<Cl> = None;
	while let Some(oc) = o {
		let mut join = false;
		let omd = md.clone();
		let mut sf = F::Line;
		let len;
		let flags = c.clines.get(oc).flags;
		if flags & clf::LINE != 0 {
			let (s, sl) = field(c, oc, F::Line);
			len = sub_match(c, &mut md, &s, sl, sfx);
			if len != sl {
				join = true;
				sf = F::Line;
			}
		} else {
			let (s, sl) = field(c, oc, F::Word);
			len = sub_match(c, &mut md, &s, sl, sfx);
			if len != sl {
				if c.clines.get(oc).line.is_some() {
					md = omd;
					c.clines.get_mut(oc).flags |= clf::LINE | clf::DIFF;
					continue;
				}
				let v = c.clines.get(oc).llen - c.clines.get(ot).slen;
				set_llen(c, oc, v);
				join = true;
				sf = F::Word;
			}
		}
		let mut o_now = oc;
		if join {
			let (sstr, slen) = field(c, oc, sf);
			let mut jlen = 0;
			let nojoin = c.clines.get(oc).flags & clf::JOIN == 0;
			if let Some(joinl) =
				join_sub(c, &mut md, tail(&sstr, len as isize), slen - len, &mut jlen, sfx, nojoin)
			{
				c.clines.get_mut(joinl).flags |= clf::DIFF;
				let onext = c.clines.get(oc).next;
				if len + jlen == slen {
					c.clines.get_mut(joinl).next = onext;
				} else {
					let off = if sfx { 0 } else { (len + jlen) as isize };
					let rest =
						get_cline(c, None, 0, Some(tail(&sstr, off)), slen - len - jlen, None, 0, 0);
					c.clines.get_mut(rest).next = onext;
					c.clines.get_mut(joinl).next = Some(rest);
				}
				if len != 0 {
					set_field(c, oc, sf, if sfx { slen - len } else { 0 }, len);
					c.clines.get_mut(oc).next = Some(joinl);
				} else {
					c.clines.get_mut(oc).next = None;
					free_cline(c, Some(oc));
					match p {
						Some(p) => c.clines.get_mut(p).next = Some(joinl),
						None => set_sub(c, ot, sfx, Some(joinl)),
					}
				}
				o_now = joinl;
				join = false;
			}
		}
		if join {
			let (sstr, slen) = field(c, oc, sf);
			if len != 0 {
				if let Some(r) = orest.as_deref_mut() {
					let fl = c.clines.get(oc).flags;
					let rs = tail(&sstr, len as isize);
					let x = if sf == F::Line {
						get_cline(c, Some(rs), slen - len, None, 0, None, 0, fl)
					} else {
						get_cline(c, None, 0, Some(rs), slen - len, None, 0, fl)
					};
					let onext = c.clines.get(oc).next;
					c.clines.get_mut(x).next = onext;
					*r = Some(x);
					set_field(c, oc, sf, 0, len);
				} else {
					set_field(c, oc, sf, if sfx { slen - len } else { 0 }, len);
					let onext = c.clines.get(oc).next;
					free_cline(c, onext);
				}
				c.clines.get_mut(oc).next = None;
			} else {
				match p {
					Some(p) => c.clines.get_mut(p).next = None,
					None => set_sub(c, ot, sfx, None),
				}
				match orest.as_deref_mut() {
					Some(r) => *r = Some(oc),
					None => free_cline(c, Some(oc)),
				}
			}
			if orest.is_none() || nrest.is_none() {
				c.clines.get_mut(ot).flags |= clf::MISS;
			}
			if let Some(r) = nrest.as_deref_mut() {
				*r = undo_cmdata(c, &md, sfx);
			}
			return;
		}
		p = Some(o_now);
		o = c.clines.get(o_now).next;
	}
	if md.len != 0 || md.cl.is_some() {
		c.clines.get_mut(ot).flags |= clf::MISS;
	}
	if let Some(r) = orest {
		*r = None;
	}
	if let Some(r) = nrest {
		*r = undo_cmdata(c, &md, sfx);
	}
}

/// zsh `join_mid`: the common prefix and suffix of a mid-cline.
fn join_mid(c: &mut Comp, o: Cl, n: Cl) {
	if c.clines.get(o).flags & clf::JOIN != 0 {
		let mut nr = None;
		join_psfx(c, o, n, None, Some(&mut nr), false);
		let r = revert_cline(c, nr);
		c.clines.get_mut(n).suffix = r;
	} else {
		c.clines.get_mut(o).flags |= clf::JOIN;
		let (mut or, mut nr) = (None, None);
		join_psfx(c, o, n, Some(&mut or), Some(&mut nr), false);
		if let Some(x) = or {
			let (slen, wlen) = (c.clines.get(o).slen, c.clines.get(x).wlen);
			set_llen(c, x, if slen > wlen { wlen } else { slen });
		}
		let r = revert_cline(c, or);
		c.clines.get_mut(o).suffix = r;
		let r = revert_cline(c, nr);
		c.clines.get_mut(n).suffix = r;
	}
	join_psfx(c, o, n, None, None, true);
	c.clines.get_mut(n).suffix = None;
}

/// zsh `sub_join`: turn the anchors from `b` up to `e` into a prefix
/// before `e`'s and join it with `a`'s prefix; the length difference.
fn sub_join(c: &mut Comp, a: Cl, b: Cl, e: Cl, anew: bool) -> i32 {
	if c.clines.get(e).suffix.is_some() || c.clines.get(a).prefix.is_none() {
		return 0;
	}
	let op = c.clines.get(e).prefix;
	let mut head: Option<Cl> = None;
	let mut last: Option<Cl> = None;
	let (mut min, mut max) = (0, 0);
	let link = |c: &mut Comp, head: &mut Option<Cl>, last: Option<Cl>, x: Option<Cl>| match last {
		Some(l) => c.clines.get_mut(l).next = x,
		None => *head = x,
	};
	let mut b = Some(b);
	while let Some(bb) = b
		&& bb != e
	{
		let bp = c.clines.get(bb).prefix;
		link(c, &mut head, last, bp);
		if let Some(mut t) = bp {
			while let Some(nx) = c.clines.get(t).next {
				t = nx;
			}
			last = Some(t);
		}
		let y = c.clines.get_mut(bb);
		y.suffix = None;
		y.prefix = None;
		y.flags &= !clf::SUF;
		min += y.min;
		max += y.max;
		let next = y.next;
		link(c, &mut head, last, Some(bb));
		last = Some(bb);
		b = next;
	}
	link(c, &mut head, last, op);
	let ca = c.clines.get(a).prefix;
	let mut n = head;
	while let Some(nn) = n {
		let ep = cp_cline(c, Some(nn), true);
		c.clines.get_mut(e).prefix = ep;
		let ap = cp_cline(c, ca, true);
		c.clines.get_mut(a).prefix = ap;
		let f = c.clines.get(e).flags;
		if anew {
			join_psfx(c, e, a, None, None, false);
			c.clines.get_mut(e).flags = f;
			if c.clines.get(e).prefix.is_some() {
				return max - min;
			}
		} else {
			join_psfx(c, a, e, None, None, false);
			c.clines.get_mut(e).flags = f;
			if c.clines.get(a).prefix.is_some() {
				return max - min;
			}
		}
		min -= c.clines.get(nn).min;
		if Some(nn) == op {
			break;
		}
		n = c.clines.get(nn).next;
	}
	max - min
}

/// `for (t = from; (tn = t->next) && cond(tn); t = tn);`: `(t, tn)`.
fn scan(c: &mut Comp, from: Cl, mut cond: impl FnMut(&mut Comp, Cl) -> bool) -> (Cl, Option<Cl>) {
	let mut t = from;
	loop {
		let next = c.clines.get(t).next;
		match next {
			Some(tn) if cond(c, tn) => t = tn,
			tn => return (t, tn),
		}
	}
}

fn fl(c: &Comp, x: Cl) -> u32 {
	c.clines.get(x).flags
}

/// `po->flags |= CLF_MISS; po->max += diff` on `po` when it has a
/// prefix and `test`, else on `o`.
fn miss(c: &mut Comp, po: Option<Cl>, o: Cl, diff: i32, test: impl FnOnce(&mut Comp, Cl) -> bool) {
	let target = if let Some(p) = po
		&& c.clines.get(p).prefix.is_some()
		&& test(c, p)
	{
		p
	} else {
		o
	};
	let y = c.clines.get_mut(target);
	y.flags |= clf::MISS;
	y.max += diff;
}

/// zsh `join_clines`: simplify the cline list `o` so that it also
/// matches `n` (the first call returns `n`).
pub fn join_clines(c: &mut Comp, o: Option<Cl>, n: Option<Cl>) -> Option<Cl> {
	cline_setlens(&mut c.clines, n, true);
	let Some(o0) = o else { return n };
	let (mut oo, nn) = (Some(o0), n);
	let (mut o, mut n) = (Some(o0), n);
	let (mut po, mut pn): (Option<Cl>, Option<Cl>) = (None, None);
	let sm = clf::SUF | clf::MID;
	while let (Some(oc), Some(ncl)) = (o, n) {
		if fl(c, oc) & clf::NEW != 0 && fl(c, ncl) & clf::NEW == 0 {
			let (t, tn) =
				scan(c, oc, |c, tn| fl(c, tn) & clf::NEW != 0 || cmp_anchors(c, tn, ncl, false) == 0);
			if let Some(tn) = tn {
				let diff = sub_join(c, ncl, oc, tn, true);
				match po {
					Some(p) => c.clines.get_mut(p).next = Some(tn),
					None => oo = Some(tn),
				}
				c.clines.get_mut(t).next = None;
				free_cline(c, Some(oc));
				let x = oc;
				o = Some(tn);
				miss(c, po, tn, diff, |c, p| cmp_anchors(c, x, p, false) != 0);
				continue;
			}
		}
		if fl(c, oc) & clf::NEW == 0 && fl(c, ncl) & clf::NEW != 0 {
			let (_, tn) =
				scan(c, ncl, |c, tn| fl(c, tn) & clf::NEW != 0 || cmp_anchors(c, oc, tn, false) == 0);
			if let Some(tn) = tn {
				let of = fl(c, oc) & clf::MISS;
				let diff = sub_join(c, oc, ncl, tn, false);
				let y = c.clines.get_mut(oc);
				y.flags = (y.flags & !clf::MISS) | of;
				let pnv = pn;
				miss(c, po, oc, diff, |c, _| pnv.is_some_and(|pn| cmp_anchors(c, ncl, pn, false) != 0));
				n = Some(tn);
				continue;
			}
		}
		if fl(c, oc) & sm != fl(c, ncl) & sm {
			let of = fl(c, oc) & sm;
			let (_, tn) = scan(c, ncl, |c, tn| fl(c, tn) & sm != of);
			if let Some(tn) = tn
				&& cmp_anchors(c, oc, tn, true) != 0
			{
				sub_join(c, oc, ncl, tn, false);
				n = Some(tn);
				continue;
			}
			let nf = fl(c, ncl) & sm;
			let (t, tn) = scan(c, oc, |c, tn| fl(c, tn) & sm != nf);
			if let Some(tn) = tn
				&& cmp_anchors(c, tn, ncl, true) != 0
			{
				sub_join(c, ncl, oc, tn, true);
				match po {
					Some(p) => c.clines.get_mut(p).next = Some(tn),
					None => oo = Some(tn),
				}
				c.clines.get_mut(t).next = None;
				free_cline(c, Some(oc));
				o = Some(tn);
				continue;
			}
			if fl(c, oc) & clf::MID != 0 {
				let nsuf = fl(c, ncl) & clf::SUF;
				let y = c.clines.get_mut(oc);
				y.flags = (y.flags & !clf::MID) | nsuf;
				if nsuf != 0 {
					let p = y.prefix.take();
					free_cline(c, p);
				} else {
					let s = y.suffix.take();
					free_cline(c, s);
				}
			}
			break;
		}
		if fl(c, oc) & clf::MID == 0 && cmp_anchors(c, oc, ncl, true) == 0 {
			// Find a common skipped anchor in both lists.
			let mut to: Option<Cl> = None;
			let mut tnf: Option<Cl> = None;
			let mut t = ncl;
			while let Some(tn) = c.clines.get(t).next {
				if fl(c, tn) & clf::NEW == 0 && fl(c, tn) & clf::SKIP != 0 {
					let mut tt = oc;
					to = None;
					while let Some(x) = c.clines.get(tt).next {
						if fl(c, x) & clf::NEW == 0
							&& fl(c, x) & clf::SKIP != 0
							&& cmp_anchors(c, tn, x, true) != 0
						{
							to = Some(x);
							break;
						}
						tt = x;
					}
					if to.is_some() {
						tnf = Some(tn);
						break;
					}
				}
				t = tn;
			}
			if let Some(tn) = tnf {
				let to = to.unwrap_or(tn);
				match po {
					Some(p) => c.clines.get_mut(p).next = Some(to),
					None => oo = Some(to),
				}
				let diff = sub_join(c, to, ncl, tn, false);
				let y = c.clines.get_mut(to);
				y.flags |= clf::MISS;
				y.max += diff;
				po = Some(to);
				o = c.clines.get(to).next;
				pn = Some(tn);
				n = c.clines.get(tn).next;
				continue;
			}
			let (_, to1) =
				scan(c, oc, |c, x| !(fl(c, x) & clf::SKIP != 0 && cmp_anchors(c, ncl, x, true) != 0));
			if let Some(to) = to1 {
				let diff = sub_join(c, ncl, oc, to, true);
				match po {
					Some(p) => c.clines.get_mut(p).next = Some(to),
					None => oo = Some(to),
				}
				let x = oc;
				o = Some(to);
				miss(c, po, to, diff, |c, p| cmp_anchors(c, x, p, false) != 0);
				continue;
			}
			// C leaves `to` from the inner loop of its last outer pass.
			let mut to2: Option<Cl> = None;
			let mut t = ncl;
			while let Some(tn) = c.clines.get(t).next {
				if fl(c, tn) & clf::SKIP != 0 {
					let mut tt = oc;
					to2 = None;
					while let Some(x) = c.clines.get(tt).next {
						if fl(c, x) & clf::SKIP != 0 && cmp_anchors(c, tn, x, true) != 0 {
							to2 = Some(x);
							break;
						}
						tt = x;
					}
				}
				if to2.is_some() {
					break;
				}
				t = tn;
			}
			if let Some(to) = to2 {
				let diff = sub_join(c, ncl, oc, to, true);
				match po {
					Some(p) => c.clines.get_mut(p).next = Some(to),
					None => oo = Some(to),
				}
				let x = oc;
				o = Some(to);
				miss(c, po, to, diff, |c, p| cmp_anchors(c, x, p, false) != 0);
				continue;
			}
			let mut tn = Some(ncl);
			while let Some(x) = tn {
				if fl(c, x) & clf::NEW == fl(c, oc) & clf::NEW && cmp_anchors(c, x, oc, true) != 0 {
					break;
				}
				tn = c.clines.get(x).next;
			}
			if let Some(tn) = tn {
				let of = fl(c, oc) & clf::MISS;
				let diff = sub_join(c, oc, ncl, tn, false);
				if diff != 0 {
					let y = c.clines.get_mut(oc);
					y.flags = (y.flags & !clf::MISS) | of;
					miss(c, po, oc, diff, |_, _| true);
				}
				po = Some(oc);
				o = c.clines.get(oc).next;
				pn = Some(tn);
				n = c.clines.get(tn).next;
				continue;
			}
			if fl(c, oc) & clf::SUF != 0 {
				break;
			}
			let y = c.clines.get_mut(oc);
			y.word = None;
			y.line = None;
			y.orig = None;
			y.wlen = 0;
			let nx = y.next.take();
			y.flags |= clf::MISS;
			free_cline(c, nx);
		}
		// Equal: copy the original string, min/max, join the sub-lists.
		let (no, nol, nmin, nmax) = {
			let y = c.clines.get(ncl);
			(y.orig.clone(), y.olen, y.min, y.max)
		};
		let y = c.clines.get_mut(oc);
		if y.orig.is_none() && y.olen == 0 {
			y.orig = no;
			y.olen = nol;
		}
		if nmin < y.min {
			y.min = nmin;
		}
		if nmax > y.max {
			y.max = nmax;
		}
		if y.flags & clf::MID != 0 {
			join_mid(c, oc, ncl);
		} else {
			let s = y.flags & clf::SUF != 0;
			join_psfx(c, oc, ncl, None, None, s);
		}
		po = Some(oc);
		o = c.clines.get(oc).next;
		pn = Some(ncl);
		n = c.clines.get(ncl).next;
	}
	if let Some(oc) = o {
		match po {
			Some(p) => c.clines.get_mut(p).next = None,
			None => oo = None,
		}
		free_cline(c, Some(oc));
	}
	free_cline(c, nn);
	oo
}
