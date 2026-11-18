//! compcore.c: sorting and deduplicating a group's matches (`matchcmp`,
//! `matcheq`, `makearray`), the permanent copies of the groups
//! (`dupmatch`, `permmatches`) and freeing them (`freematches`).

use std::cmp::Ordering;

use super::super::{
	Comp, isset,
	types::{Cexpl, Cmatch, Cmgroup, GId, cgf, cmf},
};
use crate::{
	bash::{
		syntax::zsh::tok::unmetafy,
		vm::{expand::Expander, zsh::params::collator_in},
		zshopt::ZshOpt,
	},
	sys::langinfo::Collator,
};

/// zsh `zstrcmp(as, bs, SORTIT_IGNORING_BACKSLASHES | (numeric ?
/// SORTIT_NUMERICALLY : 0))` (sort.c `eltpcmp`) on metafied strings:
/// backslashes skipped in the common prefix, then `strcoll` (`coll`;
/// bytes in the `C` locale), numbers compared as numbers.
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's eltpcmp")]
fn zstrcmp(a: &[u8], b: &[u8], numeric: bool, coll: Option<&Collator>) -> Ordering {
	let (a, b) = (unmetafy(a), unmetafy(b));
	let ca = |k: usize| a.get(k).copied().unwrap_or(0);
	let cb = |k: usize| b.get(k).copied().unwrap_or(0);
	let (mut i, mut j) = (0usize, 0usize);
	while ca(i) != 0 && cb(j) != 0 {
		if ca(i) == b'\\' {
			i += 1;
		}
		if cb(j) == b'\\' {
			j += 1;
		}
		if ca(i) != cb(j) || ca(i) == 0 {
			break;
		}
		i += 1;
		j += 1;
	}
	// strcoll(as, bs): up to a NUL, as C sees the strings.
	let cstr = |s: &[u8], k: usize| -> Vec<u8> {
		let t = &s[k.min(s.len())..];
		t[..t.iter().position(|&c| c == 0).unwrap_or(t.len())].to_vec()
	};
	let (sa, sb) = (cstr(&a, i), cstr(&b, j));
	let mut cmp = match coll {
		Some(c) => c.key(&sa).cmp(&c.key(&sb)),
		None => sa.cmp(&sb),
	};
	if numeric {
		let dig = |c: u8| c.is_ascii_digit();
		while ca(i) == cb(j) && ca(i) != 0 {
			i += 1;
			j += 1;
		}
		if dig(ca(i)) || dig(cb(j)) {
			while i > 0 && j > 0 && dig(ca(i - 1)) {
				i -= 1;
				j -= 1;
			}
			if dig(ca(i)) && dig(cb(j)) {
				while ca(i) == b'0' {
					i += 1;
				}
				while cb(j) == b'0' {
					j += 1;
				}
				while dig(ca(i)) && ca(i) == cb(j) {
					i += 1;
					j += 1;
				}
				if dig(ca(i)) || dig(cb(j)) {
					cmp = ca(i).cmp(&cb(j));
					while dig(ca(i)) && dig(cb(j)) {
						i += 1;
						j += 1;
					}
					if dig(ca(i)) && !dig(cb(j)) {
						return Ordering::Greater;
					}
					if dig(cb(j)) && !dig(ca(i)) {
						return Ordering::Less;
					}
				}
			}
		}
	}
	cmp
}

