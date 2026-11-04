//! bash's pattern matcher, ported from `lib/glob/sm_loop.c` (`GMATCH`,
//! `BRACKMATCH`, `EXTMATCH`, `PATSCAN`) and `smatch.c`.
//!
//! The port keeps bash's control flow, including its quirks: bracket
//! expressions are parsed while matching, an unterminated `[` matches a
//! literal `[`, an invalid extglob compares as a string, and sub-patterns
//! read past their end into the rest of the pattern exactly where bash's
//! pointers do. Pattern and subject are indexed slices; reading past the
//! end of either yields NUL, as bash's NUL-terminated strings do, so a
//! subject slice behaves like bash's temporarily truncated string.
//!
//! It runs on bytes ([`u8`], a single-byte locale) or on decoded characters
//! ([`u32`], bash's wide-character `internal_wstrmatch` in a UTF-8 locale).
//!
//! Matching is backtracking, as in bash: `*` uses glibc's trick of never
//! returning to an earlier `*`, but nested extglob operators can take time
//! exponential in the subject. Recursion is capped at [`MAX_DEPTH`] levels;
//! deeper attempts fail to match instead of exhausting the stack.

use core::cell::Cell;

use crate::bash::pattern::class::{Class, collsym};

/// `FNM_PATHNAME`: wildcards and bracket expressions never match `/`.
pub const PATHNAME: u32 = 1 << 0;
/// `FNM_PERIOD`: a leading `.` (after `/` with [`PATHNAME`]) must be matched
/// explicitly.
pub const PERIOD: u32 = 1 << 2;
/// `FNM_CASEFOLD`: compare case-insensitively.
pub const CASEFOLD: u32 = 1 << 4;
/// `FNM_EXTMATCH`: recognize `?( ) *( ) +( ) @( ) !( )`.
pub const EXTMATCH: u32 = 1 << 5;
/// `FNM_DOTDOT`: wildcards never match a leading `.` or `..` component.
pub const DOTDOT: u32 = 1 << 7;

/// Deepest recursion the matcher enters before giving up on a match.
const MAX_DEPTH: u32 = 10_000;

/// A matching unit: a byte or a decoded character.
pub trait Unit: Copy + Eq + Ord + core::fmt::Debug {
	/// bash's `INVALID` stored in a `CHAR`: an unknown collating symbol.
	const INVALID: Self;
	/// The unit for ASCII byte `c`.
	fn of(c: u8) -> Self;
	/// The numeric value (byte or code point).
	fn code(self) -> u32;
	/// bash's `FOLD`: lower-case when [`CASEFOLD`] is set.
	fn fold(self, flags: u32) -> Self;
	/// Whether the unit belongs to `class`.
	fn in_class(self, class: Class) -> bool;

	/// The unit as an ASCII byte, if it is one.
	fn ascii(self) -> Option<u8> {
		u8::try_from(self.code()).ok().filter(u8::is_ascii)
	}
}

impl Unit for u8 {
	const INVALID: Self = 0xff;

	fn of(c: u8) -> Self {
		c
	}

	fn code(self) -> u32 {
		u32::from(self)
	}

	fn fold(self, flags: u32) -> Self {
		if flags & CASEFOLD == 0 {
			self
		} else {
			self.to_ascii_lowercase()
		}
	}

	fn in_class(self, class: Class) -> bool {
		class.matches(self)
	}
}

impl Unit for u32 {
	const INVALID: Self = Self::MAX;

	fn of(c: u8) -> Self {
		Self::from(c)
	}

	fn code(self) -> u32 {
		self
	}

	fn fold(self, flags: u32) -> Self {
		if flags & CASEFOLD == 0 {
			return self;
		}
		char::from_u32(self)
			.filter(|c| c.is_uppercase())
			.and_then(|c| {
				let mut lower = c.to_lowercase();
				match (lower.next(), lower.next()) {
					(Some(one), None) => Some(Self::from(one)),
					_ => None,
				}
			})
			.unwrap_or(self)
	}

