//! zsh's history-style colon modifiers on parameter values (`subst.c`
//! `modify`, `hist.c` `remtpath`, `remtext`, `rembutext`, `remlpaths`,
//! `subst`, `convamps`, `chabspath`): `:h :t :r :e :a :A :c :l :u :q :Q
//! :P :s/l/r/ :& :g… :w :W:sep: :f :F:n:`.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use super::{params, subscript, subst, text};
use crate::bash::{
	diag::Diag,
	pattern::zsh::SubFlags,
	syntax::zsh::tok::{
		BNULL, BNULLKEEP, POUND, head, is_null, metafy, span, tail, unmetafy, untokenize,
	},
	vm::{
		expand::{Expander, Stop, X},
		proc::{Atom, Probe},
	},
	zshopt::ZshOpt,
};

/// The `:s/l/r/` strings last used (zsh `hsubl`/`hsubr`), for `:&`.
#[derive(Clone, Debug, Default)]
pub struct HistSubst {
	/// Left side.
	pub l: Option<Vec<u8>>,
	/// Right side.
	pub r: Option<Vec<u8>>,
}

/// zsh `remtpath` (`:h`, `:hN`).
fn remtpath(s: &mut Vec<u8>, count: usize) {
	let is_sep = |c: u8| c == b'/';
	let mut end = s.len();
	while end > 0 && is_sep(s[end - 1]) {
		end -= 1;
	}
	if count == 0 {
		while end > 0 && !is_sep(s[end - 1]) {
			end -= 1;
		}
	}
	if end == 0 {
		*s = if s.first() == Some(&b'/') {
			b"/".to_vec()
		} else {
			b".".to_vec()
		};
		return;
	}
	if count > 0 {
		let mut left = count;
		let mut p = 0;
		while p + 1 < end {
			if is_sep(s[p]) {
				left -= 1;
				if left == 0 {
					let cut = if p == 0 { 1 } else { p };
					s.truncate(cut);
					return;
				}
				while p + 1 < s.len() && is_sep(s[p + 1]) {
					p += 1;
				}
			}
			p += 1;
		}
		return;
	}
	// `end` is just after the last separator before the file name.
	let mut cut = end - 1;
	while cut > 0 && is_sep(s[cut - 1]) {
		cut -= 1;
	}
	if cut == 0 {
		cut = 1;
		if s.get(1) == Some(&b'/') && s.get(2) != Some(&b'/') {
			cut = 2;
		}
	}
	s.truncate(cut);
}

/// zsh `remtext` (`:r`).
fn remtext(s: &mut Vec<u8>) {
	for i in (0..s.len()).rev() {
		match s[i] {
			b'/' => return,
			b'.' => {
				s.truncate(i);
				return;
			},
			_ => {},
		}
	}
}

/// zsh `rembutext` (`:e`).
fn rembutext(s: &mut Vec<u8>) {
	for i in (0..s.len()).rev() {
		match s[i] {
			b'/' => break,
			b'.' => {
				*s = tail(s, i + 1).to_vec();
				return;
			},
			_ => {},
		}
	}
	s.clear();
}

/// zsh `remlpaths` (`:t`, `:tN`).
fn remlpaths(s: &mut Vec<u8>, count: usize) {
	let mut end = s.len();
	if end > 0 && s[end - 1] == b'/' {
		while end > 0 && s[end - 1] == b'/' {
			end -= 1;
		}
		s.truncate(end);
	}
	let mut count = count.max(1);
	let mut i = s.len();
	loop {
		while i > 0 {
			i -= 1;
			if s[i] == b'/' {
				count -= 1;
				if count > 0 {
					if i > 0 {
						break;
					}
					return;
				}
				*s = tail(s, i + 1).to_vec();
				return;
			}
		}
		while i > 0 && s[i - 1] == b'/' {
			i -= 1;
		}
		if i <= 1 {
			return;
		}
	}
}