/// zsh `matchcmp`: the sort order of matches under the group flags
/// `matchorder` (`CGF_MATSORT`, `CGF_NUMSORT`, `CGF_REVSORT`);
/// `numericglobsort` is the `NUMERIC_GLOB_SORT` option, `coll` the
/// `LC_COLLATE` collation (`None`: the `C` locale).
pub fn matchcmp(
	a: &Cmatch,
	b: &Cmatch,
	matchorder: u32,
	numericglobsort: bool,
	coll: Option<&Collator>,
) -> Ordering {
	let cmp = i32::from(b.disp.is_some()) - i32::from(a.disp.is_some());
	let (as_, bs): (&[u8], &[u8]) =
		if matchorder & cgf::MATSORT != 0 || (cmp == 0 && a.disp.is_none()) {
			(&a.str, &b.str)
		} else {
			if cmp != 0 {
				// Matches with display strings come first.
				return cmp.cmp(&0);
			}
			let cmp = i64::from(b.flags & cmf::DISPLINE) - i64::from(a.flags & cmf::DISPLINE);
			if cmp != 0 {
				// One-per-line display strings first.
				return cmp.cmp(&0);
			}
			(a.disp.as_deref().map_or(&[][..], |s| s), b.disp.as_deref().map_or(&[][..], |s| s))
		};
	let o = zstrcmp(as_, bs, numericglobsort || matchorder & cgf::NUMSORT != 0, coll);
	if matchorder & cgf::REVSORT != 0 {
		o.reverse()
	} else {
		o
	}
}

/// zsh `matcheq`: whether two matches put the same strings on the line.
pub fn matcheq(a: &Cmatch, b: &Cmatch) -> bool {
	a.ipre == b.ipre
		&& a.pre == b.pre
		&& a.ppre == b.ppre
		&& a.psuf == b.psuf
		&& a.suf == b.suf
		&& a.str == b.str
}

/// What [`makearray`] made.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Made {
	/// The array: indices into the list, in order.
	pub idx: Vec<usize>,
	/// zsh `*np`: its length.
	pub n:   i32,
	/// zsh `*nlp`: the `CMF_NOLIST`/`CMF_MULT` elements.
	pub nl:  i32,
	/// zsh `*llp`: display strings on lines of their own.
	pub ll:  i32,
}

/// zsh `makearray(l, 1, flags, …)`: the group's match list `l` as an
/// array, sorted and deduplicated as the group flags say. As in C the
/// flags of the list's matches are changed (`CMF_MULT`, `CMF_FMULT`,
/// `CMF_DELETE`), which later calls see. (`makearray(l, 0, 0, …)` for
/// explanations is a plain copy: see [`permmatches`].)
#[allow(clippy::too_many_lines, reason = "a direct port of zsh's makearray")]
pub fn makearray(
	l: &mut [Cmatch],
	flags: u32,
	numericglobsort: bool,
	coll: Option<&Collator>,
) -> Made {
	let mut rp: Vec<usize> = (0..l.len()).collect();
	let mut n = l.len();
	let (mut nl, mut ll) = (0, 0);
	// zsh's consecutive-duplicate pass (sorted, or `-1` unsorted).
	let uniq_consecutive = |l: &mut [Cmatch], rp: &mut Vec<usize>, n: &mut usize| {
		let mut out = Vec::with_capacity(rp.len());
		let mut ap = 0;
		while ap < rp.len() {
			out.push(rp[ap]);
			let mut bp = ap;
			while bp + 1 < rp.len() && matcheq(&l[rp[ap]], &l[rp[bp + 1]]) {
				bp += 1;
				*n -= 1;
			}
			ap = bp;
			// Mark those that would show the same string in the list.
			let mut dup = false;
			while bp + 1 < rp.len()
				&& l[rp[ap]].disp.is_none()
				&& l[rp[bp + 1]].disp.is_none()
				&& l[rp[ap]].str == l[rp[bp + 1]].str
			{
				l[rp[bp + 1]].flags |= cmf::MULT;
				dup = true;
				bp += 1;
			}
			if dup {
				l[rp[ap]].flags |= cmf::FMULT;
			}
			ap += 1;
		}
		*rp = out;
	};
	if n > 0 {
		if flags & cgf::NOSORT == 0 {
			rp.sort_by(|&a, &b| matchcmp(&l[a], &l[b], flags, numericglobsort, coll));
			// Sorted, so `-1` is a no-op: only `-2` keeps duplicates.
			if flags & cgf::UNIQCON == 0 {
				uniq_consecutive(l, &mut rp, &mut n);
			}
		} else if flags & cgf::UNIQALL == 0 && flags & cgf::UNIQCON == 0 {
			// Remove all duplicates: sort a copy, mark, then delete.
			let mut del = false;
			let mut sp = rp.clone();
			sp.sort_by(|&a, &b| matchcmp(&l[a], &l[b], flags, numericglobsort, coll));
			// zsh moves `sp` itself in the inner loop (`bp = ++sp`); `base`
			// is that pointer, `asp` runs independently.
			let mut base = 0usize;
			let mut asp = 1usize;
			while asp < sp.len() {
				let ap = asp - 1;
				let mut bp = asp;
				if matcheq(&l[sp[ap]], &l[sp[bp]]) {
					l[sp[bp]].flags = cmf::DELETE;
					del = true;
				} else if l[sp[ap]].disp.is_none() {
					let mut dup = false;
					while bp < sp.len() && l[sp[bp]].disp.is_none() && l[sp[ap]].str == l[sp[bp]].str {
						l[sp[bp]].flags |= cmf::MULT;
						dup = true;
						base += 1;
						bp = base;
					}
					if dup {
						l[sp[ap]].flags |= cmf::FMULT;
					}
				}
				asp += 1;
			}
			if del {
				rp.retain(|&i| {
					let keep = l[i].flags & cmf::DELETE == 0;
					if !keep {
						n -= 1;
					}
					keep
				});
			}
		} else if flags & cgf::UNIQCON == 0 {
			uniq_consecutive(l, &mut rp, &mut n);
		}
		for &i in &rp {
			if l[i].disp.is_some() && l[i].flags & cmf::DISPLINE != 0 {
				ll += 1;
			}
			if l[i].flags & (cmf::NOLIST | cmf::MULT) != 0 {
				nl += 1;
			}
		}
	}
	Made { idx: rp, n: i32::try_from(n).unwrap_or(i32::MAX), nl, ll }
}

