//! The zsh pattern matcher: zsh 5.9 `pattern.c` `pattryrefs` (behind
//! `pattry` and `pattrylen`, with `patmungestring` and `patallocstr`
//! preparing the subject), the backtracking `patmatch` with its
//! approximation code, and `patrepeat`.
//!
//! The subject is matched unmetafied, as zsh does whenever it holds a
//! metafied byte; a subject without one is matched in place. zsh's
//! per-node scratch strings (`P_WBRANCH` and `P_EXCLUDE` sync strings,
//! `P_COUNT` counters), which live in its compiled program, live in the
//! [`Run`] here, so a [`Pattern`] stays immutable and shareable.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::borrow::Cow;

use super::{
	CharEnv, PatFlags,
	class::{self, fold_lower, lower_to_upper},
	compile::Pattern,
	mbchar::{charnext, charprev, charref, charrefinc, charsub},
	prog::*,
};
use crate::bash::syntax::zsh::tok::{META, NULARG, at, head, is_meta, span, tail, unmetafy};

/// A matched stretch of a subject: a whole `(#m)` match or one `(#b)`
/// group.
///
/// `begin` and `end` count characters from the start of the subject
/// (end exclusive), so zsh's `MBEGIN`/`$mbegin[i]` is `begin + 1` and
/// `MEND`/`$mend[i]` is `end` (`begin` and `end - 1` under `KSH_ARRAYS`).
/// `byte_begin..byte_end` is the stretch in the metafied subject the
/// caller passed, which is `$MATCH`/`$match[i]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
	/// Character offset of the start.
	pub begin:      usize,
	/// Character offset after the end.
	pub end:        usize,
	/// Byte offset of the start in the metafied subject.
	pub byte_begin: usize,
	/// Byte offset after the end in the metafied subject.
	pub byte_end:   usize,
}

/// The `(#b)` groups of a match (zsh `match`, `mbegin`, `mend`): one entry
/// per capturing parenthesis, `None` for a group that did not take part
/// (zsh's empty string and `-1`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Groups {
	/// Number of capturing parentheses.
	len:   u8,
	/// The spans, the first `len` used.
	spans: [Option<Span>; NSUBEXP],
}

impl Groups {
	/// The number of groups, the length of `$match`.
	pub const fn len(&self) -> usize {
		self.len as usize
	}

	/// Whether there are no groups (never, for a recorded match).
	pub const fn is_empty(&self) -> bool {
		self.len == 0
	}

	/// Group `i` (from 0), if it took part in the match.
	pub fn get(&self, i: usize) -> Option<Span> {
		head(&self.spans, self.len()).get(i).copied().flatten()
	}

	/// Every group in order, `None` for those that did not take part.
	pub fn iter(&self) -> impl ExactSizeIterator<Item = Option<Span>> + '_ {
		head(&self.spans, self.len()).iter().copied()
	}
}

/// What a successful match reports to the capture variables. Each field is
/// written by every successful match that sets it and left alone
/// otherwise, as zsh leaves `$match` and `$MATCH` alone on failure.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Captures {
	/// `(#m)`: `$MATCH`, `$MBEGIN`, `$MEND`; written when `(#m)` is in
	/// effect at the end of the pattern ([`Pattern::sets_match`]).
	pub whole:  Option<Span>,
	/// `(#b)`: `$match`, `$mbegin`, `$mend`; written when the pattern has
	/// capturing parentheses ([`Pattern::npar`]).
	pub groups: Option<Groups>,
}

/// The approximation state a file glob shares across path segments (zsh's
/// globals `errsfound` and `forceerrs`, which `glob.c`'s `scanner`
/// adjusts between segments).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Approx {
	/// Errors used by the segments matched so far.
	pub errsfound: i32,
	/// A forced maximum error count, -1 for none.
	pub forceerrs: i32,
}

impl Approx {
	/// zsh `pattrystart`: no errors, no forced maximum.
	pub const START: Self = Self { errsfound: 0, forceerrs: -1 };
}

impl Default for Approx {
	fn default() -> Self {
		Self::START
	}
}

/// Maps offsets in an unmetafied subject to the metafied string it came
/// from.
#[derive(Clone, Copy)]
pub(super) struct MetaMap<'a> {
	/// The unmetafied subject.
	raw:   &'a [u8],
	/// Bytes of the caller's string before the subject (a leading
	/// `Nularg`).
	base:  usize,
	/// Whether the subject held no metafied byte.
	plain: bool,
}

impl<'a> MetaMap<'a> {
	/// The map for the unmetafied `raw` of a metafied string `meta_len`
	/// bytes long, `base` bytes into the caller's string.
	pub const fn new(raw: &'a [u8], meta_len: usize, base: usize) -> Self {
		Self { raw, base, plain: raw.len() == meta_len }
	}

