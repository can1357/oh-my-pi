//! `compfiles` (the C helpers of `_path_files`) and `compgroups`
//! (computil.c `cfp_*`, `cf_*`, `bin_compfiles`, `bin_compgroups`).
//!
//! Strings are handled in zsh's metafied form, as the C code does, and
//! unmetafied when they go back into parameters.

use std::sync::Arc;

use bstr::{BStr, BString, ByteSlice};

use super::{compstr, fin, gate, getaparam, px, quote_opts, rembslash, setaparam, warn};
use crate::bash::{
	fs::{Stat, StatKind},
	pattern::zsh::{PatFlags, haswilds, remnulargs, tokenize},
	syntax::zsh::tok::{META, metafy, unmetafy},
	vm::{
		builtins::{Ctx, Need, R, done, zsh_args::Ops, zsh_print},
		probe::absolute,
		proc::{Probe, ProbeResult},
		zle::comp::{
			self, compcore, compmatch, qt,
			types::{Cmatcher, Cpattern, cgf, cmatcher_flags as cmf},
		},
		zsh::{text::QuoteOpts, zpattern},
	},
	zshopt::ZshOpt,
};

/// zsh `PATH_MAX2`.
const PATH_MAX2: usize = crate::sys::PATH_MAX * 2;

/// What `compfiles` reads from the completion state once.
struct Env {
	/// `PREFIX`, metafied.
	prefix:   Vec<u8>,
	/// `SUFFIX`, metafied.
	suffix:   Vec<u8>,
	/// `GLOB_DOTS`.
	globdots: bool,
	/// Options for `quotestring`.
	qopts:    QuoteOpts,
}

/// `stat` (`follow`) or `lstat` of the unmetafied `path`, relative to the
/// shell's directory.
fn stat(ctx: &Ctx<'_, '_>, path: &[u8], follow: bool) -> Result<Option<Stat>, Need> {
	if path.is_empty() {
		return Ok(None);
	}
	let path = absolute(&ctx.vp.cwd, path);
	Ok(match ctx.probe(Probe::Stat { path, follow })? {
		ProbeResult::Stat(s) => s,
		_ => None,
	})
}

/// zsh `ztat`: `stat`/`lstat` (`ls`) of the metafied `nam`, again with
/// backslashes removed when that fails.
fn ztat(ctx: &Ctx<'_, '_>, nam: &[u8], ls: bool) -> Result<Option<Stat>, Need> {
	let raw = unmetafy(nam);
	if let Some(st) = stat(ctx, &raw, !ls)? {
		return Ok(Some(st));
	}
	let mut p = Vec::with_capacity(raw.len());
	let mut q = 0;
	while q < raw.len() {
		if raw[q] == b'\\' && q + 1 < raw.len() {
			q += 1;
		}
		p.push(raw[q]);
		q += 1;
	}
	stat(ctx, &p, !ls)
}

/// Same file (`st_dev` and `st_ino`).
const fn same(a: &Stat, b: &Stat) -> bool {
	a.dev == b.dev && a.ino == b.ino
}

/// Tokenize and compile the metafied pattern `p`.
fn compile(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	p: &[u8],
) -> Result<Option<Arc<crate::bash::pattern::zsh::Pattern>>, Need> {
	let mut t = p.to_vec();
	tokenize(&mut t);
	Ok(px(ctx, failed, |ex| zpattern::try_compile(ex, &t, PatFlags::NONE))?.flatten())
}

/// zsh `pattry` of a compiled pattern against the metafied `s`.
fn pattry(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	prog: &crate::bash::pattern::zsh::Pattern,
	s: &[u8],
) -> Result<bool, Need> {
	let raw = unmetafy(s);
	Ok(px(ctx, failed, |ex| zpattern::matches(ex, prog, &raw))?.unwrap_or(false))
}

