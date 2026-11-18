//! Glob patterns with the semantics of Rust's `globset` built with literal
//! separators — the dialect of gitignore rules (via the `ignore` crate) and
//! of pi's glob/grep path filters:
//!
//! ```text
//! ?       one byte other than '/'
//! *       any run of bytes without '/'
//! **/     leading: any (possibly empty) run of whole directories
//! /**     trailing: '/' followed by anything
//! /**/    '/' or '/…/'
//! [a-z]   byte class; [!…] and [^…] negate (negated classes match '/')
//! {a,b}   alternatives (empty alternatives are dropped)
//! \c      literal c
//! ```
//!
//! A `**` in any other position is two `*`s, and a pattern that is exactly
//! `**` matches everything. Paths are `/`-separated, relative, raw bytes.
//!
//! Besides [`Glob::is_match`], a compiled glob answers the questions a walker
//! needs to prune: [`Glob::may_match_under`] (can anything below this
//! directory match?) and [`Glob::max_depth`] (how deep can a match be?).
//!
//! ```ignore
//! let glob = Glob::new("src/**/*.rs")?;
//! assert!(glob.is_match(b"src/a/b.rs"));
//! assert!(!glob.may_match_under(b"docs"));
//! ```

use std::fmt;

/// Dialect switches.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Dialect {
	/// Treat a `[` without a closing `]` as a literal (gitignore rules)
	/// instead of rejecting the pattern.
	pub allow_unclosed_class: bool,
}

/// A malformed pattern: an unclosed class (unless allowed), a dangling
/// escape, unbalanced braces, an inverted range, or too many alternatives.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PatternError {
	pattern: String,
	reason:  &'static str,
}

impl PatternError {
	pub(crate) fn new(pattern: &str, reason: &'static str) -> Self {
		Self { pattern: pattern.to_owned(), reason }
	}

	/// The rejected pattern.
	pub fn pattern(&self) -> &str {
		&self.pattern
	}
}

impl fmt::Display for PatternError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{}: {}", self.pattern, self.reason)
	}
}

impl std::error::Error for PatternError {}

/// A compiled pattern; it matches when any of its alternatives does.
/// Immutable and safe to share across threads.
#[derive(Clone, Debug)]
pub struct Glob {
	alts: Vec<Alt>,
	/// The pattern is exactly `**`.
	all:  bool,
}

/// Bound on `{a,b}` expansion.
const MAX_ALTERNATIVES: usize = 256;

impl Glob {
	/// Compiles `pattern` in the default dialect.
	pub fn new(pattern: &str) -> Result<Self, PatternError> {
		Self::with_dialect(pattern, Dialect::default())
	}

	/// Compiles `pattern` in `dialect`.
	pub fn with_dialect(pattern: &str, dialect: Dialect) -> Result<Self, PatternError> {
		let toks = Parser::parse(pattern, dialect)?;
		if matches!(toks.as_slice(), [Tok::RecPrefix]) {
			return Ok(Self { alts: Vec::new(), all: true });
		}
		let seqs = expand_alts(toks, MAX_ALTERNATIVES)
			.ok_or_else(|| PatternError::new(pattern, "too many alternatives"))?;
		Ok(Self { alts: seqs.into_iter().map(Alt::compile).collect(), all: false })
	}

	/// One glob matching whatever any of `globs` matches.
	pub fn union(globs: impl IntoIterator<Item = Self>) -> Self {
		let mut out = Self { alts: Vec::new(), all: false };
		for glob in globs {
			out.all |= glob.all;
			out.alts.extend(glob.alts);
		}
		if out.all {
			out.alts.clear();
		}
		out
	}

	/// Whether `path` matches.
	pub fn is_match(&self, path: &[u8]) -> bool {
		let base = memchr::memrchr(b'/', path).map_or(path, |i| &path[i + 1..]);
		self.is_match_base(path, base)
	}