	/// The offset in the caller's metafied string of unmetafied offset `u`.
	pub fn at(&self, u: usize) -> usize {
		let extra = if self.plain {
			0
		} else {
			head(self.raw, u).iter().filter(|&&b| is_meta(b)).count()
		};
		self.base + u + extra
	}
}

/// A subject prepared for matching: zsh `patmungestring` (a leading
/// `Nularg` marks an empty tokenized string) and `patallocstr`
/// (unmetafied only when it holds a metafied byte).
struct Subject<'s> {
	/// Bytes skipped at the start.
	base:     usize,
	/// Length of the metafied subject after them.
	meta_len: usize,
	/// The unmetafied subject.
	raw:      Cow<'s, [u8]>,
}

impl<'s> Subject<'s> {
	/// Prepare the metafied `s`.
	fn new(s: &'s [u8]) -> Self {
		let base = usize::from(s.first() == Some(&NULARG));
		let meta = tail(s, base);
		let raw = if meta.contains(&META) {
			Cow::Owned(unmetafy(meta))
		} else {
			Cow::Borrowed(meta)
		};
		Self { base, meta_len: meta.len(), raw }
	}

	/// The offset map of this subject.
	fn map(&self) -> MetaMap<'_> {
		MetaMap::new(&self.raw, self.meta_len, self.base)
	}
}

impl Pattern {
	/// zsh `pattry`: whether the metafied `subject` matches (whole string
	/// unless compiled with [`PatFlags::NOANCH`]).
	pub fn matches(&self, subject: &[u8], env: &CharEnv) -> bool {
		self.try_match(subject, env, None).is_some()
	}

	/// zsh `pattryrefs`: match the metafied `subject`, returning the
	/// metafied length of the match (zsh `patmatchlen`; a prefix under
	/// [`PatFlags::NOANCH`], the whole subject otherwise). On success the
	/// `(#b)`/`(#m)` captures are written to `caps`.
	pub fn try_match(
		&self,
		subject: &[u8],
		env: &CharEnv,
		caps: Option<&mut Captures>,
	) -> Option<usize> {
		let sub = Subject::new(subject);
		let map = sub.map();
		let mut run = Run::new(&self.prog, &sub.raw, env);
		let end = run.trial(0, sub.raw.len(), PatFlags::NONE, None, None)?;
		if let Some(caps) = caps {
			run.record(caps, 0, end, 0, &map);
		}
		Some(map.at(end) - sub.base)
	}

	/// zsh `pattry` on one file name of a glob (`glob.c` `scanner`):
	/// `name` is the metafied directory entry, `path` the metafied path
	/// matched so far (zsh `pathbuf`), which a top-level `~` exclusion of a
	/// [`PatFlags::FILET`] pattern matches together with `name`.
	/// Approximation errors accumulate in `approx` across segments.
	pub fn try_file(&self, name: &[u8], path: &[u8], env: &CharEnv, approx: &mut Approx) -> bool {
		let sub = Subject::new(name);
		let needpath = self.prog.flags.contains(PatFlags::HAS_EXCLUDP) && !path.is_empty();
		let (buf, start) = if needpath {
			let mut full = unmetafy(path);
			let start = full.len();
			full.extend_from_slice(&sub.raw);
			(Cow::Owned(full), start)
		} else {
			(sub.raw, 0)
		};
		let mut run = Run::new(&self.prog, &buf, env);
		run.trial(start, buf.len(), PatFlags::NONE, needpath.then_some(0), Some(approx))
			.is_some()
	}
}

/// How [`Run::star`] leaves the main loop of `patmatch`.
enum Flow {
	/// Return this result.
	Done(bool),
	/// Go on with this node (zsh's `break` out of the switch).
	Goto(usize),
}