	fn in_class(self, class: Class) -> bool {
		char::from_u32(self).is_some_and(|c| class.matches_char(c))
	}
}

/// Whether `pattern` matches the whole of `subject` under `flags`.
pub fn strmatch<C: Unit>(pattern: &[C], subject: &[C], flags: u32) -> bool {
	let m = Matcher { p: pattern, s: subject, depth: Cell::new(0) };
	m.gmatch(0, subject.len(), 0, pattern.len(), None, flags)
}

/// bash's `PATSCAN` over a byte pattern: the index just past the `)` that
/// closes the extglob group whose body starts at `start` (or past the next
/// top-level `|` when `bar`), never scanning past `end`; `None` if it is
/// not closed.
pub fn patscan(pattern: &[u8], start: usize, end: usize, bar: bool) -> Option<usize> {
	let m = Matcher { p: pattern, s: &[], depth: Cell::new(0) };
	m.patscan(start, end, if bar { b'|' } else { 0 }, 0)
}

/// Where a `*` stopped a recursive match (glibc's `struct STRUCT`).
#[derive(Default)]
struct End {
	pattern: Option<usize>,
	string:  usize,
}

struct Matcher<'a, C> {
	p:     &'a [C],
	s:     &'a [C],
	depth: Cell<u32>,
}

const fn is_ext_op(c: u8) -> bool {
	matches!(c, b'+' | b'*' | b'?' | b'@' | b'!')
}

