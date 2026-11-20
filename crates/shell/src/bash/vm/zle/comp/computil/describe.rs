//! `compdescribe`: lay out matches with descriptions for `_describe`
//! (computil.c `cd_*`, `bin_compdescribe`).
//!
//! The C code links strings through `next`/`other`/`run` pointers; here
//! they are indexes into [`CdState::strs`]. Grouped descriptions sort by
//! `LC_COLLATE`, as `cd_sort` does, rather than by the display bytes.

use std::collections::VecDeque;

use bstr::{BStr, BString, ByteSlice};
use serde::{Deserialize, Serialize};

use super::{
	atoi, fin, gate, get_user_var, getaparam, load, rembslash, save, setaparam, setsparam, warn,
};
use crate::{
	bash::{
		store::MiscKey,
		vm::{
			builtins::{
				Ctx, Need, R, done,
				zsh_args::Ops,
				zsh_print::charset,
				zsh_quote::{Charset, niceformat},
			},
			zsh::{params::collator_in, wcwidth::wcwidth},
		},
	},
	sys::langinfo::Collator,
};

/// zsh `CM_SPACE`: columns between list entries.
const CM_SPACE: i64 = 2;

/// What a run reports (zsh `CRT_*`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
enum RunType {
	/// Matches without descriptions.
	Simple,
	/// Matches with descriptions, one per line.
	Desc,
	/// One match of a group of matches sharing a description.
	Spec,
	/// Empty slots of a group column.
	Dummy,
	/// The descriptions of the groups.
	Expl,
}

/// zsh `struct cdstr`.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Cdstr {
	/// Next in its set.
	next:    Option<usize>,
	/// The string to display.
	str:     BString,
	/// The description.
	desc:    Option<BString>,
	/// The match to add.
	mat:     BString,
	/// `str`'s `LC_COLLATE` key, or its bytes in the C locale.
	sortstr: BString,
	/// Length of `str` when it was read.
	len:     usize,
	/// Its screen width.
	width:   i64,
	/// Next string with the same description.
	other:   Option<usize>,
	/// 0: not in a group, 1: the first, 2: another.
	kind:    u8,
	/// The set it is in.
	set:     usize,
	/// Next in its run.
	run:     Option<usize>,
}

/// zsh `struct cdset`.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Cdset {
	/// The `compadd` options.
	opts:  Vec<BString>,
	/// The first string.
	strs:  Option<usize>,
	/// Number of strings.
	count: usize,
	/// Number of strings with a description.
	desc:  usize,
}

/// zsh `struct cdrun`.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Cdrun {
	ty:    RunType,
	strs:  Option<usize>,
	count: usize,
}

/// zsh `struct cdstate`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct CdState {
	showd:   bool,
	sep:     BString,
	slen:    i64,
	swidth:  i64,
	maxmlen: i64,
	sets:    Vec<Cdset>,
	pre:     i64,
	premaxw: i64,
	suf:     i64,
	maxg:    i64,
	maxglen: i64,
	groups:  i64,
	descs:   i64,
	gprew:   i64,
	runs:    VecDeque<Cdrun>,
	strs:    Vec<Cdstr>,
}

/// zsh `ZMB_nicewidth`: the screen width of `s` shown with unprintable
/// characters made visible.
pub(super) fn nicewidth(s: &[u8], cs: Charset) -> i64 {
	let shown = niceformat(s, false, cs);
	if cs.utf8 {
		shown.chars().map(|c| i64::from(wcwidth(c).max(0))).sum()
	} else {
		shown.len() as i64
	}
}

/// The length in bytes of the character at the start of `s`
/// (`MB_METACHARLEN` on unmetafied text).
fn charlen(s: &[u8], cs: Charset) -> usize {
	if !cs.utf8 {
		return 1;
	}
	let (_, n) = bstr::decode_utf8(s);
	n.max(1)
}