/// The state of matching one program against one subject buffer (zsh
/// `struct rpat` plus the globals `patflags`, `patglobflags`, `errsfound`,
/// `forceerrs`, `exactpos`/`exactend`, and the program's scratch slots).
pub(super) struct Run<'a> {
	/// The program.
	prog:      &'a Prog,
	/// The unmetafied subject buffer (with a path prefix for `~` in file
	/// globs).
	buf:       &'a [u8],
	/// The shell values of zsh's own character classes.
	env:       &'a CharEnv<'a>,
	/// Start of the trial string (zsh `patinstart`).
	instart:   usize,
	/// End of the trial string (zsh `patinend`).
	inend:     usize,
	/// The input position (zsh `patinput`).
	input:     usize,
	/// Start of the full path for `~` exclusions (zsh `patinpath`).
	inpath:    Option<usize>,
	/// Starts of the captures (zsh `patbeginp`).
	beginp:    [usize; NSUBEXP],
	/// Ends of the captures (zsh `patendp`).
	endp:      [usize; NSUBEXP],
	/// Captures found: bit `n - 1` for a start, `n + 15` for an end (zsh
	/// `parsfound`).
	parsfound: u32,
	/// Whether a leading `.` may match a wildcard (zsh `globdots`).
	globdots:  bool,
	/// `PAT_*` flags of this trial (zsh `patflags`).
	patflags:  PatFlags,
	/// Globbing flags in effect (zsh `patglobflags`).
	globflags: u32,
	/// Approximation errors so far (zsh `errsfound`).
	errsfound: i32,
	/// Forced maximum error count, -1 for none (zsh `forceerrs`).
	forceerrs: i32,
	/// Where an approximated `P_EXACTLY` resumes in its string, and the end
	/// (zsh `exactpos`, `exactend`).
	exactpos:  Option<(usize, usize)>,
	/// Scratch strings of `P_WBRANCH`/`P_EXCLUDE` nodes, empty when unset
	/// (zsh's `uc*` operands).
	sync:      Vec<Vec<u8>>,
	/// `P_COUNT` state: the current count and the input position of the
	/// last attempt, `usize::MAX` for none (zsh `P_CT_CURRENT`,
	/// `P_CT_PTR`).
	count:     Vec<(i64, usize)>,
}

impl<'a> Run<'a> {
	/// A run of `prog` over the unmetafied `buf`.
	pub fn new(prog: &'a Prog, buf: &'a [u8], env: &'a CharEnv<'a>) -> Self {
		Self {
			prog,
			buf,
			env,
			instart: 0,
			inend: 0,
			input: 0,
			inpath: None,
			beginp: [0; NSUBEXP],
			endp: [0; NSUBEXP],
			parsfound: 0,
			globdots: true,
			patflags: PatFlags::NONE,
			globflags: 0,
			errsfound: 0,
			forceerrs: -1,
			exactpos: None,
			sync: vec![Vec::new(); prog.nsync as usize],
			count: vec![(0, usize::MAX); prog.ncount as usize],
		}
	}

	/// The trial core of zsh `pattryrefs`: match `buf[start..end]` with
	/// `extra` (`PAT_NOTSTART`/`PAT_NOTEND`) added to the program's flags.
	/// Returns the end of the match in `buf`.
	pub fn trial(
		&mut self,
		start: usize,
		end: usize,
		extra: PatFlags,
		inpath: Option<usize>,
		approx: Option<&mut Approx>,
	) -> Option<usize> {
		let prog = self.prog;
		let buf = self.buf;
		self.patflags = prog.flags | extra;
		self.instart = start;
		self.inend = end;
		self.inpath = inpath;

		if prog.flags.contains(PatFlags::PURES) || prog.flags.contains(PatFlags::ANY) {
			// A pure string, or anything at all.
			let plen = prog.pure.len();
			let ok = prog.flags.contains(PatFlags::ANY)
				|| (end - start >= plen
					&& span(buf, start, start + plen) == &*prog.pure
					&& (end - start == plen || prog.flags.contains(PatFlags::NOANCH)));
			// For files, no initial "." unless glob_dots.
			if !ok || (prog.flags.contains(PatFlags::NOGLD) && start < end && at(buf, start) == b'.') {
				return None;
			}
			self.globflags = prog.globend;
			self.input = start + plen;
			return Some(self.input);
		}

		// The must-match string, unless the caller is scanning.
		if !prog.flags.contains(PatFlags::SCAN)
			&& let Some(must) = &prog.must
			&& !span(buf, start, end)
				.windows(must.len())
				.any(|w| w == &**must)
		{
			return None;
		}

		self.globflags = prog.globflags;
		if prog.flags.contains(PatFlags::FILE) {
			if let Some(a) = &approx {
				self.errsfound = a.errsfound;
				self.forceerrs = a.forceerrs;
			}
		} else {
			self.forceerrs = -1;
			self.errsfound = 0;
		}
		self.globdots = !prog.flags.contains(PatFlags::NOGLD);
		self.parsfound = 0;
		self.input = start;
		self.exactpos = None;
		for s in &mut self.sync {
			s.clear();
		}
		self.count.fill((0, usize::MAX));
		let ok = self.patmatch(1);
		if let Some(a) = approx {
			a.errsfound = self.errsfound;
			a.forceerrs = self.forceerrs;
		}
		if !ok {
			return None;
		}
		// Exclusions that failed did not save the flags.
		self.globflags = prog.globend;
		Some(self.input)
	}