/// zsh `cfp_test_exact`: names to accept exactly (`accept-exact`),
/// `None` when there are none.
fn cfp_test_exact(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	env: &Env,
	names: &[Vec<u8>],
	accept: Option<&[BString]>,
	skipped: &[u8],
) -> Result<Option<Vec<Vec<u8>>>, Need> {
	if env.prefix.is_empty() && env.suffix.is_empty() {
		return Ok(None);
	}
	let Some(accept) = accept.filter(|a| !a.is_empty()) else {
		return Ok(None);
	};
	let is = |s: &BString, set: [&str; 4]| set.iter().any(|w| s.as_slice() == w.as_bytes());
	if accept.len() == 1 && is(&accept[0], ["false", "no", "off", "0"]) {
		return Ok(None);
	}
	let alist: Option<Vec<Arc<crate::bash::pattern::zsh::Pattern>>> =
		if accept.len() > 1 || !is(&accept[0], ["true", "yes", "on", "1"]) {
			let mut l = Vec::new();
			let mut any = false;
			for p in accept {
				if p == "*" {
					any = true;
					break;
				}
				if let Some(prog) = compile(ctx, failed, &metafy(p))? {
					l.push(prog);
				}
			}
			(!any).then_some(l)
		} else {
			None
		};
	let sl = skipped.len() + env.prefix.len() + env.suffix.len();
	if sl > PATH_MAX2 {
		return Ok(None);
	}
	let mut suf = skipped.to_vec();
	suf.extend_from_slice(&rembslash(&[&env.prefix[..], &env.suffix[..]].concat()));
	let mut ret = Vec::new();
	for p in names {
		if p.len() + sl >= PATH_MAX2 {
			continue;
		}
		let buf = [&p[..], &suf[..]].concat();
		if ztat(ctx, &buf, false)?.is_none() {
			continue;
		}
		if let Some(al) = &alist {
			let mut hit = false;
			for prog in al {
				if pattry(ctx, failed, prog, &buf)? {
					hit = true;
					break;
				}
			}
			if !hit {
				continue;
			}
		}
		ret.push(buf);
	}
	Ok((!ret.is_empty()).then_some(ret))
}

/// The next (metafied) character of `s` at `i`: its byte length and
/// value (zsh `MB_METACHARLENCONV`; an undecodable byte is itself).
fn metachar(s: &[u8], i: usize, utf8: bool) -> (usize, char) {
	let raw_at = |j: usize| -> (u8, usize) {
		if s[j] == META && j + 1 < s.len() {
			(s[j + 1] ^ 32, 2)
		} else {
			(s[j], 1)
		}
	};
	let (b0, l0) = raw_at(i);
	if !utf8 || b0 < 0x80 {
		return (l0, char::from(b0));
	}
	// Collect up to four unmetafied bytes to decode one character.
	let mut raw = vec![b0];
	let mut lens = vec![l0];
	let mut j = i + l0;
	while raw.len() < 4 && j < s.len() {
		let (b, l) = raw_at(j);
		raw.push(b);
		lens.push(l);
		j += l;
	}
	let (c, n) = bstr::decode_utf8(&raw);
	match c {
		Some(c) => (lens[..n].iter().sum(), c),
		None => (l0, char::from_u32(u32::from(b0)).unwrap_or('\u{fffd}')),
	}
}

/// Push character `c` metafied.
fn push_meta(out: &mut Vec<u8>, c: char) {
	let mut b = [0u8; 4];
	out.extend_from_slice(&metafy(c.encode_utf8(&mut b).as_bytes()));
}