/// zsh `chrealpath` of the absolute raw path `s` (`:A`, `:P`): the
/// longest prefix ending at a `/` that `realpath` resolves, resolved, with
/// the rest appended; `s` itself when no proper prefix resolves.
fn chrealpath(ex: &mut Expander<'_, '_>, s: Vec<u8>) -> X<Vec<u8>> {
	if s.first() != Some(&b'/') {
		return Ok(s);
	}
	let mut cut = s.len();
	loop {
		if let Some(real) = realpath(ex, head(&s, cut))? {
			let mut out = real;
			out.extend_from_slice(tail(&s, cut));
			return Ok(out);
		}
		if cut == 0 {
			return Ok(s);
		}
		cut = head(&s, cut).iter().rposition(|&c| c == b'/').unwrap_or(0);
	}
}

/// The canonical physical path of the absolute raw path `path`, through
/// the pollable file system: the first pass parks the op
/// ([`Stop::Probe`]), the replay reads the logged answer.
fn realpath(ex: &mut Expander<'_, '_>, path: &[u8]) -> X<Option<Vec<u8>>> {
	if path.is_empty() {
		return Ok(None);
	}
	let atom = ex.log.get(ex.cursor).cloned();
	ex.cursor += usize::from(atom.is_some());
	if let Some(Atom::Str(found)) = atom {
		return Ok(found.map(Vec::from));
	}
	Err(Stop::Probe(Probe::RealPath { path: path.into() }))
}

/// zsh `chabspath` (`:a`): absolute, `.` and `..` resolved lexically.
pub(crate) fn chabspath(s: &[u8], cwd: &[u8]) -> Vec<u8> {
	let mut path: Vec<u8> = if s.first() == Some(&b'/') {
		s.to_vec()
	} else {
		let mut p = cwd.to_vec();
		if !p.ends_with(b"/") {
			p.push(b'/');
		}
		p.extend_from_slice(s);
		p
	};
	if path.is_empty() {
		path.push(b'/');
	}
	let mut out: Vec<&[u8]> = Vec::new();
	for comp in path.split(|&c| c == b'/') {
		match comp {
			b"" | b"." => {},
			b".." => {
				out.pop();
			},
			c => out.push(c),
		}
	}
	let mut r = Vec::with_capacity(path.len());
	for c in out {
		r.push(b'/');
		r.extend_from_slice(c);
	}
	if r.is_empty() {
		r.push(b'/');
	}
	r
}

/// zsh `convamps`: `&` in `out` replaced by `in`, `\x` by `x`.
pub(crate) fn convamps(out: &[u8], inp: &[u8]) -> Vec<u8> {
	let mut r = Vec::with_capacity(out.len());
	let mut i = 0;
	while i < out.len() {
		match out[i] {
			b'\\' if i + 1 < out.len() => {
				r.push(out[i + 1]);
				i += 2;
			},
			b'&' => {
				r.extend_from_slice(inp);
				i += 1;
			},
			c => {
				r.push(c);
				i += 1;
			},
		}
	}
	r
}

