//! zsh 5.9 `get_comp_string` (`Src/Zle/zle_tricky.c`): the word to
//! complete taken from the metafied line by running the lexer over it in
//! ZLE mode, with the command it belongs to (`clwords`, `clwpos`,
//! `cmdstr`), its context (command position, redirection, assignment,
//! parameter, subscript, arithmetic: `lincmd`, `linredir`, `inwhat`,
//! `insubscr`, `varname`), its quoting (`instring`, `qipre`, `qisuf`,
//! `autoq`; the quotes are taken off the line) and the braces around the
//! cursor (`brbeg`, `brend`, `lastprebr`, `lastpostbr`).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::BString;

use super::{IN_COND, IN_ENV, IN_MATH, IN_NOTHING, IN_PAR, State, dupstrspace, quotename};
use crate::bash::{
	syntax::{
		AliasLookup, Features,
		zsh::{
			LexTok, ZleLex, ZleWords, ident_end, skipparens,
			tok::{
				BNULL, COMMA, DNULL, EQUALS, HAT, INBRACE, INBRACK, INPAR, META, OUTBRACE, OUTBRACK,
				OUTPAR, POUND, QSTRING, QUEST, SNULL, STAR, STRING, TILDE, at, is_null, is_tok,
				unmetafy, untokenize,
			},
			tokstring,
		},
	},
	vm::{
		zle::comp::{MetaLine, qt},
		zsh::text::{QuoteOpts, getkey, getkeystring},
	},
};

/// The options `get_comp_string` reads.
#[derive(Clone, Copy, Debug, Default)]
pub struct CompStrOpts {
	/// `COMPLETE_ALIASES` (zsh sets `noaliases` from it).
	pub completealiases: bool,
	/// `RC_QUOTES`.
	pub rcquotes:        bool,
	/// `EQUALS`.
	pub equals:          bool,
	/// `COMPLETE_IN_WORD`.
	pub completeinword:  bool,
	/// `IGNORE_BRACES`.
	pub ignorebraces:    bool,
	/// What `quotestring` reads.
	pub quote:           QuoteOpts,
}

/// The grammar the line is lexed with.
pub struct LexEnv<'a> {
	/// Parse-affecting options.
	pub feat:    Features,
	/// The alias tables (zsh expands aliases while completing unless
	/// `COMPLETE_ALIASES`).
	pub aliases: &'a dyn AliasLookup,
}

/// zsh `MB_METACHARLEN`: metafied bytes of the character at `i`.
fn mb_metacharlen(s: &[u8], i: usize) -> usize {
	let byte = |k: usize| -> Option<(u8, usize)> {
		match at(s, k) {
			0 if k >= s.len() => None,
			META => Some((at(s, k + 1) ^ 32, 2)),
			c => Some((c, 1)),
		}
	};
	let Some((lead, n0)) = byte(i) else {
		return 1;
	};
	let need = match lead {
		0xc2..=0xdf => 1,
		0xe0..=0xef => 2,
		0xf0..=0xf4 => 3,
		_ => return n0,
	};
	let mut len = n0;
	for _ in 0..need {
		match byte(i + len) {
			Some((c, n)) if c & 0xc0 == 0x80 => len += n,
			_ => return n0,
		}
	}
	len
}

/// zsh `itype_end(s, IIDENT, 1)`: past the one identifier character at
/// `i`, or `i`.
const fn ident_once(s: &[u8], i: usize) -> usize {
	if crate::bash::syntax::zsh::iident(at(s, i)) {
		i + 1
	} else {
		i
	}
}

/// zsh `has_real_token`: like `has_token`, but nulls (and `$'`) do not
/// count.
pub const fn has_real_token(s: &[u8]) -> bool {
	let mut i = 0;
	while i < s.len() {
		if (s[i] == QSTRING && at(s, i + 1) == b'\'') || (s[i] == STRING && at(s, i + 1) == SNULL) {
			i += 2;
			continue;
		}
		if is_tok(s[i]) && !is_null(s[i]) {
			return true;
		}
		i += 1;
	}
	false
}

const fn is_str(c: u8) -> bool {
	c == STRING || c == QSTRING
}

/// zsh `parambeg`: when the cursor (`offs` into `s`) is in the name of
/// a parameter expansion, where the name starts.
pub fn parambeg(s: &[u8], offs: i32) -> Option<usize> {
	let mut p = usize::try_from(offs).unwrap_or(0);
	while p > 0 && !is_str(at(s, p)) {
		p -= 1;
	}
	if is_str(at(s, p)) {
		while p > 0 && is_str(s[p - 1]) {
			p -= 1;
		}
		while is_str(at(s, p + 1)) && is_str(at(s, p + 2)) {
			p += 2;
		}
	}
	if is_str(at(s, p)) && !matches!(at(s, p + 1), INPAR | INBRACK | b'\'') {
		let mut b = p + 1;
		let n = if at(s, b) == INBRACE {
			let mut tb = b;
			if skipparens(INBRACE, OUTBRACE, s, &mut tb) == 0 {
				return None;
			}
			b += 1;
			skipparens(INPAR, OUTPAR, s, &mut b)
		} else {
			0
		};
		while at(s, b) != 0 && matches!(at(s, b), b'^' | HAT | b'=' | EQUALS | b'~' | TILDE) {
			b += 1;
		}
		if matches!(at(s, b), b'#' | POUND | b'+') {
			b += 1;
		}
		let mut e = b;
		while at(s, e) == DNULL {
			e += 1;
		}
		if matches!(
			at(s, e),
			QUEST | STAR | STRING | QSTRING | b'?' | b'*' | b'$' | b'-' | b'!' | b'@'
		) {
			e += 1;
		} else if at(s, e).is_ascii_digit() {
			while at(s, e).is_ascii_digit() {
				e += 1;
			}
		} else {
			e = ident_end(s, e, false);
		}
		let (bi, ei) = (b as i64, e as i64);
		if i64::from(offs) <= ei && i64::from(offs) >= bi && n <= 0 {
			return Some(b);
		}
	}
	None
}