	/// [`Self::is_match`] for callers that already split off `base`, the
	/// final component of `path`.
	pub fn is_match_base(&self, path: &[u8], base: &[u8]) -> bool {
		self.all || self.alts.iter().any(|alt| alt.is_match(path, base))
	}

	/// Matching looks only at the final path component, so callers may pass
	/// just that component as the path.
	pub fn basename_only(&self) -> bool {
		self.all || self.alts.iter().all(|alt| alt.kind <= Kind::BaseGlob)
	}

	/// Whether some path strictly inside directory `dir` could match; when
	/// false a walker can skip the whole subtree. Exact for literal prefixes,
	/// conservative (true) whenever wildcards could reach below `dir`. An
	/// empty `dir` (the root) is always true.
	pub fn may_match_under(&self, dir: &[u8]) -> bool {
		if self.all || dir.is_empty() {
			return true;
		}
		let mut under = Vec::with_capacity(dir.len() + 1);
		under.extend_from_slice(dir);
		under.push(b'/');
		self.alts.iter().any(|alt| match alt.kind {
			Kind::BaseLit | Kind::BaseSuffix | Kind::BasePrefix | Kind::BaseGlob => true,
			Kind::PathUnder => under.starts_with(&alt.lit) || alt.lit.starts_with(&under),
			Kind::PathLit => alt.lit.starts_with(&under),
			Kind::PathGlob => {
				Matcher { toks: &alt.toks, s: &under, failed: None, prefix: true }.at(0, 0)
			},
		})
	}

	/// The most `/`-separated components a matching path can have, or `None`
	/// when a `**` or a class matching `/` makes it unbounded.
	pub fn max_depth(&self) -> Option<usize> {
		if self.all {
			return None;
		}
		let mut depth = 0;
		for alt in &self.alts {
			depth = depth.max(alt.max_depth()?);
		}
		Some(depth)
	}
}

/// A 256-bit byte set.
#[derive(Clone, Copy, Debug, Default)]
struct ByteSet([u64; 4]);

impl ByteSet {
	const fn add(&mut self, b: u8) {
		self.0[(b >> 6) as usize] |= 1 << (b & 63);
	}

	const fn has(&self, b: u8) -> bool {
		self.0[(b >> 6) as usize] & (1 << (b & 63)) != 0
	}

	fn add_range(&mut self, lo: u8, hi: u8) {
		for c in lo..=hi {
			self.add(c);
		}
	}
}

#[derive(Clone, Debug)]
enum Tok {
	Lit(Vec<u8>),
	Any,
	Star,
	/// Leading `**/`.
	RecPrefix,
	/// Trailing `/**`.
	RecSuffix,
	/// `/**/`.
	RecMiddle,
	Class {
		neg: bool,
		set: ByteSet,
	},
	Alt(Vec<Vec<Self>>),
}

impl Tok {
	const fn is_wild(&self) -> bool {
		matches!(self, Self::Star | Self::RecPrefix | Self::RecSuffix | Self::RecMiddle)
	}
}

const fn class_matches(neg: bool, set: &ByteSet, b: u8) -> bool {
	set.has(b) != neg
}

/// Port of globset's parser, including its handling of `**` inside
/// alternates and its rollback of unclosed classes to a literal `[`.
struct Parser<'a> {
	s:              &'a str,
	dialect:        Dialect,
	/// Byte offset of the next character.
	pos:            usize,
	prev:           Option<char>,
	cur:            Option<char>,
	branches:       Vec<Vec<Tok>>,
	alt_stack:      Vec<usize>,
	unclosed_class: bool,
}

