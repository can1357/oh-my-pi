//! compcore.c: adding matches. Groups (`begcmgroup`, `endcmgroup`),
//! explanations (`addexpl`), `compadd`'s work (`addmatches`, `addmatch`)
//! and one match with its unambiguous-string clines (`add_match_data`).

use std::{borrow::Cow, sync::Arc};

use bstr::BString;

use super::{
	super::{
		Comp, complete,
		compmatch::{
			add_bmatchers, bld_parts, cline_matched, comp_match, cp_cline, free_cline, get_cline,
			join_clines, match_str, revert_cline, update_bmatchers,
		},
		compresult::hasbrpsfx,
		qt,
		types::{Aminfo, Cadata, Cexpl, Cl, Cmatch, Cmgroup, Cmlist, GId, caf, cgf, clf, cmf},
	},
	matcheq,
	strings::{get_data_arr, get_user_var, multiquote, set_list_array, tildequote},
};
use crate::bash::{
	pattern::zsh::{PatFlags, Pattern, haswilds, remnulargs, tokenize},
	syntax::zsh::tok::{QUEST, STAR, at, metafy, unmetafy, untokenize},
	vm::{
		expand::{Expander, X},
		zsh::{subst::singsub, zpattern},
	},
};

/// zsh `begcmgroup`: make the group `name` with `flags` current, reusing
/// one of that name and sort/uniq flags, else a new one at the head of
/// `amatches` (allocated on zsh's heap: freed when the completion ends).
pub fn begcmgroup(c: &mut Comp, name: Option<&[u8]>, flags: u32) {
	const SAME: u32 =
		cgf::NOSORT | cgf::UNIQALL | cgf::UNIQCON | cgf::MATSORT | cgf::NUMSORT | cgf::REVSORT;
	if let Some(n) = name {
		let found = c.groups.list(c.core.amatches).find(|&p| {
			let g = c.groups.get(p);
			g.name.as_ref().is_some_and(|gn| gn.as_slice() == n) && flags == g.flags & SAME
		});
		if let Some(p) = found {
			c.core.mgroup = Some(p);
			return;
		}
	}
	let g = c.groups.alloc(Cmgroup {
		name: name.map(BString::from),
		flags,
		lallccs: (flags & cgf::NOSORT == 0).then(Vec::new),
		next: c.core.amatches,
		prev: None,
		..Cmgroup::default()
	});
	if let Some(a) = c.core.amatches {
		c.groups.get_mut(a).prev = Some(g);
	}
	c.core.amatches = Some(g);
	c.core.heapgroups.push(g);
	c.core.mgroup = Some(g);
}

/// zsh `endcmgroup`: end the current group for now, giving it the
/// listing strings `ylist` (`compctl -y`).
///
/// # Panics
/// Without a current group (zsh dereferences `NULL`).
pub fn endcmgroup(c: &mut Comp, ylist: Option<Vec<BString>>) {
	let g = c.core.mgroup.expect("endcmgroup without a current group");
	c.groups.get_mut(g).ylist = ylist;
}

/// zsh `curexpl` as a pointer: the explanation matches are counted for,
/// which is the entry of the group's list once [`addexpl`] put it there.
pub fn curexpl_mut(c: &mut Comp) -> Option<&mut Cexpl> {
	if let Some((g, i)) = c.core.curexpl_at
		&& c.core.curexpl.is_some()
	{
		return c.groups.get_mut(g).lexpls.get_mut(i);
	}
	c.core.curexpl.as_mut()
}

/// Make `e` (or none) zsh's `curexpl`, not yet on any list.
pub fn set_curexpl(c: &mut Comp, e: Option<Cexpl>) {
	c.core.curexpl = e;
	c.core.curexpl_at = None;
}

/// zsh `addexpl`: put `curexpl` on the current group's explanations,
/// adding its counts to an equal string already there; `always` (`-x`)
/// makes it a message shown without matches.
///
/// # Panics
/// Without a current group or `curexpl` (zsh dereferences `NULL`).
pub fn addexpl(c: &mut Comp, always: bool) {
	let g = c.core.mgroup.expect("addexpl without a current group");
	let cur = curexpl_mut(c).cloned().expect("addexpl without curexpl");
	let gr = c.groups.get_mut(g);
	if let Some(e) = gr.lexpls.iter_mut().find(|e| e.str == cur.str) {
		e.count += cur.count;
		e.fcount += cur.fcount;
		if always {
			e.always = true;
			gr.new = true;
			c.core.nmessages += 1;
			c.core.newmatches = 1;
		}
		return;
	}
	gr.lexpls.push(cur);
	let i = gr.lexpls.len() - 1;
	if always {
		gr.new = true;
		c.core.nmessages += 1;
	}
	c.core.newmatches = 1;
	c.core.curexpl_at = Some((g, i));
}

/// A match [`add_match_data`] added: `c.groups.get(mgroup)`'s
/// `lmatches[i]` (`lfmatches[i]` when `alt`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Added {
	/// The group.
	pub g:      GId,
	/// Put on the `fignore`-ignored list.
	pub alt:    bool,
	/// Index in that list.
	pub i:      usize,
	/// It became `ainfo->firstm` (or `fainfo`'s).
	pub firstm: bool,
	/// It became `exactm`.
	pub exactm: bool,
}

/// The `ainfo` (or with `alt` `fainfo`) of the completion.
fn ai(c: &mut Comp, alt: bool) -> &mut Aminfo {
	let a = if alt {
		&mut c.core.fainfo
	} else {
		&mut c.core.ainfo
	};
	a.get_or_insert_with(Box::default)
}

/// Change the match `a` (zsh's callers set `rems`, `remf`, `disp`
/// through the returned pointer), also in `firstm`/`exactm` where zsh's
/// pointers would see it.
pub fn set_added(c: &mut Comp, a: Added, f: impl Fn(&mut Cmatch)) {
	let gr = c.groups.get_mut(a.g);
	let l = if a.alt {
		&mut gr.lfmatches
	} else {
		&mut gr.lmatches
	};
	if let Some(m) = l.get_mut(a.i) {
		f(m);
	}
	let ai = ai(c, a.alt);
	if a.firstm
		&& let Some(m) = ai.firstm.as_deref_mut()
	{
		f(m);
	}
	if a.exactm
		&& let Some(m) = ai.exactm.as_deref_mut()
	{
		f(m);
	}
}

