//! compcore.c's string helpers: quoting by the quote stack
//! (`multiquote`, `tildequote`), finding a parameter expansion in the
//! word (`check_param`), backslash and quote removal (`rembslash`,
//! `remsquote`, `ctokenize`), the word as completion sees it
//! (`comp_str`), `compset -q` (`set_comp_sep`), and reading and storing
//! user arrays (`get_user_var`, `set_list_array`).

use bstr::BString;

use super::super::{Comp, complete, isset, qt, types::cmf};
use crate::bash::{
	pattern::zsh::{remnulargs, tokenize},
	syntax::{
		Features, NO_ALIASES,
		zsh::{
			LexTok, ZleLex, ZleWords, ident_end, skipparens,
			tok::{
				BNULL, DNULL, EQUALS, HAT, INBRACE, INBRACK, INPAR, META, OUTBRACE, OUTPAR, POUND,
				QSTRING, QUEST, SNULL, STAR, STRING, TILDE, at, is_null, metafy, unmetafy, untokenize,
			},
		},
	},
	vm::{
		expand::{Expander, X},
		zsh::{
			params::{
				PValue, SCANPM_MATCHMANY, SCANPM_WANTKEYS, SCANPM_WANTVALS, assignaparam, fetchvalue,
				getaparam, getparam, getsparam,
			},
			text::{QuoteOpts, getkey, getkeystring},
		},
	},
	zshopt::ZshOpt,
};

/// The options `quotestring` reads.
fn quote_opts(ex: &mut Expander<'_, '_>) -> QuoteOpts {
	let (bang, bang_special) =
		crate::bash::vm::zsh::params::bang_quoting(&mut ex.k.root, ex.cx.store, ex.vp);
	QuoteOpts {
		rcquotes: isset(ex, ZshOpt::Rcquotes),
		magic_equal_subst: isset(ex, ZshOpt::Magicequalsubst),
		extended_glob: isset(ex, ZshOpt::Extendedglob),
		bang,
		bang_special,
		mb: crate::bash::vm::zsh::params::mb_quiet(ex.k, ex.cx.store, ex.vp),
	}
}

/// zsh `multiquote`: quote `s` for every level of `compqstack`
/// (`$compstate[all_quotes]`), skipping the innermost with `ign`.
pub fn multiquote(ex: &mut Expander<'_, '_>, c: &Comp, s: &[u8], ign: bool) -> BString {
	let stack = c
		.complete
		.compqstack
		.as_deref()
		.map_or(&[][..], |s| s.as_slice());
	let mut s = s.to_vec();
	if !stack.is_empty() && (!ign || stack.len() > 1) {
		let o = quote_opts(ex);
		for &q in &stack[usize::from(ign)..] {
			s = super::super::quotestring(&s, q, o);
		}
	}
	BString::from(s)
}

/// zsh `tildequote`: [`multiquote`], but a leading `~` stays unquoted.
pub fn tildequote(ex: &mut Expander<'_, '_>, c: &Comp, s: &[u8], ign: bool) -> BString {
	let tilde = s.first() == Some(&b'~');
	let mut s = s.to_vec();
	if tilde {
		s[0] = b'x';
	}
	let mut r = multiquote(ex, c, &s, ign);
	if tilde && !r.is_empty() {
		r[0] = b'~';
	}
	r
}