impl<'a> Parser<'a> {
	fn parse(s: &'a str, dialect: Dialect) -> Result<Vec<Tok>, PatternError> {
		let mut p = Self {
			s,
			dialect,
			pos: 0,
			prev: None,
			cur: None,
			branches: vec![Vec::new()],
			alt_stack: Vec::new(),
			unclosed_class: false,
		};
		let err = |reason| PatternError::new(s, reason);
		while let Some(c) = p.bump() {
			match c {
				'?' => p.push(Tok::Any),
				'*' => p.parse_star(),
				'[' if !p.unclosed_class => p.parse_class().map_err(err)?,
				'{' => {
					p.alt_stack.push(p.branches.len());
					p.branches.push(Vec::new());
				},
				'}' => {
					let start = p
						.alt_stack
						.pop()
						.ok_or_else(|| err("unopened alternation"))?;
					let alts = p.branches.split_off(start);
					p.push(Tok::Alt(alts));
				},
				',' if !p.alt_stack.is_empty() => p.branches.push(Vec::new()),
				'\\' => {
					let c = p.bump().ok_or_else(|| err("dangling escape"))?;
					p.push_lit(c);
				},
				c => p.push_lit(c),
			}
		}
		if p.branches.len() != 1 {
			return Err(err("unclosed alternation"));
		}
		Ok(p.branches.pop().unwrap_or_default())
	}

	fn bump(&mut self) -> Option<char> {
		self.prev = self.cur;
		self.cur = self.s[self.pos..].chars().next();
		if let Some(c) = self.cur {
			self.pos += c.len_utf8();
		}
		self.cur
	}

	fn peek(&self) -> Option<char> {
		self.s[self.pos..].chars().next()
	}

	fn branch(&mut self) -> &mut Vec<Tok> {
		self
			.branches
			.last_mut()
			.expect("parser always has a branch")
	}

	fn push(&mut self, t: Tok) {
		self.branch().push(t);
	}

	fn push_lit(&mut self, c: char) {
		let mut utf8 = [0; char::MAX_LEN_UTF8];
		let bytes = c.encode_utf8(&mut utf8).as_bytes();
		let branch = self.branch();
		if let Some(Tok::Lit(lit)) = branch.last_mut() {
			lit.extend_from_slice(bytes);
		} else {
			branch.push(Tok::Lit(bytes.to_vec()));
		}
	}

	/// Removes the last token as globset's `pop_token` would; a literal run
	/// loses only its final character. Reports whether it was `**` recursion.
	fn pop_rec(&mut self) -> Option<Tok> {
		let branch = self.branch();
		let popped = branch.pop()?;
		match popped {
			Tok::Lit(mut lit) => {
				let keep = std::str::from_utf8(&lit)
					.ok()
					.and_then(|s| s.char_indices().next_back())
					.map_or_else(|| lit.len().saturating_sub(1), |(i, _)| i);
				lit.truncate(keep);
				if !lit.is_empty() {
					branch.push(Tok::Lit(lit));
				}
				None
			},
			t @ (Tok::RecPrefix | Tok::RecSuffix) => Some(t),
			_ => None,
		}
	}

	fn parse_star(&mut self) {
		let prev = self.prev;
		if self.peek() != Some('*') {
			self.push(Tok::Star);
			return;
		}
		self.bump();
		if self.branch().is_empty() {
			match self.peek() {
				Some(next) if next != '/' => {
					self.push(Tok::Star);
					self.push(Tok::Star);
				},
				_ => {
					self.push(Tok::RecPrefix);
					self.bump();
				},
			}
			return;
		}
		let in_alt = self.branches.len() >= 2;
		if prev != Some('/') && (!in_alt || (prev != Some(',') && prev != Some('{'))) {
			self.push(Tok::Star);
			self.push(Tok::Star);
			return;
		}
		let suffix = match self.peek() {
			None => {
				self.bump();
				true
			},
			Some(',' | '}') if in_alt => true,
			Some('/') => {
				self.bump();
				false
			},
			Some(_) => {
				self.push(Tok::Star);
				self.push(Tok::Star);
				return;
			},
		};
		match self.pop_rec() {
			Some(t) => self.push(t),
			None => self.push(if suffix {
				Tok::RecSuffix
			} else {
				Tok::RecMiddle
			}),
		}
	}