	/// The capture half of zsh `pattryrefs`: after a successful
	/// [`Self::trial`] from `start` ending at `mend`, write `(#m)` and
	/// `(#b)` to `caps`, offsetting characters by `patoffset`.
	pub fn record(
		&self,
		caps: &mut Captures,
		start: usize,
		mend: usize,
		patoffset: usize,
		map: &MetaMap<'_>,
	) {
		let prog = self.prog;
		if prog.flags.contains(PatFlags::FILE) {
			return;
		}
		let mb = prog.multibyte;
		let span = |b: usize, e: usize| {
			let e = e.max(b);
			Span {
				begin:      charsub(self.buf, start, b, mb) + patoffset,
				end:        charsub(self.buf, start, e, mb) + patoffset,
				byte_begin: map.at(b),
				byte_end:   map.at(e),
			}
		};
		if self.globflags & GF_MATCHREF != 0 {
			caps.whole = Some(span(start, mend));
		}
		if prog.npar > 0 && !prog.flags.contains(PatFlags::PURES) {
			let mut groups = Groups { len: prog.npar, spans: [None; NSUBEXP] };
			for (i, slot) in groups.spans.iter_mut().take(prog.npar as usize).enumerate() {
				if self.parsfound & (1 << i) != 0 {
					let e = if self.parsfound & (1 << (i + 16)) != 0 {
						self.endp[i]
					} else {
						self.beginp[i]
					};
					*slot = Some(span(self.beginp[i], e));
				}
			}
			caps.groups = Some(groups);
		}
	}

	/// Whether multibyte characters are in effect.
	#[inline]
	const fn mb(&self) -> bool {
		self.globflags & GF_MULTIBYTE != 0
	}

	/// zsh `CHARMATCH`: the subject character `chin` matches the pattern
	/// character `chpa` under `(#i)`/`(#l)`.
	#[inline]
	fn charmatch(&self, chin: u32, chpa: u32) -> bool {
		let wide = self.prog.multibyte;
		chin == chpa
			|| if self.globflags & GF_IGNCASE != 0 {
				fold_lower(chin, wide) == fold_lower(chpa, wide)
			} else if self.globflags & GF_LCMATCHUC != 0 {
				lower_to_upper(chpa, wide) == Some(chin)
			} else {
				false
			}
	}

	/// zsh `patmatch`: match the program from node `start_node` at the
	/// input position, backtracking by recursion.
	fn patmatch(&mut self, start_node: usize) -> bool {
		let prog = self.prog;
		let buf = self.buf;
		let mut scan = start_node;
		let mut fail = false;
		while scan != 0 {
			let mut next = prog.next(scan);
			let op = prog.op(scan);
			if !self.globdots
				&& not_dot(op)
				&& self.input == self.instart
				&& self.input < self.inend
				&& at(buf, self.input) == b'.'
			{
				return false;
			}
			match op {
				P_ANY => {
					if self.input == self.inend {
						fail = true;
					} else {
						self.input = charnext(buf, self.input, self.inend, self.mb());
					}
				},
				P_EXACTLY => fail = self.exactly(scan),
				P_ANYOF | P_ANYBUT => {
					if self.input == self.inend {
						fail = true;
					} else {
						let mb = self.mb();
						let (cr, zmb) = charref(buf, self.input, self.inend, mb);
						if class::matchrange(prog.set(scan), cr, zmb, mb, self.env) == (op == P_ANYOF) {
							self.input = charnext(buf, self.input, self.inend, mb);
						} else {
							fail = true;
						}
					}
				},
				P_NUMRNG | P_NUMFROM | P_NUMTO | P_NUMANY => {
					if self.numeric(scan, next) {
						return true;
					}
					fail = true;
				},
				P_GFLAGS => self.globflags = prog.gflags(scan),
				o if (P_OPEN..=P_OPEN + 9).contains(&o) => {
					let no = (o - P_OPEN) as usize;
					let save = self.input;
					if !self.patmatch(next) {
						return false;
					}
					// Don't overwrite what a later invocation of the same
					// parentheses has set.
					if no > 0 && self.parsfound & (1 << (no - 1)) == 0 {
						self.beginp[no - 1] = save;
						self.parsfound |= 1 << (no - 1);
					}
					return true;
				},
				o if (P_CLOSE..=P_CLOSE + 9).contains(&o) => {
					let no = (o - P_CLOSE) as usize;
					let save = self.input;
					if !self.patmatch(next) {
						return false;
					}
					if no > 0 && self.parsfound & (1 << (no + 15)) == 0 {
						self.endp[no - 1] = save;
						self.parsfound |= 1 << (no + 15);
					}
					return true;
				},
				P_EXCSYNC => {
					// The P_EXCLUDE after this node holds the sync string.
					let slot = prog.sync(scan + 1);
					let idx = self.input - self.instart;
					if let Some(b) = self.sync.get_mut(slot).and_then(|v| v.get_mut(idx)) {
						// Matched from here before: fail this time.
						if *b != 0 && self.errsfound + 1 >= i32::from(*b) {
							return false;
						}
						*b = (self.errsfound + 1) as u8;
					}
				},
				P_EXCEND => {
					fail = self.input < self.inend;
					if !fail {
						return true;
					}
				},
				P_BRANCH | P_WBRANCH => {
					if is_branch(prog.op(next)) {
						return self.branch(scan, next);
					}
					// No choice, avoid recursion.
					next = scan + 1;
				},
				P_STAR | P_ONEHASH | P_TWOHASH => match self.star(scan, next) {
					Flow::Done(r) => return r,
					Flow::Goto(n) => next = n,
				},
				P_ISSTART => {
					fail = self.input != self.instart || self.patflags.contains(PatFlags::NOTSTART);
				},
				P_ISEND => {
					fail = self.input < self.inend || self.patflags.contains(PatFlags::NOTEND);
				},
				P_COUNTSTART => return self.countstart(scan),
				P_COUNT => return self.count(scan, next),
				P_END => {
					fail = self.input < self.inend && !self.patflags.contains(PatFlags::NOANCH);
					if !fail {
						return true;
					}
				},
				// P_NOTHING, P_BACK.
				_ => {},
			}

			if fail {
				if self.errsfound < (self.globflags & GF_ERRS) as i32
					&& (self.forceerrs == -1 || self.errsfound < self.forceerrs)
				{
					fail = false;
					match self.approximate(scan, op) {
						Some(true) => return true,
						Some(false) => continue,
						None => {},
					}
				}
				self.exactpos = None;
				return false;
			}
			scan = next;
		}
		false
	}