/// zsh `check_param`: whether the cursor (`offs` into the word `s`) is in
/// the name of a parameter expansion. `test`: only say where the name
/// starts. Otherwise `ispar`, `parq`, `parpre`, … are set, `wb`/`we`/
/// `offs` narrowed to the name, `s` cut after it (zsh's `b[we-wb] =
/// '\0'`), and with `set` the ignored prefix/suffix (`ipre`, `ripre`,
/// `isuf`) extended. The offset in `s` where the name starts.
#[allow(clippy::too_many_lines, reason = "a direct port of zsh's check_param")]
pub fn check_param(c: &mut Comp, s: &mut Vec<u8>, set: bool, test: bool) -> Option<usize> {
	let offs = usize::try_from(c.tricky.offs).unwrap_or(0);
	let mut found = false;
	let mut qstring = false;
	c.core.parpre = None;
	if !test {
		c.core.ispar = 0;
		c.core.parq = 0;
		c.core.eparq = 0;
	}
	let isdollar = |ch: u8| ch == STRING || ch == QSTRING;
	// Step back from the cursor to a `$` in the word.
	let mut p = offs;
	loop {
		let ch = at(s, p);
		if isdollar(ch)
			&& p < offs
			&& !(ch == STRING && at(s, p + 1) == SNULL)
			&& !(ch == QSTRING && at(s, p + 1) == b'\'')
		{
			found = true;
			qstring = ch == QSTRING;
			break;
		}
		if p == 0 {
			break;
		}
		p -= 1;
	}
	if found {
		// `$$`s.
		while p > 0 && isdollar(at(s, p - 1)) {
			p -= 1;
		}
		while isdollar(at(s, p + 1)) && isdollar(at(s, p + 2)) {
			p += 2;
		}
	}
	if !(found && at(s, p + 1) != INPAR && at(s, p + 1) != INBRACK && at(s, p + 1) != SNULL) {
		return None;
	}
	// A parameter expression, not `$(...)`, `$[...]`, `$'...'`.
	let mut b = p + 1;
	let mut br = 1;
	let mut nest = false;
	if at(s, b) == INBRACE {
		let mut tb = b;
		// A `${...}`: are we before the `}`?
		if skipparens(INBRACE, OUTBRACE, s, &mut tb) == 0 && tb <= offs {
			return None;
		}
		// Skip the `(...)` flags.
		b += 1;
		br += 1;
		let r = if qstring {
			skipparens(b'(', b')', s, &mut b)
		} else {
			skipparens(INPAR, OUTPAR, s, &mut b)
		};
		if r > 0 || b > offs {
			// Still in the flags: a brace parameter, nothing more.
			c.core.ispar = 2;
			return None;
		}
		let mut tb = isize::try_from(p).unwrap_or(0) - 1;
		let ch = |i: isize| usize::try_from(i).map_or(0, |i| at(s, i));
		while tb > 0 && ch(tb) != OUTBRACE && ch(tb) != INBRACE {
			tb -= 1;
		}
		if tb > 0 && ch(tb) == INBRACE && (ch(tb - 1) == STRING || ch(tb) == QSTRING) {
			nest = true;
		}
	}
	// Skip what comes before the name.
	while matches!(at(s, b), b'^' | HAT | b'=' | EQUALS | b'~' | TILDE) {
		b += 1;
	}
	if matches!(at(s, b), b'#' | POUND | b'+') {
		b += 1;
	}
	let mut e = b;
	let q = if test { DNULL } else { b'"' };
	while at(s, e) == q {
		e += 1;
		c.core.parq += 1;
	}
	if !test {
		b = e;
	}
	// The end of the name.
	let ce = at(s, e);
	let patmatch = c
		.complete
		.comppatmatch
		.as_ref()
		.is_some_and(|p| !p.is_empty());
	if matches!(ce, QUEST | STAR | STRING | QSTRING | b'?' | b'*' | b'$' | b'-' | b'!' | b'@') {
		e += 1;
	} else if ce.is_ascii_digit() {
		while at(s, e).is_ascii_digit() {
			e += 1;
		}
	} else {
		let mut ie = ident_end(s, e, false);
		if ie != e {
			loop {
				e = ie;
				ie = if patmatch && (at(s, e) == STAR || at(s, e) == QUEST) {
					e + 1
				} else {
					ident_end(s, e, false)
				};
				if ie == e {
					break;
				}
			}
		}
	}
	// Is the cursor inside the name?
	if offs <= e && offs >= b {
		let mut p = e;
		while at(s, p) == q {
			p += 1;
			c.core.parq -= 1;
			c.core.eparq += 1;
		}
		if test {
			return Some(b);
		}
		if set {
			if br >= 2 {
				c.core.mflags |= cmf::PARBR as i32;
				if nest {
					c.core.mflags |= cmf::PARNEST as i32;
				}
			}
			// The prefix up to the name and the suffix after it.
			let mut isuf = s[e.min(s.len())..].to_vec();
			untokenize(&mut isuf);
			c.core.isuf = Some(isuf.into());
			let pre = &s[..b.min(s.len())];
			let mut ripre = c.core.ripre.take().unwrap_or_default();
			ripre.extend_from_slice(pre);
			c.core.ripre = Some(ripre);
			let mut ipre = c.core.ipre.take().map_or_default(Vec::from);
			ipre.extend_from_slice(pre);
			untokenize(&mut ipre);
			c.core.ipre = Some(ipre.into());
		}
		if c.tricky.compfunc.is_some() {
			c.core.parflags = if br >= 2 {
				(cmf::PARBR | if nest { cmf::PARNEST } else { 0 }) as i32
			} else {
				0
			};
			let mut pp = s[..b.min(s.len())].to_vec();
			untokenize(&mut pp);
			c.core.parpre = Some(pp.into());
		}
		// Narrow wb, we and offs to the name.
		let noffs = offs - b;
		c.tricky.offs = i32::try_from(noffs).unwrap_or(0);
		c.tricky.wb = i32::try_from(c.line.cs).unwrap_or(0) - c.tricky.offs;
		c.tricky.we = c.tricky.wb + i32::try_from(e - b).unwrap_or(0);
		c.core.ispar = if br >= 2 { 2 } else { 1 };
		s.truncate(e);
		return Some(b);
	} else if offs > e && at(s, e) == b':' {
		// Probably in modifiers: a rough guess.
		c.core.ispar = if br >= 2 { 2 } else { 1 };
	}
	None
}