/// zsh `cfp_matcher_range`: a pattern matching at each position either
/// the character of `add` or what the matcher for that position allows.
fn cfp_matcher_range(ms: &[Option<Arc<Cmatcher>>], add: &[u8], utf8: bool) -> Vec<u8> {
	let mut out = Vec::new();
	let mut i = 0;
	let mut mp = 0;
	while i < add.len() {
		let (addlen, addc) = metachar(add, i, utf8);
		let here = &add[i..i + addlen];
		match ms.get(mp).cloned().flatten() {
			None => out.extend_from_slice(here),
			Some(m) if m.flags & cmf::RIGHT != 0 => {
				out.push(b'*');
				out.extend_from_slice(here);
			},
			Some(m) => {
				let lp = m.line.first();
				let wp = m.word.first();
				if let (Some(Cpattern::Equiv(lstr)), Some(Cpattern::Equiv(_))) = (lp, wp) {
					out.push(b'[');
					out.extend_from_slice(here);
					let (mut ind, mut mt) = (0u32, 0i32);
					if compmatch::patmatchrange(lstr, addc, &mut ind, &mut mt)
						&& let Some(e) =
							compmatch::pattern_match_equivalence(wp.expect("matched"), ind, mt, addc)
					{
						push_meta(&mut out, e);
					}
					out.push(b']');
				} else {
					match wp {
						Some(Cpattern::NClass(range)) => {
							out.extend_from_slice(b"[^");
							out.extend_from_slice(&compmatch::pattern_range_to_string(range));
							out.push(b']');
						},
						Some(p @ (Cpattern::CClass(_) | Cpattern::Equiv(_) | Cpattern::Char(_))) => {
							out.push(b'[');
							let mut mt = 0;
							let addadd = !compmatch::pattern_match1(p, addc, &mut mt);
							if addadd && here[0] == b']' {
								out.push(b']');
							}
							match p {
								Cpattern::Char(c) => push_meta(&mut out, *c),
								Cpattern::CClass(r) | Cpattern::Equiv(r) => {
									out.extend_from_slice(&compmatch::pattern_range_to_string(r));
								},
								_ => {},
							}
							if addadd && here[0] != b']' {
								out.extend_from_slice(here);
							}
							out.push(b']');
						},
						Some(Cpattern::Any) => out.push(b'?'),
						None => {},
					}
				}
			},
		}
		i += addlen;
		mp += 1;
	}
	out
}

/// zsh `cfp_matcher_pats`: `add` cut where the matcher spec `matcher`
/// could match differently, as a pattern. Warnings parsing the spec go
/// to `warns`.
fn cfp_matcher_pats(matcher: &[u8], add: &[u8], utf8: bool, warns: &mut Vec<Vec<u8>>) -> Vec<u8> {
	let mut add = add.to_vec();
	let parsed = compmatch::parse_cmatcher(None, matcher, &mut |m: &[u8]| warns.push(m.to_vec()));
	let Ok(Some(first)) = parsed else {
		return add;
	};
	// One matcher per (possibly wide) character.
	let mut ms: Vec<Option<Arc<Cmatcher>>> = vec![None; add.len()];
	let step = |s: &[u8], i: usize| metachar(s, i, utf8).0;
	let mut m = Some(first);
	while let Some(cm) = m.take().filter(|_| !add.is_empty()) {
		let mut stopp: Option<(Vec<Cpattern>, i32)> = None;
		if cm.flags & (cmf::LEFT | cmf::RIGHT) == 0 {
			if cm.llen == 1 && cm.wlen == 1 {
				let (mut t, mut k) = (0, 0);
				while t < add.len() {
					if compmatch::pattern_match(&cm.line, &add[t..]) {
						if ms[k].is_some() {
							add.truncate(t);
							break;
						}
						ms[k] = Some(cm.clone());
					}
					t += step(&add, t);
					k += 1;
				}
			} else {
				stopp = Some((cm.line.clone(), cm.llen));
			}
		} else if cm.flags & cmf::RIGHT != 0 {
			if cm.wlen < 0 && cm.llen == 0 && cm.ralen == 1 {
				let (mut t, mut k) = (0, 0);
				while t < add.len() {
					if compmatch::pattern_match(&cm.right, &add[t..]) {
						if ms[k].is_some() || (t == 0 && add[0] == b'.') {
							add.truncate(t);
							break;
						}
						ms[k] = Some(cm.clone());
					}
					t += step(&add, t);
					k += 1;
				}
			} else if cm.llen != 0 {
				stopp = Some((cm.line.clone(), cm.llen));
			} else {
				stopp = Some((cm.right.clone(), cm.ralen));
			}
		} else {
			if cm.lalen == 0 {
				return Vec::new();
			}
			stopp = Some((cm.left.clone(), cm.lalen));
		}
		if let Some((pat, stopl)) = stopp {
			let stopl = usize::try_from(stopl).unwrap_or(0);
			let mut t = 0;
			while add.len() - t >= stopl {
				if compmatch::pattern_match(&pat, &add[t..]) {
					add.truncate(t);
					break;
				}
				if t >= add.len() {
					break;
				}
				t += step(&add, t);
			}
		}
		m.clone_from(&cm.next);
	}
	if add.is_empty() {
		add
	} else {
		cfp_matcher_range(&ms, &add, utf8)
	}
}