/// zsh `addx`: the line with an `x` (and with `comppref` a space) at the
/// cursor where there is no word to lex there; `addedx`.
fn addx(line: &[u8], cs: usize, instring: i32, comppref: bool) -> Option<(Vec<u8>, i32)> {
	let c = at(line, cs);
	let mut addspace = false;
	let hit = c == 0
		|| c == b'\n'
		|| (matches!(c, b' ' | b'\t') && (cs == 0 || line[cs - 1] != b'\\'))
		|| matches!(c, b')' | b'`' | b'}' | b';' | b'|' | b'&' | b'>' | b'<')
		|| (instring != i32::from(qt::NONE) && matches!(c, b'"' | b'\''))
		|| {
			addspace = comppref && !matches!(c, b' ' | b'\t');
			addspace
		};
	if !hit {
		return None;
	}
	let mut out = Vec::with_capacity(line.len() + 2);
	out.extend_from_slice(&line[..cs.min(line.len())]);
	out.push(b'x');
	if addspace {
		out.push(b' ');
	}
	out.extend_from_slice(&line[cs.min(line.len())..]);
	Some((out, 1 + i32::from(addspace)))
}

/// zsh `chuck`: drop the byte at `i` (nothing past the end).
fn chuck(s: &mut Vec<u8>, i: i64) {
	if let Ok(i) = usize::try_from(i)
		&& i < s.len()
	{
		s.remove(i);
	}
}

/// Clamp a C pointer difference into an index.
fn ix(i: i64) -> usize {
	usize::try_from(i).unwrap_or(0)
}