	fn parse_class(&mut self) -> Result<(), &'static str> {
		let saved = (self.pos, self.prev, self.cur);
		let mut ranges: Vec<(char, char)> = Vec::new();
		let neg = if matches!(self.peek(), Some('!' | '^')) {
			self.bump();
			true
		} else {
			false
		};
		let mut first = true;
		let mut in_range = false;
		loop {
			let Some(c) = self.bump() else {
				if !self.dialect.allow_unclosed_class {
					return Err("unclosed character class");
				}
				(self.pos, self.prev, self.cur) = saved;
				self.unclosed_class = true;
				self.push_lit('[');
				return Ok(());
			};
			match c {
				']' if !first => {
					if in_range {
						ranges.push(('-', '-'));
					}
					let mut set = ByteSet::default();
					for &(lo, hi) in &ranges {
						add_class_span(&mut set, lo, hi);
					}
					self.push(Tok::Class { neg, set });
					return Ok(());
				},
				'-' if first => ranges.push(('-', '-')),
				_ if in_range => {
					let last = ranges.last_mut().expect("a range has a start");
					last.1 = c;
					if last.1 < last.0 {
						return Err("invalid character range");
					}
					in_range = false;
				},
				'-' => in_range = true,
				_ => ranges.push((c, c)),
			}
			first = false;
		}
	}
}

/// Adds a character range the way globset's byte-oriented regex sees it:
/// each character becomes its UTF-8 bytes, and a range spans only the last
/// byte of `lo` to the first byte of `hi`. ASCII ranges are exact.
fn add_class_span(set: &mut ByteSet, lo: char, hi: char) {
	let (mut a, mut b) = ([0; char::MAX_LEN_UTF8], [0; char::MAX_LEN_UTF8]);
	let a = lo.encode_utf8(&mut a).as_bytes();
	if lo == hi {
		for &c in a {
			set.add(c);
		}
		return;
	}
	let b = hi.encode_utf8(&mut b).as_bytes();
	let (a_last, a_head) = a.split_last().expect("utf-8 is never empty");
	for &c in a_head {
		set.add(c);
	}
	if *a_last <= b[0] {
		set.add_range(*a_last, b[0]);
	}
	for &c in &b[1..] {
		set.add(c);
	}
}

/// Flattens alternates into plain token sequences, merging adjacent
/// literals. Empty alternatives are dropped as in globset; an alternate whose
/// every branch is empty matches the empty string. `None` past `limit`.
fn expand_alts(toks: Vec<Tok>, limit: usize) -> Option<Vec<Vec<Tok>>> {
	if !toks.iter().any(|t| matches!(t, Tok::Alt(_))) {
		return Some(vec![toks]);
	}
	let mut seqs: Vec<Vec<Tok>> = vec![Vec::new()];
	for t in toks {
		let alts = match t {
			Tok::Alt(alts) => alts,
			t => {
				for seq in &mut seqs {
					append_tok(seq, t.clone());
				}
				continue;
			},
		};
		let mut branches = Vec::new();
		for alt in alts {
			if !alt.is_empty() {
				branches.extend(expand_alts(alt, limit)?);
			}
		}
		if branches.is_empty() {
			continue;
		}
		if seqs.len() * branches.len() > limit {
			return None;
		}
		let mut next = Vec::with_capacity(seqs.len() * branches.len());
		for seq in &seqs {
			for branch in &branches {
				let mut out = seq.clone();
				for bt in branch {
					append_tok(&mut out, bt.clone());
				}
				next.push(out);
			}
		}
		seqs = next;
	}
	Some(seqs)
}

fn append_tok(seq: &mut Vec<Tok>, t: Tok) {
	if let (Tok::Lit(add), Some(Tok::Lit(lit))) = (&t, seq.last_mut()) {
		lit.extend_from_slice(add);
		return;
	}
	seq.push(t);
}