/// Pattern characters `cfp_opt_pats` quotes in the prefix.
const fn patchar(c: u8) -> bool {
	matches!(
		c,
		b'*' | b'?' | b'<' | b'>' | b'(' | b')' | b'[' | b']' | b'|' | b'#' | b'^' | b'~' | b'='
	)
}

/// `s` cut at the first occurrence of `c`.
fn cut_at(s: &mut Vec<u8>, c: u8) {
	if let Some(i) = s.find_byte(c) {
		s.truncate(i);
	}
}

/// zsh `cfp_opt_pats`: prefix the `*` patterns with the literal part of
/// `PREFIX` they must match anyway.
fn cfp_opt_pats(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	env: &Env,
	pats: &mut [Vec<u8>],
	matcher: &[u8],
) -> Result<(), Need> {
	let pre = &env.prefix;
	if pre.is_empty() {
		return Ok(());
	}
	let patmatch = comp::comp(ctx.vp)
		.and_then(|c| c.complete.comppatmatch.clone())
		.unwrap_or_default();
	if !patmatch.is_empty() {
		let mut t = rembslash(&[&pre[..], &env.suffix[..]].concat()).to_vec();
		tokenize(&mut t);
		remnulargs(&mut t);
		let popts = px(ctx, failed, zpattern::opts)?.unwrap_or_default();
		if haswilds(&mut t, &popts) {
			return Ok(());
		}
	}
	let mut add = Vec::with_capacity(pre.len() * 2);
	for (i, &c) in pre.iter().enumerate() {
		let next = pre.get(i + 1).copied();
		if c != b'\\' || next.is_none() || next.is_some_and(patchar) {
			if (i == 0 || pre[i - 1] != b'\\') && patchar(c) {
				add.push(b'\\');
			}
			add.push(c);
		}
	}
	for q in pats.iter() {
		if add.is_empty() {
			break;
		}
		if q.is_empty() {
			continue;
		}
		let mut q = q.clone();
		// Cut glob qualifiers `(…)` at the end.
		if q.last() == Some(&b')') {
			let mut t = q.len() as isize - 2;
			while t > 0 {
				if matches!(q[t as usize], b')' | b'|' | b'~' | b'(') {
					break;
				}
				t -= 1;
			}
			if t > 0 && q[t as usize] == b'(' {
				q.truncate(t as usize);
			}
		}
		let mut k = 0;
		while k < q.len() && !add.is_empty() {
			match q[k] {
				b'\\' if k + 1 < q.len() => {
					k += 1;
					cut_at(&mut add, q[k]);
				},
				b'<' => {
					if let Some(i) = add.iter().position(u8::is_ascii_digit) {
						add.truncate(i);
					}
				},
				b'[' => {
					k += 1;
					let mut x = k;
					if matches!(q.get(x), Some(b'!' | b'^')) {
						x += 1;
					}
					while x < q.len() {
						if q.get(x + 1) == Some(&b'-') && x + 2 < q.len() {
							let (c1, c2) = (q[x], q[x + 2]);
							// zsh compares the range's own first character, so
							// the scan stops at once.
							let xc = q[x];
							let stop = add
								.iter()
								.position(|_| !(xc < c1 || xc > c2))
								.unwrap_or(add.len());
							add.truncate(stop);
						} else {
							cut_at(&mut add, q[x]);
						}
						x += 1;
					}
				},
				b'?' | b'*' | b'(' | b')' | b'|' | b'~' | b'#' => {},
				c => cut_at(&mut add, c),
			}
			k += 1;
		}
	}
	if !add.is_empty() {
		if !matcher.is_empty() {
			let utf8 = zsh_print::charset(ctx)?.utf8;
			let mut warns = Vec::new();
			add = cfp_matcher_pats(matcher, &add, utf8, &mut warns);
			for w in warns {
				ctx.diag(crate::bash::diag::Diag::Usage {
					msg: String::from_utf8_lossy(&w).into_owned().into(),
				});
			}
		}
		for p in pats.iter_mut() {
			if p.first() == Some(&b'*') {
				let mut n = add.clone();
				n.extend_from_slice(p);
				*p = n;
			}
		}
	}
	Ok(())
}