/// zsh `dupmatch`: the permanent copy of a match (the brace position
/// arrays keep their first `nbeg`/`nend` entries).
pub fn dupmatch(m: &Cmatch, nbeg: i32, nend: i32) -> Cmatch {
	let cut = |v: &Option<Vec<i32>>, n: i32| {
		v.as_ref().map(|v| {
			v.iter()
				.copied()
				.take(usize::try_from(n).unwrap_or(0))
				.collect()
		})
	};
	Cmatch { brpl: cut(&m.brpl, nbeg), brsl: cut(&m.brsl, nend), ..m.clone() }
}

/// zsh `permmatches`: make the permanent copies (`pmatches`) of the groups
/// built so far (`amatches`), only of groups that changed; 1 when only
/// matches ignored by `fignore` are there (`last`: switch `ainfo` to
/// `fainfo` then).
pub fn permmatches(ex: &mut Expander<'_, '_>, c: &mut Comp, last: i32) -> i32 {
	let ngs = isset(ex, ZshOpt::Numericglobsort);
	let coll = collator_in(&mut ex.k.root, ex.cx.store, ex.vp);
	permmatches_with(c, last, ngs, coll.as_ref())
}

/// [`permmatches`] with `NUMERIC_GLOB_SORT` and the collation given.
pub fn permmatches_with(
	c: &mut Comp,
	last: i32,
	numericglobsort: bool,
	coll: Option<&Collator>,
) -> i32 {
	let ofi = c.core.fi;
	if c.core.pmatches.is_some() && c.core.newmatches == 0 {
		if last != 0 && c.core.fi != 0 {
			c.core.ainfo = c.core.fainfo.clone();
		}
		return c.core.fi;
	}
	c.core.newmatches = 0;
	c.core.fi = 0;
	c.core.pmatches = None;
	c.core.lmatches = None;
	c.core.nmatches = 0;
	c.core.smatches = 0;
	c.core.diffmatches = 0;
	if c.core.ainfo.as_ref().is_none_or(|a| a.count == 0) {
		if last != 0 {
			c.core.ainfo = c.core.fainfo.clone();
		}
		c.core.fi = 1;
	}
	let fi = c.core.fi;
	let (nbrbeg, nbrend) = (c.tricky.nbrbeg, c.tricky.nbrend);
	let mut gn = 1;
	let mut g = c.core.amatches;
	while let Some(gid) = g {
		let gr = c.groups.get(gid);
		if let Some(perm) = gr.perm
			&& fi == ofi
			&& !gr.new
		{
			let (mcount, lcount) = (gr.mcount, gr.lcount);
			if c.core.lmatches.is_none() {
				c.core.lmatches = Some(perm);
			}
			if let Some(p) = c.core.pmatches {
				c.groups.get_mut(p).prev = Some(perm);
			}
			let pm = c.core.pmatches;
			let pg = c.groups.get_mut(perm);
			pg.next = pm;
			pg.prev = None;
			c.core.pmatches = Some(perm);
			c.core.nmatches += mcount;
			c.core.smatches += lcount;
			if mcount > 1 {
				c.core.diffmatches = 1;
			}
			c.groups.get_mut(gid).num = gn;
			gn += 1;
		} else {
			let gr = c.groups.get_mut(gid);
			let flags = gr.flags;
			let list = if fi != 0 {
				&mut gr.lfmatches
			} else {
				&mut gr.lmatches
			};
			let made = makearray(list, flags, numericglobsort, coll);
			let arr: Vec<Cmatch> = made.idx.iter().map(|&i| list[i].clone()).collect();
			gr.matches = arr;
			gr.mcount = made.n;
			gr.lcount = (made.n - made.nl).max(0);
			gr.llcount = made.ll;
			if let Some(y) = &gr.ylist {
				gr.lcount = i32::try_from(y.len()).unwrap_or(i32::MAX);
				c.core.smatches = 2;
			}
			gr.expls = gr.lexpls.clone();
			gr.ecount = i32::try_from(gr.expls.len()).unwrap_or(i32::MAX);
			gr.ccount = 0;
			let (mcount, lcount) = (gr.mcount, gr.lcount);
			c.core.nmatches += mcount;
			c.core.smatches += lcount;
			if mcount > 1 {
				c.core.diffmatches = 1;
			}
			if let Some(old) = c.groups.get(gid).perm {
				c.groups.get_mut(old).next = None;
				freematches(c, Some(old), false);
			}
			let gr = c.groups.get(gid);
			let n = Cmgroup {
				num: gn,
				flags: gr.flags,
				mcount: gr.mcount,
				name: gr.name.clone(),
				matches: gr
					.matches
					.iter()
					.map(|m| dupmatch(m, nbrbeg, nbrend))
					.collect(),
				lcount: gr.lcount,
				llcount: gr.llcount,
				ylist: gr.ylist.clone(),
				ecount: gr.ecount,
				expls: gr
					.expls
					.iter()
					.map(|o| Cexpl {
						count:  if fi != 0 { o.fcount } else { o.count },
						always: o.always,
						fcount: 0,
						str:    o.str.clone(),
					})
					.collect(),
				widths: None,
				next: c.core.pmatches,
				prev: None,
				..Cmgroup::default()
			};
			gn += 1;
			let nid = c.groups.alloc(n);
			c.groups.get_mut(gid).perm = Some(nid);
			if c.core.lmatches.is_none() {
				c.core.lmatches = Some(nid);
			}
			if let Some(p) = c.core.pmatches {
				c.groups.get_mut(p).prev = Some(nid);
			}
			c.core.pmatches = Some(nid);
		}
		let gr = c.groups.get_mut(gid);
		gr.new = false;
		g = gr.next;
	}
	let mut mn = 1;
	let mut first: Option<GId> = None;
	let ids: Vec<GId> = c.groups.list(c.core.pmatches).collect();
	for gid in ids {
		let gr = c.groups.get_mut(gid);
		gr.nbrbeg = nbrbeg;
		gr.nbrend = nbrend;
		for (rn, m) in gr.matches.iter_mut().enumerate() {
			m.rnum = i32::try_from(rn + 1).unwrap_or(i32::MAX);
			m.gnum = mn;
			mn += 1;
		}
		if c.core.diffmatches == 0 && !c.groups.get(gid).matches.is_empty() {
			match first {
				Some(p) => {
					if !matcheq(&c.groups.get(gid).matches[0], &c.groups.get(p).matches[0]) {
						c.core.diffmatches = 1;
					}
				},
				None => first = Some(gid),
			}
		}
	}
	c.core.hasperm = 1;
	c.core.permmnum = mn - 1;
	c.core.permgnum = gn - 1;
	c.core.listdat.valid = false;
	fi
}

