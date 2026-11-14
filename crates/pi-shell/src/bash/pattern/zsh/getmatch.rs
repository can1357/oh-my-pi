//! Pattern matching inside parameter expansion: zsh 5.9 `glob.c`'s
//! `getmatch`, `getmatcharr`, `getmatchlist`, `compgetmatch`, the
//! multibyte `igetmatch` and `get_match_ret`, behind `${x#p}` `${x##p}`
//! `${x%p}` `${x%%p}` `${x/p/r}` `${x//p/r}` `${x:#p}` and the `(S)`
//! `(I:n:)` `(B)` `(E)` `(M)` `(N)` `(R)` flags.
//!
//! The caller (zsh `paramsubst`) picks the [`SubFlags`] exactly as zsh's
//! `subst.c` does and passes the replacement as a [`Replace`] callback, so
//! that a pattern with `(#b)` or `(#m)` gets its replacement expanded
//! again at every match with that match's [`Captures`] (zsh
//! `SUB_DOSUBST`).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use core::{fmt::Write as _, ops};
use std::borrow::Cow;

use super::{
	BadPattern, CharEnv, Opts, PatFlags,
	compile::Pattern,
	exec::{Captures, MetaMap, Run},
	mbchar::{charlen, metastrlen},
};
use crate::bash::syntax::zsh::tok::{META, at, head, span, tail, unmetafy};

/// `SUB_*` flags of a parameter-expansion match (zsh `zsh.h`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct SubFlags(u16);

impl SubFlags {
	/// `${x:#p}`: match the complete string.
	pub const ALL: Self = Self(0x0100);
	/// `(B)`: the index of the start of the match.
	pub const BIND: Self = Self(0x0020);
	/// `(*)`: extended globbing for this match.
	pub const EGLOB: Self = Self(0x4000);
	/// `(E)`: the index after the end of the match.
	pub const EIND: Self = Self(0x0040);
	/// Match at the end: `%` and `%%`.
	pub const END: Self = Self(0x0001);
	/// `//`: replace every match.
	pub const GLOBAL: Self = Self(0x0200);
	/// `(N)`: the length of the match.
	pub const LEN: Self = Self(0x0080);
	/// Internal: collect the matches instead ([`getmatchlist`]).
	const LIST: Self = Self(0x2000);
	/// Longest match: `##`, `%%`, and `/` without `(S)`.
	pub const LONG: Self = Self(0x0002);
	/// `(M)`: the result includes the matched portion.
	pub const MATCH: Self = Self(0x0008);
	/// No flags: shortest match at the head, as `${x#p}` before `REST`.
	pub const NONE: Self = Self(0);
	/// `(R)`, and the default: the result includes the unmatched portion.
	pub const REST: Self = Self(0x0010);
	/// Report no match as a failure ([`GetMatch::keep`] false).
	pub const RETFAIL: Self = Self(0x0800);
	/// `/#`: anchored at the start (only read together with
	/// [`Self::END`], for `/#%`).
	pub const START: Self = Self(0x1000);
	/// Match a substring: `(S)`, and an unanchored `/`.
	pub const SUBSTR: Self = Self(0x0004);

	/// Whether every flag of `other` is set.
	pub const fn contains(self, other: Self) -> bool {
		self.0 & other.0 == other.0
	}

	/// Whether any flag of `other` is set.
	const fn any(self, other: Self) -> bool {
		self.0 & other.0 != 0
	}
}

impl ops::BitOr for SubFlags {
	type Output = Self;

	fn bitor(self, rhs: Self) -> Self {
		Self(self.0 | rhs.0)
	}
}

impl ops::BitOrAssign for SubFlags {
	fn bitor_assign(&mut self, rhs: Self) {
		self.0 |= rhs.0;
	}
}

/// The replacement of `${x/p/r}` (zsh `replstr`).
///
/// It appends the expanded, untokenized, metafied replacement to the
/// buffer. For a pattern without
/// captures ([`Pattern::has_refs`] false) it is called once, before
/// matching, with empty [`Captures`] (zsh `compgetmatch`'s `singsub`);
/// otherwise once per match with that match's captures, which the caller
/// assigns to `$match`/`$MATCH`… before expanding (zsh `SUB_DOSUBST`).
pub type Replace<'r> = dyn FnMut(&Captures, &mut Vec<u8>) + 'r;

/// The result of one `igetmatch`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GetMatch {
	/// The new value, metafied (zsh `*sp`).
	pub value: Vec<u8>,
	/// zsh's return value: false when an array element is to be dropped
	/// (`${a:#p}` that matched, `(M)` that did not, [`SubFlags::RETFAIL`]
	/// without a match).
	pub keep:  bool,
}