/// zsh `cfp_bld_pats`: each name with `skipped` and each pattern.
fn cfp_bld_pats(env: &Env, names: &[Vec<u8>], skipped: &[u8], pats: &[Vec<u8>]) -> Vec<Vec<u8>> {
	let dot = !env.globdots && env.prefix.first() == Some(&b'.');
	let mut ret = Vec::new();
	for o in names {
		for p in pats {
			ret.push([&o[..], skipped, &p[..]].concat());
			if dot && p.first() != Some(&b'.') {
				ret.push([&o[..], skipped, b".", &p[..]].concat());
			}
		}
	}
	ret
}

/// zsh `cfp_add_sdirs`: add `.`/`..` (`special-dirs`) and `fake-files`.
fn cfp_add_sdirs(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	env: &Env,
	mut fin_: Vec<Vec<u8>>,
	orig: &[Vec<u8>],
	skipped: &[u8],
	sdirs: &[u8],
	fake: Option<&[BString]>,
) -> Result<Vec<Vec<u8>>, Need> {
	let mut add = 0;
	if !sdirs.is_empty() && (env.globdots || env.prefix.first() == Some(&b'.')) {
		if matches!(sdirs, b"yes" | b"true" | b"on" | b"1") {
			add = 2;
		} else if sdirs == b".." {
			add = 1;
		}
	}
	if add > 0 {
		for m in orig {
			fin_.push([&m[..], skipped, b".."].concat());
			if add == 2 {
				fin_.push([&m[..], skipped, b"."].concat());
			}
		}
	}
	for f in fake.unwrap_or_default() {
		let f = metafy(f);
		// The name up to the first unquoted `:`.
		let mut name = Vec::new();
		let mut p = 0;
		while p < f.len() {
			if f[p] == b':' {
				break;
			} else if f[p] == b'\\' && f.get(p + 1) == Some(&b':') {
				p += 1;
			}
			name.push(f[p]);
			p += 1;
		}
		if p >= f.len() {
			continue;
		}
		p += 1;
		if p >= f.len() {
			continue;
		}
		let prog = compile(ctx, failed, &name)?;
		for m in orig {
			let mut hit = match &prog {
				Some(prog) => pattry(ctx, failed, prog, m)?,
				None => name == *m,
			};
			if !hit && let Some(a) = stat(ctx, &unmetafy(&name), true)? {
				let mraw = if m.is_empty() {
					b".".to_vec()
				} else {
					unmetafy(m)
				};
				hit = stat(ctx, &mraw, true)?.is_some_and(|b| same(&a, &b));
			}
			if !hit {
				continue;
			}
			// zsh walks the words with one pointer: only the first
			// matching name gets them.
			while p < f.len() {
				while p < f.len() && matches!(f[p], b' ' | b'\t' | b'\n') {
					p += 1;
				}
				if p >= f.len() {
					break;
				}
				let mut w = Vec::new();
				while p < f.len() && !matches!(f[p], b' ' | b'\t' | b'\n') {
					if f[p] == b'\\' && p + 1 < f.len() {
						p += 1;
					}
					w.push(f[p]);
					p += 1;
				}
				fin_.push([&m[..], skipped, &w[..]].concat());
			}
		}
	}
	Ok(fin_)
}