/// zsh `freematches`: free the groups of the list starting at `g`
/// (following `next`); `cm` also forgets the menu's current match.
pub fn freematches(c: &mut Comp, g: Option<GId>, cm: bool) {
	let mut g = g;
	while let Some(id) = g {
		g = c.groups.get(id).next;
		c.groups.free(id);
	}
	if cm {
		c.core.minfo.cur = None;
	}
}

#[cfg(test)]
mod tests {
	use bstr::BString;

	use super::*;
	use crate::bash::vm::zle::comp::types::Aminfo;

	fn m(s: &str) -> Cmatch {
		Cmatch { str: BString::from(s), ..Cmatch::default() }
	}

	/// zsh `begcmgroup(name, flags)` of a fresh group, by hand.
	fn group(c: &mut Comp, name: &str, flags: u32, l: Vec<Cmatch>, fl: Vec<Cmatch>) -> GId {
		let g = c.groups.alloc(Cmgroup {
			name: Some(BString::from(name)),
			flags,
			lmatches: l,
			lfmatches: fl,
			new: true,
			next: c.core.amatches,
			..Cmgroup::default()
		});
		if let Some(a) = c.core.amatches {
			c.groups.get_mut(a).prev = Some(g);
		}
		c.core.amatches = Some(g);
		g
	}