	/// The `P_EXACTLY` case of zsh `patmatch`; true for a failure, which
	/// leaves the unmatched rest in `exactpos` for the approximation code.
	fn exactly(&mut self, scan: usize) -> bool {
		let buf = self.buf;
		let prog = self.prog;
		let ex = prog.exact(scan);
		let (mut chrop, chrend) = self.exactpos.take().unwrap_or((0, ex.len()));
		let mb = self.mb();
		let mut fail = false;
		while chrop < chrend && self.input < self.inend {
			let savpatinput = self.input;
			let savchrop = chrop;
			let (chin, badin) = charrefinc(buf, &mut self.input, self.inend, mb);
			let (chpa, badpa) = charrefinc(ex, &mut chrop, chrend, mb);
			if !self.charmatch(chin, chpa) || badin != badpa {
				fail = true;
				self.input = savpatinput;
				chrop = savchrop;
				break;
			}
		}
		if chrop < chrend {
			self.exactpos = Some((chrop, chrend));
			fail = true;
		}
		fail
	}

	/// The approximation code of zsh `patmatch` for a failed node `scan`
	/// (one more error): omit a character of the input, transpose input and
	/// pattern characters, omit one of each, omit a pattern character.
	/// `Some(true)` is a match, `Some(false)` retries `scan` in the main
	/// loop, `None` fails.
	fn approximate(&mut self, scan: usize, op: u8) -> Option<bool> {
		let buf = self.buf;
		let savexact = self.exactpos;
		let save = self.input;
		let savglobflags = self.globflags;
		self.errsfound += 1;
		let saverrsfound = self.errsfound;
		let mb = self.mb();

		// Omit a character from the input string.
		if self.input < self.inend {
			self.input = charnext(buf, self.input, self.inend, mb);
			// Not an exact string: this is the last attempt, so loop.
			if op != P_EXACTLY {
				return Some(false);
			}
			if self.patmatch(scan) {
				return Some(true);
			}
		}
		if op != P_EXACTLY {
			return None;
		}
		let prog = self.prog;
		let ex = prog.exact(scan);
		let (sx, exactend) = savexact.unwrap_or((ex.len(), ex.len()));
		let nextexact = charnext(ex, sx, exactend, mb);
		if save < self.inend {
			let nextin = charnext(buf, save, self.inend, mb);
			self.globflags = savglobflags;
			self.errsfound = saverrsfound;
			self.exactpos = savexact;
			// Swap two characters in the input and the pattern.
			if nextin < self.inend && nextexact < exactend {
				let cin0 = charref(buf, save, self.inend, mb).0;
				let cpa0 = charref(ex, sx, exactend, mb).0;
				let cin1 = charref(buf, nextin, self.inend, mb).0;
				let cpa1 = charref(ex, nextexact, exactend, mb).0;
				if self.charmatch(cin0, cpa1) && self.charmatch(cin1, cpa0) {
					self.input = charnext(buf, nextin, self.inend, mb);
					self.exactpos = Some((charnext(ex, nextexact, exactend, mb), exactend));
					if self.patmatch(scan) {
						return Some(true);
					}
					self.globflags = savglobflags;
					self.errsfound = saverrsfound;
				}
			}
			// Move up both strings.
			self.input = nextin;
			self.exactpos = Some((nextexact, exactend));
			if self.patmatch(scan) {
				return Some(true);
			}
			self.input = save;
			self.globflags = savglobflags;
			self.errsfound = saverrsfound;
			self.exactpos = savexact;
		}
		// Move up the pattern string: the last attempt, so loop.
		self.exactpos = Some((nextexact, exactend));
		Some(false)
	}