/// `d` cut to what fits in `remw` columns, character by character (the
/// copy loops of `cd_get`); the columns left.
fn fit(d: &[u8], mut remw: i64, cs: Charset, out: &mut Vec<u8>) -> i64 {
	let w = nicewidth(d, cs);
	if w <= remw {
		out.extend_from_slice(d);
		return remw - w;
	}
	let mut i = 0;
	while remw > 0 && i < d.len() {
		let l = charlen(&d[i..], cs);
		let w = nicewidth(&d[i..i + l], cs);
		if w > remw {
			break;
		}
		out.extend_from_slice(&d[i..i + l]);
		i += l;
		remw -= w;
	}
	remw
}

impl CdState {
	/// The strings of set `s`, in order.
	fn set_strs(&self, s: usize) -> Vec<usize> {
		let mut v = Vec::new();
		let mut p = self.sets[s].strs;
		while let Some(i) = p {
			v.push(i);
			p = self.strs[i].next;
		}
		v
	}

	/// All strings, set by set.
	fn all_strs(&self) -> Vec<usize> {
		(0..self.sets.len())
			.flat_map(|s| self.set_strs(s))
			.collect()
	}

	/// zsh `cd_group`: group matches with the same description.
	fn group(&mut self, maxg: i64) {
		self.groups = 0;
		self.descs = 0;
		self.maxglen = 0;
		self.maxg = 0;
		for i in self.all_strs() {
			self.strs[i].kind = 0;
			self.strs[i].other = None;
		}
		let order = self.all_strs();
		for (k, &s1) in order.iter().enumerate() {
			if self.strs[s1].desc.is_none() || self.strs[s1].kind != 0 {
				continue;
			}
			let mut num = 1;
			let mut width = self.strs[s1].width + self.swidth;
			if width > self.maxglen {
				self.maxglen = width;
			}
			// Where the next `other` link goes: `None` for `s1` itself.
			let mut tail = s1;
			for &s2 in &order[k + 1..] {
				if self.strs[s2].desc.is_some() && self.strs[s1].desc == self.strs[s2].desc {
					width += CM_SPACE + self.strs[s2].width;
					if width > self.maxmlen || num == maxg {
						break;
					}
					if width > self.maxglen {
						self.maxglen = width;
					}
					self.strs[s1].kind = 1;
					self.strs[s2].kind = 2;
					num += 1;
					self.strs[tail].other = Some(s2);
					tail = s2;
				}
			}
			self.strs[tail].other = None;
			if num > 1 {
				self.groups += 1;
			} else {
				self.descs += 1;
			}
			if num > self.maxg {
				self.maxg = num;
			}
		}
	}

	/// zsh `cd_calc`: longest prefix and suffix, count descriptions.
	fn calc(&mut self, cs: Charset) {
		self.pre = 0;
		self.suf = 0;
		for s in 0..self.sets.len() {
			let strs = self.set_strs(s);
			let (mut count, mut desc) = (0, 0);
			for i in strs {
				count += 1;
				let st = &self.strs[i];
				self.pre = self.pre.max(st.str.len() as i64);
				self.premaxw = self.premaxw.max(nicewidth(&st.str, cs));
				if let Some(d) = &st.desc {
					desc += 1;
					self.suf = self.suf.max(d.len() as i64);
				}
			}
			self.sets[s].count = count;
			self.sets[s].desc = desc;
		}
	}

	/// zsh `cd_groups_want_sorting`.
	fn groups_want_sorting(&self) -> bool {
		for set in &self.sets {
			for o in &set.opts {
				if o.starts_with(b"-V") {
					return false;
				} else if o.starts_with(b"-J") {
					return true;
				}
			}
		}
		true
	}