	fn strs(l: &[Cmatch], made: &Made) -> Vec<String> {
		made.idx.iter().map(|&i| l[i].str.to_string()).collect()
	}

	#[test]
	fn sorted_dedup_and_mult() {
		let mut l = vec![m("b"), m("a"), m("b"), Cmatch { pre: Some("x".into()), ..m("a") }];
		let made = makearray(&mut l, 0, false, None);
		assert_eq!(strs(&l, &made), ["a", "a", "b"]);
		assert_eq!((made.n, made.nl, made.ll), (3, 1, 0));
		// The first "a" is FMULT, the other (different prefix) MULT.
		let fl: Vec<u32> = made
			.idx
			.iter()
			.map(|&i| l[i].flags & (cmf::MULT | cmf::FMULT))
			.collect();
		assert_eq!(fl, [cmf::FMULT, cmf::MULT, 0]);
	}

	#[test]
	fn numeric_reverse_and_matsort() {
		let mut l = vec![m("a10"), m("a9"), m("a100")];
		let made = makearray(&mut l, cgf::NUMSORT, false, None);
		assert_eq!(strs(&l, &made), ["a9", "a10", "a100"]);
		let mut l = vec![m("a10"), m("a9"), m("a100")];
		let made = makearray(&mut l, 0, false, None);
		assert_eq!(strs(&l, &made), ["a10", "a100", "a9"]);
		let made = makearray(&mut l, cgf::REVSORT | cgf::NUMSORT, false, None);
		assert_eq!(strs(&l, &made), ["a100", "a10", "a9"]);
		// Display strings sort first, by display string unless MATSORT.
		let mut l = vec![m("a"), Cmatch { disp: Some("z".into()), ..m("c") }, Cmatch {
			disp: Some("y".into()),
			..m("d")
		}];
		let made = makearray(&mut l, 0, false, None);
		assert_eq!(strs(&l, &made), ["d", "c", "a"]);
		let made = makearray(&mut l, cgf::MATSORT, false, None);
		assert_eq!(strs(&l, &made), ["a", "c", "d"]);
	}

