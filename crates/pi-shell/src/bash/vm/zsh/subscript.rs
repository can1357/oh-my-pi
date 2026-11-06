//! zsh subscripts: a port of zsh 5.9's `params.c`
//! `getindex` and `getarg`: `[n]`, `[a,b]` ranges, negative indices,
//! character subscripts of scalars, association keys, and the subscript
//! flags `(i I r R k K w f s:sep: p e n:N: b:N:)`, with `ksharrays` and
//! `kshzerosubscript`.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::sync::Arc;

use bstr::BString;

use super::{
	arith,
	params::{
		self, HashElem, PValue, PmFlags, SCANPM_ARRONLY, SCANPM_CHECKING, SCANPM_DQUOTED,
		SCANPM_ISVAR_AT, SCANPM_KEYMATCH, SCANPM_MATCHKEY, SCANPM_MATCHMANY, SCANPM_MATCHVAL,
		SCANPM_WANTINDEX, SCANPM_WANTKEYS, SCANPM_WANTVALS, Scan, VALFLAG_EMPTY, VALFLAG_INV, Value,
	},
	subst, text, zpattern,
};
use crate::bash::{
	pattern::zsh::{PatFlags, Pattern},
	syntax::zsh::tok::{
		INBRACK, INPAR, OUTBRACK, OUTPAR, STAR, at, head, is_null, is_tok, span, tail, tok_char,
		unmetafy, untokenize,
	},
	vm::expand::{Expander, X},
	zshopt::ZshOpt,
};

/// zsh `parse_subscript` (lex.c) for a check only: the index in `s` of
/// the `endchar` that closes a subscript starting at `s[0]`.
pub fn parse_subscript_end(s: &[u8], sub: bool, endchar: u8) -> Option<usize> {
	crate::bash::syntax::zsh::parse_subscript(s, sub, endchar).map(|(_, e)| e)
}

/// zsh `get_strarg`: the delimited argument starting at `s[i]` (the
/// delimiter, a character under `mb`; brackets pair with their closers).
/// Returns the index of the closing delimiter (`s.len()` when missing)
/// and its length (0 then). The argument starts after the opening
/// delimiter, `text::charlen(s, i, mb)` bytes on.
pub fn get_strarg(s: &[u8], i: usize, mb: bool) -> (usize, usize) {
	if i >= s.len() {
		return (i, 0);
	}
	let (len, del) = text::delim_at(s, i, mb);
	let mut j = i + len;
	let ctok = match at(s, i) {
		INPAR => Some(OUTPAR),
		crate::bash::syntax::zsh::tok::INANG => Some(crate::bash::syntax::zsh::tok::OUTANG),
		crate::bash::syntax::zsh::tok::INBRACE => Some(crate::bash::syntax::zsh::tok::OUTBRACE),
		INBRACK => Some(OUTBRACK),
		_ => None,
	};
	if let Some(ct) = ctok {
		while j < s.len() && s[j] != ct {
			j += 1;
		}
		return (j, usize::from(j < s.len()));
	}
	let del = match char::from_u32(del) {
		Some('(') => u32::from(b')'),
		Some('[') => u32::from(b']'),
		Some('{') => u32::from(b'}'),
		Some('<') => u32::from(b'>'),
		_ => del,
	};
	while j < s.len() {
		let (l, d) = text::delim_at(s, j, mb);
		if d == del {
			return (j, l);
		}
		j += l.max(1);
	}
	(j, 0)
}

/// Results of [`getarg`] besides the index.
struct Arg {
	/// Inverse subscripting (`(i)`/`(I)`): the result is an index.
	inv:     bool,
	/// The end of a word found by `(w)` (0: none).
	w:       i64,
	/// Bytes of the character before the index position.
	prevlen: i64,
	/// Bytes of the character at the index position.
	nextlen: i64,
	/// Where the argument ended in the subscript text.
	end:     usize,
}