/// zsh `compstate[list]` "packed"/"rows" as match flags.
fn listflags(c: &Comp) -> u32 {
	c.complete.complist.as_ref().map_or(0, |l| {
		let has = |w: &[u8]| l.windows(w.len()).any(|x| x == w);
		(if has(b"packed") { cmf::PACKED } else { 0 }) | (if has(b"rows") { cmf::ROWS } else { 0 })
	})
}

/// `compadd -d` display strings: zsh's `char **disp` walked with
/// `*++disp` (the strings and how far it went).
type Disp = Option<(Vec<BString>, usize)>;

/// zsh's `if (!*++disp) disp = NULL`.
fn disp_next(disp: &mut Disp) {
	if let Some((v, n)) = disp {
		*n += 1;
		if *n > v.len() {
			*disp = None;
		}
	}
}

/// The current display string.
fn disp_cur(disp: &Disp) -> Option<BString> {
	disp
		.as_ref()
		.and_then(|(v, n)| v.get(n.wrapping_sub(1)).cloned())
}

/// zsh `addmatch`: a bare match (`<all>` of `compadd -C`, `-E` dummies).
fn addmatch(c: &mut Comp, str: &[u8], flags: u32, disp: &mut Disp, line: bool) {
	let mut cm =
		Cmatch { str: BString::from(str), flags: flags | listflags(c), ..Cmatch::default() };
	if disp.is_some() {
		disp_next(disp);
		if disp.is_some() {
			cm.disp = disp_cur(disp);
		}
	} else if line {
		cm.disp = Some(BString::default());
		cm.flags |= cmf::DISPLINE;
	}
	c.core.mnum += 1;
	ai(c, false).count += 1;
	if let Some(e) = curexpl_mut(c) {
		e.count += 1;
	}
	let g = c.core.mgroup.expect("addmatch without a current group");
	let gr = c.groups.get_mut(g);
	gr.lmatches.push(cm);
	gr.new = true;
	c.core.newmatches = 1;
}

/// zsh `strpfx(s, t)`: `s` is a prefix of `t`.
fn strpfx(s: &[u8], t: &[u8]) -> bool {
	t.starts_with(s)
}

/// zsh `strsfx(s, t)`: `s` is a suffix of `t`.
fn strsfx(s: &[u8], t: &[u8]) -> bool {
	t.ends_with(s)
}

/// zsh `pfxlen`.
fn pfxlen(a: &[u8], b: &[u8]) -> usize {
	a.iter().zip(b).take_while(|(x, y)| x == y).count()
}

/// The `-a`/`-k` arrays' elements, one array after the other, skipping
/// empty ones (zsh's `arrays` walk): the next non-empty one.
fn next_array(
	ex: &mut Expander<'_, '_>,
	names: &[BString],
	ni: &mut usize,
	keys: bool,
) -> X<Vec<BString>> {
	while *ni < names.len() {
		let a = get_data_arr(ex, &names[*ni], keys)?;
		*ni += 1;
		if let Some(a) = a
			&& !a.is_empty()
		{
			return Ok(a);
		}
	}
	*ni += 1;
	Ok(Vec::new())
}

/// The paths [`add_match_data`] will look up in `ztat_cache` for this
/// `compadd` (every candidate string with `-f`; a superset), without
/// changing anything: `compadd` stats them first.
///
/// # Errors
/// As the parameter and `singsub` expansions.
pub fn ztat_paths(
	ex: &mut Expander<'_, '_>,
	_c: &Comp,
	dat: &Cadata,
	argv: &[BString],
) -> X<Vec<BString>> {
	if dat.flags & cmf::FILE == 0 {
		return Ok(Vec::new());
	}
	let prpre = match &dat.prpre {
		Some(p) => Some(p.to_vec()),
		None => match &dat.ppre {
			Some(p) => {
				let mut s = singsub(ex, p.to_vec())?;
				untokenize(&mut s);
				Some(s)
			},
			None => None,
		},
	};
	let mut strs = Vec::new();
	if dat.aflags & caf::ARRAYS != 0 {
		for n in argv {
			if let Some(a) = get_data_arr(ex, n, dat.aflags & caf::KEYS != 0)? {
				strs.extend(a);
			}
		}
	} else {
		strs.extend_from_slice(argv);
	}
	Ok(strs
		.into_iter()
		.filter(|s| !s.is_empty() && s.last() != Some(&b'/'))
		.map(|s| {
			let mut pb = prpre
				.clone()
				.filter(|p| !p.is_empty())
				.unwrap_or_else(|| b"./".to_vec());
			pb.extend_from_slice(&s);
			BString::from(pb)
		})
		.collect())
}

/// zsh `addmatches`: `compadd`'s work: select the group, match the
/// strings `argv` (or the arrays they name) against `PREFIX`/`SUFFIX`
/// as the options in `dat` say, and add them (or store them in the
/// `-A`/`-O`/`-D` arrays). 1 when no match was added.
///
/// # Errors
/// As parameter access and pattern matching.
pub fn addmatches(
	ex: &mut Expander<'_, '_>,
	c: &mut Comp,
	dat: &mut Cadata,
	argv: &[BString],
) -> X<i32> {
	let oaq = c.tricky.autoq.clone();
	let (oqp, oqs) = (c.tricky.qipre.clone(), c.tricky.qisuf.clone());
	let (ois, oib) = (c.tricky.instring, c.tricky.inbackt);
	let oms = c.core.mstack.clone();
	let nm = c.core.mnum;
	let ohp = c.core.haspattern;
	let r = addmatches_body(ex, c, dat, argv);
	if matches!(r, Ok(true)) {
		// zsh returns before changing anything else.
		return Ok(1);
	}
	c.core.mstack = oms;
	c.tricky.instring = ois;
	c.tricky.inbackt = oib;
	c.tricky.autoq = oaq;
	c.tricky.qipre = oqp;
	c.tricky.qisuf = oqs;
	r?;
	if c.core.mnum == nm {
		c.core.haspattern = ohp;
	}
	Ok(i32::from(c.core.mnum == nm))
}