/// Specialised matcher shapes, basename kinds first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
	/// Basename equals `lit`.
	BaseLit,
	/// Basename ends with `lit` (`*.log`).
	BaseSuffix,
	/// Basename starts with `lit` (`foo*`).
	BasePrefix,
	/// Tokens against the basename.
	BaseGlob,
	/// Path equals `lit`.
	PathLit,
	/// Path strictly below `lit`, which ends in `/` (`dir/**`).
	PathUnder,
	/// Tokens against the whole path.
	PathGlob,
}

/// One alternative of a compiled glob.
#[derive(Clone, Debug)]
struct Alt {
	kind: Kind,
	lit:  Vec<u8>,
	toks: Vec<Tok>,
	/// Backtracking could go exponential; memoize failed states.
	memo: bool,
}

impl Alt {
	fn compile(mut toks: Vec<Tok>) -> Self {
		let simple = |kind, lit| Self { kind, lit, toks: Vec::new(), memo: false };
		if toks.len() > 1 && matches!(toks[0], Tok::RecPrefix) && !can_match_slash(&toks[1..]) {
			toks.remove(0);
			let special = match toks.as_slice() {
				[Tok::Lit(lit)] => Some((Kind::BaseLit, lit.clone())),
				[Tok::Star, Tok::Lit(lit)] => Some((Kind::BaseSuffix, lit.clone())),
				[Tok::Lit(lit), Tok::Star] => Some((Kind::BasePrefix, lit.clone())),
				_ => None,
			};
			return match special {
				Some((kind, lit)) => simple(kind, lit),
				None => Self { kind: Kind::BaseGlob, lit: Vec::new(), memo: needs_memo(&toks), toks },
			};
		}
		let special = match toks.as_slice() {
			[Tok::Lit(lit)] => Some((Kind::PathLit, lit.clone())),
			[Tok::Lit(lit), Tok::RecMiddle, Tok::Star] => {
				let mut lit = lit.clone();
				lit.push(b'/');
				Some((Kind::PathUnder, lit))
			},
			_ => None,
		};
		match special {
			Some((kind, lit)) => simple(kind, lit),
			None => Self { kind: Kind::PathGlob, lit: Vec::new(), memo: needs_memo(&toks), toks },
		}
	}

	fn max_depth(&self) -> Option<usize> {
		match self.kind {
			Kind::PathLit => Some(memchr::memchr_iter(b'/', &self.lit).count() + 1),
			Kind::PathGlob => {
				let mut depth = 1;
				for t in &self.toks {
					match t {
						Tok::Lit(lit) => depth += memchr::memchr_iter(b'/', lit).count(),
						Tok::Class { neg, set } if class_matches(*neg, set, b'/') => return None,
						Tok::RecPrefix | Tok::RecSuffix | Tok::RecMiddle => return None,
						_ => {},
					}
				}
				Some(depth)
			},
			_ => None,
		}
	}

	fn is_match(&self, path: &[u8], base: &[u8]) -> bool {
		match self.kind {
			Kind::BaseLit => base == self.lit.as_slice(),
			Kind::BaseSuffix => base.ends_with(&self.lit),
			Kind::BasePrefix => base.starts_with(&self.lit),
			Kind::BaseGlob => match_toks(&self.toks, base, self.memo),
			Kind::PathLit => path == self.lit.as_slice(),
			Kind::PathUnder => path.len() > self.lit.len() && path.starts_with(&self.lit),
			Kind::PathGlob => match_toks(&self.toks, path, self.memo),
		}
	}
}

/// Whether `toks` could consume a `/`, which would let a `**/`-prefixed
/// alternative match more than the final path component.
fn can_match_slash(toks: &[Tok]) -> bool {
	toks.iter().any(|t| match t {
		Tok::Lit(lit) => lit.contains(&b'/'),
		Tok::Class { neg, set } => class_matches(*neg, set, b'/'),
		Tok::RecPrefix | Tok::RecSuffix | Tok::RecMiddle => true,
		_ => false,
	})
}

fn needs_memo(toks: &[Tok]) -> bool {
	toks.iter().filter(|t| t.is_wild()).count() > 2
}