/// zsh `getindex`: parse the subscript at `s[*pos]` (`[` or `Inbrack`) and
/// narrow `v` to it (`start`/`end`, `isarr`, an association element);
/// `*pos` moves past the `]`.
///
/// # Errors
/// `invalid subscript`, math and pattern errors, a parked substitution.
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's getindex")]
pub fn getindex(
	ex: &mut Expander<'_, '_>,
	s: &[u8],
	pos: &mut usize,
	v: &mut Value,
	flags: u32,
) -> X<()> {
	let dq = flags & SCANPM_DQUOTED != 0;
	let mb = params::mb(ex)?;
	let body = tail(s, *pos + 1);
	let Some((tok, e)) = crate::bash::syntax::zsh::parse_subscript(body, dq, b']') else {
		return Err(params::bad_subscript("invalid subscript"));
	};
	// Untokenize everything except the null markers (and what they quote),
	// so `*` and `@` can be recognised.
	let mut sub: Vec<u8> = Vec::with_capacity(e);
	let mut i = 0;
	while i < e {
		let c = at(&tok, i);
		if is_null(c) {
			sub.push(c);
			if i + 1 < e {
				sub.push(at(&tok, i + 1));
			}
			i += 2;
			continue;
		}
		sub.push(if is_tok(c) {
			tok_char(c).unwrap_or(c)
		} else {
			c
		});
		i += 1;
	}
	*pos += 1 + e + 1;
	// Only a plain key is answered without the whole value.
	if v.pm.lazy && (sub == b"*" || sub == b"@" || sub.first() == Some(&b'(')) {
		v.pm.materialize(ex)?;
	}
	if sub == b"*" || sub == b"@" {
		if (v.isarr != 0 || is_unset_value(v)) && sub.first() == Some(&b'@') {
			v.isarr |= SCANPM_ISVAR_AT;
		}
		v.start = 0;
		v.end = -1;
		return Ok(());
	}
	let ksh = params::opt(ex, ZshOpt::Ksharrays)?;
	let mut at = 0;
	let a = getarg(ex, &sub, &mut at, v, false, flags)?;
	let mut start = a.start;
	if a.arg.inv {
		if v.isarr == 0 && start != 0 {
			let t = v.getstrvalue(ex)?;
			if start > 0 {
				// Byte offset back to a character position.
				let target = usize::try_from(start - a.arg.prevlen).unwrap_or(0);
				let mut nstart: i64 = 0;
				let mut p = 0;
				while p < t.len() {
					p += text::charlen(&t, p, mb);
					if p < target {
						nstart += 1;
					} else {
						if p == target {
							nstart += 1;
						} else {
							p = target;
						}
						break;
					}
				}
				start = nstart + i64::try_from(target).unwrap_or(0) - i64::try_from(p).unwrap_or(0) + 1;
			} else {
				let startoff = start + i64::try_from(t.len()).unwrap_or(0);
				if startoff < 0 {
					start = startoff;
				} else {
					let so = usize::try_from(startoff).unwrap_or(0);
					let mut p = 0;
					while p < so {
						p += text::charlen(&t, p, mb);
					}
					start =
						-i64::try_from(text::strlen_chars(tail(&t, p.min(t.len())), mb)).unwrap_or(0);
				}
			}
		}
		if start > 0 && (ksh || v.pm.flags.contains(PmFlags::HASHED)) {
			start -= 1;
		}
		if v.isarr != SCANPM_WANTINDEX {
			v.flags |= VALFLAG_INV;
			v.isarr = 0;
			v.start = start;
			v.end = start + 1;
		}
		if sub.get(a.arg.end) == Some(&b',') {
			return Err(params::bad_subscript("invalid subscript"));
		}
		return Ok(());
	}
	let mut com = sub.get(a.arg.end) == Some(&b',');
	let mut end = if com {
		let mut at2 = a.arg.end + 1;
		let b = getarg(ex, &sub, &mut at2, v, true, flags)?;
		at = b.arg.end;
		b.start
	} else {
		at = a.arg.end;
		if a.arg.w != 0 { a.arg.w } else { start }
	};
	if start != end {
		com = true;
	}
	if start > 0 {
		start -= a.arg.prevlen;
	} else if start == 0 && end == 0 {
		if params::opt(ex, ZshOpt::Kshzerosubscript)? {
			end = a.arg.nextlen;
		} else {
			v.flags |= VALFLAG_EMPTY;
			start = -1;
			com = true;
		}
	}
	if at >= sub.len() {
		if v.isarr != 0
			&& !com
			&& (v.isarr & SCANPM_MATCHMANY == 0
				|| v.isarr & (SCANPM_MATCHKEY | SCANPM_MATCHVAL | SCANPM_KEYMATCH) == 0)
		{
			v.isarr = 0;
		}
		v.start = start;
		v.end = end;
	}
	Ok(())
}