/// [`addmatches`] up to the restoring of the globals; `true`: nothing to
/// add at all (zsh's early `return 1`).
#[allow(
	clippy::too_many_lines,
	clippy::cognitive_complexity,
	reason = "a direct port of zsh's addmatches"
)]
fn addmatches_body(
	ex: &mut Expander<'_, '_>,
	c: &mut Comp,
	dat: &mut Cadata,
	argv: &[BString],
) -> X<bool> {
	let oppre = dat.ppre.clone();
	if dat.dummies >= 0 {
		dat.aflags = (dat.aflags | caf::NOSORT | caf::UNIQCON) & !caf::UNIQALL;
	}
	// Select the group in which to store the matches.
	let gflags = (if dat.aflags & caf::NOSORT != 0 {
		cgf::NOSORT
	} else {
		0
	}) | (if dat.aflags & caf::MATSORT != 0 {
		cgf::MATSORT
	} else {
		0
	}) | (if dat.aflags & caf::NUMSORT != 0 {
		cgf::NUMSORT
	} else {
		0
	}) | (if dat.aflags & caf::REVSORT != 0 {
		cgf::REVSORT
	} else {
		0
	}) | (if dat.aflags & caf::UNIQALL != 0 {
		cgf::UNIQALL
	} else {
		0
	}) | (if dat.aflags & caf::UNIQCON != 0 {
		cgf::UNIQCON
	} else {
		0
	});
	endcmgroup(c, None);
	if let Some(g) = dat.group.clone() {
		begcmgroup(c, Some(&g), gflags);
	} else {
		begcmgroup(c, Some(b"default"), 0);
	}
	if dat.mesg.is_some() || dat.exp.is_some() {
		let str = dat
			.mesg
			.clone()
			.or_else(|| dat.exp.clone())
			.unwrap_or_default();
		set_curexpl(c, Some(Cexpl { always: dat.mesg.is_some(), str, count: 0, fcount: 0 }));
		if dat.mesg.is_some() && dat.dpar.is_empty() && dat.opar.is_none() && dat.apar.is_none() {
			addexpl(c, true);
		}
	} else {
		set_curexpl(c, None);
	}
	if argv.is_empty() && dat.dummies == 0 && dat.aflags & caf::ALL == 0 {
		return Ok(true);
	}
	let quote = dat.aflags & caf::QUOTE != 0;
	for bp in &mut c.tricky.brbeg {
		bp.curpos = if quote { bp.pos } else { bp.qpos };
	}
	for bp in &mut c.tricky.brend {
		bp.curpos = if quote { bp.pos } else { bp.qpos };
	}
	if dat.flags & cmf::ISPAR != 0 {
		dat.flags |= u32::try_from(c.core.parflags).unwrap_or(0);
	}
	match c.complete.compquote.clone().filter(|q| !q.is_empty()) {
		Some(cq) if cq[0] == b'`' => {
			c.tricky.instring = i32::from(qt::NONE);
			c.tricky.inbackt = 0;
			c.tricky.autoq = Some(BString::default());
		},
		Some(cq) => {
			match cq[0] {
				b'\'' => c.tricky.instring = i32::from(qt::SINGLE),
				b'"' => c.tricky.instring = i32::from(qt::DOUBLE),
				b'$' => c.tricky.instring = i32::from(qt::DOLLARS),
				_ => {},
			}
			c.tricky.inbackt = 0;
			let q = if cq[0] == b'$' { &cq[1..] } else { &cq[..] };
			c.tricky.autoq = Some(multiquote(ex, c, q, true));
		},
		None => {
			c.tricky.instring = i32::from(qt::NONE);
			c.tricky.inbackt = 0;
			c.tricky.autoq = None;
		},
	}
	c.tricky.qipre = Some(c.complete.compqiprefix.clone().unwrap_or_default());
	c.tricky.qisuf = Some(c.complete.compqisuffix.clone().unwrap_or_default());
	c.core.useexact = i32::from(
		c.complete
			.compexact
			.as_ref()
			.is_some_and(|e| e.as_slice() == b"accept"),
	);

	let doadd = dat.apar.is_none() && dat.opar.is_none() && dat.dpar.is_empty();
	if doadd {
		if dat.aflags & caf::MATCH != 0 {
			c.core.hasmatched = 1;
		} else {
			c.core.hasunmatched = 1;
		}
	}
	let mut aparl: Vec<BString> = Vec::new();
	let mut oparl: Vec<BString> = Vec::new();
	// -D: the arrays (walked along with the matches) and what is kept.
	let mut dparr: Vec<Option<(Vec<BString>, usize)>> = Vec::new();
	let mut dparl: Vec<Vec<BString>> = Vec::new();
	if !dat.dpar.is_empty() {
		let mut darr = 0;
		let mut dparlen = dat.dpar.len();
		while darr < dparlen {
			let raw = unmetafy(&dat.dpar[darr]);
			match crate::bash::vm::zsh::params::getaparam(ex, &raw)? {
				Some(a) if !a.is_empty() => {
					dparr.push(Some((a.iter().map(|e| BString::from(metafy(e))).collect(), 0)));
					dparl.push(Vec::new());
					darr += 1;
				},
				_ => {
					// Swap in the last -D argument.
					dparlen -= 1;
					dat.dpar.swap(darr, dparlen);
					dat.dpar.truncate(dparlen);
				},
			}
		}
	}
	let dpar_on = !dat.dpar.is_empty() || !dparl.is_empty();
	let dpar_next = |dparr: &mut Vec<Option<(Vec<BString>, usize)>>| {
		for d in dparr.iter_mut() {
			if let Some((a, i)) = d {
				*i += 1;
				if *i >= a.len() {
					*d = None;
				}
			}
		}
	};
	// Our matcher on the stack of matchers.
	if let Some(m) = dat.matcher.clone() {
		c.core.mstack = Some(Arc::new(Cmlist {
			next:    c.core.mstack.clone(),
			matcher: Some(m.clone()),
			str:     BString::default(),
		}));
		add_bmatchers(c, Some(&m));
		c.core.matchers.push(m);
	}
	if c.core.mnum != 0 && (c.core.mstack.is_some() || c.core.bmatchers.is_some()) {
		update_bmatchers(c);
	}
	// The suffixes and patterns to ignore (-F).
	let (aign, pign): (Option<Vec<Vec<u8>>>, Option<Vec<Pattern>>) = if let Some(ign) =
		dat.ign.clone()
		&& let Some(a) = get_user_var(ex, Some(&ign))?
	{
		let opts = zpattern::opts(ex)?;
		let (mut sfx, mut pats) = (Vec::new(), Vec::new());
		for t in a {
			let mut tmp = t.to_vec();
			tokenize(&mut tmp);
			remnulargs(&mut tmp);
			let star_q = (at(&tmp, 0) == QUEST && at(&tmp, 1) == STAR)
				|| (at(&tmp, 1) == QUEST && at(&tmp, 0) == STAR);
			if star_q && at(&tmp, 2) != 0 && !haswilds(&mut tmp[2..], &opts) {
				let mut s = tmp[2..].to_vec();
				untokenize(&mut s);
				sfx.push(s);
			} else if let Ok(p) = Pattern::compile(&tmp, PatFlags::NONE, &opts) {
				pats.push(p);
			}
		}
		((!sfx.is_empty()).then_some(sfx), (!pats.is_empty()).then_some(pats))
	} else {
		(None, None)
	};
	// The display strings.
	let mut disp: Disp = match dat.disp.clone() {
		Some(d) => get_user_var(ex, Some(&d))?.map(|v| (v, 0)),
		None => None,
	};
	// The completion variables, when matching.
	let get = |s: &Option<BString>| s.as_ref().map_or_default(|s| s.to_vec());
	let (mut lipre, mut lisuf, mut lpre, mut lsuf) = (None, None, Vec::new(), Vec::new());
	let matching = dat.aflags & caf::MATCH != 0;
	if matching {
		lipre = Some(get(&c.complete.compiprefix));
		lisuf = Some(get(&c.complete.compisuffix));
		lpre = get(&c.complete.compprefix);
		lsuf = get(&c.complete.compsuffix);
		let qil = c.complete.compqiprefix.as_ref().map_or(0, |s| s.len());
		let qisl = c.complete.compqisuffix.as_ref().map_or(0, |s| s.len());
		if i32::try_from(lpre.len() + qil + lipre.as_ref().map_or(0, Vec::len)).unwrap_or(0)
			!= c.core.origlpre
			|| i32::try_from(lsuf.len() + qisl + lisuf.as_ref().map_or(0, Vec::len)).unwrap_or(0)
				!= c.core.origlsuf
		{
			c.core.lenchanged = 1;
		}
		// An existing -P prefix.
		if let Some(pre) = dat.pre.as_ref().filter(|p| !p.is_empty()) {
			let n = pfxlen(pre, &lpre);
			if n == pre.len() || n == lpre.len() {
				lpre.drain(..n);
			}
		}
	}
	// The strings from the command line.
	let cat = |a: Option<Vec<u8>>, b: &Option<BString>| -> Option<BString> {
		match (a, b) {
			(Some(mut a), Some(b)) => {
				a.extend_from_slice(b);
				Some(a.into())
			},
			(None, Some(b)) => Some(b.clone()),
			(Some(a), None) => Some(a.into()),
			(None, None) => None,
		}
	};
	dat.ipre = cat(lipre, &dat.ipre);
	dat.isuf = cat(lisuf, &dat.isuf);
	let lpl = if let Some(p) = dat.ppre.clone() {
		let q = if dat.flags & cmf::FILE != 0 {
			tildequote(ex, c, &p, quote)
		} else {
			multiquote(ex, c, &p, quote)
		};
		let l = q.len();
		dat.ppre = Some(q);
		l
	} else {
		0
	};
	let lsl = if let Some(p) = dat.psuf.clone() {
		let q = multiquote(ex, c, &p, quote);
		let l = q.len();
		dat.psuf = Some(q);
		l
	} else {
		0
	};
	let mut noargs = false;
	let mut obpl = 0usize;
	let mut obsl = 0usize;
	let (mut bcp, mut bcs, mut bpadd, mut bsadd) = (0i32, 0i32, 0i32, 0i32);
	let mut pline: Option<Cl> = None;
	let mut sline: Option<Cl> = None;
	let mut cp: Option<Pattern> = None;
	let patmatch = c.complete.comppatmatch.clone().filter(|p| !p.is_empty());
	if matching {
		let mut globflag: Vec<u8> = Vec::new();
		if patmatch.is_some()
			&& dat.ppre.is_some()
			&& lpre.starts_with(b"(#")
			&& let Some(p) = lpre[2..].iter().position(|&ch| ch == b')')
		{
			let p = p + 2;
			globflag = lpre[..=p].to_vec();
			lpre.drain(..=p);
		}
		if let Some(s) = dat.ppre.clone() {
			let ml = match_str(c, &lpre, &s, Some(&mut obpl), 0, None, false, 0, true);
			if ml >= 0 {
				if let Some(subs) = c.matcher.matchsubs {
					let tmp = get_cline(c, None, 0, None, 0, None, 0, 0);
					c.clines.get_mut(tmp).prefix = Some(subs);
					match c.matcher.matchlastpart {
						Some(lp) => c.clines.get_mut(lp).next = Some(tmp),
						None => c.matcher.matchparts = Some(tmp),
					}
				}
				pline = c.matcher.matchparts;
				let ml = usize::try_from(ml).unwrap_or(0).min(lpre.len());
				lpre.drain(..ml);
				bcp = i32::try_from(ml).unwrap_or(0);
				bpadd = i32::try_from(s.len()).unwrap_or(0) - bcp;
			} else {
				if lpre.len() <= lpl && strpfx(&lpre, &s) {
					lpre.clear();
				} else if lpre.len() > lpl && strpfx(&s, &lpre) {
					lpre.drain(..lpl);
				} else {
					noargs = true;
				}
				bcp = i32::try_from(lpl).unwrap_or(0);
			}
		}
		if let Some(s) = dat.psuf.clone() {
			let ml = match_str(c, &lsuf, &s, Some(&mut obsl), 0, None, true, 0, true);
			if ml >= 0 {
				if let Some(subs) = c.matcher.matchsubs {
					let tmp = get_cline(c, None, 0, None, 0, None, 0, clf::SUF);
					c.clines.get_mut(tmp).suffix = Some(subs);
					match c.matcher.matchlastpart {
						Some(lp) => c.clines.get_mut(lp).next = Some(tmp),
						None => c.matcher.matchparts = Some(tmp),
					}
				}
				let parts = c.matcher.matchparts;
				sline = revert_cline(c, parts);
				let ml = usize::try_from(ml).unwrap_or(0).min(lsuf.len());
				lsuf.truncate(lsuf.len() - ml);
				bcs = i32::try_from(ml).unwrap_or(0);
				bsadd = i32::try_from(s.len()).unwrap_or(0) - bcs;
			} else {
				if lsuf.len() <= lsl && strsfx(&lsuf, &s) {
					lsuf.clear();
				} else if lsuf.len() > lsl && strsfx(&s, &lsuf) {
					lsuf.truncate(lsuf.len() - lsl);
				} else {
					noargs = true;
				}
				bcs = i32::try_from(lsl).unwrap_or(0);
			}
		}
		if let Some(pm) = &patmatch {
			let is = pm[0] == b'*';
			let mut tmp = globflag;
			tmp.extend_from_slice(&lpre);
			let xat = tmp.len();
			if is {
				tmp.push(b'x');
			}
			tmp.extend_from_slice(&lsuf);
			tokenize(&mut tmp);
			let opts = zpattern::opts(ex)?;
			if haswilds(&mut tmp, &opts) {
				if is {
					tmp[xat] = STAR;
				}
				remnulargs(&mut tmp);
				if let Ok(p) = Pattern::compile(&tmp, PatFlags::NONE, &opts) {
					cp = Some(p);
					c.core.haspattern = 1;
				}
			}
		}
	} else if patmatch.is_some() {
		// No matching here, but patterns in what the caller passes as
		// PREFIX/SUFFIX still make this an ambiguous pattern completion.
		let mut tmp = get(&c.complete.compprefix);
		tmp.extend_from_slice(&get(&c.complete.compsuffix));
		tokenize(&mut tmp);
		remnulargs(&mut tmp);
		let opts = zpattern::opts(ex)?;
		if haswilds(&mut tmp, &opts) {
			c.core.haspattern = 1;
		}
	}
	let empty_argv = argv.is_empty();
	if !noargs && !empty_argv {
		if dat.prpre.is_none()
			&& let Some(p) = oppre
		{
			let mut s = singsub(ex, p.to_vec())?;
			untokenize(&mut s);
			dat.prpre = Some(s.into());
		}
		if dat.remf.is_some() {
			dat.rems = None;
		}
		lpre = if !quote && dat.ppre.is_none() && dat.flags & cmf::FILE != 0 {
			tildequote(ex, c, &lpre, true).into()
		} else {
			multiquote(ex, c, &lpre, true).into()
		};
		lsuf = multiquote(ex, c, &lsuf, true).into();
	}
	// Walk through the matches given.
	let keys = dat.aflags & caf::KEYS != 0;
	let arrays = dat.aflags & caf::ARRAYS != 0;
	let mut ni = 0usize;
	let mut list: Cow<'_, [BString]> = if noargs {
		Cow::Borrowed(&[])
	} else if arrays {
		Cow::Owned(next_array(ex, argv, &mut ni, keys)?)
	} else {
		Cow::Borrowed(argv)
	};
	let ppl = dat.ppre.as_ref().map_or(0, |s| s.len());
	let psl = dat.psuf.as_ref().map_or(0, |s| s.len());
	let qu = if quote {
		0
	} else if dat.ppre.is_some() || dat.flags & cmf::FILE == 0 {
		1
	} else {
		2
	};
	let mut li = 0usize;
	// These shell values cannot change while compadd walks its candidates.
	// Read them lazily: ignored candidates and literal matches need no
	// character-class environment.
	let mut pattern_env: Option<zpattern::CharEnvBuf> = None;
	while li < list.len() {
		let s = &list[li];
		'one: {
			let mut bpl = obpl;
			let mut bsl = obsl;
			if disp.is_some() {
				disp_next(&mut disp);
			}
			if aign.is_some() || pign.is_some() {
				let mut ibuf = dat.ppre.as_ref().map_or_default(|p| p.to_vec());
				ibuf.extend_from_slice(s);
				if let Some(p) = &dat.psuf {
					ibuf.extend_from_slice(p);
				}
				let il = ppl + s.len() + psl;
				let mut addit = aign
					.as_ref()
					.is_none_or(|a| !a.iter().any(|t| t.len() < il && ibuf.ends_with(t)));
				if addit && let Some(p) = &pign {
					if pattern_env.is_none() {
						pattern_env = Some(zpattern::char_env(ex)?);
					}
					let env = pattern_env
						.as_ref()
						.expect("character-class environment initialized");
					addit = !p.iter().any(|p| p.matches(&ibuf, &env.env()));
				}
				if !addit {
					c.complete.compignored += 1;
					dpar_next(&mut dparr);
					break 'one;
				}
			}
			let mut lc: Option<Cl> = None;
			let mut isexact = 0;
			let ms: BString = if matching {
				let cp = if let Some(cp) = cp.as_ref() {
					if pattern_env.is_none() {
						pattern_env = Some(zpattern::char_env(ex)?);
					}
					let env = pattern_env
						.as_ref()
						.expect("character-class environment initialized");
					Some((cp, env.env()))
				} else {
					None
				};
				if let Some(ms) = comp_match(
					ex,
					c,
					&lpre,
					Some(&lsuf),
					s,
					cp,
					&mut lc,
					qu,
					&mut bpl,
					bcp,
					&mut bsl,
					bcs,
					&mut isexact,
				) {
					ms
				} else {
					dpar_next(&mut dparr);
					break 'one;
				}
			} else {
				let ms = if quote {
					s.clone()
				} else {
					multiquote(ex, c, s, false)
				};
				lc = Some(bld_parts(c, &ms, i32::try_from(ms.len()).unwrap_or(0), -1, None, None));
				ms
			};
			if doadd {
				for bp in c.tricky.brbeg.iter_mut().skip(obpl) {
					bp.curpos += bpadd;
				}
				for bp in c.tricky.brend.iter_mut().skip(obsl) {
					bp.curpos += bsadd;
				}
				if let Some(a) = add_match_data(
					c,
					false,
					&ms,
					s,
					lc,
					dat.ipre.as_deref().map(|s| s.as_slice()),
					None,
					dat.isuf.as_deref().map(|s| s.as_slice()),
					dat.pre.as_deref().map(|s| s.as_slice()),
					dat.prpre.as_deref().map(|s| s.as_slice()),
					dat.ppre.as_deref().map(|s| s.as_slice()),
					pline,
					dat.psuf.as_deref().map(|s| s.as_slice()),
					sline,
					dat.suf.as_deref().map(|s| s.as_slice()),
					dat.flags,
					isexact,
				) {
					let d = disp_cur(&disp);
					set_added(c, a, |m| {
						m.rems.clone_from(&dat.rems);
						m.remf.clone_from(&dat.remf);
						if d.is_some() {
							m.disp.clone_from(&d);
						}
					});
				}
			} else {
				if dat.apar.is_some() {
					aparl.push(ms.clone());
				}
				if dat.opar.is_some() {
					oparl.push(s.clone());
				}
				for (d, l) in dparr.iter_mut().zip(dparl.iter_mut()) {
					if let Some((a, i)) = d {
						l.push(a[*i].clone());
						*i += 1;
						if *i >= a.len() {
							*d = None;
						}
					}
				}
				free_cline(c, lc);
			}
		}
		// next_array:
		if arrays && li + 1 >= list.len() {
			list = Cow::Owned(next_array(ex, argv, &mut ni, keys)?);
			li = 0;
		} else {
			li += 1;
		}
	}
	if let Some(a) = dat.apar.clone() {
		set_list_array(ex, &a, aparl)?;
	}
	if let Some(o) = dat.opar.clone() {
		set_list_array(ex, &o, oparl)?;
	}
	if dpar_on {
		for (name, l) in dat.dpar.clone().iter().zip(dparl) {
			set_list_array(ex, name, l)?;
		}
	}
	if dat.exp.is_some() {
		addexpl(c, false);
	}
	if c.core.hasallmatch == 0 && dat.aflags & caf::ALL != 0 {
		addmatch(c, b"<all>", dat.flags | cmf::ALL, &mut disp, true);
		c.core.hasallmatch = 1;
	}
	while dat.dummies > 0 {
		dat.dummies -= 1;
		addmatch(c, b"", dat.flags | cmf::DUMMY, &mut disp, false);
	}
	dat.dummies -= 1;
	Ok(false)
}