impl<C: Unit> Matcher<'_, C> {
	/// Pattern unit at `i`; NUL past the end.
	fn pc(&self, i: usize) -> C {
		self.p.get(i).copied().unwrap_or_else(|| C::of(0))
	}

	/// Subject unit at `i`; NUL past the end.
	fn sc(&self, i: usize) -> C {
		self.s.get(i).copied().unwrap_or_else(|| C::of(0))
	}

	fn is(c: C, b: u8) -> bool {
		c == C::of(b)
	}

	/// `PATHSEP`: `/` or the end.
	fn pathsep(c: C) -> bool {
		Self::is(c, b'/') || Self::is(c, 0)
	}

	/// `SDOT_OR_DOTDOT`: the subject at `n` is exactly `.` or `..`.
	fn sdot(&self, n: usize) -> bool {
		Self::is(self.sc(n), b'.')
			&& (Self::is(self.sc(n + 1), 0)
				|| (Self::is(self.sc(n + 1), b'.') && Self::is(self.sc(n + 2), 0)))
	}

	/// `PDOT_OR_DOTDOT`: the component at `n` is `.` or `..`.
	fn pdot(&self, n: usize) -> bool {
		Self::is(self.sc(n), b'.')
			&& (Self::pathsep(self.sc(n + 1))
				|| (Self::is(self.sc(n + 1), b'.') && Self::pathsep(self.sc(n + 2))))
	}

	/// A wildcard may not match the `.` at `n` ([`PERIOD`]).
	fn lead_dot(&self, n: usize, string: usize, sc: C, flags: u32) -> bool {
		flags & PERIOD != 0
			&& Self::is(sc, b'.')
			&& (n == string || (flags & PATHNAME != 0 && Self::is(self.sc(n - 1), b'/')))
	}

	/// A wildcard may not match the `.`/`..` at `n` ([`DOTDOT`]).
	fn lead_dotdot(&self, n: usize, string: usize, flags: u32) -> bool {
		flags & DOTDOT != 0
			&& ((n == string && self.sdot(n))
				|| (flags & PATHNAME != 0
					&& n > string
					&& Self::is(self.sc(n - 1), b'/')
					&& self.pdot(n)))
	}

	/// bash's `GMATCH`: does `s[string..se]` match `p[pattern..pe]`?
	fn gmatch(
		&self,
		string: usize,
		se: usize,
		pattern: usize,
		pe: usize,
		ends: Option<&mut End>,
		flags: u32,
	) -> bool {
		let depth = self.depth.get();
		if depth >= MAX_DEPTH {
			return false;
		}
		self.depth.set(depth + 1);
		let r = self.gmatch_inner(string, se, pattern, pe, ends, flags);
		self.depth.set(depth);
		r
	}

	fn gmatch_inner(
		&self,
		string: usize,
		se: usize,
		pattern: usize,
		pe: usize,
		mut ends: Option<&mut End>,
		flags: u32,
	) -> bool {
		let nul = C::of(0);
		let (mut p, mut n) = (pattern, string);
		'next: while p < pe {
			let c = self.pc(p).fold(flags);
			p += 1;
			let mut sc = if n < se { self.sc(n) } else { nul };
			if flags & EXTMATCH != 0 && Self::is(self.pc(p), b'(') && c.ascii().is_some_and(is_ext_op)
			{
				let lflags = if n == string {
					flags
				} else {
					flags & !(PERIOD | DOTDOT)
				};
				return self.extmatch(c, n, se, p, pe, lflags);
			}
			match c.ascii() {
				Some(b'?') => {
					if sc == nul
						|| (flags & PATHNAME != 0 && Self::is(sc, b'/'))
						|| self.lead_dot(n, string, sc, flags)
						|| self.lead_dotdot(n, string, flags)
					{
						return false;
					}
				},
				Some(b'\\') => {
					if !(p == pe && Self::is(sc, b'\\') && n + 1 == se) {
						if p == pe {
							return false;
						}
						let esc = self.pc(p).fold(flags);
						p += 1;
						if sc.fold(flags) != esc {
							return false;
						}
					}
				},
				Some(b'*') => {
					if let Some(e) = ends.take() {
						e.pattern = Some(p - 1);
						e.string = n;
						return true;
					}
					if self.lead_dot(n, string, sc, flags) || self.lead_dotdot(n, string, flags) {
						return false;
					}
					if p == pe {
						return true;
					}
					// Collapse a run of `*` and `?`, consuming one unit per `?`.
					let mut c = self.pc(p);
					p += 1;
					while Self::is(c, b'?') || Self::is(c, b'*') {
						if flags & PATHNAME != 0 && Self::is(sc, b'/') {
							return false;
						}
						if flags & EXTMATCH != 0 && Self::is(c, b'?') && Self::is(self.pc(p), b'(') {
							if self.extmatch(c, n, se, p, pe, flags) {
								return true;
							}
							p = self.patscan(p + 1, pe, 0, flags).unwrap_or(pe);
						} else if Self::is(c, b'?') {
							if sc == nul {
								return false;
							}
							n += 1;
							sc = if n < se { self.sc(n) } else { nul };
						}
						if flags & EXTMATCH != 0 && Self::is(c, b'*') && Self::is(self.pc(p), b'(') {
							for newn in n..se {
								if self.extmatch(c, newn, se, p, pe, flags) {
									return true;
								}
							}
							p = self.patscan(p + 1, pe, 0, flags).unwrap_or(pe);
						}
						if p == pe {
							break;
						}
						c = self.pc(p);
						p += 1;
					}
					if c == nul {
						return flags & PATHNAME == 0
							|| !self.s[n..se].iter().any(|&u| Self::is(u, b'/'));
					}
					if p == pe && (Self::is(c, b'?') || Self::is(c, b'*')) {
						return true;
					}
					if n == se
						&& flags & EXTMATCH != 0
						&& (Self::is(c, b'!') || Self::is(c, b'?'))
						&& Self::is(self.pc(p), b'(')
					{
						// bash passes the operator itself, not the `(`.
						let r = self.extmatch(c, n, se, p - 1, pe, flags);
						return r != Self::is(c, b'!');
					}
					if Self::is(c, b'/') && flags & PATHNAME != 0 {
						while n < se && !Self::is(self.sc(n), b'/') {
							n += 1;
						}
						return n < se
							&& Self::is(self.sc(n), b'/')
							&& self.gmatch(n + 1, se, p, pe, None, flags);
					}
					// General case: try each start, stopping at the next `*`.
					let mut end = End::default();
					let endp = if flags & PATHNAME != 0 {
						self.s[n..se]
							.iter()
							.position(|&u| Self::is(u, b'/'))
							.map_or(se, |i| n + i)
					} else {
						se
					};
					let c1 = if Self::is(c, b'\\') { self.pc(p) } else { c }.fold(flags);
					p -= 1;
					let ext_head =
						Self::is(self.pc(p + 1), b'(') || self.pc(p).ascii().is_some_and(is_ext_op);
					while n < endp {
						let skip = !Self::is(c, b'[')
							&& self.sc(n).fold(flags) != c1
							&& (flags & EXTMATCH == 0 || !ext_head);
						if !skip && self.gmatch(n, se, p, pe, Some(&mut end), flags & !(PERIOD | DOTDOT))
						{
							if end.pattern.is_none() {
								return true;
							}
							break;
						}
						n += 1;
					}
					if let Some(ep) = end.pattern {
						p = ep;
						n = end.string;
						continue 'next;
					}
					return false;
				},
				Some(b'[') => {
					if sc == nul
						|| n == se
						|| self.lead_dot(n, string, sc, flags)
						|| (Self::is(sc, b'/') && flags & PATHNAME != 0)
						|| self.lead_dotdot(n, string, flags)
					{
						return false;
					}
					match self.brackmatch(p, sc, flags) {
						Some(np) => p = np,
						None => return false,
					}
				},
				_ => {
					if c != sc.fold(flags) {
						return false;
					}
				},
			}
			n += 1;
		}
		n == se
	}

	/// bash's `PARSE_SUBBRACKET`: `p` is at the `.`, `=` or `:` after `[`;
	/// the index of the closing `.]`, `=]` or `:]`. Only a collating symbol
	/// may contain `]`.
	fn subbracket(&self, mut p: usize, flags: u32) -> Option<usize> {
		let kind = self.pc(p);
		loop {
			p += 1;
			let c = self.pc(p);
			if Self::is(c, 0)
				|| (Self::is(c, b'/') && flags & PATHNAME != 0)
				|| (!Self::is(kind, b'.') && Self::is(c, b']'))
			{
				return None;
			}
			if c == kind && Self::is(self.pc(p + 1), b']') {
				return Some(p);
			}
		}
	}

	/// bash's `COLLSYM`: the unit the name `p[start..end]` stands for.
	fn collsym(&self, start: usize, end: usize) -> C {
		let name = &self.p[start.min(self.p.len())..end.min(self.p.len())];
		let ascii: Option<Vec<u8>> = name.iter().map(|u| u.ascii()).collect();
		if let Some(code) = ascii.and_then(|n| collsym(&n)) {
			return C::of(code);
		}
		match name {
			[one] => *one,
			_ => C::INVALID,
		}
	}

	/// `IS_CCLASS`: whether `c` is in the class named `p[start..end]`
	/// (backslashes removed); an unknown name matches nothing.
	fn in_class(&self, c: C, start: usize, end: usize) -> bool {
		let mut name = Vec::with_capacity(end - start);
		let mut i = start;
		while i < end {
			if Self::is(self.pc(i), b'\\') {
				i += 1;
				if i >= end {
					break;
				}
			}
			let Some(b) = self.pc(i).ascii() else {
				return false;
			};
			name.push(b);
			i += 1;
		}
		Class::parse(&name).is_some_and(|class| c.in_class(class))
	}

	/// bash's `BRACKMATCH`: `p` is just past the `[`; the index past the
	/// bracket expression if `test` matches it, else `None`. An unterminated
	/// expression matches a literal `[` and resumes right after it.
	fn brackmatch(&self, mut p: usize, orig_test: C, flags: u32) -> Option<usize> {
		let test = orig_test.fold(flags);
		let savep = p;
		let unterminated = || Self::is(test, b'[').then_some(savep);
		let stop = |c: C| Self::is(c, 0) || (Self::is(c, b'/') && flags & PATHNAME != 0);
		let not = Self::is(self.pc(p), b'!') || Self::is(self.pc(p), b'^');
		if not {
			p += 1;
		}
		let mut c = self.pc(p);
		p += 1;
		// Ranges compare code points: bash's `rangecmp` in the C locale (and
		// for ASCII under `globasciiranges`, the default).
		let matched = 'scan: loop {
			let mut cstart = c;
			let mut cend;
			// `[=c=]` and `[:class:]` cannot start a range.
			if Self::is(c, b'[')
				&& let Some(kind @ (b'=' | b':')) = self.pc(p).ascii()
				&& let Some(close) = self.subbracket(p, flags)
			{
				let hit = if kind == b'=' {
					test == self.collsym(p + 1, close).fold(flags)
				} else {
					self.in_class(orig_test, p + 1, close)
				};
				p = close + 2;
				if hit {
					p += 1;
					break 'scan true;
				}
				c = self.pc(p);
				p += 1;
				if stop(c) {
					return unterminated();
				}
				if Self::is(c, b']') {
					break 'scan false;
				}
				c = c.fold(flags);
				continue;
			}
			if Self::is(c, b'[')
				&& Self::is(self.pc(p), b'.')
				&& let Some(close) = self.subbracket(p, flags)
			{
				cstart = self.collsym(p + 1, close);
				p = close + 2;
			}
			if Self::is(c, b'\\') {
				let e = self.pc(p);
				if stop(e) {
					return unterminated();
				}
				cstart = e;
				p += 1;
			}
			cstart = cstart.fold(flags);
			cend = cstart;
			if stop(c) {
				return unterminated();
			}
			c = self.pc(p).fold(flags);
			p += 1;
			if stop(c) {
				return unterminated();
			}
			// Without a range `cend == cstart`, so the range test below is
			// bash's `test == cstart`.
			if Self::is(c, b'-') && !Self::is(self.pc(p), b']') {
				cend = self.pc(p);
				p += 1;
				if Self::is(cend, b'\\') {
					cend = self.pc(p);
					p += 1;
				}
				if stop(cend) {
					return unterminated();
				}
				if Self::is(cend, b'[')
					&& Self::is(self.pc(p), b'.')
					&& let Some(close) = self.subbracket(p, flags)
				{
					cend = self.collsym(p + 1, close);
					p = close + 2;
				}
				cend = cend.fold(flags);
				c = self.pc(p);
				p += 1;
				// A reversed range matches nothing; the rest still counts.
				if cstart.code() > cend.code() {
					if Self::is(c, b']') {
						break 'scan false;
					}
					c = c.fold(flags);
					continue;
				}
			}
			if (cstart.code()..=cend.code()).contains(&test.code()) {
				break 'scan true;
			}
			if Self::is(c, b']') {
				break 'scan false;
			}
		};
		if !matched {
			return not.then_some(p);
		}
		// Skip the rest of the matched expression.
		p -= 1;
		let mut c = self.pc(p);
		loop {
			if stop(c) {
				return unterminated();
			}
			c = self.pc(p);
			p += 1;
			if Self::is(c, b'[')
				&& self
					.pc(p)
					.ascii()
					.is_some_and(|b| matches!(b, b'=' | b':' | b'.'))
			{
				if let Some(close) = self.subbracket(p, flags) {
					p = close + 2;
				}
			} else if Self::is(c, b']') {
				break;
			} else if Self::is(c, b'\\') {
				if stop(self.pc(p)) {
					return unterminated();
				}
				p += 1;
			}
		}
		(!not).then_some(p)
	}

	/// bash's `PATSCAN` (see [`patscan`]); `delim` is `|` or NUL.
	fn patscan(&self, start: usize, end: usize, delim: u8, flags: u32) -> Option<usize> {
		if start == end {
			return None;
		}
		let (mut pnest, mut bnest) = (0usize, 0usize);
		let mut skip = false;
		let mut bfirst: Option<usize> = None;
		let mut s = start;
		loop {
			let c = self.pc(s);
			if Self::is(c, 0) {
				return None;
			}
			if s >= end {
				return Some(s);
			}
			if skip {
				skip = false;
				s += 1;
				continue;
			}
			match c.ascii() {
				Some(b'\\') => skip = true,
				Some(b'[') => {
					if bnest == 0 {
						let mut first = s + 1;
						if matches!(self.pc(first).ascii(), Some(b'!' | b'^')) {
							first += 1;
						}
						bfirst = Some(first);
						bnest += 1;
					} else if matches!(self.pc(s + 1).ascii(), Some(b':' | b'.' | b'='))
						&& let Some(t) = self.subbracket(s + 1, flags)
					{
						s = t + 1;
					}
				},
				Some(b']') => {
					if bnest > 0 && bfirst != Some(s) {
						bnest -= 1;
						bfirst = None;
					}
				},
				Some(b'(') if bnest == 0 => pnest += 1,
				Some(b')') if bnest == 0 => {
					if pnest == 0 {
						return Some(s + 1);
					}
					pnest -= 1;
				},
				Some(b'|') if bnest == 0 && pnest == 0 && delim == b'|' => return Some(s + 1),
				_ => {},
			}
			s += 1;
		}
	}

	/// bash's `STRCOMPARE`: `p[ps..pe]` equals `s[ss..se]`.
	fn strcompare(&self, ps: usize, pe: usize, ss: usize, se: usize) -> bool {
		pe - ps == se - ss && (0..pe - ps).all(|i| self.pc(ps + i) == self.sc(ss + i))
	}

	/// bash's `EXTMATCH`: `xc(…)` at `p` (the `(`) against `s[s..se]`,
	/// followed by the rest of the pattern.
	fn extmatch(&self, xc: C, s: usize, se: usize, p: usize, pe: usize, flags: u32) -> bool {
		let open = usize::from(Self::is(self.pc(p), b'('));
		let Some(prest) = self.patscan(p + open, pe, 0, flags) else {
			// Not a valid group: compare as a string.
			return self.strcompare(p - 1, pe, s, se);
		};
		let not_lead = |srest: usize| {
			if srest > s {
				flags & !(PERIOD | DOTDOT)
			} else {
				flags
			}
		};
		let subs = |psub: usize| self.patscan(psub, pe, b'|', flags).unwrap_or(prest);
		match xc.ascii() {
			Some(op @ (b'+' | b'*')) => {
				if op == b'*' && self.gmatch(s, se, prest, pe, None, flags) {
					return true;
				}
				let mut psub = p + 1;
				loop {
					let pnext = subs(psub);
					for srest in s..=se {
						if self.gmatch(s, srest, psub, pnext - 1, None, flags) {
							let xflags = not_lead(srest);
							if self.gmatch(srest, se, prest, pe, None, xflags)
								|| (s != srest && self.gmatch(srest, se, p - 1, pe, None, xflags))
							{
								return true;
							}
						}
					}
					if pnext == prest {
						return false;
					}
					psub = pnext;
				}
			},
			Some(op @ (b'?' | b'@')) => {
				if op == b'?' && self.gmatch(s, se, prest, pe, None, flags) {
					return true;
				}
				let mut psub = p + 1;
				loop {
					let pnext = subs(psub);
					let first = if prest == pe { se } else { s };
					for srest in first..=se {
						if self.gmatch(s, srest, psub, pnext - 1, None, flags)
							&& self.gmatch(srest, se, prest, pe, None, not_lead(srest))
						{
							return true;
						}
					}
					if pnext == prest {
						return false;
					}
					psub = pnext;
				}
			},
			Some(b'!') => {
				for srest in s..=se {
					let mut psub = p + 1;
					let m1 = loop {
						let pnext = subs(psub);
						if self.gmatch(s, srest, psub, pnext - 1, None, flags) {
							break true;
						}
						if pnext == prest {
							break false;
						}
						psub = pnext;
					};
					if !m1 {
						if (flags & PERIOD != 0 && Self::is(self.sc(s), b'.'))
							|| (flags & DOTDOT != 0 && self.sdot(s))
						{
							return false;
						}
						if self.gmatch(srest, se, prest, pe, None, not_lead(srest)) {
							return true;
						}
					}
				}
				false
			},
			_ => false,
		}
	}
}