/// zsh `get_comp_string` over the completion state `c` (the metafied line
/// in `c.line`): the word to complete (metafied, tokenized), `None` when
/// there is nothing completion can handle at the cursor. `param` looks a
/// parameter up: `None` when there is none, else whether it is an
/// association (`PM_HASHED`).
#[allow(
	clippy::cognitive_complexity,
	clippy::too_many_lines,
	reason = "a direct port of zsh's get_comp_string"
)]
pub fn get_comp_string_in(
	t: &mut State,
	line: &mut MetaLine,
	compfunc: bool,
	o: &CompStrOpts,
	lex: &LexEnv<'_>,
	param: &mut dyn FnMut(&[u8]) -> Option<bool>,
) -> Option<Vec<u8>> {
	t.brbeg.clear();
	t.brend.clear();
	t.nbrbeg = 0;
	t.nbrend = 0;
	t.lastprebr = None;
	t.lastpostbr = None;
	t.rdstrs.clear();
	let mut rdop: Vec<u8> = Vec::new();
	t.rdstr = None;
	let noaliases = o.completealiases;
	let orig: Vec<u8> = line.bytes().to_vec();
	let cs = i32::try_from(line.cs).unwrap_or(i32::MAX);

	// Inside `...`?
	{
		let (mut i, mut j, mut k) = (0, 0, 0);
		let mut u = 0usize;
		while u < line.cs {
			let ch = at(&orig, u);
			if ch == b'`' && k & 1 == 0 {
				i += 1;
			} else if ch == b'"' && k & 1 == 0 && i & 1 == 0 {
				j += 1;
			} else if ch == b'\'' && j & 1 == 0 {
				k += 1;
			} else if ch == b'\\' && at(&orig, u + 1) != 0 && k & 1 == 0 {
				u += 1;
			}
			u += 1;
		}
		t.inbackt = i & 1;
	}
	t.instring = i32::from(qt::NONE);
	let (mut zl, mut tmp, mut addedx) = match addx(&orig, line.cs, t.instring, t.comppref != 0) {
		Some((x, n)) => (x, Some(orig.clone()), n),
		None => (orig.clone(), None, 0),
	};
	let mut ll = i32::try_from(orig.len()).unwrap_or(i32::MAX);
	let mut linptr = 0usize;

	// Function-wide variables of the C code.
	let mut zlemetacs_qsub: i32 = 0;
	let mut varq = false;
	let mut tt: Option<Vec<u8>> = None;
	let mut words: Vec<Option<Vec<u8>>> = Vec::new();
	let (mut wb, mut we, mut inwhat);

	let s: Option<Vec<u8>> = 'start: loop {
		t.lincmd = 1;
		t.linredir = 0;
		t.cmdstr = None;
		let mut cmdtok: Option<LexTok> = None;
		t.varname = None;
		t.insubscr = 0;
		t.clwpos = -1;
		let src = unmetafy(&dupstrspace(&zl[linptr.min(zl.len())..]));
		let mut lx = ZleLex::new(&src, lex.feat, lex.aliases, noaliases, ZleWords {
			zlemetacs: cs,
			zlemetall: ll,
			addedx,
			wb: cs,
			we: cs,
			wordbeg: 0,
			parbegin: -1,
			parend: -1,
			inwhat: IN_NOTHING,
		});
		let (mut wordpos, mut cp, mut rd, mut ins, mut oins) = (0i32, 0i32, 0i32, 0i32, 0i32);
		let (mut parct, mut ia, mut redirpos) = (0i32, 0i32, 0i32);
		t.linarr = 0;
		let mut tt0: Option<LexTok> = None;

		'lex: loop {
			let mut qsub: i32 = 0;
			let mut noword = false;
			'body: {
				let inredir = lx.inredir();
				let incmdpos = lx.incmdpos();
				let incond = lx.incond() != 0;
				t.linredir = i32::from(inredir && ins == 0);
				t.lincmd = i32::from(
					!inredir
						&& ((incmdpos && ins == 0 && !incond)
							|| (oins == 2 && wordpos == 2)
							|| (ins == 3 && wordpos == 1)
							|| (cmdtok.is_none() && !incond)),
				);
				oins = ins;
				if t.linarr != 0 {
					lx.set_incmdpos(false);
				}
				if cmdtok == Some(LexTok::Typeset) {
					lx.set_intypeset(t.linarr == 0);
				}
				lx.ctxtlex();

				if lx.tok() == LexTok::Lexerr {
					let Some(ts) = lx.tokstr() else {
						break 'lex;
					};
					let nq = ts.iter().filter(|&&c| c == SNULL || c == DNULL).count();
					if nq & 1 != 0 {
						if t.lincmd != 0 && ts.contains(&b'=') {
							varq = true;
							lx.set_tok(LexTok::Envstring);
						} else {
							lx.set_tok(LexTok::String);
						}
					}
				} else if lx.tok() == LexTok::Envstring {
					varq = false;
				}
				let tok = lx.tok();
				if tok == LexTok::Envarray {
					t.linarr = 1;
					t.varname = lx.tokstr().map(BString::from);
				} else if tok == LexTok::Inpar {
					parct += 1;
				} else if tok == LexTok::Outpar {
					if parct != 0 {
						parct -= 1;
					} else if t.linarr != 0 {
						t.linarr = 0;
						lx.set_incmdpos(true);
					}
				}
				if lx.inredir() && tok.is_redirop() {
					rdop.clear();
					if lx.tokfd() >= 0 {
						rdop.extend_from_slice(lx.tokfd().to_string().as_bytes());
					}
					rdop.extend_from_slice(tokstring(tok).unwrap_or_default());
					t.rdstr = Some(BString::from(rdop.clone()));
					if wordpos == redirpos {
						redirpos += 1;
					}
					let inbufct = lx.inbufct();
					let z = lx.z_mut();
					if z.zlemetacs < z.zlemetall - inbufct && z.zlemetacs >= z.wordbeg && z.wb == z.we {
						z.we = z.zlemetall - (inbufct + z.addedx);
						if z.addedx != 0 && z.we > z.wb {
							z.wb += 1;
						} else {
							z.wb = z.zlemetacs;
						}
					}
				}
				if tok == LexTok::Dinpar {
					lx.set_tokstr(None);
				}
				if tok == LexTok::Endinput {
					break 'lex;
				}
				let incmdpos = lx.incmdpos();
				let incond = lx.incond() != 0;
				if (ins != 0 && matches!(tok, LexTok::Doloop | LexTok::Seper))
					|| (ins == 2 && wordpos == 2)
					|| (ins == 3 && wordpos == 3)
					|| matches!(tok, LexTok::Bar | LexTok::Amper | LexTok::Baramp | LexTok::Amperbang)
					|| (matches!(tok, LexTok::Dbar | LexTok::Damper) && !incond)
					|| (tt.is_some() && incmdpos)
				{
					if tt.is_some() {
						break 'lex;
					}
					if ins < 2 {
						noword = true;
					}
					wordpos = 0;
					cp = 0;
					rd = 0;
					ins = 0;
					redirpos = 0;
					tt0 = None;
				}
				if t.lincmd != 0
					&& matches!(
						tok,
						LexTok::String
							| LexTok::For
							| LexTok::Foreach
							| LexTok::Select
							| LexTok::Repeat
							| LexTok::Case
							| LexTok::Typeset
					) {
					ins = if tok == LexTok::Repeat {
						2
					} else {
						i32::from(tok != LexTok::String && tok != LexTok::Typeset)
					};
					t.cmdstr = lx.tokstr().map(BString::from);
					cmdtok = Some(tok);
					if wordpos != redirpos && t.clwpos == -1 {
						wordpos = 0;
						redirpos = 0;
					}
				} else if tok == LexTok::Seper {
					ins = i32::from(cmdtok != Some(LexTok::String) && cmdtok != Some(LexTok::Typeset));
				}
				if lx.lexflags() == 0 && tt0.is_none() {
					tt = lx.tokstr().map(<[u8]>::to_vec);
					let (zwb, zwe) = (lx.z().wb, lx.z().we);
					// Backslash-newlines the lexer removed from the word.
					let (mut i, mut j, mut k) = (0, 0, 0);
					let mut u = ix(i64::from(zwb));
					while (u as i64) < i64::from(zwe) {
						let ch = at(&zl, u);
						if ch == b'`' && k & 1 == 0 {
							i += 1;
						} else if ch == b'"' && k & 1 == 0 && i & 1 == 0 {
							j += 1;
						} else if ch == b'\'' && j & 1 == 0 {
							k += 1;
						} else if ch == b'\\' && at(&zl, u + 1) != 0 && k & 1 == 0 {
							if at(&zl, u + 1) == b'\n' {
								qsub += 2;
							}
							u += 1;
						}
						u += 1;
					}
					// RC_QUOTES pairs the lexer turned into one quote.
					if o.rcquotes
						&& let Some(ttv) = tt.as_ref()
					{
						let e = i64::from(cs) - i64::from(zwb) - i64::from(qsub);
						for (t1, &c1) in ttv.iter().enumerate() {
							if c1 == SNULL {
								let mut p = t1;
								while p < ttv.len() && (p as i64) < e {
									if ttv[p] == b'\'' {
										qsub += 1;
									}
									p += 1;
								}
							}
						}
					}
					if addedx != 0
						&& let Some(ttv) = tt.as_mut()
					{
						chuck(ttv, i64::from(cs) - i64::from(zwb) - i64::from(qsub));
					}
					tt0 = Some(tok);
					t.clwpos = wordpos;
					cp = t.lincmd;
					rd = t.linredir;
					ia = t.linarr;
					if lx.z().inwhat == IN_NOTHING && incond {
						lx.z_mut().inwhat = IN_COND;
					}
				} else if t.linredir != 0 {
					if !rdop.is_empty()
						&& let Some(ts) = lx.tokstr()
					{
						let mut r = rdop.clone();
						r.push(b':');
						r.extend_from_slice(ts);
						t.rdstrs.push(BString::from(r));
					}
					break 'body;
				}
				if incond {
					if tok == LexTok::Dbar {
						lx.set_tokstr(Some(&b"||"[..]));
					} else if tok == LexTok::Damper {
						lx.set_tokstr(Some(&b"&&"[..]));
					}
				}
				let Some(ts) = lx.tokstr().map(<[u8]>::to_vec) else {
					break 'body;
				};
				if noword {
					break 'body;
				}
				if oins == 2 && wordpos == 0 && ts == b"do" {
					ins = 3;
				}
				let wp = ix(i64::from(wordpos));
				if words.len() <= wp {
					words.resize(wp + 1, None);
				}
				let mut w = ts;
				let mut sl = w.len();
				while sl > 0
					&& w[sl - 1] == b' '
					&& (sl < 2 || (w[sl - 2] != BNULL && w[sl - 2] != META))
				{
					sl -= 1;
					w.truncate(sl);
				}
				let cur = t.clwpos == wordpos;
				wordpos += 1;
				if cur && addedx != 0 {
					zlemetacs_qsub = cs - qsub;
					let word_diff = zlemetacs_qsub - lx.z().wb;
					let chuck_at = if word_diff >= sl as i32 {
						sl as i64 - 1
					} else if word_diff < 0 {
						0
					} else {
						i64::from(word_diff)
					};
					chuck(&mut w, chuck_at);
				}
				words[wp] = Some(w);
			}
			let tok = lx.tok();
			if tok == LexTok::Lexerr
				|| tok == LexTok::Endinput
				|| (tok == LexTok::Seper && !(lx.lexflags() != 0 && tt0.is_none()))
			{
				break;
			}
		}
		t.clwnum = if tt.is_some() || wordpos == 0 {
			wordpos
		} else {
			wordpos - 1
		};
		let cn = ix(i64::from(t.clwnum));
		if words.len() <= cn {
			words.resize(cn + 1, None);
		}
		words[cn] = None;
		let mut t0 = tt0;
		let z = *lx.z();
		wb = z.wb;
		we = z.we;
		inwhat = z.inwhat;
		if ia != 0 {
			t.lincmd = 0;
			t.linredir = 0;
			inwhat = IN_ENV;
		} else {
			t.lincmd = cp;
			t.linredir = rd;
		}
		drop(lx);
		if z.parbegin != -1 {
			// In a command or process substitution (not `$((…))`): lex
			// again from inside it.
			if z.parend >= 0 && tmp.is_none() {
				tmp = Some(zl.clone());
			}
			let lp = i64::from(ll) + i64::from(addedx) - i64::from(z.parbegin) + 1;
			if lp < 3
				|| at(&zl, ix(lp)) != b'('
				|| at(&zl, ix(lp - 1)) != b'('
				|| at(&zl, ix(lp - 2)) != b'$'
			{
				linptr = ix(lp);
				if z.parend >= 0 {
					ll -= z.parend;
					zl.truncate(ix(i64::from(ll) + i64::from(addedx)));
				}
				tt = None;
				continue 'start;
			}
		}

		let s: Option<Vec<u8>>;
		if inwhat == IN_MATH {
			s = None;
		} else if t0.is_none() || t0 == Some(LexTok::Endinput) {
			s = Some(Vec::new());
			we = cs;
			wb = cs;
			t.clwpos = t.clwnum;
			t0 = Some(LexTok::String);
		} else if matches!(t0, Some(LexTok::String | LexTok::Typeset)) {
			s = Some(
				words
					.get(ix(i64::from(t.clwpos)))
					.cloned()
					.flatten()
					.unwrap_or_default(),
			);
		} else if t0 == Some(LexTok::Envstring) {
			if varq {
				tt = words.get(ix(i64::from(t.clwpos))).cloned().flatten();
			}
			let ttv = tt.clone().unwrap_or_default();
			let mut si = ident_end(&ttv, 0, false);
			let name = ttv[..si].to_vec();
			t.varname = Some(BString::from(name.clone()));
			if at(&ttv, si) == b'+' {
				si += 1;
			}
			let lev = skipparens(INBRACK, OUTBRACK, &ttv, &mut si);
			if lev > 0 || (si as i64) > i64::from(zlemetacs_qsub) - i64::from(wb) {
				s = None;
				inwhat = IN_MATH;
				let kp = param(&name);
				t.keypm = kp.map(|_| BString::from(name.clone()));
				t.insubscr = if kp == Some(true) { 2 } else { 1 };
			} else if at(&ttv, si) == b'=' {
				if i64::from(zlemetacs_qsub) > i64::from(wb) + si as i64 {
					si += 1;
					wb += si as i32;
					s = Some(ttv[si.min(ttv.len())..].to_vec());
					inwhat = IN_ENV;
				} else {
					let mut p = si;
					if p > 0 && ttv[p - 1] == b'+' {
						p -= 1;
					}
					inwhat = IN_PAR;
					s = Some(ttv[..p].to_vec());
					we = wb + p as i32;
				}
				t0 = Some(LexTok::String);
			} else {
				s = None;
			}
			t.lincmd = 1;
		} else {
			s = None;
		}
		if we > ll {
			we = ll;
		}
		let restored = tmp.clone().unwrap_or_else(|| zl.clone());
		let lexed = std::mem::replace(&mut zl, restored);
		ll = i32::try_from(zl.len()).unwrap_or(i32::MAX);
		if !matches!(t0, Some(LexTok::String | LexTok::Typeset)) && inwhat != IN_MATH {
			if tmp.is_some() {
				// Try again without the `x`.
				tt = Some(lexed);
				tmp = None;
				linptr = 0;
				addedx = 0;
				continue 'start;
			}
			t.addedx = addedx;
			t.inwhat = inwhat;
			return None;
		}
		break s;
	};
	t.addedx = addedx;
	let mut s = s;

	// Subscripts: inside brackets is taken as arithmetic.
	if inwhat != IN_MATH {
		let sv = s.clone().unwrap_or_default();
		let lim = i64::from(zlemetacs_qsub) - i64::from(wb);
		let mut i = 0;
		let mut nnb = if ident_once(&sv, 0) == 0 {
			mb_metacharlen(&sv, 0)
		} else {
			0
		};
		let (mut nb, mut ne): (Option<usize>, Option<usize>) = (None, None);
		let mut tp = 0usize;
		if t.lincmd != 0 {
			while at(&sv, tp) == INBRACK && (tp as i64) < lim {
				tp += 1;
			}
		}
		while (tp as i64) < lim {
			if at(&sv, tp) == INBRACK {
				i += 1;
				nb = Some(nnb);
				ne = Some(tp);
				tp += 1;
			} else if i > 0 && at(&sv, tp) == OUTBRACK {
				i -= 1;
				tp += 1;
			} else {
				let nclen = mb_metacharlen(&sv, tp);
				if ident_once(&sv, tp) == tp {
					nnb = tp + nclen;
				}
				tp += nclen;
			}
		}
		if i > 0 {
			inwhat = IN_MATH;
			t.insubscr = 1;
			if let (Some(b), Some(e)) = (nb, ne)
				&& b < e
			{
				let name = sv[b..e.min(sv.len())].to_vec();
				t.varname = Some(BString::from(name.clone()));
				let kp = param(&name);
				t.keypm = kp.map(|_| BString::from(name));
				if kp == Some(true) {
					t.insubscr = 2;
				}
			}
		}
	}
	if inwhat == IN_MATH {
		if compfunc || t.insubscr == 2 {
			let mut lev = 0;
			wb = cs - 1;
			while wb > 0 {
				let ch = at(&zl, ix(i64::from(wb)));
				if ch == b']' || ch == b')' {
					lev += 1;
				} else if ch == b'[' {
					if lev == 0 {
						break;
					}
					lev -= 1;
				} else if ch == b'(' {
					if lev == 0 && at(&zl, ix(i64::from(wb) - 1)) == b'(' {
						break;
					}
					if lev != 0 {
						lev -= 1;
					}
				}
				wb -= 1;
			}
			let mut p = ix(i64::from(wb));
			wb += 1;
			let pc = at(&zl, p);
			if wb != 0 && (pc == b'[' || pc == b'(') {
				let close = if pc == b'[' { b']' } else { b')' };
				if skipparens(pc, close, &zl, &mut p) == 0 {
					we = p as i32 - 1;
					if t.insubscr == 2 {
						t.insubscr = 3;
					}
				}
			}
		} else {
			// Arithmetic: complete the parameter name around the cursor.
			let cspos = ix(i64::from(cs));
			we = ident_end(&zl, cspos, false) as i32;
			let mut wptr = 0usize;
			loop {
				let mut cptr = ident_end(&zl, wptr, false);
				if cptr == wptr {
					cptr += mb_metacharlen(&zl, cptr);
					wptr = cptr;
				}
				if cptr >= cspos {
					wb = wptr as i32;
					break;
				}
				wptr = cptr;
			}
		}
		let (b, e) = (ix(i64::from(wb)).min(zl.len()), ix(i64::from(we)).min(zl.len()));
		let mut sv = zl[b..e.max(b)].to_vec();
		if wb > 2 && at(&zl, ix(i64::from(wb) - 1)) == b'[' {
			let sqbr = ix(i64::from(wb) - 1);
			let mut wptr = 0usize;
			loop {
				let mut cptr = ident_end(&zl, wptr, false);
				if cptr == wptr {
					cptr += mb_metacharlen(&zl, cptr);
					wptr = cptr;
				}
				if cptr >= sqbr {
					break;
				}
				wptr = cptr;
			}
			if wptr < sqbr {
				let name = zl[wptr..sqbr].to_vec();
				t.varname = Some(BString::from(name.clone()));
				let kp = param(&name);
				t.keypm = kp.map(|_| BString::from(name));
				if kp == Some(true) {
					if t.insubscr != 3 {
						t.insubscr = 2;
					}
				} else {
					t.insubscr = 1;
				}
			}
		}
		parse_subst_string_inplace(&mut sv);
		s = Some(sv);
	}
	let mut s = s.unwrap_or_default();
	t.inwhat = inwhat;

	// The current word in quoted form.
	let mut offs = cs - wb;
	if parambeg(&s, offs).is_some() {
		for b in &mut s {
			if *b == DNULL {
				*b = b'"';
			} else if *b == SNULL {
				*b = b'\'';
			}
		}
	} else {
		let mut level = 0;
		let mut p = 0;
		while p < s.len() {
			if level != 0 && s[p] == SNULL {
				s[p] = b'\'';
			} else if level != 0 && s[p] == DNULL {
				s[p] = b'"';
			} else if is_str(s[p]) && at(&s, p + 1) == INBRACE {
				level += 1;
			} else if s[p] == OUTBRACE {
				level -= 1;
			}
			p += 1;
		}
	}
	let s0 = at(&s, 0);
	if (s0 == SNULL || s0 == DNULL || (is_str(s0) && at(&s, 1) == SNULL))
		&& !has_real_token(&s[1.min(s.len())..])
	{
		let mut sl = s.len();
		let mut qtptr = 0;
		let q: &[u8] = match s0 {
			SNULL => {
				t.instring = i32::from(qt::SINGLE);
				b"'"
			},
			DNULL => {
				t.instring = i32::from(qt::DOUBLE);
				b"\""
			},
			_ => {
				t.instring = i32::from(qt::DOLLARS);
				qtptr = 1;
				sl -= 1;
				b"$'"
			},
		};
		let mut n = t.qipre.take().unwrap_or_default();
		n.extend_from_slice(q);
		t.qipre = Some(n);
		let q = if q[0] == b'$' { &q[1..] } else { q };
		if sl > 1 && at(&s, qtptr + sl - 1) == at(&s, qtptr) {
			let mut n = BString::from(q);
			if let Some(old) = &t.qisuf {
				n.extend_from_slice(old);
			}
			t.qisuf = Some(n);
		}
		t.autoq = Some(BString::from(q));
		if t.instring == i32::from(qt::DOUBLE) {
			for p in 0..s.len() {
				if s[p] == b'\\' && at(&s, p + 1) == b'!' {
					s[p] = BNULL;
				}
			}
		}
	}
	if at(&s, 0) == EQUALS && !o.equals {
		s[0] = b'=';
	}

	// Build the quoted form and take the quotes off the line.
	{
		let mut p: i64 = 0;
		let mut i: i64 = i64::from(wb);
		let mut j = 0;
		let mut we64 = i64::from(we);
		let mut offs64 = i64::from(offs);
		let mut zcs = line.cs as i64;
		while (p as usize) < s.len() {
			let pu = p as usize;
			let c0 = s[pu];
			let mut skipchars: i64;
			if c0 == STRING && at(&s, pu + 1) == SNULL {
				let mut pe = pu + 2;
				while at(&s, pe) != 0 && s[pe] != SNULL && i + ((pe - pu) as i64) < zcs {
					pe += 1;
				}
				if at(&s, pe) == SNULL {
					let ks = getkeystring(&s[pu + 2..], getkey::DOLLARS_QUOTE);
					let len = ks.consumed as i64 + 2;
					let tlen = ks.text.len() as i64;
					skipchars = len - tlen;
					if skipchars >= 0 {
						s[pu..pu + ks.text.len()].copy_from_slice(&ks.text);
						let ocs = zcs;
						zcs = i;
						if skipchars > 0 {
							let from = pu + ks.text.len();
							s.drain(from..(from + skipchars as usize).min(s.len()));
							if i < ocs {
								offs64 -= skipchars;
							}
							line.cs = ix(zcs);
							line.foredel(skipchars as usize);
							zcs = ocs;
							if zcs > i {
								zcs -= skipchars;
							}
							we64 -= skipchars;
						}
						if let Some(l) = line.s.as_mut() {
							let at_i = ix(i);
							let end = (at_i + ks.text.len()).min(l.len());
							l[at_i.min(end)..end].copy_from_slice(&ks.text[..end - at_i.min(end)]);
						}
						p += tlen - 1;
						i += tlen - 1;
						p += 1;
						i += 1;
						continue;
					}
					skipchars = 2;
					j = 1;
				} else {
					skipchars = 2;
					if at(&s, pe) != 0 {
						j = 1;
					}
				}
			} else if c0 == QSTRING && at(&s, pu + 1) == SNULL {
				skipchars = 2;
			} else if is_null(c0) {
				skipchars = 1;
			} else {
				skipchars = 0;
			}
			if skipchars != 0 {
				if i < zcs {
					offs64 -= skipchars;
				}
				if c0 == SNULL && o.rcquotes {
					j = 1 - j;
				}
				if at(&s, pu + 1) != 0 || c0 != BNULL {
					if c0 == BNULL {
						if zcs == i + 1 {
							zcs += 1;
							offs64 += 1;
						}
					} else {
						let ocs = zcs;
						line.cs = ix(i);
						line.foredel(skipchars as usize);
						i -= 1;
						zcs = ocs;
						if zcs > i {
							zcs -= skipchars;
							if i64::from(wb) > zcs {
								zcs = i64::from(wb);
							}
						}
						we64 -= skipchars;
					}
				} else {
					let ocs = zcs;
					line.cs = ix(we64);
					line.backdel(skipchars as usize);
					zcs = if ocs == we64 { we64 - skipchars } else { ocs };
					if i64::from(wb) > zcs {
						zcs = i64::from(wb);
					}
					we64 -= skipchars;
				}
				for _ in 0..skipchars {
					chuck(&mut s, p);
				}
				p -= 1;
			} else if j != 0 && c0 == b'\'' && i < zcs {
				offs64 -= 1;
			}
			p += 1;
			i += 1;
		}
		line.cs = ix(zcs);
		we = i32::try_from(we64).unwrap_or(i32::MAX);
		offs = i32::try_from(offs64).unwrap_or(0);
	}

	t.origword = Some(BString::from(s.clone()));

	if !o.ignorebraces {
		braces(t, &mut s, &mut offs, o);
	}
	t.wb = wb;
	t.we = we;
	t.offs = offs;
	t.clwords = words
		.into_iter()
		.take(ix(i64::from(t.clwnum)))
		.map(|w| BString::from(w.unwrap_or_default()))
		.collect();
	Some(s)
}