/// zsh `rembslash`: a copy of `s` without its backslashes (each quoting
/// the next byte).
pub fn rembslash(s: &[u8]) -> BString {
	let mut r = Vec::with_capacity(s.len());
	let mut i = 0;
	while i < s.len() {
		if s[i] == b'\\' {
			i += 1;
			if i < s.len() {
				r.push(s[i]);
				i += 1;
			}
		} else {
			r.push(s[i]);
			i += 1;
		}
	}
	BString::from(r)
}

/// zsh `remsquote`: undo one level of single-quote quoting of quotes in
/// `s` (`''` with `RC_QUOTES`, else `'\''`), in place; the bytes removed.
fn remsquote_with(rcquotes: bool, s: &mut Vec<u8>) -> i32 {
	let qa = if rcquotes { 1 } else { 3 };
	let mut ret = 0;
	let mut out = Vec::with_capacity(s.len());
	let mut i = 0;
	while i < s.len() {
		let hit = if qa == 1 {
			at(s, i) == b'\'' && at(s, i + 1) == b'\''
		} else {
			at(s, i) == b'\''
				&& at(s, i + 1) == b'\\'
				&& at(s, i + 2) == b'\''
				&& at(s, i + 3) == b'\''
		};
		if hit {
			ret += qa;
			out.push(b'\'');
			i += usize::try_from(qa).unwrap_or(1) + 1;
		} else {
			out.push(s[i]);
			i += 1;
		}
	}
	*s = out;
	ret
}

/// zsh `ctokenize`: [`tokenize`], and `$`, `{`, `}` become tokens unless
/// a backslash quotes them (then the backslash becomes a `Bnull`).
pub fn ctokenize(p: &mut [u8]) {
	tokenize(p);
	let mut bslash = false;
	for i in 0..p.len() {
		if p[i] == b'\\' {
			bslash = true;
		} else {
			if matches!(p[i], b'$' | b'{' | b'}') {
				if bslash {
					p[i - 1] = BNULL;
				} else {
					p[i] = match p[i] {
						b'$' => STRING,
						b'{' => INBRACE,
						_ => OUTBRACE,
					};
				}
			}
			bslash = false;
		}
	}
}

/// zsh `comp_str`: `$IPREFIX$PREFIX$SUFFIX` (prefix and suffix
/// tokenized unless `untok`), with the lengths of the ignored prefix and
/// of the prefix.
pub fn comp_str(c: &Comp, untok: bool) -> (BString, i32, i32) {
	let get = |s: &Option<BString>| s.as_ref().map_or_default(|s| s.to_vec());
	let mut p = get(&c.complete.compprefix);
	let mut s = get(&c.complete.compsuffix);
	let ip = get(&c.complete.compiprefix);
	if !untok {
		ctokenize(&mut p);
		remnulargs(&mut p);
		ctokenize(&mut s);
		remnulargs(&mut s);
	}
	let (lip, lp) = (ip.len(), p.len());
	let mut str = ip;
	str.extend_from_slice(&p);
	str.extend_from_slice(&s);
	(BString::from(str), i32::try_from(lip).unwrap_or(0), i32::try_from(lp).unwrap_or(0))
}