/// zsh `subst` (hist.c): replace `inp` by `out` in `s` (all with `gbal`);
/// patterns under `histsubstpattern`. `false` when nothing matched.
fn hist_subst(
	ex: &mut Expander<'_, '_>,
	s: &mut Vec<u8>,
	inp: &[u8],
	out: &[u8],
	gbal: bool,
) -> X<bool> {
	let (inp, gbal) = if inp.is_empty() {
		(s.clone(), false)
	} else {
		(inp.to_vec(), gbal)
	};
	if params::opt(ex, ZshOpt::Histsubstpattern)? {
		let mut fl = SubFlags::LONG | SubFlags::REST | SubFlags::RETFAIL;
		if gbal {
			fl |= SubFlags::GLOBAL;
		}
		let mut p: &[u8] = &inp;
		if matches!(p.first(), Some(&(b'#' | POUND))) {
			fl |= SubFlags::START;
			p = tail(p, 1);
		}
		if p.first() == Some(&b'%') {
			fl |= SubFlags::END;
			p = tail(p, 1);
		}
		if p.len() == inp.len() {
			fl |= SubFlags::SUBSTR;
		}
		let Ok(pat) = subst::parse_subst_string(p) else {
			return Ok(false);
		};
		let Ok(rep) = subst::parse_subst_string(out) else {
			return Ok(false);
		};
		let pat = subst::singsub(ex, pat)?;
		// The replacement is substituted like `${x/p/r}`'s: per match
		// when the pattern sets `$match`/`$MATCH` (zsh `SUB_DOSUBST`).
		let mut vals = vec![s.clone()];
		let keep = subst::do_getmatch(ex, &mut vals, true, &pat, fl, 1, Some(rep.as_slice()))?;
		if keep && let Some(v) = vals.pop() {
			*s = v;
		}
		return Ok(keep);
	}
	let Some(first) = s
		.windows(inp.len().max(1))
		.position(|w| w == inp.as_slice())
	else {
		return Ok(false);
	};
	let sptr = convamps(out, &inp);
	let mut res = Vec::with_capacity(s.len());
	let mut i = 0;
	let mut at = Some(first);
	while let Some(a) = at {
		res.extend_from_slice(span(s, i, a));
		res.extend_from_slice(&sptr);
		i = a + inp.len();
		at = if gbal && !inp.is_empty() {
			tail(s, i)
				.windows(inp.len())
				.position(|w| w == inp.as_slice())
				.map(|p| p + i)
		} else {
			None
		};
	}
	res.extend_from_slice(tail(s, i));
	*s = res;
	Ok(true)
}

/// One part of `:s/l/r/` at `ptr[start..]`, up to the delimiter `del` or
/// the end (zsh `modify`, case `s`): the text, a backslash that starts a
/// pair turned into `Bnull` (in double quotes zsh leaves it untokenized)
/// and the pair taken as is; the index it stops at; and the length of the
/// delimiter there (a character under `mb`; 0 at the end).
fn s_part(ptr: &[u8], start: usize, del: u32, mb: bool) -> (Vec<u8>, usize, usize) {
	let mut out = Vec::new();
	let mut i = start;
	while i < ptr.len() {
		if matches!(ptr[i], BNULL | b'\\') && i + 1 < ptr.len() {
			out.push(BNULL);
			out.push(ptr[i + 1]);
			i += 2;
			continue;
		}
		let (n, d) = text::delim_at(ptr, i, mb);
		if d == del {
			return (out, i, n);
		}
		out.extend_from_slice(span(ptr, i, i + n));
		i += n;
	}
	(out, i, 0)
}