/// `quotename` of `s` then `untokenize`d: a brace part's text.
fn brace_str(t: &State, s: &[u8], o: &CompStrOpts) -> BString {
	let mut v = quotename(t, s, o.quote);
	untokenize(&mut v);
	BString::from(v)
}

/// The brace part of `get_comp_string` (`foo{xxx` etc.): the opening
/// braces before the cursor (`brbeg`), the closing ones after it
/// (`brend`), taken out of the word.
#[allow(
	clippy::cognitive_complexity,
	clippy::too_many_lines,
	reason = "a direct port of zsh's get_comp_string"
)]
fn braces(t: &mut State, word: &mut Vec<u8>, offs: &mut i32, o: &CompStrOpts) {
	let owned = word.clone();
	let s: &[u8] = &owned;
	let curs: i64 = if o.completeinword {
		i64::from(*offs)
	} else {
		s.len() as i64
	};
	let mut predup = s.to_vec();
	let mut dp: i64 = 0;
	let (mut bbeg, mut bend, mut dbeg, mut lastp, mut firsts): (
		Option<i64>,
		i64,
		i64,
		Option<i64>,
		Option<i64>,
	) = (None, 0, 0, None, None);
	let mut cant = false;
	let mut begi: i64 = 0;
	let mut boffs = i64::from(*offs);
	let mut hascom = 0;
	let mut i: i64 = 0;
	let mut p: i64 = 0;

	// zsh's code to stack the text between `{` (or the last comma) and
	// the cursor: `adjust` is whether `i` and `dp` follow the cut.
	let push_beg =
		|t: &mut State, predup: &mut Vec<u8>, bb: i64, bend: i64, dbeg: i64, begi: i64| -> i64 {
			let len = bend - bb;
			let text = s_slice(s, bb, bb + len);
			let str = brace_str(t, &text, o);
			let qpos = quotename(t, &predup[..ix(dbeg).min(predup.len())], o.quote).len();
			t.brbeg.push(super::super::types::Brinfo {
				str,
				pos: i32::try_from(begi).unwrap_or(0),
				qpos: i32::try_from(qpos).unwrap_or(0),
				curpos: 0,
			});
			t.nbrbeg += 1;
			let a = ix(dbeg).min(predup.len());
			let b = ix(dbeg + len).min(predup.len());
			predup.drain(a..b);
			len
		};

	'scan: while (p as usize) < s.len() {
		let pu = p as usize;
		let ch = s[pu];
		'next: {
			if is_str(ch) {
				let n1 = at(s, pu + 1);
				if n1 == INBRACE || n1 == INPAR || n1 == INBRACK {
					let mut tp = pu + 1;
					let close = if n1 == INBRACE {
						OUTBRACE
					} else if n1 == INPAR {
						OUTPAR
					} else {
						OUTBRACK
					};
					if skipparens(n1, close, s, &mut tp) != 0 {
						break 'scan;
					}
					i += tp as i64 - p;
					dp += tp as i64 - p;
					p = tp as i64;
				} else if n1 != SNULL {
					let mut tp = pu + 1;
					while matches!(
						at(s, tp),
						b'^' | HAT | b'=' | EQUALS | b'~' | TILDE | b'#' | POUND | b'+'
					) {
						tp += 1;
					}
					if matches!(
						at(s, tp),
						QUEST | STAR | STRING | QSTRING | b'?' | b'*' | b'$' | b'-' | b'!' | b'@'
					) {
						p += 1;
						i += 1;
					} else {
						if at(s, tp).is_ascii_digit() {
							while at(s, tp).is_ascii_digit() {
								tp += 1;
							}
						} else {
							let ie = ident_end(s, tp, false);
							if ie == tp {
								break 'scan;
							}
							tp = ie;
						}
						if at(s, tp) == INBRACE {
							cant = true;
							break 'scan;
						}
						tp -= 1;
						i += tp as i64 - p;
						dp += tp as i64 - p;
						p = tp as i64;
					}
				}
			} else if p < curs {
				if ch == OUTBRACE {
					cant = true;
					break 'scan;
				}
				if ch == INBRACE {
					let mut tp = pu;
					if skipparens(INBRACE, OUTBRACE, s, &mut tp) == 0 {
						i += tp as i64 - p - 1;
						dp += tp as i64 - p - 1;
						p = tp as i64 - 1;
						break 'next;
					}
					t.commaspecial = true;
					if let Some(bb) = bbeg {
						let len = push_beg(t, &mut predup, bb, bend, dbeg, begi);
						i -= len;
						boffs -= len;
						dp -= len;
					}
					bbeg = Some(p);
					lastp = Some(p);
					dbeg = dp;
					bend = p + 1;
					begi = i;
				} else if ch == COMMA && bbeg.is_some() {
					bend = p + 1;
					hascom = 1;
				}
			} else {
				if ch == INBRACE {
					let mut tp = pu;
					if skipparens(INBRACE, OUTBRACE, s, &mut tp) == 0 {
						i += tp as i64 - p - 1;
						dp += tp as i64 - p - 1;
						p = tp as i64 - 1;
						break 'next;
					}
					cant = true;
					t.commaspecial = true;
					break 'scan;
				}
				if p == curs {
					if let Some(bb) = bbeg {
						let len = push_beg(t, &mut predup, bb, bend, dbeg, begi);
						i -= len;
						boffs -= len;
						dp -= len;
					}
					bbeg = None;
				}
				if ch == COMMA {
					if bbeg.is_none() {
						bbeg = Some(p);
					}
					hascom = 2;
				} else if ch == OUTBRACE {
					let bb = bbeg.unwrap_or(p);
					let len = p + 1 - bb;
					if firsts.is_none() {
						firsts = Some(p + 1);
					}
					let text = s_slice(s, bb, bb + len);
					let str = brace_str(t, &text, o);
					t.nbrend += 1;
					t.brend.insert(0, super::super::types::Brinfo {
						str,
						pos: i32::try_from(dp - len + 1).unwrap_or(0),
						qpos: i32::try_from(len).unwrap_or(0),
						curpos: 0,
					});
					bbeg = None;
				}
			}
		}
		p += 1;
		dp += 1;
		i += 1;
	}
	if cant {
		t.brbeg.clear();
		t.brend.clear();
		t.nbrbeg = 0;
		t.nbrend = 0;
		return;
	}
	if p == curs
		&& let Some(bb) = bbeg
	{
		let len = push_beg(t, &mut predup, bb, bend, dbeg, begi);
		boffs -= len;
	}
	for k in 0..t.brend.len() {
		let (p0, l) = (ix(i64::from(t.brend[k].pos)), ix(i64::from(t.brend[k].qpos)));
		let from = (p0 + l).min(predup.len());
		let rest = predup[from..].to_vec();
		t.brend[k].pos = i32::try_from(rest.len()).unwrap_or(0);
		t.brend[k].qpos = i32::try_from(quotename(t, &rest, o.quote).len()).unwrap_or(0);
		predup.drain(p0.min(from)..from);
	}
	if hascom != 0 {
		if let Some(lp) = lastp {
			let mut v = s_slice(s, 0, lp);
			untokenize(&mut v);
			t.lastprebr = Some(BString::from(v));
		}
		t.lastpostbr = firsts.map(|f| {
			let mut v = s_slice(s, f, s.len() as i64);
			untokenize(&mut v);
			BString::from(v)
		});
	}
	*word = predup;
	*offs = i32::try_from(boffs).unwrap_or(0);
}