	/// zsh `cd_prep`: build the runs; `true` when the groups are too wide
	/// (try again with smaller ones).
	#[expect(clippy::too_many_lines, reason = "a faithful port of one C function")]
	fn prep(&mut self, coll: Option<&Collator>) -> bool {
		let mut runs: VecDeque<Cdrun> = VecDeque::new();
		if self.groups > 0 {
			let preplines = (self.groups + self.descs) as usize;
			let maxg = self.maxg as usize;
			let mut grps: Vec<Option<usize>> = Vec::with_capacity(preplines);
			let mut wids = vec![0i64; maxg];
			for s in 0..self.sets.len() {
				for str in self.set_strs(s) {
					if self.strs[str].kind != 1 {
						if self.strs[str].kind == 0 && self.strs[str].desc.is_some() {
							if self.strs[str].width > wids[0] {
								wids[0] = self.strs[str].width;
							}
							self.strs[str].other = None;
							grps.push(Some(str));
						}
						continue;
					}
					// Sort the group by decreasing width.
					let mut gs = str;
					self.strs[gs].kind = 2;
					let mut gp = self.strs[str].other;
					self.strs[gs].other = None;
					while let Some(g) = gp {
						let gn = self.strs[g].other;
						self.strs[g].other = None;
						// Insert `g` before the first narrower-or-equal one.
						let mut prev: Option<usize> = None;
						let mut cur = Some(gs);
						while let Some(c) = cur
							&& self.strs[c].width > self.strs[g].width
						{
							prev = Some(c);
							cur = self.strs[c].other;
						}
						self.strs[g].other = cur;
						match prev {
							Some(p) => self.strs[p].other = Some(g),
							None => gs = g,
						}
						gp = gn;
					}
					let mut i = 0;
					let mut p = Some(gs);
					while let Some(g) = p {
						if self.strs[g].width > wids[i] {
							wids[i] = self.strs[g].width;
						}
						i += 1;
						p = self.strs[g].other;
					}
					grps.push(Some(gs));
				}
			}
			self.gprew = wids.iter().map(|w| w + CM_SPACE).sum();
			if self.gprew > self.maxmlen && self.maxglen > 1 {
				return true;
			}
			if self.groups_want_sorting() {
				for g in grps.iter().flatten() {
					let s = &mut self.strs[*g];
					s.sortstr = match coll {
						Some(coll) => coll.key(&s.str).into(),
						None => s.str.clone(),
					};
				}
				let strs = &self.strs;
				grps.sort_by(|a, b| {
					strs[a.expect("set")]
						.sortstr
						.cmp(&strs[b.expect("set")].sortstr)
				});
			}
			// Move entries with the same description next to each other.
			let desc = |s: &Self, i: Option<usize>| s.strs[i.expect("set")].desc.clone();
			let mut i = preplines;
			let mut p = 0;
			while i > 1 {
				let mut q = p + 1;
				if desc(self, grps[p]) == desc(self, grps[q]) {
					i -= 1;
					p += 1;
					continue;
				}
				let mut j = i as i64 - 2;
				q += 1;
				while j > 0 {
					if desc(self, grps[p]) == desc(self, grps[q]) {
						let tmp = grps[q];
						grps.copy_within(p + 1..q, p + 2);
						p += 1;
						grps[p] = tmp;
						i -= 1;
					}
					j -= 1;
					q += 1;
				}
				i -= 1;
				p += 1;
			}
			let mut expl = Cdrun { ty: RunType::Expl, strs: grps[0], count: preplines };
			let mut prev: Option<usize> = None;
			for g in &mut grps {
				let str = g.expect("set");
				*g = self.strs[str].other;
				if let Some(p) = prev {
					self.strs[p].run = Some(str);
				} else {
					expl.strs = Some(str);
				}
				prev = Some(str);
				runs.push_back(Cdrun { ty: RunType::Spec, strs: Some(str), count: 1 });
			}
			if let Some(p) = prev {
				self.strs[p].run = None;
			}
			for _ in 1..maxg {
				let mut d = 0;
				for g in &mut grps {
					if let Some(str) = *g {
						if d > 0 {
							runs.push_back(Cdrun { ty: RunType::Dummy, strs: expl.strs, count: d });
							d = 0;
						}
						runs.push_back(Cdrun { ty: RunType::Spec, strs: Some(str), count: 1 });
						self.strs[str].run = None;
						*g = self.strs[str].other;
					} else {
						d += 1;
					}
				}
				if d > 0 {
					runs.push_back(Cdrun { ty: RunType::Dummy, strs: expl.strs, count: d });
				}
			}
			runs.push_back(expl);
			for s in 0..self.sets.len() {
				let plain: Vec<usize> = self
					.set_strs(s)
					.into_iter()
					.filter(|&i| self.strs[i].kind == 0 && self.strs[i].desc.is_none())
					.collect();
				if !plain.is_empty() {
					self.chain(&plain);
					runs.push_back(Cdrun {
						ty:    RunType::Simple,
						strs:  Some(plain[0]),
						count: plain.len(),
					});
				}
			}
		} else if self.showd {
			for s in 0..self.sets.len() {
				let strs = self.set_strs(s);
				if self.sets[s].desc > 0 {
					let with: Vec<usize> = strs
						.iter()
						.copied()
						.filter(|&i| self.strs[i].desc.is_some())
						.collect();
					self.chain(&with);
					runs.push_back(Cdrun {
						ty:    RunType::Desc,
						strs:  with.first().copied(),
						count: self.sets[s].desc,
					});
				}
				if self.sets[s].desc != self.sets[s].count {
					let without: Vec<usize> = strs
						.iter()
						.copied()
						.filter(|&i| self.strs[i].desc.is_none())
						.collect();
					self.chain(&without);
					runs.push_back(Cdrun {
						ty:    RunType::Simple,
						strs:  without.first().copied(),
						count: self.sets[s].count - self.sets[s].desc,
					});
				}
			}
		} else {
			for s in 0..self.sets.len() {
				if self.sets[s].count > 0 {
					let strs = self.set_strs(s);
					self.chain(&strs);
					runs.push_back(Cdrun {
						ty:    RunType::Simple,
						strs:  self.sets[s].strs,
						count: self.sets[s].count,
					});
				}
			}
		}
		self.runs = runs;
		false
	}