/// zsh `modify`: apply the colon modifiers at `ptr[*pos..]` (starting at
/// a `:`) to `s` (metafied); `*pos` moves past the last modifier
/// recognised. `inbrace`: inside `${…}` (`:h2`/`:t2` counts allowed).
///
/// # Errors
/// `bad substitution` for an unterminated `:s`, `no previous
/// substitution`, pattern and parameter errors.
#[expect(clippy::too_many_lines, reason = "a faithful port of one C function")]
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's modify")]
pub fn modify(
	ex: &mut Expander<'_, '_>,
	s: &mut Vec<u8>,
	ptr: &[u8],
	pos: &mut usize,
	inbrace: bool,
	hist: &mut HistSubst,
) -> X<()> {
	while ptr.get(*pos) == Some(&b':') {
		let lptr = *pos;
		*pos += 1;
		let mut count = 0usize;
		let (mut wall, mut gbal) = (false, false);
		let mut rec: i64 = 1;
		let mut c = 0u8;
		let mut sep: Option<Vec<u8>> = None;
		while c == 0 && *pos < ptr.len() {
			match ptr[*pos] {
				m @ (b'a' | b'A' | b'c' | b'r' | b'e' | b'l' | b'u' | b'q' | b'Q' | b'P') => c = m,
				m @ (b'h' | b't') => {
					c = m;
					if inbrace {
						while ptr.get(*pos + 1).is_some_and(u8::is_ascii_digit) {
							count = 10 * count + usize::from(ptr[*pos + 1] - b'0');
							*pos += 1;
						}
					}
				},
				b's' => {
					c = b's';
					*pos += 1;
					if *pos >= ptr.len() {
						return Err(Stop::Fail(Diag::BadSubst { text: Default::default() }));
					}
					let mb = params::mb(ex)?;
					let (dl, del) = text::delim_at(ptr, *pos, mb);
					let (l, p1, l1) = s_part(ptr, *pos + dl, del, mb);
					if p1 >= ptr.len() {
						return Err(Stop::Fail(Diag::BadSubst { text: Default::default() }));
					}
					let (r, p3, l3) = s_part(ptr, p1 + l1, del, mb);
					if !l.is_empty() {
						let mut l: Vec<u8> = l
							.into_iter()
							.filter(|&b| !(is_null(b) && b != BNULLKEEP))
							.collect();
						if !params::opt(ex, ZshOpt::Histsubstpattern)? {
							untokenize(&mut l);
						}
						hist.l = Some(l);
					}
					if hist.l.is_none() {
						return Err(Stop::Fail(Diag::ZshSubst {
							msg: "no previous substitution".into(),
						}));
					}
					let mut rr = Vec::with_capacity(r.len());
					for (k, &b) in r.iter().enumerate() {
						if !is_null(b) || b == BNULLKEEP {
							rr.push(b);
						} else if b == BNULL && matches!(r.get(k + 1), Some(&(b'&' | b'\\'))) {
							// `\&` and `\\` stay escaped for the substitution.
							rr.push(b'\\');
						}
					}
					hist.r = Some(rr);
					// zsh leaves the pointer on the last byte of the
					// closing delimiter (optional at the end).
					*pos = p3 + l3 - 1;
				},
				b'&' => c = b's',
				b'g' => {
					*pos += 1;
					gbal = true;
				},
				b'w' => {
					wall = true;
					*pos += 1;
				},
				b'W' => {
					wall = true;
					*pos += 1;
					let mb = params::mb(ex)?;
					let (t, dl) = subscript::get_strarg(ptr, *pos, mb);
					let start = (*pos + text::charlen(ptr, *pos, mb)).min(t);
					sep = Some(span(ptr, start, t).to_vec());
					*pos = t + dl;
					c = 0;
				},
				b'f' => {
					rec = -1;
					*pos += 1;
				},
				b'F' => {
					*pos += 1;
					rec = subst::get_intarg(ex, ptr, pos)?.0;
				},
				_ => {
					*pos = lptr;
					return Ok(());
				},
			}
		}
		*pos += 1;
		if c == 0 {
			*pos = lptr;
			return Ok(());
		}
		let mut test = if rec < 0 { Some(s.clone()) } else { None };
		while rec != 0 {
			rec -= 1;
			if wall {
				let seps = params::seps(ex)?;
				let mut all: Vec<u8> = Vec::new();
				let mut t = 0;
				let mut e = 0;
				while let Some(tt) = text::findword(&seps, s, &mut e, sep.as_deref()) {
					let word = span(s, tt, e).to_vec();
					let copy = apply(ex, c, word, count, gbal, hist)?;
					all.extend_from_slice(span(s, t, tt));
					all.extend_from_slice(&copy);
					t = e;
				}
				*s = all;
			} else {
				let cur = std::mem::take(s);
				*s = apply(ex, c, cur, count, gbal, hist)?;
			}
			if let Some(prev) = &test {
				if prev == s {
					rec = 0;
				} else {
					test = Some(s.clone());
				}
			}
		}
	}
	Ok(())
}