/// zsh `IS_UNSET_VALUE`.
const fn is_unset_value(v: &Value) -> bool {
	v.pm_flags().contains(PmFlags::UNSET)
}

/// A [`getarg`] result: the raw offset and the side results.
struct GetArg {
	start: i64,
	arg:   Arg,
}

/// The subscript flags of a [`getarg`] argument.
#[derive(Default)]
struct SubFlags {
	hasbeg:    bool,
	word:      bool,
	rev:       bool,
	ind:       bool,
	down:      bool,
	keymatch:  bool,
	quote_arg: bool,
	num:       i64,
	beg:       i64,
	sep:       Option<Vec<u8>>,
}

/// zsh `getarg`: one argument of a subscript, from `sub[*at]`, against
/// `v` (`a2`: the second of a range). Returns zsh's raw offset (an array
/// index, or a byte offset after the character into a scalar).
#[expect(clippy::too_many_lines, reason = "a faithful port of one C function")]
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's getarg")]
fn getarg(
	ex: &mut Expander<'_, '_>,
	sub: &[u8],
	at: &mut usize,
	v: &mut Value,
	a2: bool,
	flags: u32,
) -> X<GetArg> {
	let ishash = v.pm.flags.type_bits() == PmFlags::HASHED && v.elem.is_none();
	let mb = params::mb(ex)?;
	let mut f = SubFlags { num: 1, ..SubFlags::default() };
	let mut arg = Arg { inv: false, w: 0, prevlen: 1, nextlen: 1, end: *at };
	let mut s = *at;
	if matches!(sub.get(s), Some(&(b'(' | INPAR))) {
		let mut escapes = false;
		let mut k = s + 1;
		let mut ok = true;
		while k < sub.len() && !matches!(sub[k], b')' | OUTPAR) {
			match sub[k] {
				b'r' => {
					f.rev = true;
					f.keymatch = false;
					f.down = false;
					f.ind = false;
				},
				b'R' => {
					f.rev = true;
					f.down = true;
					f.keymatch = false;
					f.ind = false;
				},
				b'k' => {
					f.keymatch = ishash;
					f.rev = true;
					f.down = false;
					f.ind = false;
				},
				b'K' => {
					f.keymatch = ishash;
					f.rev = true;
					f.down = true;
					f.ind = false;
				},
				b'i' => {
					f.rev = true;
					f.ind = true;
					f.down = false;
					f.keymatch = false;
				},
				b'I' => {
					f.rev = true;
					f.ind = true;
					f.down = true;
					f.keymatch = false;
				},
				b'w' => f.word = true,
				b'f' => {
					f.word = true;
					f.sep = Some(b"\n".to_vec());
				},
				b'e' => f.quote_arg = true,
				b'p' => escapes = true,
				b'n' | b'b' | b's' => {
					let which = sub.get(k).copied().unwrap_or(0);
					let (t, arglen) = get_strarg(sub, k + 1, mb);
					if t >= sub.len() || arglen == 0 {
						ok = false;
						break;
					}
					let start = k + 1 + text::charlen(sub, k + 1, mb);
					let body = span(sub, start.min(t), t);
					match which {
						b'n' => {
							let n = arith::mathevali(ex, body)?;
							f.num = if n == 0 { 1 } else { n };
						},
						b'b' => {
							f.hasbeg = true;
							let b = arith::mathevali(ex, body)?;
							f.beg = if b > 0 { b - 1 } else { b };
						},
						_ => {
							f.sep = Some(if escapes {
								text::getkeystring(body, text::getkey::SEP).text
							} else {
								body.to_vec()
							});
						},
					}
					k = t + arglen - 1;
				},
				_ => {
					ok = false;
					break;
				},
			}
			k += 1;
		}
		if ok && k < sub.len() {
			s = k + 1;
		} else {
			f = SubFlags { num: 1, ..SubFlags::default() };
		}
	}
	if f.num < 0 {
		f.down = !f.down;
		f.num = -f.num;
	}
	if v.isarr & SCANPM_WANTKEYS != 0 {
		arg.inv = f.ind || v.isarr & SCANPM_WANTVALS == 0;
	} else if v.isarr & SCANPM_WANTVALS != 0 {
		arg.inv = false;
	} else {
		if v.isarr != 0 {
			if f.ind {
				v.isarr |= SCANPM_WANTKEYS;
				v.isarr &= !SCANPM_WANTVALS;
			} else if f.rev {
				v.isarr |= SCANPM_WANTVALS;
			}
			if !f.down && f.keymatch && ishash {
				v.isarr &= !SCANPM_MATCHMANY;
			}
		}
		arg.inv = f.ind;
	}
	// Find the end of the argument.
	let mut t = s;
	let mut depth = 0i32;
	let mut inpar = 0i32;
	let mut needtok = false;
	let mut text: Vec<u8> = Vec::with_capacity(sub.len() - s);
	while t < sub.len() {
		let c = sub[t];
		if depth == 0 && inpar == 0 && !ishash && c == b',' {
			break;
		}
		if is_null(c) {
			let n = sub.get(t + 1).copied().unwrap_or(0);
			if matches!(n, b'[' | b']' | b'(' | b')' | b'{' | b'}') {
				text.push(if ishash && depth > 0 {
					tok_char(c).unwrap_or(c)
				} else {
					c
				});
				needtok = true;
				t += 1;
				text.push(n);
			} else if n != b'"' {
				text.push(tok_char(c).unwrap_or(c));
			} else {
				text.push(c);
			}
			t += 1;
			continue;
		}
		match c {
			b'[' | INBRACK => depth += 1,
			b']' | OUTBRACK => depth -= 1,
			b'(' | INPAR => inpar += 1,
			b')' | OUTPAR => inpar -= 1,
			_ => {},
		}
		if text::ispecial(c) {
			needtok = true;
		}
		text.push(c);
		t += 1;
	}
	arg.end = t;
	*at = t;
	if !params::opt(ex, ZshOpt::Exec)? {
		return Ok(GetArg { start: 0, arg });
	}
	let mut s: Vec<u8> = text;
	if ishash && (f.keymatch || !f.rev) {
		crate::bash::pattern::zsh::remnulargs(&mut s);
	}
	if needtok {
		s = match crate::bash::syntax::zsh::parsestr(&s) {
			Ok(p) => p,
			Err(_) => return Ok(GetArg { start: 0, arg }),
		};
		s = subst::singsub(ex, s)?;
	} else if f.rev {
		crate::bash::pattern::zsh::remnulargs(&mut s);
	}
	let ksh = params::opt(ex, ZshOpt::Ksharrays)?;
	let mut r: i64;
	if !f.rev {
		if ishash {
			if flags & SCANPM_CHECKING != 0 && !matches!(v.pm.value, PValue::Hash(_)) {
				return Ok(GetArg { start: 0, arg });
			}
			untokenize(&mut s);
			let key = BString::from(unmetafy(&s));
			let value = match v.pm.special {
				// A keyed special's `getnode`: that one entry.
				Some(sp) if sp.keyed() => super::specials::get_elem(ex, sp, &key)?,
				_ => match &v.pm.value {
					PValue::Hash(h) => h.iter().find(|e| e.0 == key).map(|e| e.1.clone()),
					_ => None,
				},
			};
			v.elem = Some(HashElem { key, value });
			v.isarr = if arg.inv { SCANPM_WANTINDEX } else { 0 };
			v.start = 0;
			arg.inv = false;
			arg.w = -1;
			v.end = -1;
			return Ok(GetArg { start: i64::from(ksh), arg });
		}
		r = arith::mathevalarg(ex, &s)?.0;
		if ksh && r >= 0 {
			r += 1;
		}
		if f.word && v.isarr == 0 {
			let st = v.getstrvalue(ex)?;
			let seps = params::seps(ex)?;
			let sep = f.sep.as_deref();
			let n = i64::try_from(text::wordcount(&seps, &st, sep, 0)).unwrap_or(0);
			if r < 0 {
				r += n + 1;
			}
			r = r.clamp(1, n.max(1));
			if st.is_empty() {
				return Ok(GetArg { start: 0, arg });
			}
			let mut p = 0;
			let mut d = None;
			let mut left = r;
			while left > 0 {
				d = text::findword(&seps, &st, &mut p, sep);
				if d.is_none() {
					break;
				}
				left -= 1;
			}
			let Some(d) = d else {
				return Ok(GetArg { start: 0, arg });
			};
			if !a2 && sub.get(arg.end) != Some(&b',') {
				arg.w = i64::try_from(p).unwrap_or(0);
			}
			let off = if a2 { p } else { d + 1 };
			return Ok(GetArg { start: i64::try_from(off).unwrap_or(0), arg });
		} else if v.isarr == 0 && !f.word {
			let st = v.getstrvalue(ex)?;
			match r.cmp(&0) {
				std::cmp::Ordering::Greater => {
					let mut nchars = r;
					let mut t = 0;
					let mut lastlen = 1;
					while nchars > 0 && t < st.len() {
						lastlen = text::charlen(&st, t, mb);
						t += lastlen;
						nchars -= 1;
					}
					r = i64::try_from(t).unwrap_or(0) + nchars;
					if nchars == 0 {
						arg.prevlen = i64::try_from(lastlen).unwrap_or(1);
					}
					if t < st.len() {
						arg.nextlen = i64::try_from(text::charlen(&st, t, mb)).unwrap_or(1);
					}
				},
				std::cmp::Ordering::Equal => {
					arg.prevlen = 0;
					if !st.is_empty() {
						arg.nextlen = i64::try_from(text::charlen(&st, 0, mb)).unwrap_or(1);
					}
				},
				std::cmp::Ordering::Less => {
					let nchars = i64::try_from(text::strlen_chars(&st, mb)).unwrap_or(0) + r;
					if nchars < 0 {
						r -= i64::try_from(st.len()).unwrap_or(0);
					} else {
						let mut t = 0;
						let mut lastlen = 1;
						for _ in 0..nchars {
							if t >= st.len() {
								break;
							}
							lastlen = text::charlen(&st, t, mb);
							t += lastlen;
						}
						r = -i64::try_from(st.len() - t.min(st.len())).unwrap_or(0);
						arg.prevlen = i64::try_from(lastlen).unwrap_or(1);
						if t < st.len() {
							arg.nextlen = i64::try_from(text::charlen(&st, t, mb)).unwrap_or(1);
						}
					}
				},
			}
		}
		return Ok(GetArg { start: r, arg });
	}
	// Reverse subscripting: pattern matching.
	if v.isarr == 0 && !f.word && !f.quote_arg {
		let l = s.len();
		if a2 {
			if l == 0 || s[0] != b'*' {
				s.insert(0, b'*');
			}
		} else if l == 0 || s[l - 1] != b'*' || (l > 1 && s[l - 2] == b'\\') {
			s.push(b'*');
		}
	}
	let pprog: Option<Arc<Pattern>> = if f.keymatch {
		None
	} else {
		if f.quote_arg {
			untokenize(&mut s);
			if v.isarr == 0 && !f.word {
				if a2 {
					s.insert(0, STAR);
				} else {
					s.push(STAR);
				}
			}
		} else {
			crate::bash::pattern::zsh::tokenize(&mut s);
		}
		crate::bash::pattern::zsh::remnulargs(&mut s);
		// A malformed pattern matches nothing (zsh `patcompile` → NULL).
		zpattern::try_compile(ex, &s, PatFlags::NONE)?
	};
	let env = zpattern::char_env(ex)?;
	let env = env.env();
	let tries =
		|p: &Option<Arc<Pattern>>, subj: &[u8]| p.as_ref().is_some_and(|p| p.matches(subj, &env));
	let num = f.num;
	let down = f.down;
	let hasbeg = f.hasbeg;
	let mut beg = f.beg;
	if v.isarr != 0 {
		let ta = if ishash {
			v.scan = Some(Scan { prog: pprog.clone(), text: s.clone() });
			if f.keymatch {
				v.isarr |= SCANPM_KEYMATCH;
			} else {
				if pprog.is_none() {
					return Ok(GetArg { start: 1, arg });
				}
				v.isarr |= if f.ind {
					SCANPM_MATCHKEY
				} else {
					SCANPM_MATCHVAL
				};
			}
			if down {
				v.isarr |= SCANPM_MATCHMANY;
			}
			let mut probe = v.clone();
			probe.start = 0;
			probe.end = -1;
			let ta = probe.getarrvalue(ex)?;
			*v = probe;
			if !ta.is_empty()
				|| (v.isarr & SCANPM_MATCHMANY != 0
					&& v.isarr & (SCANPM_MATCHKEY | SCANPM_MATCHVAL | SCANPM_KEYMATCH) != 0)
			{
				arg.inv = v.flags & VALFLAG_INV != 0;
				arg.w = i64::try_from(ta.len()).unwrap_or(0) + 1;
				v.start = 0;
				v.end = arg.w;
				return Ok(GetArg { start: 1, arg });
			}
			ta
		} else {
			let mut probe = v.clone();
			probe.start = 0;
			probe.end = -1;
			probe.getarrvalue(ex)?
		};
		if ta.is_empty() {
			return Ok(GetArg { start: i64::from(!down), arg });
		}
		let len = i64::try_from(ta.len()).unwrap_or(0);
		if beg < 0 {
			beg += len;
		}
		if down {
			if beg < 0 {
				return Ok(GetArg { start: 0, arg });
			}
		} else if beg >= len {
			return Ok(GetArg { start: len + 1, arg });
		}
		if beg >= 0 && beg < len {
			let mut left = num;
			if down {
				if !hasbeg {
					beg = len - 1;
				}
				let mut p = beg;
				while p >= 0 {
					let t = ta
						.get(usize::try_from(p).unwrap_or(0))
						.map_or(&[][..], |a| &a[..]);
					if tries(&pprog, t) {
						left -= 1;
						if left == 0 {
							return Ok(GetArg { start: p + 1, arg });
						}
					}
					p -= 1;
				}
				return Ok(GetArg { start: 0, arg });
			}
			let mut p = beg;
			while p < len {
				let t = ta
					.get(usize::try_from(p).unwrap_or(0))
					.map_or(&[][..], |a| &a[..]);
				if tries(&pprog, t) {
					left -= 1;
					if left == 0 {
						return Ok(GetArg { start: p + 1, arg });
					}
				}
				p += 1;
			}
			return Ok(GetArg { start: len + 1, arg });
		}
		return Ok(GetArg { start: 0, arg });
	}
	if f.word {
		let d = v.getstrvalue(ex)?;
		let seps = params::seps(ex)?;
		let sep = f.sep.as_deref();
		let ta = text::sepsplit(&seps, &d, sep, true);
		let len = i64::try_from(ta.len()).unwrap_or(0);
		if beg < 0 {
			beg += len;
		}
		if down {
			if beg < 0 {
				return Ok(GetArg { start: 0, arg });
			}
		} else if beg >= len {
			return Ok(GetArg { start: len + 1, arg });
		}
		let mut r = 1 + beg;
		if beg >= 0 && beg < len {
			let mut left = num;
			if down {
				if !hasbeg {
					beg = len - 1;
				}
				r = 1 + beg;
				let mut p = beg;
				loop {
					if p < 0 {
						return Ok(GetArg { start: 0, arg });
					}
					let t = ta
						.get(usize::try_from(p).unwrap_or(0))
						.map_or(&[][..], |a| &a[..]);
					if tries(&pprog, t) {
						left -= 1;
						if left == 0 {
							break;
						}
					}
					p -= 1;
					r -= 1;
				}
			} else {
				let mut p = beg;
				loop {
					if p >= len {
						return Ok(GetArg { start: 0, arg });
					}
					let t = ta
						.get(usize::try_from(p).unwrap_or(0))
						.map_or(&[][..], |a| &a[..]);
					if tries(&pprog, t) {
						left -= 1;
						if left == 0 {
							break;
						}
					}
					p += 1;
					r += 1;
				}
			}
		}
		if a2 {
			r += 1;
		}
		let mut pos = 0;
		let mut i = 0usize;
		while let Some(t) = text::findword(&seps, &d, &mut pos, sep) {
			if t >= d.len() {
				break;
			}
			r -= 1;
			if r == 0 {
				let off = i64::try_from(t).unwrap_or(0) + if a2 { -1 } else { 1 };
				if !a2 && sub.get(arg.end) != Some(&b',') {
					arg.w = off + i64::try_from(ta.get(i).map_or(0, Vec::len)).unwrap_or(0) - 1;
				}
				return Ok(GetArg { start: off, arg });
			}
			i += 1;
		}
		return Ok(GetArg { start: if a2 { -1 } else { 0 }, arg });
	}
	// Searching characters.
	let d = v.getstrvalue(ex)?;
	if d.is_empty() {
		return Ok(GetArg { start: 0, arg });
	}
	let len = i64::try_from(text::strlen_chars(&d, mb)).unwrap_or(0);
	let slen = d.len();
	if beg < 0 {
		beg += len;
	}
	// Byte offsets of every character boundary.
	let mut bounds = Vec::with_capacity(slen + 1);
	let mut p = 0;
	while p < slen {
		bounds.push(p);
		p += text::charlen(&d, p, mb);
	}
	bounds.push(slen);
	let off = |i: i64| {
		let i = usize::try_from(i)
			.unwrap_or(0)
			.min(bounds.len().saturating_sub(1));
		bounds.get(i).copied().unwrap_or(0)
	};
	if beg >= 0 && beg < len {
		if a2 {
			if down {
				if !hasbeg {
					beg = len;
				}
				let mut found: Vec<usize> = Vec::new();
				for r in 0..=beg {
					let t = off(r);
					if tries(&pprog, head(&d, t)) {
						found.push(t);
					}
					if t == slen {
						break;
					}
				}
				let n = usize::try_from(num).unwrap_or(1);
				if found.len() >= n {
					let last = found.get(found.len() - n).copied().unwrap_or(0);
					return Ok(GetArg { start: i64::try_from(last).unwrap_or(0), arg });
				}
			} else {
				let mut left = num;
				let mut r = beg;
				loop {
					let t = off(r);
					if tries(&pprog, head(&d, t)) {
						left -= 1;
						if left == 0 {
							return Ok(GetArg { start: i64::try_from(t).unwrap_or(0), arg });
						}
					}
					if t == slen {
						break;
					}
					r += 1;
				}
			}
		} else if down {
			if !hasbeg {
				beg = len;
			}
			let mut found: Vec<usize> = Vec::new();
			for r in 0..=beg {
				let t = off(r);
				if tries(&pprog, tail(&d, t)) {
					found.push(t);
				}
				if t == slen {
					break;
				}
			}
			let n = usize::try_from(num).unwrap_or(1);
			if found.len() >= n {
				let lastpos = found.get(found.len() - n).copied().unwrap_or(0);
				let cl = if lastpos < slen {
					text::charlen(&d, lastpos, mb)
				} else {
					1
				};
				let after = lastpos + cl;
				arg.prevlen = i64::try_from(cl).unwrap_or(1);
				arg.nextlen = if after < slen {
					i64::try_from(text::charlen(&d, after, mb)).unwrap_or(1)
				} else {
					1
				};
				return Ok(GetArg { start: i64::try_from(after).unwrap_or(0), arg });
			}
		} else {
			let mut left = num;
			let mut r = beg;
			loop {
				let t = off(r);
				if tries(&pprog, tail(&d, t)) {
					left -= 1;
					if left == 0 {
						let cl = if t < slen {
							text::charlen(&d, t, mb)
						} else {
							1
						};
						let after = t + cl;
						arg.prevlen = i64::try_from(cl).unwrap_or(1);
						arg.nextlen = if after < slen {
							i64::try_from(text::charlen(&d, after, mb)).unwrap_or(1)
						} else {
							1
						};
						return Ok(GetArg { start: i64::try_from(after).unwrap_or(0), arg });
					}
				}
				if t == slen {
					break;
				}
				r += 1;
			}
		}
	}
	let r = if down {
		0
	} else {
		i64::try_from(slen).unwrap_or(0) + 1
	};
	Ok(GetArg { start: r, arg })
}