/// zsh `getmatch`: match a pattern against a scalar.
///
/// `pat` (metafied, tokenized) is matched against the metafied scalar `s`
/// under `fl`, with `n` the `(I:n:)` index (at least 1). `repl`
/// is `Some` for `${x/p/r}` (also with an empty `r`). On every successful
/// trial `caps` receives the captures, so after the call it holds those of
/// the last one, as zsh's variables do.
pub fn getmatch(
	s: &[u8],
	pat: &[u8],
	fl: SubFlags,
	n: i64,
	repl: Option<&mut Replace<'_>>,
	opts: &Opts,
	env: &CharEnv,
	caps: &mut Captures,
) -> Result<GetMatch, BadPattern> {
	let (p, mut repl) = compgetmatch(pat, fl, repl, opts)?;
	Ok(igetmatch(s, &p, fl, n, &mut repl, env, caps, None))
}

/// zsh `getmatcharr`: [`getmatch`] on every element of an array with one
/// compiled pattern; elements whose match says not to keep them are
/// dropped.
pub fn getmatcharr<I, S>(
	arr: I,
	pat: &[u8],
	fl: SubFlags,
	n: i64,
	repl: Option<&mut Replace<'_>>,
	opts: &Opts,
	env: &CharEnv,
	caps: &mut Captures,
) -> Result<Vec<Vec<u8>>, BadPattern>
where
	I: IntoIterator<Item = S>,
	S: AsRef<[u8]>,
{
	let (p, mut repl) = compgetmatch(pat, fl, repl, opts)?;
	Ok(arr
		.into_iter()
		.map(|e| igetmatch(e.as_ref(), &p, fl, n, &mut repl, env, caps, None))
		.filter(|r| r.keep)
		.map(|r| r.value)
		.collect())
}

/// zsh `getmatchlist`: the byte ranges (in the metafied `s`) of every
/// longest, non-overlapping match of the compiled `p` from left to right.
pub fn getmatchlist(s: &[u8], p: &Pattern, env: &CharEnv) -> Vec<ops::Range<usize>> {
	let mut caps = Captures::default();
	let mut list = Vec::new();
	igetmatch(
		s,
		p,
		SubFlags::LONG | SubFlags::GLOBAL | SubFlags::SUBSTR | SubFlags::LIST,
		0,
		&mut Repl::Absent,
		env,
		&mut caps,
		Some(&mut list),
	);
	list
}

/// The replacement as `igetmatch` sees it.
enum Repl<'r, 'o> {
	/// No replacement: `${x#p}` and friends, or a failed match.
	Absent,
	/// Expanded once, before matching.
	Fixed(Vec<u8>),
	/// Expanded at every match.
	Subst(&'r mut Replace<'o>),
}

/// zsh `compgetmatch`: compile for `fl` (anchored at the end for `ALL`
/// and for `END` without `SUBSTR`) and decide when the replacement is
/// expanded: once now, or at every match (zsh `SUB_DOSUBST`).
fn compgetmatch<'r, 'o>(
	pat: &[u8],
	fl: SubFlags,
	repl: Option<&'r mut Replace<'o>>,
	opts: &Opts,
) -> Result<(Pattern, Repl<'r, 'o>), BadPattern> {
	let mut opts = *opts;
	if fl.contains(SubFlags::EGLOB) {
		opts.extended_glob = true;
	}
	let mut pf = PatFlags::SCAN | PatFlags::NOANCH;
	if fl.contains(SubFlags::ALL) || (fl.contains(SubFlags::END) && !fl.contains(SubFlags::SUBSTR)) {
		pf = pf.without(PatFlags::NOANCH);
	}
	let p = Pattern::compile(pat, pf, &opts)?;
	let repl = match repl {
		None => Repl::Absent,
		Some(f) if p.has_refs() => Repl::Subst(f),
		Some(f) => {
			let mut text = Vec::new();
			f(&Captures::default(), &mut text);
			Repl::Fixed(text)
		},
	};
	Ok((p, repl))
}

/// One replacement of a global substitution (zsh `struct repldata`):
/// metafied begin and end, and the replacement's range in the arena.
type Repldata = (usize, usize, ops::Range<usize>);