	/// Link `strs` through `run`, in order.
	fn chain(&mut self, strs: &[usize]) {
		for w in strs.windows(2) {
			self.strs[w[0]].run = Some(w[1]);
		}
		if let Some(&l) = strs.last() {
			self.strs[l].run = None;
		}
	}

	/// The strings of a run, following `run` links from `head`.
	fn run_strs(&self, head: Option<usize>) -> Vec<usize> {
		let mut v = Vec::new();
		let mut p = head;
		while let Some(i) = p {
			v.push(i);
			p = self.strs[i].run;
		}
		v
	}
}

/// zsh `cd_arrdup`/`cd_arrcat` with a first element: `first` then `opts`.
fn with_first(first: &[u8], opts: &[BString]) -> Vec<BString> {
	let mut v = Vec::with_capacity(opts.len() + 1);
	v.push(first.into());
	v.extend_from_slice(opts);
	v
}

/// zsh `cd_init`.
#[expect(clippy::too_many_arguments, reason = "zsh's cd_init signature")]
fn cd_init(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	hide: &[u8],
	mlen: &[u8],
	sep: &[u8],
	opts: Option<&[BString]>,
	mut args: &[BString],
	disp: bool,
) -> R {
	let cs = charset(ctx)?;
	let columns = columns(ctx, failed)?;
	let mut st = CdState {
		sep: sep.into(),
		slen: sep.len() as i64,
		swidth: nicewidth(sep, cs),
		showd: disp,
		maxmlen: atoi(mlen),
		..CdState::default()
	};
	let itmp = columns - st.swidth - 4;
	if st.maxmlen > itmp {
		st.maxmlen = itmp;
	}
	if st.maxmlen < 4 {
		st.maxmlen = 4;
	}
	let grp = if args.first().is_some_and(|a| a == "-g") {
		args = &args[1..];
		true
	} else {
		false
	};
	// zsh drops its old state before parsing (`cd_parsed = 0`).
	save::<CdState>(ctx, MiscKey::ZshCompDescribe, None);
	while let Some(a) = args.first() {
		let set = st.sets.len();
		st.sets
			.push(Cdset { opts: Vec::new(), strs: None, count: 0, desc: 0 });
		let Some(ap) = get_user_var(ctx, failed, a)? else {
			return warn(ctx, format!("invalid argument: {}", BStr::new(a)));
		};
		let mut prev: Option<usize> = None;
		let first = st.strs.len();
		for e in &ap {
			// The first unescaped colon.
			let mut t = 0;
			while t < e.len() && e[t] != b':' {
				if e[t] == b'\\' && t + 1 < e.len() {
					t += 1;
				}
				t += 1;
			}
			let desc = (t < e.len()).then(|| rembslash(&e[t + 1..]));
			let s = rembslash(&e[..t.min(e.len())]);
			let i = st.strs.len();
			st.strs.push(Cdstr {
				next: None,
				len: s.len(),
				width: nicewidth(&s, cs),
				mat: s.clone(),
				str: s,
				desc,
				sortstr: BString::default(),
				other: None,
				kind: 0,
				set,
				run: None,
			});
			if let Some(p) = prev {
				st.strs[p].next = Some(i);
			} else {
				st.sets[set].strs = Some(i);
			}
			prev = Some(i);
		}
		args = &args[1..];
		if let Some(a) = args.first()
			&& !a.starts_with(b"-")
		{
			let Some(ap) = get_user_var(ctx, failed, a)? else {
				return warn(ctx, format!("invalid argument: {}", BStr::new(a)));
			};
			for (i, m) in (first..st.strs.len()).zip(ap) {
				st.strs[i].mat = m;
			}
			args = &args[1..];
		}
		if !hide.is_empty() {
			for i in first..st.strs.len() {
				let s = &mut st.strs[i].str;
				if hide.len() > 1 && s.starts_with(b"--") {
					s.drain(..2);
				} else if s.first().is_some_and(|&c| c == b'-' || c == b'+') {
					s.drain(..1);
				}
			}
		}
		let end = args.iter().position(|a| a == "--").unwrap_or(args.len());
		let mut o = args[..end].to_vec();
		if let Some(x) = opts {
			o.extend_from_slice(x);
		}
		st.sets[set].opts = o;
		args = &args[(end + 1).min(args.len())..];
	}
	if disp && grp {
		let coll = collator_in(&mut ctx.k.root, ctx.cx.store, ctx.vp);
		let mut mg = columns;
		loop {
			st.group(mg);
			mg = st.maxg - 1;
			st.calc(cs);
			if !st.prep(coll.as_ref()) {
				break;
			}
		}
	} else {
		st.calc(cs);
		st.prep(None);
	}
	save(ctx, MiscKey::ZshCompDescribe, Some(&st));
	fin(0, *failed)
}