	/// The numeric-range cases of zsh `patmatch` (`P_NUMRNG`, `P_NUMFROM`,
	/// `P_NUMTO`, `P_NUMANY`): the digits at the input as a closure, so
	/// that `<1-1000>33` matches `633`. True for a match of the rest.
	fn numeric(&mut self, scan: usize, next: usize) -> bool {
		let prog = self.prog;
		let buf = self.buf;
		let op = prog.op(scan);
		let start = self.input;
		// A following exact string that cannot start with a digit stops the
		// backtracking after the first attempt.
		let stops = |run: &Self| {
			prog.op(next) == P_EXACTLY
				&& prog.exact(next).first().is_none_or(|c| !c.is_ascii_digit())
				&& run.globflags & GF_ERRS == 0
		};
		if op == P_NUMANY {
			// <->: any set of digits, no comparison.
			while self.input < self.inend && buf[self.input].is_ascii_digit() {
				self.input += 1;
			}
			let mut save = self.input;
			let mut no = 0;
			while self.input > start {
				if self.patmatch(next) {
					return true;
				}
				if no == 0 && stops(&*self) {
					return false;
				}
				save -= 1;
				self.input = save;
				no += 1;
			}
			self.input = start;
			return false;
		}
		let from = if op == P_NUMTO { 0 } else { prog.num(scan + 1) };
		let to = match op {
			P_NUMRNG => prog.num(scan + 2),
			P_NUMTO => prog.num(scan + 1),
			_ => 0,
		};
		let mut compend = start;
		let mut comp: i64 = 0;
		while self.input < self.inend && buf[self.input].is_ascii_digit() {
			let digit = i64::from(buf[self.input] - b'0');
			let out_of_range = match comp.checked_mul(10).and_then(|c| c.checked_add(digit)) {
				Some(v) => {
					comp = v;
					false
				},
				None => true,
			};
			self.input += 1;
			compend += 1;
			if (out_of_range || comp & (1 << 62) != 0) && op == P_NUMFROM {
				// Too big to compare: a "from" range takes all the digits.
				while self.input < self.inend && buf[self.input].is_ascii_digit() {
					self.input += 1;
				}
			}
		}
		let mut save = self.input;
		let mut no = 0;
		while self.input > start {
			// Already too small, nothing can save it.
			if comp < from && self.input <= compend {
				break;
			}
			if (op == P_NUMFROM || comp <= to) && self.patmatch(next) {
				return true;
			}
			if no == 0 && stops(&*self) {
				return false;
			}
			save -= 1;
			self.input = save;
			no += 1;
			// An unrepresentable number keeps its value until the input
			// backs down to a representable one.
			if self.input < compend {
				comp /= 10;
			}
		}
		self.input = start;
		false
	}

	/// The `P_BRANCH`/`P_WBRANCH` case of zsh `patmatch` with alternatives:
	/// try each branch in turn, including exclusions.
	fn branch(&mut self, mut scan: usize, mut next: usize) -> bool {
		let prog = self.prog;
		loop {
			let save = self.input;
			let savglobflags = self.globflags;
			let saverrsfound = self.errsfound;
			if is_exclude(prog.op(next)) {
				if self.exclude(scan, next, save, savglobflags, saverrsfound) {
					return true;
				}
				loop {
					scan = prog.next(scan);
					if scan == 0 || !is_exclude(prog.op(scan)) {
						break;
					}
				}
			} else {
				let mut ret = true;
				let mut pfree = usize::MAX;
				let opnd = if prog.op(scan) == P_WBRANCH {
					// Never match a zero-length string twice from the same
					// point in a closure: record the positions tried, with
					// the error count for approximation.
					let slot = prog.sync(scan);
					let len = self.inend - self.instart + 1;
					let idx = self.input - self.instart;
					let errs = self.errsfound;
					if let Some(v) = self.sync.get_mut(slot) {
						if v.is_empty() {
							v.resize(len, 0);
							pfree = slot;
						}
						if let Some(b) = v.get_mut(idx) {
							if *b != 0 && errs + 1 >= i32::from(*b) {
								ret = false;
							}
							*b = (errs + 1) as u8;
						}
					}
					scan + 2
				} else {
					scan + 1
				};
				if ret {
					ret = self.patmatch(opnd);
				}
				if let Some(v) = self.sync.get_mut(pfree) {
					v.clear();
				}
				if ret {
					return true;
				}
				scan = prog.next(scan);
			}
			self.input = save;
			self.globflags = savglobflags;
			self.errsfound = saverrsfound;
			next = prog.next(scan);
			if scan == 0 || !is_branch(prog.op(scan)) {
				return false;
			}
		}
	}