/// The state of one `igetmatch` (zsh `struct imatchdata` plus the
/// pattern's `PAT_NOTSTART`/`PAT_NOTEND` bits and `patmatchlen`).
struct Imatch<'a> {
	/// The matcher over the unmetafied subject.
	run:      Run<'a>,
	/// The unmetafied subject (zsh `ustr`).
	raw:      &'a [u8],
	/// The metafied subject (zsh `mstr`).
	mstr:     &'a [u8],
	/// Offsets back into `mstr`.
	map:      MetaMap<'a>,
	/// `PAT_NOTSTART`/`PAT_NOTEND` as `set_pat_start`/`set_pat_end` left
	/// them.
	pflags:   PatFlags,
	/// Unmetafied length of the last successful match (zsh
	/// `patmatchlen`).
	last_len: usize,
	/// Where captures go.
	caps:     &'a mut Captures,
	/// The `SUB_*` flags.
	fl:       SubFlags,
	/// The `MULTIBYTE` option.
	mb:       bool,
	/// Replacements of a global substitution (zsh `repllist`).
	repllist: Option<Vec<Repldata>>,
	/// Storage for the replacement texts.
	arena:    Vec<u8>,
}

impl Imatch<'_> {
	/// zsh `pattrylen` on `raw[t..t + len]` with character offset `ioff`;
	/// the unmetafied match length on success.
	fn try_(&mut self, t: usize, len: usize, ioff: usize) -> Option<usize> {
		let end = self.run.trial(t, t + len, self.pflags, None, None)?;
		self.run.record(self.caps, t, end, ioff, &self.map);
		self.last_len = end - t;
		Some(self.last_len)
	}

	/// zsh `set_pat_start`: `(#s)` fails unless the trial starts at the
	/// real start.
	fn set_start(&mut self, offs: usize) {
		self.pflags = if offs != 0 {
			self.pflags | PatFlags::NOTSTART
		} else {
			self.pflags.without(PatFlags::NOTSTART)
		};
	}

	/// zsh `set_pat_end`: `(#e)` fails when the trial is cut before the
	/// character `null_me` (a NUL byte counts as the end).
	fn set_end(&mut self, null_me: u8) {
		self.pflags = if null_me != 0 {
			self.pflags | PatFlags::NOTEND
		} else {
			self.pflags.without(PatFlags::NOTEND)
		};
	}

	/// zsh `iincchar`: the byte length of the character at `t`.
	fn inc(&self, t: usize, end: usize) -> usize {
		charlen(self.raw, t, end, self.mb)
	}

	/// zsh `get_match_ret`: the result for a match of `raw[b..e]`, or, for
	/// a global substitution, record the replacement and return nothing
	/// useful.
	fn ret(&mut self, b: usize, e: usize, repl: &mut Repl<'_, '_>) -> Vec<u8> {
		let fl = self.fl;
		let b = self.map.at(b);
		let e = self.map.at(e);
		let mstr = self.mstr;
		let mut rtext = 0..0;
		let has_repl = !matches!(repl, Repl::Absent);
		if has_repl || fl.contains(SubFlags::LIST) {
			let from = self.arena.len();
			match repl {
				Repl::Subst(f) => f(&*self.caps, &mut self.arena),
				Repl::Fixed(t) => self.arena.extend_from_slice(t),
				Repl::Absent => {},
			}
			rtext = from..self.arena.len();
			if fl.any(SubFlags::GLOBAL | SubFlags::LIST)
				&& let Some(list) = &mut self.repllist
			{
				// Replacing the chunk: add it to the list.
				list.push((b, e, rtext));
				return Vec::new();
			}
		}
		let mut out = Vec::new();
		let mut t = fl.contains(SubFlags::MATCH);
		if t {
			out.extend_from_slice(span(mstr, b, e));
		}
		if fl.contains(SubFlags::REST) {
			// Both portions requested: a space between.
			if t {
				out.push(b' ');
			}
			out.extend_from_slice(head(mstr, b));
			if has_repl {
				out.extend_from_slice(self.arena.get(rtext).unwrap_or_default());
			}
			out.extend_from_slice(tail(mstr, e));
			t = true;
		}
		let mut nums = String::new();
		if fl.contains(SubFlags::BIND) {
			let _ = write!(nums, "{} ", metastrlen(head(mstr, b), self.mb) + 1);
		}
		if fl.contains(SubFlags::EIND) {
			let _ = write!(nums, "{} ", metastrlen(head(mstr, e), self.mb) + 1);
		}
		if fl.contains(SubFlags::LEN) {
			let _ = write!(nums, "{} ", metastrlen(span(mstr, b, e), self.mb));
		}
		if !nums.is_empty() {
			nums.pop();
			if t {
				out.push(b' ');
			}
			out.extend_from_slice(nums.as_bytes());
		}
		out
	}
}