/// zsh `issetvar`: whether `name` (raw; may carry a subscript) names a
/// set parameter, or an element or slice inside its range (`[[ -v ]]`).
///
/// # Errors
/// A subscript error, a parked substitution, a store failure.
pub fn issetvar(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<bool> {
	let s = crate::bash::syntax::zsh::tok::metafy(name);
	let mut pos = 0;
	let Some(v) = params::fetchvalue(ex, &s, &mut pos, 1, 0)? else {
		return Ok(false);
	};
	if pos != s.len() {
		return Ok(false);
	}
	// For extracted elements, `end` is a count.
	if v.isarr & !SCANPM_ARRONLY != 0 {
		return Ok(v.end > 1);
	}
	let slice = v.start != 0 || v.end != -1;
	// A hash element stands for its own (scalar) parameter.
	let flags = v.pm_flags();
	if flags.type_bits() != PmFlags::ARRAY || !slice {
		return Ok(!slice && !flags.contains(PmFlags::UNSET));
	}
	if v.end == 0 {
		return Ok(false);
	}
	// `arrlen_ge(arr, |end|)`.
	let PValue::Array(a) = &v.pm.value else {
		return Ok(false);
	};
	Ok(u64::try_from(a.len()).unwrap_or(u64::MAX) >= v.end.unsigned_abs())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn strarg_finds_matching_delimiters() {
		assert_eq!(get_strarg(b":a:b", 0, false), (2, 1));
		assert_eq!(get_strarg(b"(ab)c", 0, false), (3, 1));
		assert_eq!(get_strarg(b"<x>", 0, false), (2, 1));
		assert_eq!(get_strarg(b":abc", 0, false), (4, 0));
		// A multibyte delimiter: `£` is two bytes.
		assert_eq!(get_strarg("£5£".as_bytes(), 0, true), (3, 2));
	}
}