	/// The exclusion half of zsh's `P_BRANCH` case: match the asserted
	/// branch `scan`, recording through its `P_EXCSYNC` where the part to
	/// exclude ended, and fail it if one of the exclusions from `next`
	/// matches that much; backtrack the asserted branch until an attempt
	/// survives.
	fn exclude(
		&mut self,
		scan: usize,
		next: usize,
		save: usize,
		savglobflags: u32,
		saverrsfound: i32,
	) -> bool {
		let prog = self.prog;
		let slot = prog.sync(next);
		if slot >= self.sync.len() {
			return false;
		}
		// Each test at the same point is separate: a fresh sync string.
		let len = self.inend - self.instart + 1;
		let oldsync = match self.sync.get_mut(slot) {
			Some(sync) => std::mem::replace(sync, vec![0; len]),
			None => return false,
		};
		let origpatinend = self.inend;
		let savparsfound = self.parsfound;
		let mut matchpt = 0;
		let mut matchederrs = 0;
		let mut ret;
		loop {
			ret = self.patmatch(scan + 1);
			if !ret {
				break;
			}
			let savforce = self.forceerrs;
			let savpatflags = self.patflags;
			self.forceerrs = -1;
			let savglobdots = self.globdots;
			matchederrs = self.errsfound;
			matchpt = self.input;
			self.globdots = true;
			// Where the scan matched the part to be excluded: because of
			// backtracking, the most recent match is the first.
			let synclen = self
				.sync
				.get(slot)
				.map_or(&[][..], Vec::as_slice)
				.iter()
				.position(|&b| b != 0)
				.unwrap_or(len - 1);
			if self.instart + synclen != self.inend {
				// End the string there for the exclusion; (#e) knows.
				self.inend = self.instart + synclen;
				self.patflags |= PatFlags::NOTEND;
			}
			let savpatinstart = self.instart;
			let mut nx = prog.next(scan);
			while nx != 0 && is_exclude(prog.op(nx)) {
				self.input = save;
				// No approximation in exclusions; other flags carry over.
				self.globflags &= !GF_ERRS;
				self.errsfound = 0;
				if prog.op(nx) == P_EXCLUDP
					&& let Some(path) = self.inpath
				{
					// A top-level file exclusion applies to the whole path.
					self.input = path;
					self.instart = path;
				}
				if self.patmatch(nx + 2) {
					ret = false;
					// Captures of an excluded match are invalid.
					self.parsfound = savparsfound;
				}
				if self.inpath.is_some() {
					self.input = savpatinstart + self.input.saturating_sub(self.instart);
					self.instart = savpatinstart;
				}
				if !ret {
					break;
				}
				nx = prog.next(nx);
			}
			self.inend = origpatinend;
			self.patflags = savpatflags;
			self.globdots = savglobdots;
			self.forceerrs = savforce;
			if ret {
				break;
			}
			self.input = save;
			self.globflags = savglobflags;
			self.errsfound = saverrsfound;
		}
		if let Some(sync) = self.sync.get_mut(slot) {
			*sync = oldsync;
		}
		if ret {
			self.input = matchpt;
			self.errsfound = matchederrs;
		}
		ret
	}