/// zsh `igetmatch` (the `MULTIBYTE_SUPPORT` version): the match of `pat`
/// in the metafied `mstr` that `fl` and `n` select, and the result value.
fn igetmatch(
	mstr: &[u8],
	pat: &Pattern,
	fl: SubFlags,
	mut n: i64,
	repl: &mut Repl<'_, '_>,
	env: &CharEnv,
	caps: &mut Captures,
	list: Option<&mut Vec<ops::Range<usize>>>,
) -> GetMatch {
	let prog = &*pat.prog;
	let raw: Cow<'_, [u8]> = if mstr.contains(&META) {
		Cow::Owned(unmetafy(mstr))
	} else {
		Cow::Borrowed(mstr)
	};
	let mlen = mstr.len();
	let umltot = raw.len();
	let send = umltot;
	let mut im = Imatch {
		run: Run::new(prog, &raw, env),
		raw: &raw,
		mstr,
		map: MetaMap::new(&raw, mlen, 0),
		pflags: PatFlags::NONE,
		last_len: 0,
		caps,
		fl,
		mb: prog.multibyte,
		repllist: None,
		arena: Vec::new(),
	};
	let pures = prog.flags.contains(PatFlags::PURES);
	let long = fl.contains(SubFlags::LONG);

	// The must-match test for complex closures.
	let matched = prog
		.must
		.as_ref()
		.is_none_or(|must| must.len() <= umltot && raw.windows(must.len()).any(|w| w == &**must));

	if fl.contains(SubFlags::ALL) {
		let ok = matched && im.try_(0, umltot, 0).is_some();
		let value = if ok {
			im.ret(0, umltot, repl)
		} else {
			im.ret(0, 0, &mut Repl::Absent)
		};
		let keep = !(value.is_empty()
			&& ((fl.contains(SubFlags::MATCH) && !ok) || (fl.contains(SubFlags::REST) && ok)));
		return GetMatch { value, keep };
	}

	if matched {
		let case = fl.0 & (SubFlags::END.0 | SubFlags::LONG.0 | SubFlags::SUBSTR.0);
		let end = SubFlags::END.0;
		let substr = SubFlags::SUBSTR.0;
		let start_only = fl.contains(SubFlags::START);
		if case & (end | substr) == 0 {
			// Longest or shortest match at the head: first the longest.
			if let Some(mut mlen) = im.try_(0, umltot, 0) {
				if !long && !pures {
					// Then the shortest, by brute force.
					let lim = mlen;
					let mut t = 0;
					while t < lim {
						im.set_end(at(&raw, t));
						if let Some(ml) = im.try_(0, t, 0) {
							mlen = ml;
							break;
						}
						t += im.inc(t, lim);
					}
				}
				return GetMatch { value: im.ret(0, mlen, repl), keep: true };
			}
		} else if case == end {
			// Shortest match at the tail: match at every point going
			// forwards and keep the last success.
			let mut tmatch = None;
			im.set_start(mlen);
			if im.try_(send, 0, umltot).is_some() {
				n -= 1;
				if n == 0 {
					return GetMatch { value: im.ret(umltot, umltot, repl), keep: true };
				}
			}
			let mut ioff = 0;
			let mut t = 0;
			while t < send {
				im.set_start(t);
				if im.try_(t, send - t, ioff).is_some() {
					tmatch = Some(t);
				}
				if start_only {
					break;
				}
				t += im.inc(t, send);
				ioff += 1;
			}
			if let Some(tm) = tmatch {
				return GetMatch { value: im.ret(tm, umltot, repl), keep: true };
			}
			if !start_only && im.try_(umltot, 0, ioff).is_some() {
				return GetMatch { value: im.ret(umltot, umltot, repl), keep: true };
			}
		} else if case == end | SubFlags::LONG.0 {
			// Longest match at the tail: move forwards until a match.
			let mut ioff = 0;
			let mut t = 0;
			loop {
				im.set_start(t);
				if im.try_(t, send - t, ioff).is_some() {
					return GetMatch { value: im.ret(t, umltot, repl), keep: true };
				}
				if start_only || t == send {
					break;
				}
				t += im.inc(t, send);
				ioff += 1;
			}
			if !start_only && im.try_(send, 0, ioff).is_some() {
				return GetMatch { value: im.ret(umltot, umltot, repl), keep: true };
			}
		} else if case & end == 0 {
			// Substrings from the start, shortest (SUB_SUBSTR) or longest.
			if !long {
				im.set_start(mlen);
				if !fl.contains(SubFlags::GLOBAL) && im.try_(send, 0, 0).is_some() {
					n -= 1;
					if n == 0 {
						return GetMatch { value: im.ret(0, 0, repl), keep: true };
					}
				}
			}
			let global = fl.contains(SubFlags::GLOBAL);
			if global {
				im.repllist = Some(Vec::new());
			}
			let mut t = 0;
			let mut ioff = 0;
			loop {
				// Loop over all matches for a global substitution.
				let mut found = false;
				while t <= send {
					// The longest match from this position.
					im.set_start(t);
					if let Some(ml) = im.try_(t, send - t, ioff) {
						let mut mpos = t + ml;
						if !long && !pures {
							// The shortest: grow from zero length.
							let mut ptr = t;
							while ptr < mpos {
								im.set_end(at(&raw, ptr));
								if let Some(ml2) = im.try_(t, ptr - t, ioff) {
									mpos = t + ml2;
									break;
								}
								ptr += im.inc(ptr, mpos);
							}
						}
						n -= 1;
						let value = if n == 0 || (n <= 0 && global) {
							let v = im.ret(t, mpos, repl);
							if mpos == t {
								mpos += im.inc(mpos, send);
							}
							v
						} else {
							Vec::new()
						};
						if !global {
							if n != 0 {
								// A later match may overlap this one.
								t += im.inc(t, send);
								ioff += 1;
								continue;
							}
							return GetMatch { value, keep: true };
						}
						// Skip what is already marked for replacement.
						found = true;
						if t == send {
							break;
						}
						while t < mpos {
							ioff += 1;
							t += im.inc(t, send);
						}
						break;
					}
					if t == send {
						break;
					}
					t += im.inc(t, send);
					ioff += 1;
				}
				if !(found && t < send) {
					break;
				}
			}
			// An empty match at the start, but not for global ones.
			im.set_start(mlen);
			if long && !global && im.try_(send, 0, 0).is_some() {
				n -= 1;
				if n == 0 {
					return GetMatch { value: im.ret(0, 0, repl), keep: true };
				}
			}
		} else {
			// Longest or shortest substring at the end.
			im.set_start(mlen);
			if im.try_(send, 0, umltot).is_some() {
				n -= 1;
				if n == 0 {
					return GetMatch { value: im.ret(umltot, umltot, repl), keep: true };
				}
			}
			// Count the matches from the start, then find the n'th last.
			let mut nmatches: i64 = 0;
			let mut tmatch = 0;
			let mut ioff = 0;
			let mut t = 0;
			while t < send {
				im.set_start(t);
				if im.try_(t, send - t, ioff).is_some() {
					nmatches += 1;
					tmatch = t;
				}
				t += im.inc(t, send);
				ioff += 1;
			}
			if nmatches > 0 {
				if n > 1 {
					n = nmatches - n;
					ioff = 0;
					t = 0;
					while t < send {
						im.set_start(t);
						if im.try_(t, send - t, ioff).is_some() {
							let was = n;
							n -= 1;
							if was == 0 {
								tmatch = t;
								break;
							}
						}
						t += im.inc(t, send);
						ioff += 1;
					}
				}
				let mut mpos = tmatch + im.last_len;
				if !long && !pures {
					// The shortest match from there.
					let mut t = tmatch;
					while t < mpos {
						im.set_end(at(&raw, t));
						if let Some(ml) = im.try_(tmatch, t - tmatch, ioff) {
							mpos = tmatch + ml;
							break;
						}
						t += im.inc(t, mpos);
					}
				}
				return GetMatch { value: im.ret(tmatch, mpos, repl), keep: true };
			}
			im.set_start(mlen);
			if long && im.try_(send, 0, umltot).is_some() {
				n -= 1;
				if n == 0 {
					return GetMatch { value: im.ret(umltot, umltot, repl), keep: true };
				}
			}
		}
	}

	if let Some(rl) = im.repllist.take()
		&& !rl.is_empty()
	{
		if let Some(list) = list {
			list.extend(rl.iter().map(|(b, e, _)| *b..*e));
			return GetMatch { value: mstr.to_vec(), keep: true };
		}
		// Put the bits of a global substitution together.
		let mut out = Vec::with_capacity(mlen + im.arena.len());
		let mut from = 0;
		for (rb, re, rt) in rl {
			out.extend_from_slice(span(mstr, from, rb));
			out.extend_from_slice(im.arena.get(rt).unwrap_or_default());
			from = re;
		}
		out.extend_from_slice(tail(mstr, from));
		return GetMatch { value: out, keep: true };
	}
	if fl.contains(SubFlags::LIST) {
		return GetMatch { value: mstr.to_vec(), keep: false };
	}
	// No match: the whole string, no replacement.
	GetMatch { value: im.ret(0, 0, &mut Repl::Absent), keep: !fl.contains(SubFlags::RETFAIL) }
}