/// zsh `comp_quoting_string`: the quote that opens a `QT_*` context.
pub const fn comp_quoting_string(stype: u8) -> &'static [u8] {
	match stype {
		qt::SINGLE => b"'",
		qt::DOUBLE => b"\"",
		qt::DOLLARS => b"$'",
		_ => b"\\",
	}
}

/// zsh `set_comp_sep` (`compset -q`): split the current word as if it
/// were a command line, making its words `$words` and the word the
/// cursor is in the one completed (one more quoting level on
/// `compqstack`). 1 when that is impossible (or the shell's options
/// cannot be read).
#[allow(clippy::too_many_lines, reason = "a direct port of zsh's set_comp_sep")]
pub fn set_comp_sep(ex: &mut Expander<'_, '_>, c: &mut Comp) -> i32 {
	let (full, lip, lp) = comp_str(c, true);
	let (lip, noffs) = (usize::try_from(lip).unwrap_or(0), usize::try_from(lp).unwrap_or(0));
	let mut wordlist: Vec<Vec<u8>> = Vec::new();
	let (owe, owb) = (c.tricky.we, c.tricky.wb);
	let (mut swb, mut swe, mut soffs) = (0i32, 0i32, 0i32);
	let mut got = false;
	let mut i = 0i32;
	let mut cur: i32 = -1;
	let mut css = 0i32;
	let mut remq = false;
	let (mut dq, mut sq, mut sqq, mut lsq, mut qa, mut dolq) = (0i32, 0i32, 0i32, 0i32, 0i32, 0i32);
	let (ois, oib) = (c.tricky.instring, c.tricky.inbackt);
	let mut s = full[lip.min(full.len())..].to_vec();
	let wb0 = c.tricky.wb + i32::try_from(lip).unwrap_or(0);
	untokenize(&mut s);
	let mut ns: Option<Vec<u8>> = None;
	// The word with a space before it and an `x` at the cursor.
	let tl = s.len() + 2;
	let mut tmp = Vec::with_capacity(tl + 1);
	tmp.push(b' ');
	tmp.extend_from_slice(&s[..noffs.min(s.len())]);
	let scs0 = 1 + noffs.min(s.len());
	tmp.push(b'x');
	tmp.extend_from_slice(&s[noffs.min(s.len())..]);
	let mut scs = i32::try_from(scs0).unwrap_or(0);
	let mut zcs = scs;
	let qttype = c
		.complete
		.compqstack
		.as_ref()
		.and_then(|q| q.first().copied())
		.unwrap_or(qt::NONE);
	let rcquotes = isset(ex, ZshOpt::Rcquotes);
	match qttype {
		qt::BACKSLASH => {
			remq = true;
			tmp = rembslash(&tmp).into();
		},
		qt::SINGLE => {
			qa = if rcquotes { 1 } else { 3 };
			sq = remsquote_with(rcquotes, &mut tmp);
		},
		qt::DOUBLE => {
			let (mut p, mut j) = (0usize, 0i32);
			while p < tmp.len() {
				if tmp[p] == b'\\' && (at(&tmp, p + 1) == b'\\' || at(&tmp, p + 1) == b'"') {
					dq += 1;
					tmp.remove(p);
					if at(&tmp, p) == b'"' {
						zcs -= 1;
					} else if j > zcs {
						zcs += 1;
						css += 1;
					}
					if p >= tmp.len() {
						break;
					}
				}
				p += 1;
				j += 1;
			}
		},
		qt::DOLLARS => {
			let j = zcs;
			let cut = usize::try_from(zcs).unwrap_or(0).min(tmp.len());
			// GETKEY_UPDATE_OFFSET: the cursor moves with what is
			// removed before it.
			let ncs = getkeystring(&tmp[..cut], getkey::DOLLAR_QUOTE).text.len();
			tmp = getkeystring(&tmp, getkey::DOLLAR_QUOTE).text;
			zcs = i32::try_from(ncs).unwrap_or(0);
			dolq = i32::try_from(tl).unwrap_or(0) - i32::try_from(tmp.len()).unwrap_or(0);
			css += zcs - j;
		},
		_ => {},
	}
	let odq = dq;
	// Lex it as zle's line (zsh's inpush, LEXFLAGS_ZLE, noaliases).
	let Ok(feat) =
		crate::bash::vm::mode::features(&mut ex.k.root, ex.cx.store, ex.vp, Features::ZSH)
	else {
		return 1;
	};
	let mut src = unmetafy(&tmp);
	src.push(b' ');
	let z = ZleWords {
		zlemetacs: zcs,
		zlemetall: i32::try_from(tl).unwrap_or(0) - 1,
		addedx:    1,
		wb:        wb0,
		we:        owe,
		wordbeg:   0,
		parbegin:  -1,
		parend:    -1,
		inwhat:    0,
	};
	let mut lx = ZleLex::new(&src, feat, NO_ALIASES, true, z);
	loop {
		lx.ctxtlex();
		if lx.tok() == LexTok::Lexerr {
			let Some(ts) = lx.tokstr().map(<[u8]>::to_vec) else {
				break;
			};
			// An unterminated string? An odd number of active quotes.
			let j = ts.iter().filter(|&&ch| ch == SNULL || ch == DNULL).count();
			if j & 1 == 1 {
				lx.set_tok(LexTok::String);
				let mut ts = ts;
				if ts.last() == Some(&b' ') {
					ts.pop();
				}
				lx.set_tokstr(Some(ts.as_slice()));
			}
		}
		if lx.tok() == LexTok::Endinput {
			break;
		}
		let has = match lx.tokstr() {
			Some(ts) if !ts.is_empty() => {
				let ts = ts.to_vec();
				let mut p = 0;
				while dq != 0 && p < ts.len() {
					if ts[p] == BNULL {
						dq -= 1;
						if at(&ts, p + 1) == b'\\' {
							dq -= 1;
						}
					}
					p += 1;
				}
				lsq = 0;
				if qttype == qt::SINGLE {
					for &ch in &ts {
						if sq != 0 && ch == SNULL {
							sq -= qa;
						}
						if ch == b'\'' {
							sq -= qa;
							lsq += qa;
						}
					}
				}
				wordlist.push(ts);
				true
			},
			_ => false,
		};
		if !got && lx.lexflags() == 0 {
			got = true;
			cur = i32::try_from(wordlist.len()).unwrap_or(0) - 1;
			let z = lx.z();
			swb = z.wb - dq - sq - dolq;
			swe = z.we - dq - sq - dolq;
			sqq = lsq;
			soffs = zcs - swb - css;
			if has && let Some(w) = wordlist.last_mut() {
				// Take out the `x`.
				if let Ok(o) = usize::try_from(soffs)
					&& o < w.len()
				{
					w.remove(o);
				}
				ns = Some(w.clone());
			} else {
				ns = Some(Vec::new());
			}
		}
		i += 1;
		if matches!(lx.tok(), LexTok::Endinput | LexTok::Lexerr) {
			break;
		}
	}
	drop(lx);
	c.tricky.wb = owb;
	c.tricky.we = owe;
	if cur < 0 || i < 1 {
		return 1;
	}
	let mut ns = ns.unwrap_or_default();
	let ooffs = c.tricky.offs;
	c.tricky.offs = soffs;
	if check_param(c, &mut ns.clone(), false, true).is_some() {
		for ch in &mut ns {
			if *ch == DNULL {
				*ch = b'"';
			} else if *ch == SNULL {
				*ch = b'\'';
			}
		}
	}
	c.tricky.offs = ooffs;
	let mut ts = ns.clone();
	untokenize(&mut ts);
	let n0 = at(&ns, 0);
	if n0 == SNULL || n0 == DNULL || ((n0 == STRING || n0 == QSTRING) && at(&ns, 1) == SNULL) {
		let (mut nsp, mut tsp) = (0usize, 0usize);
		match n0 {
			SNULL => c.tricky.instring = i32::from(qt::SINGLE),
			DNULL => c.tricky.instring = i32::from(qt::DOUBLE),
			_ => {
				c.tricky.instring = i32::from(qt::DOLLARS);
				nsp += 1;
				tsp += 1;
				swb += 1;
			},
		}
		c.tricky.inbackt = 0;
		swb += 1;
		if ns.len() > nsp && ns[ns.len() - 1] == ns[nsp] && at(&ns, nsp + 1) != 0 {
			swe -= 1;
		}
		tsp += 1;
		let multi = c.complete.compqstack.as_ref().is_some_and(|q| q.len() > 1);
		c.tricky.autoq = Some(if multi {
			BString::default()
		} else {
			multiquote(ex, c, &ts[..tsp.min(ts.len())], true)
		});
		ts.drain(..tsp.min(ts.len()));
	} else {
		c.tricky.instring = i32::from(qt::NONE);
		c.tricky.autoq = None;
	}
	// Indices for the word's start and the cursor without the quotes.
	{
		let mut p = 0usize;
		let mut i = swb;
		while p < ns.len() {
			if is_null(ns[p]) {
				if i < scs && ns[p] == BNULL {
					if at(&ns, p + 1) != 0 && remq {
						swb -= 2;
					}
					if odq != 0 {
						swb -= 1;
						if at(&ns, p + 1) == b'\\' {
							swb -= 1;
						}
					}
				}
				if at(&ns, p + 1) != 0 || ns[p] != BNULL {
					if ns[p] == BNULL {
						if scs == i + 1 {
							scs += 1;
							soffs += 1;
						}
					} else {
						if scs > i {
							scs -= 1;
						}
						i -= 1;
					}
				} else if scs == swe {
					scs -= 1;
				}
				ns.remove(p);
			} else {
				p += 1;
			}
			i += 1;
		}
	}
	let mut ns = ts;
	let stack = c.complete.compqstack.clone().unwrap_or_default();
	if c.tricky.instring != 0 && stack.contains(&qt::BACKSLASH) {
		let rl = ns.len();
		let ql = multiquote(ex, c, &ns, stack.len() > 1).len();
		if ql > rl {
			swb -= i32::try_from(ql - rl).unwrap_or(0);
		}
	}
	let clamp = |x: i32, len: usize| usize::try_from(x).unwrap_or(0).min(len);
	let qi = clamp(swb - 1 - sqq + dq, s.len());
	let mut qp: Vec<u8> = if qttype == qt::SINGLE {
		s[..qi].to_vec()
	} else {
		rembslash(&s[..qi]).into()
	};
	if swe < swb {
		swe = swb;
	}
	swe -= 1;
	let sl = i32::try_from(s.len()).unwrap_or(0);
	if swe > sl {
		swe = sl;
		let keep = usize::try_from(swe - swb + 1).unwrap_or(0);
		if ns.len() > keep {
			ns.truncate(keep);
		}
	}
	let qsi = clamp(swe, s.len());
	let mut qs: Vec<u8> = if qttype == qt::SINGLE {
		s[qsi..].to_vec()
	} else {
		rembslash(&s[qsi..]).into()
	};
	let soffs = usize::try_from(soffs).unwrap_or(0).min(ns.len());
	if qttype == qt::SINGLE {
		remsquote_with(rcquotes, &mut qp);
		remsquote_with(rcquotes, &mut qs);
	}
	let mut set = complete::CP_QUOTE | complete::CP_QUOTING;
	let mut unset = 0;
	let instring = u8::try_from(c.tricky.instring).unwrap_or(0);
	let mut nstack = vec![if instring == qt::NONE {
		qt::BACKSLASH
	} else {
		instring
	}];
	nstack.extend_from_slice(&stack);
	c.complete.compqstack = Some(nstack.into());
	let (quote, quoting): (&[u8], &[u8]) = match instring {
		qt::DOUBLE => (b"\"", b"double"),
		qt::SINGLE => (b"'", b"single"),
		qt::DOLLARS => (b"$'", b"dollars"),
		_ => {
			unset = set;
			set = 0;
			(b"", b"")
		},
	};
	c.complete.compquote = Some(quote.into());
	c.complete.compquoting = Some(quoting.into());
	complete::comp_setunset(c, 0, 0, set, unset);
	let (mut pre, mut suf) = if isset(ex, ZshOpt::Completeinword) {
		(ns[..soffs].to_vec(), ns[soffs..].to_vec())
	} else {
		(ns.clone(), Vec::new())
	};
	untokenize(&mut pre);
	untokenize(&mut suf);
	let pl = pre.len();
	if pl > 1 && pre[pl - 1] == b'\\' && pre[pl - 2] != b'\\' && pre[pl - 2] != META {
		pre.pop();
	}
	c.complete.compprefix = Some(pre.into());
	c.complete.compsuffix = Some(suf.into());
	let get = |s: &Option<BString>| s.as_ref().map_or_default(|s| s.to_vec());
	let mut qip = get(&c.complete.compqiprefix);
	qip.extend_from_slice(&get(&c.complete.compiprefix));
	qip.extend_from_slice(&multiquote(ex, c, &qp, true));
	c.complete.compqiprefix = Some(qip.into());
	let mut qis = multiquote(ex, c, &qs, true).to_vec();
	qis.extend_from_slice(&get(&c.complete.compisuffix));
	qis.extend_from_slice(&get(&c.complete.compqisuffix));
	c.complete.compqisuffix = Some(qis.into());
	c.complete.compiprefix = Some(BString::default());
	c.complete.compisuffix = Some(BString::default());
	let n = wordlist.len();
	c.complete.compwords = wordlist
		.into_iter()
		.map(|mut w| {
			untokenize(&mut w);
			BString::from(w)
		})
		.collect();
	c.complete.compcurrent = i64::from(cur + 1).min(i64::try_from(n).unwrap_or(0));
	c.tricky.instring = ois;
	c.tricky.inbackt = oib;
	0
}