	#[test]
	fn backslashes_skipped_only_while_equal() {
		// zsh 5.9, LC_ALL=C (Y01 c017).
		let want = [r"\!foo", r"\#foo", "Afoo", r"\\foo", "bfoo", r"\|foo", r"\~foo"];
		let mut l: Vec<Cmatch> = want.iter().rev().map(|s| m(s)).collect();
		let made = makearray(&mut l, 0, false, None);
		assert_eq!(strs(&l, &made), want);
		// Numbers: "a19" < "a100" once the common "a1" is passed.
		let mut l = vec![m("a100"), m("a19")];
		let made = makearray(&mut l, cgf::NUMSORT, false, None);
		assert_eq!(strs(&l, &made), ["a19", "a100"]);
	}

	#[test]
	fn unsorted_uniq_modes() {
		let mut l = vec![m("b"), m("a"), m("b"), m("a")];
		let made = makearray(&mut l, cgf::NOSORT, false, None);
		assert_eq!(strs(&l, &made), ["b", "a"]);
		assert_eq!(made.n, 2);
		let mut l = vec![m("b"), m("b"), m("a"), m("b")];
		let made = makearray(&mut l, cgf::NOSORT | cgf::UNIQALL, false, None);
		assert_eq!(strs(&l, &made), ["b", "a", "b"]);
		let mut l = vec![m("b"), m("b")];
		let made = makearray(&mut l, cgf::NOSORT | cgf::UNIQCON, false, None);
		assert_eq!(strs(&l, &made), ["b", "b"]);
		let mut l = vec![m("b"), m("b")];
		let made = makearray(&mut l, cgf::UNIQCON, false, None);
		assert_eq!(strs(&l, &made), ["b", "b"]);
	}

	#[test]
	fn permmatches_groups() {
		let mut c = Comp::default();
		c.core.ainfo = Some(Box::new(Aminfo { count: 3, ..Aminfo::default() }));
		c.core.fainfo = Some(Box::default());
		group(&mut c, "g1", 0, vec![m("y"), m("x")], vec![]);
		group(&mut c, "g2", cgf::NOSORT, vec![m("q")], vec![]);
		c.core.newmatches = 1;
		assert_eq!(permmatches_with(&mut c, 1, false, None), 0);
		assert_eq!(
			(c.core.nmatches, c.core.diffmatches, c.core.permmnum, c.core.permgnum),
			(3, 1, 3, 2)
		);
		let groups: Vec<GId> = c.groups.list(c.core.pmatches).collect();
		assert_eq!(groups.len(), 2);
		// pmatches lists the groups in creation order (amatches is newest first).
		let first = c.groups.get(groups[0]);
		assert_eq!(first.name.as_ref().map(|s| s.as_slice()), Some(&b"g1"[..]));
		let s: Vec<_> = first
			.matches
			.iter()
			.map(|m| (m.str.to_string(), m.rnum, m.gnum))
			.collect();
		assert_eq!(s, [("x".into(), 1, 1), ("y".into(), 2, 2)]);
		assert_eq!(c.groups.get(groups[1]).matches[0].gnum, 3);
		// Unchanged: the same permanent groups are reused.
		c.core.newmatches = 1;
		c.core.pmatches = None;
		assert_eq!(permmatches_with(&mut c, 1, false, None), 0);
		assert_eq!(c.groups.list(c.core.pmatches).collect::<Vec<_>>(), groups);
		// Only ignored matches: fainfo, the lfmatches.
		let mut c = Comp::default();
		c.core.ainfo = Some(Box::default());
		c.core.fainfo = Some(Box::new(Aminfo { count: 1, ..Aminfo::default() }));
		group(&mut c, "default", 0, vec![], vec![m("ign.o")]);
		c.core.newmatches = 1;
		assert_eq!(permmatches_with(&mut c, 1, false, None), 1);
		assert_eq!(c.core.ainfo.as_ref().unwrap().count, 1);
		assert_eq!(c.core.nmatches, 1);
		let h = c.core.pmatches;
		freematches(&mut c, h, true);
	}
}