	/// The `P_STAR`/`P_ONEHASH`/`P_TWOHASH` case of zsh `patmatch`: take
	/// as many characters as possible, then give them back one at a time.
	fn star(&mut self, mut scan: usize, mut next: usize) -> Flow {
		let prog = self.prog;
		let buf = self.buf;
		if prog.op(scan) == P_STAR {
			// Chains of *'s are one *.
			while prog.op(next) == P_STAR {
				scan = next;
				next = prog.next(scan);
			}
		}
		let op = prog.op(scan);
		let start = self.input;
		let mb = self.mb();
		let mut no: usize;
		if op == P_STAR {
			no = 0;
			while self.input < self.inend {
				self.input = charnext(buf, self.input, self.inend, mb);
				no += 1;
			}
			if prog.op(next) == P_END {
				return Flow::Done(true);
			}
		} else {
			if !self.globdots
				&& not_dot(prog.op(scan + 1))
				&& self.input == self.instart
				&& self.input < self.inend
				&& charref(buf, self.input, self.inend, mb).0 == u32::from(b'.')
			{
				return Flow::Done(false);
			}
			no = self.patrepeat(scan + 1);
		}
		let min = usize::from(op == P_TWOHASH);
		// Look ahead at a following exact string (not with approximation).
		let nextch = if prog.op(next) == P_EXACTLY
			&& !prog.exact(next).is_empty()
			&& self.globflags & GF_ERRS == 0
		{
			let nextop = prog.exact(next);
			if prog.op(prog.next(next)) == P_END && !self.patflags.contains(PatFlags::NOANCH) {
				// A last exact string can only match at one point.
				let base = if min > 0 {
					charnext(buf, start, self.inend, mb)
				} else {
					start
				};
				let Some(lenmatch) = self.inend.checked_sub(base) else {
					return Flow::Done(false);
				};
				let ptlen = self.inend - self.input;
				if nextop.len() > lenmatch || nextop.len() < ptlen {
					return Flow::Done(false);
				}
				self.input = self.inend - nextop.len();
				return Flow::Goto(next);
			}
			Some(charref(nextop, 0, nextop.len(), mb).0)
		} else {
			None
		};
		let savglobflags = self.globflags;
		let saverrsfound = self.errsfound;
		// The position being tried (zsh `lastcharstart`): a failed attempt
		// leaves the input anywhere.
		let mut pos = self.input;
		if no >= min {
			loop {
				let try_here = nextch.is_none_or(|nc| {
					self.input < self.inend
						&& self.charmatch(charref(buf, self.input, self.inend, mb).0, nc)
				});
				if try_here && self.patmatch(next) {
					return Flow::Done(true);
				}
				if no <= min {
					break;
				}
				no -= 1;
				pos = charprev(buf, start, pos, self.inend, mb);
				self.input = pos;
				self.globflags = savglobflags;
				self.errsfound = saverrsfound;
			}
		}
		Flow::Done(false)
	}

	/// zsh `patrepeat`: match the simple operand `p` (a character or a set)
	/// as often as possible, returning the count.
	fn patrepeat(&mut self, p: usize) -> usize {
		let prog = self.prog;
		let buf = self.buf;
		let mb = self.mb();
		let mut count = 0;
		let mut scan = self.input;
		match prog.op(p) {
			P_EXACTLY => {
				let ex = prog.exact(p);
				let tch = charref(ex, 0, ex.len(), mb).0;
				while scan < self.inend && self.charmatch(charref(buf, scan, self.inend, mb).0, tch) {
					count += 1;
					scan = charnext(buf, scan, self.inend, mb);
				}
			},
			op @ (P_ANYOF | P_ANYBUT) => {
				let set = prog.set(p);
				while scan < self.inend {
					let (cr, zmb) = charref(buf, scan, self.inend, mb);
					if class::matchrange(set, cr, zmb, mb, self.env) != (op == P_ANYOF) {
						break;
					}
					count += 1;
					scan = charnext(buf, scan, self.inend, mb);
				}
			},
			_ => {},
		}
		self.input = scan;
		count
	}

	/// Update the state of count closure `slot` (none for a slot the
	/// program does not have).
	fn set_count(&mut self, slot: usize, f: impl FnOnce(&mut (i64, usize))) {
		if let Some(c) = self.count.get_mut(slot) {
			f(c);
		}
	}

	/// zsh's `P_COUNTSTART` case: run the count from zero, keeping the
	/// count of an enclosing use of the same closure.
	fn countstart(&mut self, scan: usize) -> bool {
		let (_, _, slot) = self.prog.count(scan + 1);
		let Some(&(savecount, _)) = self.count.get(slot) else {
			return false;
		};
		self.set_count(slot, |c| c.0 = 0);
		let ret = self.patmatch(scan + 1);
		self.set_count(slot, |c| c.0 = savecount);
		ret
	}

	/// zsh's `P_COUNT` case for `(#cN,M)`: one more repetition while below
	/// the maximum, else the rest of the pattern once the minimum is met.
	fn count(&mut self, scan: usize, next: usize) -> bool {
		let (min, max, slot) = self.prog.count(scan);
		let Some(&(cur, ptr)) = self.count.get(slot) else {
			return false;
		};
		if cur != 0 && cur >= min && self.input == ptr {
			// The previous repetition matched nothing: no point going on.
			return self.patmatch(next);
		}
		let input = self.input;
		self.set_count(slot, |c| c.1 = input);
		if max < 0 || cur < max {
			let thistime = self.input;
			self.set_count(slot, |c| c.0 = cur + 1);
			if self.patmatch(scan + P_CT_OPERAND) {
				return true;
			}
			self.set_count(slot, |c| c.0 = cur);
			self.input = thistime;
		}
		if cur < min {
			return false;
		}
		self.patmatch(next)
	}
}