/// zsh `set_list_array`: assign the (metafied) strings `l` to the array
/// `name`.
///
/// # Errors
/// As the assignment.
pub fn set_list_array(ex: &mut Expander<'_, '_>, name: &[u8], l: Vec<BString>) -> X<()> {
	let raw = unmetafy(name);
	assignaparam(ex, &raw, l.iter().map(|s| BString::from(unmetafy(s))).collect(), 0)
}

/// zsh `get_user_var`: the words of `nam`: a `(a b …)` list, or the
/// value of the array, association (its values) or scalar `nam`
/// (metafied).
///
/// # Errors
/// A store failure.
pub fn get_user_var(ex: &mut Expander<'_, '_>, nam: Option<&[u8]>) -> X<Option<Vec<BString>>> {
	let Some(nam) = nam else {
		return Ok(None);
	};
	if nam.first() == Some(&b'(') {
		// A (...) list, not a parameter name.
		let mut ptr = nam.to_vec();
		let mut out = Vec::new();
		let mut s = 1usize;
		let mut notempty = false;
		let mut brk = false;
		let mut i = 0usize;
		loop {
			i += 1;
			if i >= ptr.len() {
				break;
			}
			let ch = ptr[i];
			if ch == b'\\' && i + 1 < ptr.len() {
				ptr.remove(i);
				notempty = true;
			} else if ch == b',' || ch == b' ' || ch == b'\t' || ch == b'\n' || ch == b')' {
				if ch == b')' {
					brk = true;
				}
				if notempty {
					let mut st = s;
					if ptr.get(st) == Some(&b'\n') {
						st += 1;
					}
					out.push(BString::from(&ptr[st.min(i)..i]));
				}
				s = i + 1;
				notempty = false;
			} else {
				notempty = true;
				if ch == META {
					i += 1;
				}
			}
			if brk {
				break;
			}
		}
		if !brk || out.is_empty() {
			return Ok(None);
		}
		return Ok(Some(out));
	}
	// zsh's getaparam/gethparam/getsparam: getvalue without subscripts,
	// the whole of `nam` a name.
	let mut pos = 0;
	if fetchvalue(ex, nam, &mut pos, 0, 0)?.is_none() || pos != nam.len() {
		return Ok(None);
	}
	let raw = unmetafy(nam);
	if let Some(a) = getaparam(ex, &raw)? {
		return Ok(Some(a.iter().map(|e| BString::from(metafy(e))).collect()));
	}
	if let Some(p) = getparam(ex, &raw)?
		&& let PValue::Hash(kv) = p.value
	{
		return Ok(Some(kv.iter().map(|(_, v)| BString::from(metafy(v))).collect()));
	}
	Ok(getsparam(ex, &raw)?.map(|v| vec![BString::from(metafy(&v))]))
}

/// zsh `get_data_arr`: the elements (or with `keys` the keys) of the
/// parameter expression `name` (may have a subscript), metafied.
pub(super) fn get_data_arr(
	ex: &mut Expander<'_, '_>,
	name: &[u8],
	keys: bool,
) -> X<Option<Vec<BString>>> {
	let mut pos = 0;
	let flags = if keys {
		SCANPM_WANTKEYS
	} else {
		SCANPM_WANTVALS
	} | SCANPM_MATCHMANY;
	let Some(mut v) = fetchvalue(ex, name, &mut pos, 1, flags)? else {
		return Ok(None);
	};
	Ok(Some(v.getarrvalue(ex)?.into_iter().map(BString::from).collect()))
}