thread_local! {
	/// Reused failure bitmap for memoized matching.
	static MEMO: std::cell::RefCell<Vec<u64>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn match_toks(toks: &[Tok], s: &[u8], memo: bool) -> bool {
	if !memo {
		return Matcher { toks, s, failed: None, prefix: false }.at(0, 0);
	}
	MEMO.with(|cell| {
		let Ok(mut failed) = cell.try_borrow_mut() else {
			let mut own = Vec::new();
			return run_memo(toks, s, &mut own);
		};
		run_memo(toks, s, &mut failed)
	})
}

fn run_memo(toks: &[Tok], s: &[u8], failed: &mut Vec<u64>) -> bool {
	failed.clear();
	failed.resize(((toks.len() + 1) * (s.len() + 1)).div_ceil(64), 0);
	Matcher { toks, s, failed: Some(failed), prefix: false }.at(0, 0)
}

/// Backtracking matcher over one token sequence. With `failed`, each
/// (token, offset) state is explored at most once, bounding the work by
/// tokens × bytes. With `prefix`, it instead reports whether `s` could be
/// extended into a match: running out of input inside the pattern succeeds.
struct Matcher<'a> {
	toks:   &'a [Tok],
	s:      &'a [u8],
	failed: Option<&'a mut Vec<u64>>,
	prefix: bool,
}

impl Matcher<'_> {
	fn at(&mut self, ti: usize, si: usize) -> bool {
		let bit = ti * (self.s.len() + 1) + si;
		if let Some(failed) = &self.failed
			&& failed[bit >> 6] & (1 << (bit & 63)) != 0
		{
			return false;
		}
		if self.step(ti, si) {
			return true;
		}
		if let Some(failed) = &mut self.failed {
			failed[bit >> 6] |= 1 << (bit & 63);
		}
		false
	}

	fn step(&mut self, mut ti: usize, mut si: usize) -> bool {
		let s = self.s;
		let toks = self.toks;
		while ti < toks.len() {
			if self.prefix && si == s.len() {
				return true;
			}
			match &toks[ti] {
				Tok::Lit(lit) => {
					let rest = &s[si..];
					if self.prefix && rest.len() < lit.len() {
						return lit.starts_with(rest);
					}
					if !rest.starts_with(lit) {
						return false;
					}
					si += lit.len();
				},
				Tok::Any => {
					if si == s.len() || s[si] == b'/' {
						return false;
					}
					si += 1;
				},
				Tok::Class { neg, set } => {
					if si == s.len() || !class_matches(*neg, set, s[si]) {
						return false;
					}
					si += 1;
				},
				Tok::Star => {
					if ti + 1 == toks.len() && !self.prefix {
						return !s[si..].contains(&b'/');
					}
					loop {
						if self.at(ti + 1, si) {
							return true;
						}
						if si == s.len() || s[si] == b'/' {
							return false;
						}
						si += 1;
					}
				},
				Tok::RecPrefix => {
					if self.at(ti + 1, si) {
						return true;
					}
					for (i, &b) in s.iter().enumerate().skip(si) {
						if b == b'/' && self.at(ti + 1, i + 1) {
							return true;
						}
					}
					return self.prefix;
				},
				Tok::RecSuffix => {
					if si == s.len() || s[si] != b'/' {
						return false;
					}
					return (si + 1..=s.len()).any(|i| self.at(ti + 1, i));
				},
				Tok::RecMiddle => {
					if si == s.len() || s[si] != b'/' {
						return false;
					}
					if self.prefix {
						return true;
					}
					for (i, &b) in s.iter().enumerate().skip(si) {
						if b == b'/' && self.at(ti + 1, i + 1) {
							return true;
						}
					}
					return false;
				},
				Tok::Alt(_) => unreachable!("alternates are expanded before matching"),
			}
			ti += 1;
		}
		si == s.len()
	}
}

#[cfg(test)]
mod tests;