/// zsh `cf_pats`.
#[expect(clippy::too_many_arguments, reason = "zsh's cf_pats signature")]
fn cf_pats(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	env: &Env,
	dirs: bool,
	noopt: bool,
	names: &[Vec<u8>],
	accept: Option<&[BString]>,
	skipped: &[u8],
	matcher: &[u8],
	sdirs: &[u8],
	fake: Option<&[BString]>,
	mut pats: Vec<Vec<u8>>,
) -> Result<Vec<Vec<u8>>, Need> {
	if let Some(ret) = cfp_test_exact(ctx, failed, env, names, accept, skipped)? {
		return cfp_add_sdirs(ctx, failed, env, ret, names, skipped, sdirs, fake);
	}
	if dirs {
		pats = vec![b"*(-/)".to_vec()];
	}
	if !noopt {
		cfp_opt_pats(ctx, failed, env, &mut pats, matcher)?;
	}
	let built = cfp_bld_pats(env, names, skipped, &pats);
	cfp_add_sdirs(ctx, failed, env, built, names, skipped, sdirs, fake)
}

/// zsh `cf_ignore`: names to ignore because they are the current or the
/// parent directory (`ignore-parents` style `style`, `path` the prefix).
fn cf_ignore(
	ctx: &Ctx<'_, '_>,
	env: &Env,
	names: &[BString],
	ign: &mut Vec<BString>,
	style: &[u8],
	path: &[u8],
) -> Result<(), Need> {
	let tpar = style.find(b"parent").is_some();
	let est = if style.find(b"pwd").is_some() {
		stat(ctx, &ctx.vp.cwd, false)?
	} else {
		None
	};
	if !tpar && est.is_none() {
		return Ok(());
	}
	let path = metafy(path);
	let pl = path.len();
	for n in names {
		let n = metafy(n);
		let Some(nst) = ztat(ctx, &n, true)? else {
			continue;
		};
		if nst.kind != StatKind::Dir {
			continue;
		}
		if let Some(e) = &est
			&& same(&nst, e)
		{
			ign.push(unmetafy(&comp::quotestring(&n, qt::BACKSLASH, env.qopts)).into());
			continue;
		}
		if tpar && n.starts_with(&path) {
			let mut c = n.clone();
			let mut found = false;
			while let Some(e) = c.rfind_byte(b'/').filter(|&e| e > pl) {
				c.truncate(e);
				if ztat(ctx, &c, false)?.is_some_and(|st| same(&st, &nst)) {
					found = true;
					break;
				}
			}
			let more = !found
				&& match c.rfind_byte(b'/').filter(|&e| e > pl) {
					Some(_) => ztat(ctx, &c, true)?.is_some_and(|st| same(&st, &nst)),
					None => false,
				};
			if found || more {
				ign.push(unmetafy(&comp::quotestring(&n, qt::BACKSLASH, env.qopts)).into());
			}
		}
	}
	Ok(())
}

/// zsh `cf_remove_other`: the names in the directory `PREFIX` names,
/// when some are there; `amb` set when the names differ.
fn cf_remove_other(names: &[BString], pre: &[u8], amb: &mut i32) -> Option<Vec<BString>> {
	if let Some(slash) = pre.find_byte(b'/') {
		let pre = &pre[..=slash];
		if names.iter().any(|n| n.starts_with(pre)) {
			*amb = 0;
			return Some(
				names
					.iter()
					.filter(|n| n.starts_with(pre))
					.cloned()
					.collect(),
			);
		}
		match names.split_first() {
			None => *amb = 0,
			Some((first, rest)) => {
				let mut p = first.clone();
				if let Some(q) = p.find_byte(b'/') {
					p.truncate(q);
				}
				p.push(b'/');
				if rest.iter().any(|n| !n.starts_with(&p)) {
					*amb = 1;
				}
			},
		}
	} else {
		match names.split_first() {
			None => *amb = 0,
			Some((first, rest)) => {
				if rest.iter().any(|n| n != first) {
					*amb = 1;
				}
			},
		}
	}
	None
}