/// zsh `file_type` of a full `st_mode`.
const fn mode_type(mode: u32) -> u8 {
	match mode & 0o170_000 {
		0o060_000 => b'#',
		0o020_000 => b'%',
		0o040_000 => b'/',
		0o010_000 => b'|',
		0o120_000 => b'@',
		0o140_000 => b'=',
		0o100_000 => {
			if mode & 0o111 != 0 {
				b'*'
			} else {
				b' '
			}
		},
		_ => b'?',
	}
}

/// zsh's `MULTIBYTE_SUPPORT` block of `add_match_data`: bytes of the
/// metafied `str` that are no (complete) UTF-8 character become
/// `$'\ooo'`; `None` when all are fine.
fn quote_invalid(str: &[u8]) -> Option<Vec<u8>> {
	let raw = unmetafy(str);
	if std::str::from_utf8(&raw).is_ok() {
		return None;
	}
	let mut out = Vec::with_capacity(raw.len() * 2);
	let esc = |out: &mut Vec<u8>, b: u8| {
		out.extend_from_slice(b"$'\\");
		out.extend_from_slice(&[b'0' + ((b >> 6) & 7), b'0' + ((b >> 3) & 7), b'0' + (b & 7), b'\'']);
	};
	let mut fs = 0;
	while fs < raw.len() {
		match std::str::from_utf8(&raw[fs..(fs + 4).min(raw.len())]) {
			Ok(s) => {
				let n = s.chars().next().map_or(1, char::len_utf8);
				out.extend_from_slice(&metafy(&raw[fs..fs + n]));
				fs += n;
			},
			Err(e) if e.valid_up_to() > 0 => {
				let n = std::str::from_utf8(&raw[fs..fs + e.valid_up_to()])
					.ok()
					.and_then(|s| s.chars().next())
					.map_or(1, char::len_utf8);
				out.extend_from_slice(&metafy(&raw[fs..fs + n]));
				fs += n;
			},
			Err(e) if e.error_len().is_none() && fs + 4 > raw.len() => {
				// Incomplete at the end: all of it.
				for &b in &raw[fs..] {
					esc(&mut out, b);
				}
				fs = raw.len();
			},
			Err(_) => {
				esc(&mut out, raw[fs]);
				fs += 1;
			},
		}
	}
	Some(out)
}