/// One modifier `c` applied to `s`.
fn apply(
	ex: &mut Expander<'_, '_>,
	c: u8,
	s: Vec<u8>,
	count: usize,
	gbal: bool,
	hist: &HistSubst,
) -> X<Vec<u8>> {
	let mut s = s;
	match c {
		b'a' => {
			let raw = unmetafy(&s);
			s = metafy(&chabspath(&raw, &ex.vp.cwd));
		},
		b'A' => {
			let raw = chabspath(&unmetafy(&s), &ex.vp.cwd);
			s = metafy(&chrealpath(ex, raw)?);
		},
		b'P' => {
			// zsh `xsymlink` of the path made absolute: the longest
			// existing prefix resolved physically, the rest lexically.
			let raw = unmetafy(&s);
			let abs = if raw.first() == Some(&b'/') {
				raw
			} else {
				let mut p = ex.vp.cwd.to_vec();
				if !p.ends_with(b"/") {
					p.push(b'/');
				}
				p.extend_from_slice(&raw);
				p
			};
			let real = chrealpath(ex, abs)?;
			s = metafy(&chabspath(&real, &ex.vp.cwd));
		},
		b'c' => {
			if let Some(p) = subst::equalsubstr(ex, &s, false, false)? {
				s = p;
			}
		},
		b'h' => remtpath(&mut s, count),
		b'r' => remtext(&mut s),
		b'e' => rembutext(&mut s),
		b't' => remlpaths(&mut s, count),
		b'l' => s = text::casemodify(&s, text::CaseMod::Lower, params::mb(ex)?),
		b'u' => s = text::casemodify(&s, text::CaseMod::Upper, params::mb(ex)?),
		b's' => {
			if let (Some(l), Some(r)) = (hist.l.clone(), hist.r.clone()) {
				hist_subst(ex, &mut s, &l, &r, gbal)?;
			}
		},
		b'q' => {
			let o = subst::quote_opts(ex)?;
			s = text::quotestring(&s, text::Qt::Backslash, o);
		},
		b'Q' => {
			if let Ok(mut p) = subst::parse_subst_string(&s) {
				crate::bash::pattern::zsh::remnulargs(&mut p);
				untokenize(&mut p);
				s = p;
			} else {
				crate::bash::pattern::zsh::remnulargs(&mut s);
				untokenize(&mut s);
			}
		},
		_ => {},
	}
	Ok(s)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn h(s: &str, n: usize) -> String {
		let mut v = s.as_bytes().to_vec();
		remtpath(&mut v, n);
		String::from_utf8(v).unwrap()
	}

	fn t(s: &str, n: usize) -> String {
		let mut v = s.as_bytes().to_vec();
		remlpaths(&mut v, n);
		String::from_utf8(v).unwrap()
	}

	#[test]
	fn head_and_tail_modifiers_match_zsh() {
		// zsh: x=/a/b/c.d; print $x:h $x:t ${x:h2} ${x:t2}
		assert_eq!(h("/a/b/c.d", 0), "/a/b");
		assert_eq!(h("c.d", 0), ".");
		assert_eq!(h("/c", 0), "/");
		assert_eq!(h("/a/b/c.d", 2), "/a");
		assert_eq!(t("/a/b/c.d", 1), "c.d");
		assert_eq!(t("/a/b/c.d", 2), "b/c.d");
		assert_eq!(t("a/b/", 1), "b");
	}

	#[test]
	fn extension_modifiers() {
		let mut v = b"dir.x/file.tar.gz".to_vec();
		remtext(&mut v);
		assert_eq!(v, b"dir.x/file.tar");
		let mut v = b"dir.x/file".to_vec();
		rembutext(&mut v);
		assert_eq!(v, b"");
	}

	#[test]
	fn absolute_paths_resolve_dots() {
		assert_eq!(chabspath(b"../x/./y", b"/a/b"), b"/a/x/y");
		assert_eq!(chabspath(b"/..", b"/"), b"/");
	}
}