/// zsh `zterm_columns`: `$COLUMNS` (80 when unset or not positive).
fn columns(ctx: &mut Ctx<'_, '_>, failed: &mut bool) -> Result<i64, Need> {
	let c = super::getsparam(ctx, failed, b"COLUMNS")?.map_or(0, |c| atoi(&c));
	Ok(if c > 0 { c } else { 80 })
}

/// zsh `cd_get`: report the next run in the four parameters `params`;
/// status 1 when there is none.
fn cd_get(ctx: &mut Ctx<'_, '_>, failed: &mut bool, mut st: CdState, params: &[BString]) -> R {
	let Some(run) = st.runs.pop_front() else {
		return done(1);
	};
	let cs = charset(ctx)?;
	let columns = columns(ctx, failed)?;
	let strs = st.run_strs(run.strs);
	let set_opts = |st: &CdState| -> Vec<BString> {
		run.strs
			.map_or_else(Vec::new, |h| st.sets[st.strs[h].set].opts.clone())
	};
	let mut csl: &[u8] = b"";
	let (opts, mats, dpys): (Vec<BString>, Vec<BString>, Vec<BString>) = match run.ty {
		RunType::Simple => {
			let mats = strs.iter().map(|&i| st.strs[i].mat.clone()).collect();
			let dpys = strs.iter().map(|&i| st.strs[i].str.clone()).collect();
			let mut opts = set_opts(&st);
			if st.groups > 0 {
				// zsh's loop tests the slot it copies to, so everything
				// from the first `-X…` on is dropped.
				if let Some(x) = opts.iter().position(|o| o.starts_with(b"-X")) {
					opts.truncate(x);
				}
			}
			(opts, mats, dpys)
		},
		RunType::Desc => {
			let mut mats = Vec::with_capacity(strs.len());
			let mut dpys = Vec::with_capacity(strs.len());
			for &i in &strs {
				let s = &st.strs[i];
				mats.push(s.mat.clone());
				let mut buf: Vec<u8> = s.str.to_vec();
				if s.str.len() < s.len {
					// zsh copies the string, then skips `len` bytes past
					// its start: the terminating NUL stays in between.
					dpys.push(buf.into());
					continue;
				}
				let pad = st.premaxw - s.width + CM_SPACE;
				buf.extend(std::iter::repeat_n(b' ', pad.max(0) as usize));
				let mut remw = columns - st.premaxw - st.swidth - 3;
				while remw < 0 && columns != 0 {
					remw += columns;
				}
				if st.slen < remw {
					buf.extend_from_slice(&st.sep);
					remw -= st.slen;
					fit(s.desc.as_deref().map_or(&[][..], |d| d.as_bytes()), remw, cs, &mut buf);
				}
				dpys.push(buf.into());
			}
			(with_first(b"-l", &set_opts(&st)), mats, dpys)
		},
		RunType::Spec => {
			let s = &st.strs[strs[0]];
			let (m, d) = (s.mat.clone(), s.str.clone());
			let mut opts = set_opts(&st);
			if let Some(j) = opts
				.iter()
				.position(|o| o.starts_with(b"-J") || o.starts_with(b"-V"))
			{
				opts[j] = [&b"-2V"[..], &opts[j][2..]].concat().into();
			} else {
				opts.insert(0, "-2V-default-".into());
			}
			csl = b"packed";
			(opts, vec![m], vec![d])
		},
		RunType::Dummy => {
			csl = b"packed";
			(with_first(format!("-E{}", run.count).as_bytes(), &set_opts(&st)), Vec::new(), Vec::new())
		},
		RunType::Expl => {
			let mut dpys = Vec::with_capacity(run.count);
			for (k, &i) in strs.iter().enumerate() {
				let s = &st.strs[i];
				if let Some(&n) = strs.get(k + 1)
					&& s.desc == st.strs[n].desc
				{
					dpys.push(BString::default());
					continue;
				}
				let mut buf: Vec<u8> = st.sep.to_vec();
				let remw = columns - st.gprew - st.swidth - CM_SPACE;
				let remw = fit(s.desc.as_deref().map_or(&[][..], |d| d.as_bytes()), remw, cs, &mut buf);
				buf.extend(std::iter::repeat_n(b' ', remw.max(0) as usize));
				dpys.push(buf.into());
			}
			csl = b"packed";
			(with_first(format!("-E{}", run.count).as_bytes(), &set_opts(&st)), Vec::new(), dpys)
		},
	};
	save(ctx, MiscKey::ZshCompDescribe, Some(&st));
	setsparam(ctx, failed, &params[0], csl)?;
	setaparam(ctx, failed, &params[1], opts)?;
	setaparam(ctx, failed, &params[2], mats)?;
	setaparam(ctx, failed, &params[3], dpys)?;
	fin(0, *failed)
}