/// The last node of the cline list at `l`.
fn last(c: &Comp, mut l: Cl) -> Cl {
	while let Some(n) = c.clines.get(l).next {
		l = n;
	}
	l
}

/// zsh `add_match_data`: add the match `str` (from the original `orig`)
/// with its cline list `line` and the affixes to the current group
/// (`alt`: the `fignore`d list), joining its clines into the
/// unambiguous string and noting exact matches. `None` when the brace
/// prefix/suffix of the last completion rules it out.
///
/// # Panics
/// Without a cline list or a current group (zsh dereferences `NULL`).
#[allow(
	clippy::too_many_arguments,
	clippy::too_many_lines,
	reason = "a direct port of zsh's add_match_data"
)]
pub fn add_match_data(
	c: &mut Comp,
	alt: bool,
	str: &[u8],
	orig: &[u8],
	line: Option<Cl>,
	ipre: Option<&[u8]>,
	ripre: Option<&[u8]>,
	isuf: Option<&[u8]>,
	pre: Option<&[u8]>,
	prpre: Option<&[u8]>,
	ppre: Option<&[u8]>,
	pline: Option<Cl>,
	psuf: Option<&[u8]>,
	sline: Option<Cl>,
	suf: Option<&[u8]>,
	flags: u32,
	exact: i32,
) -> Option<Added> {
	let mut line = line.expect("add_match_data without cline");
	let mut sline = sline;
	cline_matched(c, Some(line));
	if pline.is_some() {
		cline_matched(c, pline);
	}
	if sline.is_some() {
		cline_matched(c, sline);
	}
	let qipre = c.tricky.qipre.clone();
	let qisuf = c.tricky.qisuf.clone();
	let len = |s: Option<&[u8]>| s.map_or(0, <[u8]>::len);
	let i32l = |n: usize| i32::try_from(n).unwrap_or(i32::MAX);
	let empty_cl = |c: &Comp, p: Cl| {
		let n = c.clines.get(p);
		n.llen == 0 && n.wlen == 0 && n.olen == 0
	};
	// A cline list for the path suffix etc., appended to the match's.
	let psl = if sline.is_none() { len(psuf) } else { 0 };
	let isl = len(isuf);
	let qisl = len(qisuf.as_deref().map(|s| s.as_slice()));
	let salen = psl + isl + qisl;
	if salen > 0 {
		let mut pp: Option<Cl> = None;
		let mut p = line;
		while let Some(n) = c.clines.get(p).next {
			pp = Some(p);
			p = n;
		}
		let mut sl: Option<Cl> = None;
		if psl > 0 {
			let mut s =
				bld_parts(c, psuf.unwrap_or_default(), i32l(psl), i32l(psl), Some(&mut sl), None);
			if let Some(sl0) = sline.take() {
				let sl2 = cp_cline(c, Some(sl0), true).expect("copy of a cline list");
				let sp = last(c, sl2);
				c.clines.get_mut(sp).next = Some(s);
				s = sl2;
			}
			let pf = c.clines.get(p).flags;
			if pf & (clf::SUF | clf::MID) == 0 && empty_cl(c, p) {
				if let Some(ppfx) = c.clines.get(p).prefix {
					let q = last(c, ppfx);
					c.clines.get_mut(q).next = c.clines.get(s).prefix;
					c.clines.get_mut(s).prefix = Some(ppfx);
					c.clines.get_mut(p).prefix = None;
				}
				c.clines.get_mut(s).flags |= (pf & clf::MATCHED) | clf::MID;
				free_cline(c, Some(p));
				match pp {
					Some(pp) => c.clines.get_mut(pp).next = Some(s),
					None => line = s,
				}
			} else {
				c.clines.get_mut(p).next = Some(s);
			}
		}
		if isl > 0 {
			let mut tsl = None;
			let s = bld_parts(c, isuf.unwrap_or_default(), i32l(isl), i32l(isl), Some(&mut tsl), None);
			if let Some(sl) = sl {
				c.clines.get_mut(sl).next = Some(s);
			} else if let Some(sl0) = sline.take() {
				let sl2 = cp_cline(c, Some(sl0), true).expect("copy of a cline list");
				let sp = last(c, sl2);
				c.clines.get_mut(sp).next = Some(s);
				c.clines.get_mut(p).next = Some(sl2);
			} else {
				c.clines.get_mut(p).next = Some(s);
			}
			sl = tsl;
		}
		if qisl > 0 {
			let q = qisuf.as_ref().map_or(&[][..], |q| q.as_slice());
			let qsl = bld_parts(c, q, i32l(qisl), i32l(qisl), None, None);
			let n = c.clines.get_mut(qsl);
			n.flags |= clf::SUF;
			n.suffix = n.prefix.take();
			if let Some(sl) = sl {
				c.clines.get_mut(sl).next = Some(qsl);
			} else if let Some(sl0) = sline.take() {
				let sl2 = cp_cline(c, Some(sl0), true).expect("copy of a cline list");
				let sp = last(c, sl2);
				c.clines.get_mut(sp).next = Some(qsl);
				c.clines.get_mut(p).next = Some(sl2);
			} else {
				c.clines.get_mut(p).next = Some(qsl);
			}
		}
	} else if let Some(sl0) = sline {
		let p = last(c, line);
		let cp = cp_cline(c, Some(sl0), true);
		c.clines.get_mut(p).next = cp;
	}
	// The prefix: the completion code is much more eager to insert the -P
	// prefix than the -S suffix.
	let qipl = len(qipre.as_deref().map(|s| s.as_slice()));
	let ipl = len(ipre);
	let pl = len(pre);
	let ppl = if pline.is_none() { len(ppre) } else { 0 };
	let palen = qipl + ipl + pl + ppl;
	// Put the list `p` … `lp` before `line`, merging an empty last node's
	// prefix into `line`'s (zsh's repeated block; `mid` adds CLF_MID to
	// the flags that prevent it).
	let prepend = |c: &mut Comp, line: &mut Cl, p: Cl, lp: Cl, mid: bool| {
		let stop = if mid { clf::SUF | clf::MID } else { clf::SUF };
		if let Some(lpp0) = c.clines.get(lp).prefix
			&& c.clines.get(*line).flags & stop == 0
			&& empty_cl(c, lp)
		{
			let lpp = last(c, lpp0);
			c.clines.get_mut(lpp).next = c.clines.get(*line).prefix;
			c.clines.get_mut(*line).prefix = Some(lpp0);
			c.clines.get_mut(lp).prefix = None;
			free_cline(c, Some(lp));
			if p != lp {
				let mut q = p;
				while c.clines.get(q).next != Some(lp) {
					q = c.clines.get(q).next.expect("lp is on the list");
				}
				c.clines.get_mut(q).next = Some(*line);
				*line = p;
			}
		} else {
			c.clines.get_mut(lp).next = Some(*line);
			*line = p;
		}
	};
	let parts = |c: &mut Comp, s: &[u8]| {
		let mut lp = None;
		let p = bld_parts(c, s, i32l(s.len()), i32l(s.len()), Some(&mut lp), None);
		(p, lp.unwrap_or(p))
	};
	if pl > 0 {
		if ppl > 0 || pline.is_some() {
			let (p, lp) = if let Some(pline) = pline {
				let p = cp_cline(c, Some(pline), true).expect("copy of a cline list");
				(p, last(c, p))
			} else {
				parts(c, ppre.unwrap_or_default())
			};
			prepend(c, &mut line, p, lp, true);
		}
		for s in [pre, ipre, qipre.as_deref().map(|s| s.as_slice())] {
			if let Some(s) = s.filter(|s| !s.is_empty()) {
				let (p, lp) = parts(c, s);
				c.clines.get_mut(lp).next = Some(line);
				line = p;
			}
		}
	} else if palen > 0 || pline.is_some() {
		let (p, lp) = if palen > 0 {
			let mut apre = Vec::with_capacity(palen);
			apre.extend_from_slice(qipre.as_deref().map_or(&[][..], |s| s.as_slice()));
			apre.extend_from_slice(ipre.unwrap_or_default());
			apre.extend_from_slice(pre.unwrap_or_default());
			if ppl > 0 {
				apre.extend_from_slice(ppre.unwrap_or_default());
			}
			let (p, mut lp) = parts(c, &apre);
			if let Some(pline) = pline {
				let cp = cp_cline(c, Some(pline), true);
				c.clines.get_mut(lp).next = cp;
				lp = last(c, lp);
			}
			(p, lp)
		} else {
			let p = cp_cline(c, pline, true).expect("copy of a cline list");
			(p, last(c, p))
		};
		prepend(c, &mut line, p, lp, false);
	}
	let str: Vec<u8> = quote_invalid(str).unwrap_or_else(|| str.to_vec());
	let stl = str.len();
	let nonempty = |s: Option<&[u8]>| s.filter(|s| !s.is_empty()).map(BString::from);
	let cat = |a: &[u8], b: &[u8]| {
		let mut v = Vec::with_capacity(a.len() + b.len());
		v.extend_from_slice(a);
		v.extend_from_slice(b);
		BString::from(v)
	};
	let qipre_ne = qipre.filter(|s| !s.is_empty());
	let qisuf_ne = qisuf.filter(|s| !s.is_empty());
	let mut cm = Cmatch {
		str: BString::from(str),
		orig: Some(BString::from(orig)),
		ppre: nonempty(ppre),
		psuf: nonempty(psuf),
		prpre: if flags & cmf::FILE != 0 {
			nonempty(prpre)
		} else {
			None
		},
		ipre: match qipre_ne {
			Some(q) => Some(match ipre.filter(|s| !s.is_empty()) {
				Some(i) => cat(&q, i),
				None => q,
			}),
			None => nonempty(ipre),
		},
		ripre: nonempty(ripre),
		isuf: match qisuf_ne {
			Some(q) => Some(match isuf.filter(|s| !s.is_empty()) {
				Some(i) => cat(i, &q),
				None => q,
			}),
			None => nonempty(isuf),
		},
		pre: pre.map(BString::from),
		suf: suf.map(BString::from),
		flags: flags | listflags(c),
		..Cmatch::default()
	};
	if flags & cmf::FILE != 0 && !orig.is_empty() && orig.last() != Some(&b'/') {
		let mut pb = cm
			.prpre
			.as_ref()
			.map_or_else(|| b"./".to_vec(), |p| p.to_vec());
		pb.extend_from_slice(orig);
		if let Some(&(l, s)) = c.core.ztat_cache.get(pb.as_slice()) {
			if let Some(m) = l {
				cm.mode = m;
				cm.modec = Some(mode_type(m)).filter(|&t| t != b' ').unwrap_or(0);
			}
			if let Some(m) = s {
				cm.fmode = m;
				cm.fmodec = Some(mode_type(m)).filter(|&t| t != b' ').unwrap_or(0);
			}
		}
	}
	let stack = c
		.complete
		.compqstack
		.as_ref()
		.map_or(&[][..], |s| s.as_slice());
	if (at(stack, 0) == qt::BACKSLASH && stack.len() > 1)
		|| (c.tricky.autoq.is_some() && !stack.is_empty() && at(stack, 1) == qt::BACKSLASH)
	{
		cm.flags |= cmf::NOSPACE;
	}
	cm.brpl = (c.tricky.nbrbeg != 0).then(|| c.tricky.brbeg.iter().map(|b| b.curpos).collect());
	cm.brsl = (c.tricky.nbrend != 0).then(|| c.tricky.brend.iter().map(|b| b.curpos).collect());
	cm.qipl = i32l(qipl);
	cm.qisl = i32l(qisl);
	cm.autoq = c
		.tricky
		.autoq
		.clone()
		.or_else(|| (c.tricky.inbackt != 0).then(|| BString::from("`")));
	if c.tricky.lastprebr.is_some() || c.tricky.lastpostbr.is_some() {
		let (pre, post) = (c.tricky.lastprebr.clone(), c.tricky.lastpostbr.clone());
		if !hasbrpsfx(
			c,
			&cm,
			pre.as_deref().map(|s| s.as_slice()),
			post.as_deref().map(|s| s.as_slice()),
		) {
			return None;
		}
	}
	// The unambiguous cline list.
	let aline = ai(c, alt).line;
	let joined = join_clines(c, aline, Some(line));
	ai(c, alt).line = joined;
	c.core.mnum += 1;
	ai(c, alt).count += 1;
	let g = c
		.core
		.mgroup
		.expect("add_match_data without a current group");
	let lpl = cm.ppre.as_ref().map_or(0, |s| s.len());
	let lsl = cm.psuf.as_ref().map_or(0, |s| s.len());
	let ml = i32l(stl + lpl + lsl);
	let gr = c.groups.get_mut(g);
	let list = if alt {
		&mut gr.lfmatches
	} else {
		&mut gr.lmatches
	};
	let i = list.len();
	gr.new = true;
	c.core.newmatches = 1;
	if alt {
		c.complete.compignored += 1;
	}
	if c
		.complete
		.complastprompt
		.as_ref()
		.is_none_or(|s| s.is_empty())
	{
		c.core.dolastprompt = 0;
	}
	if let Some(e) = curexpl_mut(c) {
		if alt {
			e.fcount += 1;
		} else {
			e.count += 1;
		}
	}
	let mut added = Added { g, alt, i, firstm: false, exactm: false };
	if ai(c, alt).firstm.is_none() {
		ai(c, alt).firstm = Some(Box::new(cm.clone()));
		added.firstm = true;
	}
	c.core.minmlen = c.core.minmlen.min(ml);
	c.core.maxmlen = c.core.maxmlen.max(ml);
	// An exact match? More than one?
	if exact != 0 {
		let useexact = c.core.useexact;
		if ai(c, alt).exact == 0 {
			ai(c, alt).exact = useexact;
			if c.incompfunc != 0
				&& c
					.complete
					.compexactstr
					.as_ref()
					.is_none_or(|s| s.is_empty())
			{
				let mut e = cm.ppre.as_ref().map_or_default(|s| s.to_vec());
				e.extend_from_slice(&cm.str);
				if let Some(p) = &cm.psuf {
					e.extend_from_slice(p);
				}
				c.complete.compexactstr = Some(e.into());
				complete::comp_setunset(c, 0, 0, complete::CP_EXACTSTR, 0);
			}
			ai(c, alt).exactm = Some(Box::new(cm.clone()));
			added.exactm = true;
		} else if useexact != 0
			&& ai(c, alt)
				.exactm
				.as_deref()
				.is_none_or(|e| !matcheq(&cm, e))
		{
			let a = ai(c, alt);
			a.exact = 2;
			a.exactm = None;
			if c.incompfunc != 0 {
				complete::comp_setunset(c, 0, 0, 0, complete::CP_EXACTSTR);
			}
		}
	}
	// Only firstm/exactm need independent copies. The group owns the
	// original match, rather than cloning every candidate into its list.
	let gr = c.groups.get_mut(g);
	let list = if alt {
		&mut gr.lfmatches
	} else {
		&mut gr.lmatches
	};
	list.push(cm);
	Some(added)
}