/// `s[a..b]` with C-pointer clamping.
fn s_slice(s: &[u8], a: i64, b: i64) -> Vec<u8> {
	let a = ix(a).min(s.len());
	let b = ix(b).min(s.len());
	s[a..b.max(a)].to_vec()
}

/// zsh `parse_subst_string` on `s` in place (tokenized as unquoted word
/// text; `$'…'` decoded), left untokenized when the lexer fails.
pub fn parse_subst_string_inplace(s: &mut Vec<u8>) {
	if s.is_empty() || s.as_slice() == [crate::bash::syntax::zsh::tok::NULARG] {
		return;
	}
	match crate::bash::syntax::zsh::parse_subst_string(s) {
		Err(_) => untokenize(s),
		Ok(toks) => {
			*s = toks;
			let mut p = 0;
			while p < s.len() {
				if s[p] == STRING && at(s, p + 1) == SNULL {
					let ks = getkeystring(&s[p + 2..], getkey::DOLLARS_QUOTE);
					let len = ks.consumed + 2;
					let tlen = ks.text.len();
					if len < tlen {
						return;
					}
					s[p..p + tlen].copy_from_slice(&ks.text);
					s.drain(p + tlen..(p + len).min(s.len()));
					p += tlen;
				} else {
					p += 1;
				}
			}
		},
	}
}