/// zsh `bin_compdescribe`.
pub fn compdescribe(ctx: &mut Ctx<'_, '_>, _ops: &Ops, args: &[BString]) -> R {
	if !gate(ctx) {
		return done(1);
	}
	let n = args.len();
	let a0 = args[0].as_slice();
	if a0.len() != 2 {
		return warn(ctx, format!("invalid argument: {}", BStr::new(a0)));
	}
	let mut failed = false;
	match a0[1] {
		b'i' => {
			if n < 3 {
				return warn(ctx, "not enough arguments");
			}
			cd_init(ctx, &mut failed, &args[1], &args[2], b"", None, &args[3..], false)
		},
		b'I' => {
			if n < 6 {
				return warn(ctx, "not enough arguments");
			}
			let Some(opts) = getaparam(ctx, &mut failed, &args[4])? else {
				return warn(ctx, format!("unknown parameter: {}", BStr::new(&args[4])));
			};
			cd_init(
				ctx,
				&mut failed,
				&args[1],
				&args[2],
				&args[3],
				Some(opts.as_slice()),
				&args[5..],
				true,
			)
		},
		b'g' => match load::<CdState>(ctx, MiscKey::ZshCompDescribe)? {
			Some(st) => {
				if n != 5 {
					return warn(
						ctx,
						if n < 5 {
							"not enough arguments"
						} else {
							"too many arguments"
						},
					);
				}
				cd_get(ctx, &mut failed, st, &args[1..])
			},
			None => warn(ctx, "no parsed state"),
		},
		_ => warn(ctx, format!("invalid option: {}", BStr::new(a0))),
	}
}