/// zsh `bin_compfiles`.
pub fn compfiles(ctx: &mut Ctx<'_, '_>, _ops: &Ops, args: &[BString]) -> R {
	if !gate(ctx) {
		return done(1);
	}
	let a0 = args[0].as_slice();
	if a0.first() != Some(&b'-') {
		return warn(ctx, format!("missing option: {}", BStr::new(a0)));
	}
	let mut failed = false;
	let env = Env {
		prefix:   metafy(&compstr(ctx, &mut failed, b"PREFIX")?),
		suffix:   metafy(&compstr(ctx, &mut failed, b"SUFFIX")?),
		globdots: ctx.zsh_option(ZshOpt::Globdots)?,
		qopts:    quote_opts(ctx)?,
	};
	match a0.get(1) {
		Some(&o @ (b'p' | b'P')) => {
			if a0.len() > 2 && (a0[2] != b'-' || a0.len() > 3) {
				return warn(ctx, format!("invalid option: {}", BStr::new(a0)));
			}
			if args.len() < 7 || (o == b'p' && args.len() < 8) {
				return warn(ctx, "too few arguments");
			}
			let Some(tmp) = getaparam(ctx, &mut failed, &args[1])? else {
				ctx.usage(format!("unknown parameter: {}", BStr::new(&args[1])));
				return done(0);
			};
			let names: Vec<Vec<u8>> = tmp
				.iter()
				.map(|n| comp::quotestring(&metafy(n), qt::BACKSLASH_PATTERN, env.qopts))
				.collect();
			let accept = getaparam(ctx, &mut failed, &args[2])?;
			let fake = getaparam(ctx, &mut failed, &args[6])?;
			let pats = args[7..].iter().map(|p| metafy(p)).collect();
			let out = cf_pats(
				ctx,
				&mut failed,
				&env,
				o == b'P',
				a0.len() > 2,
				&names,
				accept.as_deref(),
				&metafy(&args[3]),
				&metafy(&args[4]),
				&args[5],
				fake.as_deref(),
				pats,
			)?;
			let out = out.iter().map(|s| BString::from(unmetafy(s))).collect();
			setaparam(ctx, &mut failed, &args[1], out)?;
			fin(0, failed)
		},
		Some(b'i') => {
			if a0.len() > 2 {
				return warn(ctx, format!("invalid option: {}", BStr::new(a0)));
			}
			if args.len() < 5 {
				return warn(ctx, "too few arguments");
			}
			if args.len() > 5 {
				return warn(ctx, "too many arguments");
			}
			let mut l = getaparam(ctx, &mut failed, &args[2])?.unwrap_or_default();
			let Some(tmp) = getaparam(ctx, &mut failed, &args[1])? else {
				ctx.usage(format!("unknown parameter: {}", BStr::new(&args[1])));
				return done(0);
			};
			cf_ignore(ctx, &env, &tmp, &mut l, &args[3], &args[4])?;
			setaparam(ctx, &mut failed, &args[2], l)?;
			fin(0, failed)
		},
		Some(b'r') => {
			if args.len() < 3 {
				return warn(ctx, "too few arguments");
			}
			if args.len() > 3 {
				return warn(ctx, "too many arguments");
			}
			let Some(tmp) = getaparam(ctx, &mut failed, &args[1])? else {
				ctx.usage(format!("unknown parameter: {}", BStr::new(&args[1])));
				return done(0);
			};
			let mut ret = 0;
			if let Some(l) = cf_remove_other(&tmp, &args[2], &mut ret) {
				setaparam(ctx, &mut failed, &args[1], l)?;
			}
			fin(ret, failed)
		},
		_ => warn(ctx, format!("invalid option: {}", BStr::new(a0))),
	}
}

/// zsh `bin_compgroups`: open the groups of each name in the order
/// compadd would make them (sorted/unsorted, duplicates kept/removed).
pub fn compgroups(ctx: &mut Ctx<'_, '_>, _ops: &Ops, args: &[BString]) -> R {
	if !gate(ctx) {
		return done(1);
	}
	let Some(c) = comp::comp_mut(ctx.vp) else {
		return done(1);
	};
	for n in args {
		let n = metafy(n);
		for flags in [
			cgf::NOSORT | cgf::UNIQCON,
			cgf::UNIQALL,
			cgf::NOSORT | cgf::UNIQCON,
			cgf::UNIQALL,
			cgf::NOSORT,
			0,
		] {
			compcore::endcmgroup(c, None);
			compcore::begcmgroup(c, Some(n.as_slice()), flags);
		}
	}
	done(0)
}
