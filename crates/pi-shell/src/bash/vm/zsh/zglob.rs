//! zsh filename generation: a port of zsh 5.9's `glob.c` `zglob`,
//! `parsepat`, `parsecomplist`, `scanner`, `insert`, the glob qualifiers
//! (`checkglobqual`, `qgetnum`, `qgetmodespec`, the `qual*` tests),
//! `gmatchcmp` sorting, `[n,m]` slices, `nullglob`, `cshnullglob`,
//! `markdirs`, `globdots`, `nomatch` and `badpattern`.
//!
//! The port is pure over a table of file-system answers, like the bash
//! glob ([`crate::bash::vm::glob`]): a question without an answer is noted and
//! the run is discarded; the walk asks every noted question through the
//! pollable `Fs` (parking the op while one is pending) and runs again.
//! Questions are kept in the op's scratch, so after a park the walk
//! resumes where it was; after a restore it starts over (Fs reads only).
//!
//! The qualifiers that run shell code (`(e:…:)`, `(+func)`, zsh
//! `qualsheval`) are questions too: the walk runs each (code, file) pair
//! once, in the current shell above the op's frame (`REPLY` set to the
//! file, `reply` unset), and keeps its status and `reply`/`REPLY` as the
//! answer. A restored op starts over and runs them again. Sorting by shell
//! code (`(oe:…:)`, `(o+…)`) is not supported and fails loudly.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::{collections::VecDeque, task::Context};

use bstr::BString;
use hashbrown::HashMap;

use super::{
	modify::{self, HistSubst},
	params::{self, SCANPM_WANTVALS, Value, opt},
	subscript, text, zpattern,
};
use crate::bash::{
	diag::Diag,
	fs::{Stat, StatKind},
	pattern::zsh::{Approx, FileGlobState, Opts, PatFlags, Pattern},
	syntax::zsh::tok::{
		BAR, DASH, EQUALS, HAT, INANG, INBRACE, INBRACK, INPAR, OUTANG, OUTBRACE, OUTBRACK, OUTPAR,
		POUND, QUEST, STAR, TILDE, at, metafy, span, tail, unmetafy, untokenize,
	},
	vm::{
		Cx, Kernel,
		exec::{self, Flow},
		expand::{Expander, Stop, X},
		glob::{Ask, Fact, answer},
		probe,
		proc::{Atom, Scratch, Vproc},
	},
	zshopt::ZshOpt,
};

/// A `(e:code:)` / `(+func)` question: the code (metafied, untokenized)
/// and the file (metafied, as the qualifier sees it).
type EvalAsk = (Vec<u8>, Vec<u8>);

/// The answer to an [`EvalAsk`] (zsh `qualsheval`).
#[derive(Clone, Debug)]
struct EvalFact {
	/// The code returned 0: the file is selected.
	ok:      bool,
	/// zsh `inserts`: the words `reply` (array, association values or
	/// scalar) or `REPLY` left, metafied, which replace the file name.
	inserts: Option<Vec<Vec<u8>>>,
}

/// The answers and open questions of the file-system walks of one
/// command's globs (kept in the op's scratch across parks).
#[derive(Default)]
pub struct Walk {
	/// Answers so far.
	facts:        HashMap<Ask, Fact>,
	/// Questions still to ask, the first one in flight.
	asking:       VecDeque<Ask>,
	/// Names read so far for an in-flight listing.
	names:        Vec<BString>,
	/// The answers to the probes of the colon modifiers (`(:A)`, `(:P)`,
	/// `(:c)`), in the order the expansion asks them.
	probes:       Vec<Atom>,
	/// Answers of the shell-code qualifiers.
	evals:        HashMap<EvalAsk, EvalFact>,
	/// Shell-code questions still to run, in the order the walk met them.
	eval_asking:  VecDeque<EvalAsk>,
	/// The question whose code runs above the op's frame, with the `$?` to
	/// restore when it is done.
	eval_running: Option<(EvalAsk, i32)>,
}

/// A qualifier test (zsh's `qual*` functions).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QFunc {
	Islnk,
	Issock,
	Isfifo,
	Isdir,
	Isreg,
	Isblk,
	Ischr,
	Isdev,
	Iscom,
	Flags,
	Modeflags,
	Dev,
	Nlink,
	Uid,
	Gid,
	Nonemptydir,
	Time,
	Size,
	/// zsh `qualsheval`: `data` indexes [`Spec::evals`].
	Eval,
}

/// One qualifier (zsh `struct qual`).
#[derive(Clone, Copy, Debug)]
struct Qual {
	func:  QFunc,
	/// Bit 0: negated; bit 1: follow symbolic links.
	sense: u8,
	data:  i64,
	range: i32,
	amc:   i32,
	units: i32,
}

/// Sort keys (zsh `GS_*`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SortKey {
	Name,
	Depth,
	Size,
	Atime,
	Mtime,
	Ctime,
	Links,
	None,
}

/// One sort specifier: key, following links, descending.
#[derive(Clone, Copy, Debug)]
struct Sort {
	key:    SortKey,
	follow: bool,
	desc:   bool,
}

/// A parsed glob word: the pattern and everything its qualifiers asked
/// for (zsh's `curglobdata`).
#[derive(Clone, Debug)]
struct Spec {
	/// The pattern (metafied, tokenized), qualifiers removed.
	pattern:      Vec<u8>,
	/// Alternatives of qualifier lists (all of one alternative must hold).
	quals:        Vec<Vec<Qual>>,
	/// Colon modifiers applied to every match.
	colonmod:     Option<Vec<u8>>,
	nullglob:     bool,
	markdirs:     bool,
	listtypes:    bool,
	follow:       bool,
	noglobdots:   bool,
	numsort:      bool,
	sorts:        Vec<Sort>,
	first:        i64,
	end:          i64,
	shortcircuit: usize,
	pre_words:    Vec<Vec<u8>>,
	post_words:   Vec<Vec<u8>>,
	/// The code of the `e`/`+` qualifiers ([`QFunc::Eval`]).
	evals:        Vec<Vec<u8>>,
}

/// A path component of a pattern (zsh `struct complist`).
struct Comp {
	pat:     Pattern,
	/// 0: once; 1: zero or more times (`**/`, `(x/)#`); 2: one or more.
	closure: u8,
	/// `***/`: follow symbolic links.
	follow:  bool,
}

/// One match (zsh `struct gmatch`).
#[derive(Clone, Debug)]
struct Gmatch {
	/// Metafied path.
	name:  Vec<u8>,
	/// `lstat`.
	st:    Option<Stat>,
	/// `stat` (links followed).
	st2:   Option<Stat>,
	/// The name's collation key (`strxfrm`) when names sort in a locale's
	/// order; empty otherwise.
	ckey:  Vec<u8>,
	/// The name unmetafied when names sort, so each comparison does not
	/// unmetafy both sides again; empty otherwise.
	plain: Vec<u8>,
}

/// The `zerr` of a glob error.
fn gerr(msg: impl Into<BString>) -> Stop {
	Stop::Fail(Diag::ZshFileExp { msg: msg.into() })
}

/// zsh `checkglobqual`: the index of the `(` that opens trailing glob
/// qualifiers in `s`, and whether they are explicit `(#q…)` (2) or bare
/// (1).
fn checkglobqual(s: &[u8], nobareglob: bool, o: &Opts) -> Option<(usize, u8)> {
	if s.last() != Some(&OUTPAR) {
		return None;
	}
	let mut nobare = nobareglob;
	let mut paren = 0i32;
	let mut i = s.len() - 1;
	loop {
		if i == 0 {
			break;
		}
		i -= 1;
		match s[i] {
			OUTPAR => {
				paren += 1;
				nobare = true;
			},
			BAR => nobare = true,
			TILDE if o.extended_glob => nobare = true,
			INPAR => {
				if paren == 0 {
					break;
				}
				paren -= 1;
			},
			_ => {},
		}
	}
	if at(s, i) != INPAR {
		return None;
	}
	if o.extended_glob && s.get(i + 1) == Some(&POUND) {
		if s.get(i + 2) != Some(&b'q') {
			return None;
		}
		return Some((i, 2));
	}
	if nobare {
		return None;
	}
	Some((i, 1))
}

/// zsh `cond_subst`'s test: whether the `[[ ]]` operand `word` (its
/// tokenized text, before substitution) ends in explicit `(#q…)` glob
/// qualifiers, so it is filename-generated (its matches joined by spaces).
///
/// # Errors
/// An option lookup failed.
pub fn cond_globqual(ex: &mut Expander<'_, '_>, word: &[u8]) -> X<bool> {
	if word.last() != Some(&OUTPAR) {
		return Ok(false);
	}
	let o = zpattern::opts(ex)?;
	Ok(checkglobqual(word, true, &o).is_some())
}

/// zsh `qgetnum`.
fn qgetnum(s: &[u8], i: &mut usize) -> X<i64> {
	if !s.get(*i).is_some_and(u8::is_ascii_digit) {
		return Err(gerr("number expected"));
	}
	let mut v: i64 = 0;
	while let Some(&c) = s.get(*i).filter(|c| c.is_ascii_digit()) {
		v = v.wrapping_mul(10).wrapping_add(i64::from(c - b'0'));
		*i += 1;
	}
	Ok(v)
}

/// zsh `qgetmodespec`: `(f…)` mode specification as `yes | no << 12`.
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's qgetmodespec")]
fn qgetmodespec(s: &[u8], i: &mut usize) -> X<i64> {
	let bad = || gerr("invalid mode specification");
	let mut yes: i64 = 0;
	let mut no: i64 = 0;
	let mut p = *i;
	let c0 = s.get(p).copied().unwrap_or(0);
	let end =
		if matches!(c0, b'=' | EQUALS | b'+' | b'-' | b'?' | QUEST) || (b'0'..=b'7').contains(&c0) {
			0
		} else {
			p += 1;
			match c0 {
				b'<' => b'>',
				b'[' => b']',
				b'{' => b'}',
				INANG => OUTANG,
				INBRACK => OUTBRACK,
				INBRACE => OUTBRACE,
				c => c,
			}
		};
	let mut c;
	loop {
		let mut mask = 0;
		loop {
			c = s.get(p).copied().unwrap_or(0);
			if end == 0 || !matches!(c, b'u' | b'g' | b'o' | b'a') {
				break;
			}
			mask |= match c {
				b'o' => 0o1007,
				b'g' => 0o2070,
				b'u' => 0o4700,
				_ => 0o7777,
			};
			p += 1;
		}
		let how = if matches!(c, b'+' | b'-') { c } else { b'=' };
		if matches!(c, b'+' | b'-' | b'=' | EQUALS) {
			p += 1;
		}
		let mut val: i64 = 0;
		if mask != 0 {
			loop {
				c = s.get(p).copied().unwrap_or(0);
				p += 1;
				if c == b',' || c == end {
					break;
				}
				match c {
					b'x' => val |= 0o111,
					b'w' => val |= 0o222,
					b'r' => val |= 0o444,
					b's' => val |= 0o6000,
					b't' => val |= 0o1000,
					b'0'..=b'7' => {
						let t = i64::from(c - b'0');
						val |= t | (t << 3) | (t << 6);
					},
					_ => return Err(bad()),
				}
			}
			if how == b'=' || how == b'+' {
				yes |= val & mask;
				val = !val;
			}
			if how == b'=' || how == b'-' {
				no |= val & mask;
			}
		} else if !(end != 0 && c == end) && c != b',' && c != 0 {
			let mut t: i64 = 0o7777;
			loop {
				c = s.get(p).copied().unwrap_or(0);
				if c == b'?' || c == QUEST {
					t = (t << 3) | 7;
					val <<= 3;
				} else if (b'0'..=b'7').contains(&c) {
					t <<= 3;
					val = (val << 3) | i64::from(c - b'0');
				} else {
					break;
				}
				p += 1;
			}
			if end != 0 && c != end && c != b',' {
				return Err(bad());
			}
			if how == b'=' {
				yes = (yes & !t) | val;
				no = (no & !t) | (!val & !t);
			} else if how == b'+' {
				yes |= val;
			} else {
				no |= val;
			}
			if end != 0 {
				p += 1;
			}
		} else {
			return Err(bad());
		}
		if end == 0 || c == end {
			break;
		}
	}
	*i = p;
	Ok((yes & 0o7777) | ((no & 0o7777) << 12))
}

/// zsh `glob_exec_string`: the delimited argument of `e`, `P`, `oe` (or
/// the identifier of `+`); `s[*i - 1]` is the qualifier letter. `mb` and
/// `wide` as for [`params::mb`] and [`params::wide_idents`].
fn glob_exec_string(s: &[u8], i: &mut usize, mb: bool, wide: bool) -> X<Vec<u8>> {
	if at(s, i.wrapping_sub(1)) == b'+' {
		let e = text::ident_end(s, *i, wide);
		if e == *i {
			return Err(gerr("missing identifier after `+'"));
		}
		let mut d = span(s, *i, e).to_vec();
		untokenize(&mut d);
		*i = e;
		return Ok(d);
	}
	let (t, plus) = subscript::get_strarg(s, *i, mb);
	if t >= s.len() {
		return Err(gerr("missing end of string"));
	}
	let start = (*i + plus).min(t);
	let mut d = span(s, start, t).to_vec();
	untokenize(&mut d);
	*i = t + plus;
	Ok(d)
}

/// zsh `zglob`'s qualifier loop: strip trailing qualifier sets from
/// `word`, from the right, merging them.
#[expect(clippy::too_many_lines, reason = "a faithful port of one C function")]
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's parse_spec")]
fn parse_spec(ex: &mut Expander<'_, '_>, word: &[u8], o: &Opts) -> X<Spec> {
	let mut spec = Spec {
		pattern:      word.to_vec(),
		quals:        Vec::new(),
		colonmod:     None,
		nullglob:     opt(ex, ZshOpt::Nullglob)?,
		markdirs:     opt(ex, ZshOpt::Markdirs)?,
		listtypes:    false,
		follow:       false,
		noglobdots:   !opt(ex, ZshOpt::Globdots)?,
		numsort:      opt(ex, ZshOpt::Numericglobsort)?,
		sorts:        Vec::new(),
		first:        0,
		end:          -1,
		shortcircuit: 0,
		pre_words:    Vec::new(),
		post_words:   Vec::new(),
		evals:        Vec::new(),
	};
	let mut nobareglob = !opt(ex, ZshOpt::Bareglobqual)?;
	let mut sorted_keys: Vec<(SortKey, bool)> = Vec::new();
	while !nobareglob || o.extended_glob {
		let Some((open, kind)) = checkglobqual(&spec.pattern, nobareglob, o) else {
			break;
		};
		nobareglob = true;
		let body_end = spec.pattern.len() - 1;
		let mut q: Vec<u8> =
			span(&spec.pattern, open + 1 + if kind == 2 { 2 } else { 0 }, body_end).to_vec();
		spec.pattern.truncate(open);
		for c in &mut q {
			if *c == DASH {
				*c = b'-';
			}
		}
		let mut alts: Vec<Vec<Qual>> = vec![Vec::new()];
		let mut sense: u8 = 0;
		let mut i = 0;
		let mut range = 0i32;
		let mut amc = 0i32;
		let mut units = 0i32;
		let mut newcolon = false;
		while i < q.len() && !newcolon {
			let c = q[i];
			if c == b',' {
				i += 1;
				sense = 0;
				if !alts.last().is_some_and(Vec::is_empty) {
					alts.push(Vec::new());
				}
				continue;
			}
			i += 1;
			let mut func: Option<QFunc> = None;
			let mut data: i64 = 0;
			match c {
				b':' => {
					let mut m = tail(&q, i - 1).to_vec();
					untokenize(&mut m);
					spec.colonmod = Some(match spec.colonmod.take() {
						Some(prev) => {
							let mut x = m;
							x.extend_from_slice(&prev);
							x
						},
						None => m,
					});
					newcolon = true;
				},
				HAT | b'^' => sense ^= 1,
				b'-' => sense ^= 2,
				b'@' => func = Some(QFunc::Islnk),
				EQUALS | b'=' => func = Some(QFunc::Issock),
				b'p' => func = Some(QFunc::Isfifo),
				b'/' => func = Some(QFunc::Isdir),
				b'.' => func = Some(QFunc::Isreg),
				b'%' => {
					func = Some(match q.get(i) {
						Some(b'b') => {
							i += 1;
							QFunc::Isblk
						},
						Some(b'c') => {
							i += 1;
							QFunc::Ischr
						},
						_ => QFunc::Isdev,
					});
				},
				STAR => func = Some(QFunc::Iscom),
				b'R' | b'W' | b'X' | b'A' | b'I' | b'E' | b'r' | b'w' | b'x' | b's' | b'S' | b't' => {
					func = Some(QFunc::Flags);
					data = match c {
						b'R' => 0o4,
						b'W' => 0o2,
						b'X' => 0o1,
						b'A' => 0o40,
						b'I' => 0o20,
						b'E' => 0o10,
						b'r' => 0o400,
						b'w' => 0o200,
						b'x' => 0o100,
						b's' => 0o4000,
						b'S' => 0o2000,
						_ => 0o1000,
					};
				},
				b'd' => {
					func = Some(QFunc::Dev);
					data = qgetnum(&q, &mut i)?;
				},
				b'U' => {
					func = Some(QFunc::Uid);
					data = i64::from(ex.cx.host.user().euid);
				},
				b'G' => {
					func = Some(QFunc::Gid);
					data = i64::from(ex.cx.host.user().gid);
				},
				b'u' | b'g' => {
					func = Some(if c == b'u' { QFunc::Uid } else { QFunc::Gid });
					if q.get(i).is_some_and(u8::is_ascii_digit) {
						data = qgetnum(&q, &mut i)?;
					} else {
						let (t, arglen) = subscript::get_strarg(&q, i, params::mb(ex)?);
						if t >= q.len() {
							return Err(gerr(format!(
								"missing delimiter for '{}' glob qualifier",
								char::from(c)
							)));
						}
						let name = span(&q, i + arglen, t).to_vec();
						let me = ex.cx.host.user();
						if c == b'u' && unmetafy(&name) == me.name.as_slice() {
							data = i64::from(me.uid);
						} else if c == b'u' {
							return Err(gerr(format!("unknown username '{}'", bstr::BStr::new(&name))));
						} else {
							return Err(gerr("unknown group"));
						}
						i = t + arglen;
					}
				},
				b'f' => {
					func = Some(QFunc::Modeflags);
					data = qgetmodespec(&q, &mut i)?;
				},
				b'F' => func = Some(QFunc::Nonemptydir),
				b'M' => {
					spec.markdirs = sense & 1 == 0;
					if spec.markdirs {
						spec.follow = sense & 2 != 0;
					}
				},
				b'T' => {
					spec.listtypes = sense & 1 == 0;
					if spec.listtypes {
						spec.follow = sense & 2 != 0;
					}
				},
				b'N' => spec.nullglob = sense & 1 == 0,
				b'D' => spec.noglobdots = sense & 1 != 0,
				b'n' => spec.numsort = sense & 1 == 0,
				b'Y' => {
					if sense & 1 == 0 {
						spec.shortcircuit = usize::try_from(qgetnum(&q, &mut i)?).unwrap_or(0);
					} else {
						spec.shortcircuit = 0;
					}
				},
				b'a' | b'm' | b'c' | b'L' | b'l' => {
					if c == b'l' {
						func = Some(QFunc::Nlink);
						amc = -1;
					} else if c == b'L' {
						func = Some(QFunc::Size);
						amc = -1;
						units = 0;
						match q.get(i) {
							Some(b'p' | b'P') => {
								units = 1;
								i += 1;
							},
							Some(b'k' | b'K') => {
								units = 2;
								i += 1;
							},
							Some(b'm' | b'M') => {
								units = 3;
								i += 1;
							},
							Some(b'g' | b'G') => {
								units = 4;
								i += 1;
							},
							Some(b't' | b'T') => {
								units = 5;
								i += 1;
							},
							_ => {},
						}
					} else {
						func = Some(QFunc::Time);
						amc = match c {
							b'a' => 0,
							b'm' => 1,
							_ => 2,
						};
					}
					if amc >= 0 {
						units = 0;
						match q.get(i) {
							Some(b'h') => {
								units = 1;
								i += 1;
							},
							Some(b'm') => {
								units = 2;
								i += 1;
							},
							Some(b'w') => {
								units = 3;
								i += 1;
							},
							Some(b'M') => {
								units = 4;
								i += 1;
							},
							Some(b's') => {
								units = 5;
								i += 1;
							},
							Some(b'd') => i += 1,
							_ => {},
						}
					}
					range = match q.get(i) {
						Some(b'+') => 1,
						Some(&c) if c == b'-' || c == DASH => -1,
						_ => 0,
					};
					if range != 0 {
						i += 1;
					}
					data = qgetnum(&q, &mut i)?;
				},
				b'o' | b'O' => {
					let key = match q.get(i).copied().unwrap_or(0) {
						b'n' => SortKey::Name,
						b'L' => SortKey::Size,
						b'l' => SortKey::Links,
						b'a' => SortKey::Atime,
						b'm' => SortKey::Mtime,
						b'c' => SortKey::Ctime,
						b'd' => SortKey::Depth,
						b'N' => SortKey::None,
						b'e' | b'+' => {
							return Err(Stop::Fail(Diag::Unsupported {
								what: "zsh glob sort by shell code (oe, o+)".into(),
							}));
						},
						_ => return Err(gerr("unknown sort specifier")),
					};
					i += 1;
					let follow = sense & 2 != 0
						&& matches!(
							key,
							SortKey::Size
								| SortKey::Atime
								| SortKey::Mtime
								| SortKey::Ctime
								| SortKey::Links
						);
					if sorted_keys.contains(&(key, follow)) {
						return Err(gerr("doubled sort specifier"));
					}
					sorted_keys.push((key, follow));
					if spec.sorts.len() == 12 {
						return Err(gerr("too many glob sort specifiers"));
					}
					spec
						.sorts
						.push(Sort { key, follow, desc: (sense & 1 != 0) ^ (c == b'O') });
				},
				b'+' | b'e' => {
					let code = glob_exec_string(&q, &mut i, params::mb(ex)?, params::wide_idents(ex)?)?;
					func = Some(QFunc::Eval);
					data = i64::try_from(spec.evals.len()).unwrap_or(i64::MAX);
					spec.evals.push(code);
				},
				b'[' | INBRACK => {
					i -= 1;
					let mut v = Value::temp_array(&[]);
					v.isarr = SCANPM_WANTVALS;
					let os = i;
					let r = subscript::getindex(ex, &q, &mut i, &mut v, 0);
					if r.is_err() || i == os {
						return Err(params::bad_subscript("invalid subscript"));
					}
					spec.first = v.start;
					spec.end = v.end;
				},
				b'P' => {
					let w = glob_exec_string(&q, &mut i, params::mb(ex)?, params::wide_idents(ex)?)?;
					if sense & 1 != 0 {
						spec.post_words.push(w);
					} else {
						spec.pre_words.push(w);
					}
				},
				_ => {
					let mut t = vec![c];
					untokenize(&mut t);
					let shown = char::from(t.first().copied().unwrap_or(c));
					return Err(gerr(format!("unknown file attribute: {shown}")));
				},
			}
			if let (Some(func), Some(last)) = (func, alts.last_mut()) {
				last.push(Qual { func, sense, data, range, amc, units });
			}
		}
		alts.retain(|a| !a.is_empty());
		if !alts.is_empty() {
			if spec.quals.is_empty() {
				spec.quals = alts;
			} else {
				let mut merged = Vec::new();
				for n in &alts {
					for old in &spec.quals {
						let mut a = n.clone();
						a.extend_from_slice(old);
						merged.push(a);
					}
				}
				spec.quals = merged;
			}
		}
	}
	if spec.sorts.is_empty() {
		spec.sorts.push(Sort {
			key:    if spec.shortcircuit > 0 {
				SortKey::None
			} else {
				SortKey::Name
			},
			follow: false,
			desc:   false,
		});
	}
	Ok(spec)
}

/// zsh `parsecomplist`: the path components of `s`.
fn parsecomplist(
	s: &[u8],
	o: &Opts,
	noglobdots: bool,
	star_short: bool,
	st: &mut FileGlobState,
) -> Option<Vec<Comp>> {
	let compflags = if noglobdots {
		PatFlags::FILE | PatFlags::NOGLD
	} else {
		PatFlags::FILE
	};
	let mut out = Vec::new();
	let mut s = s;
	loop {
		if s.first() == Some(&STAR) && s.get(1) == Some(&STAR) {
			let three = s.get(2) == Some(&STAR) && s.get(3) == Some(&b'/');
			if s.get(2) == Some(&b'/') || three || star_short {
				let follow = s.get(2) == Some(&STAR);
				let skip = (if star_short && !three && s.get(2) != Some(&b'/') {
					1
				} else {
					3
				}) + usize::from(follow);
				let (pat, _) = Pattern::compile_segment(&[], compflags | PatFlags::ANY, o, st).ok()?;
				out.push(Comp { pat, closure: 1, follow });
				s = s.get(skip..).unwrap_or_default();
				continue;
			}
		}
		if s.first() == Some(&INPAR) {
			let mut j = 0;
			if text::skipparens(INPAR, OUTPAR, s, &mut j)
				&& s.get(j) == Some(&POUND)
				&& j >= 2
				&& at(s, j - 2) == b'/'
			{
				let (pat, end) = Pattern::compile_segment(tail(s, 1), compflags, o, st).ok()?;
				let end = end + 1;
				if s.get(end) == Some(&b'/')
					&& s.get(end + 1) == Some(&OUTPAR)
					&& s.get(end + 2) == Some(&POUND)
				{
					let mut k = end + 3;
					let mut pdflag = false;
					if s.get(k) == Some(&POUND) {
						pdflag = true;
						k += 1;
					}
					let closure = if pat.pure().is_some_and(<[u8]>::is_empty) {
						0
					} else {
						1 + u8::from(pdflag)
					};
					out.push(Comp { pat, closure, follow: false });
					s = tail(s, k);
					continue;
				}
				return None;
			}
		}
		let (pat, end) = Pattern::compile_segment(s, compflags | PatFlags::FILET, o, st).ok()?;
		out.push(Comp { pat, closure: 0, follow: false });
		match s.get(end) {
			None => return Some(out),
			// A trailing `/` leaves an empty last component: the
			// directories themselves (`*/`).
			Some(&b'/') => s = tail(s, end + 1),
			Some(_) => return None,
		}
	}
}

/// A file-system answer during a scanner run ([`Run::stat`],
/// [`Run::list`]).
enum Got<T> {
	/// Not known yet (the question is noted).
	Pending,
	/// The call failed (no such file, not a directory, …).
	Failed,
	/// The answer.
	Ok(T),
}

/// One run of the scanner over the answers known so far.
struct Run<'a> {
	facts:        &'a HashMap<Ask, Fact>,
	missing:      Vec<Ask>,
	evals:        &'a HashMap<EvalAsk, EvalFact>,
	/// Shell-code questions without an answer.
	eval_missing: Vec<EvalAsk>,
	/// zsh `inserts`: the words of the last shell-code qualifier run for
	/// the file being inserted.
	inserts:      Option<Vec<Vec<u8>>>,
	spec:         &'a Spec,
	env:          crate::bash::pattern::zsh::CharEnv<'a>,
	now:          i64,
	matches:      Vec<Gmatch>,
	approx:       Approx,
}

impl Run<'_> {
	/// The cwd-relative fs path for a metafied path. Keep an empty path
	/// empty: `answer` joins it to the cwd without an artificial `.` component.
	fn fspath(p: &[u8]) -> BString {
		BString::from(unmetafy(p))
	}

	/// `stat`/`lstat` of `p`.
	fn stat(&mut self, p: &[u8], follow: bool) -> Got<Stat> {
		let ask = Ask::Stat { path: Self::fspath(p), follow };
		match self.facts.get(&ask) {
			Some(Fact::Stat(Some(s))) => Got::Ok(*s),
			Some(Fact::Stat(None) | Fact::List(_)) => Got::Failed,
			None => {
				self.missing.push(ask);
				Got::Pending
			},
		}
	}

	/// The names in directory `p` (without `.` and `..`).
	fn list(&mut self, p: &[u8]) -> Got<Vec<BString>> {
		let ask = Ask::List(Self::fspath(p));
		match self.facts.get(&ask) {
			Some(Fact::List(Some(l))) => Got::Ok(
				l.iter()
					.filter(|n| !matches!(n.as_slice(), b"." | b".."))
					.cloned()
					.collect(),
			),
			Some(Fact::List(None) | Fact::Stat(_)) => Got::Failed,
			None => {
				self.missing.push(ask);
				Got::Pending
			},
		}
	}

	/// Whether the match budget (`(Y n)`) is used up.
	const fn done(&self) -> bool {
		self.spec.shortcircuit > 0 && self.matches.len() >= self.spec.shortcircuit
	}

	/// zsh `scanner`. `nested`: a recursion into the same repeated
	/// component (`(x/)##` matches zero directories only after its first).
	fn scanner(&mut self, comps: &[Comp], idx: usize, nested: bool, pathbuf: &mut Vec<u8>) {
		let Some(q) = comps.get(idx) else {
			return;
		};
		let mut closure = q.closure;
		let skip_zero = if closure == 2 {
			closure = 1;
			!nested
		} else {
			false
		};
		if closure == 1 && !skip_zero {
			self.scanner(comps, idx + 1, false, pathbuf);
			if self.done() {
				return;
			}
		}
		let more = idx + 1 < comps.len();
		if let Some(pure) = q.pat.pure() {
			let s = metafy(pure);
			if more {
				let add = if closure != 0 && !pathbuf.is_empty() && (s == b"." || s == b"..") {
					s != b"."
				} else {
					true
				};
				if add {
					let oppos = pathbuf.len();
					pathbuf.extend_from_slice(&s);
					pathbuf.push(b'/');
					let ok = if closure == 0 {
						true
					} else {
						matches!(self.stat(pathbuf, true), Got::Ok(st) if st.kind == StatKind::Dir)
					};
					if ok {
						if closure != 0 {
							self.scanner(comps, idx, true, pathbuf);
						} else {
							self.scanner(comps, idx + 1, false, pathbuf);
						}
					}
					pathbuf.truncate(oppos);
				}
			} else {
				self.insert(pathbuf, &s, false);
			}
			return;
		}
		let Got::Ok(names) = self.list(pathbuf) else {
			return;
		};
		let errssofar = self.approx.errsfound;
		let mut subdirs: Vec<(Vec<u8>, i32)> = Vec::new();
		for n in names {
			let fname = metafy(&n);
			self.approx.errsfound = errssofar;
			if !q.pat.try_file(&fname, pathbuf, &self.env, &mut self.approx) {
				continue;
			}
			if more {
				if self.approx.errsfound > errssofar {
					self.approx.forceerrs = self.approx.errsfound - 1;
					while self.approx.forceerrs >= errssofar {
						self.approx.errsfound = errssofar;
						if !q.pat.try_file(&fname, pathbuf, &self.env, &mut self.approx) {
							break;
						}
						self.approx.forceerrs = self.approx.errsfound - 1;
					}
					self.approx.errsfound = self.approx.forceerrs + 1;
					self.approx.forceerrs = -1;
				}
				if closure != 0 {
					let mut full = pathbuf.clone();
					full.extend_from_slice(&fname);
					if !matches!(self.stat(&full, q.follow), Got::Ok(st) if st.kind == StatKind::Dir) {
						continue;
					}
				}
				subdirs.push((fname, self.approx.errsfound));
			} else {
				self.insert(pathbuf, &fname, true);
				if self.done() {
					return;
				}
			}
		}
		let oppos = pathbuf.len();
		for (d, errs) in subdirs {
			pathbuf.extend_from_slice(&d);
			pathbuf.push(b'/');
			self.approx.errsfound = errs;
			if closure != 0 {
				self.scanner(comps, idx, true, pathbuf);
			} else {
				self.scanner(comps, idx + 1, false, pathbuf);
			}
			if self.done() {
				return;
			}
			pathbuf.truncate(oppos);
		}
	}

	/// zsh `insert`: add `pathbuf + s` if it exists and passes the
	/// qualifiers; type markers, colon modifiers and `P` words applied by
	/// the caller.
	fn insert(&mut self, pathbuf: &[u8], s: &[u8], checked: bool) {
		let mut full = pathbuf.to_vec();
		full.extend_from_slice(s);
		let spec = self.spec;
		let mut st = None;
		let mut st2 = None;
		let mut name = full.clone();
		self.inserts = None;
		// zsh `statfullpath`: an empty last component (`*/`) stats
		// `DIR/.` (following links) for its qualifiers and must be a
		// directory otherwise.
		let dirself = s.is_empty() && !pathbuf.is_empty();
		if dirself {
			full.push(b'.');
		}
		if spec.listtypes || spec.markdirs {
			let Got::Ok(lst) = self.stat(&full, dirself) else {
				return;
			};
			st = Some(lst);
			let mode_st = if spec.follow {
				let f = if lst.kind == StatKind::Symlink {
					match self.stat(&full, true) {
						Got::Ok(f) => f,
						Got::Failed => lst,
						Got::Pending => return,
					}
				} else {
					lst
				};
				st2 = Some(f);
				f
			} else {
				lst
			};
			if spec.listtypes || mode_st.kind == StatKind::Dir {
				name.push(file_type(&mode_st));
			}
		}
		if !spec.quals.is_empty() {
			if st.is_none() {
				match self.stat(&full, dirself) {
					Got::Ok(s) => st = Some(s),
					Got::Failed | Got::Pending => return,
				}
			}
			let lst = st.unwrap_or_else(unreachable_stat);
			let mut ok_any = false;
			'alts: for alt in &spec.quals {
				for q in alt {
					let bp = if q.sense & 2 != 0 {
						if st2.is_none() {
							st2 = Some(if lst.kind == StatKind::Symlink {
								match self.stat(&full, true) {
									Got::Ok(f) => f,
									Got::Failed => lst,
									Got::Pending => return,
								}
							} else {
								lst
							});
						}
						st2.unwrap_or(lst)
					} else {
						lst
					};
					let Some(r) = self.qualtest(q, &full, &name, &bp) else {
						return;
					};
					if r == (q.sense & 1 != 0) {
						continue 'alts;
					}
				}
				ok_any = true;
				break;
			}
			if !ok_any {
				return;
			}
		} else if dirself {
			full.pop();
			match self.stat(&full, true) {
				Got::Ok(s) if s.kind == StatKind::Dir => st = Some(s),
				_ => return,
			}
		} else if !checked {
			match self.stat(&full, false) {
				Got::Ok(s) => st = Some(s),
				Got::Failed | Got::Pending => return,
			}
		}
		let needs_stat = spec
			.sorts
			.iter()
			.any(|s| !matches!(s.key, SortKey::Name | SortKey::Depth | SortKey::None));
		if needs_stat {
			if st.is_none() {
				match self.stat(&full, false) {
					Got::Ok(s) => st = Some(s),
					Got::Failed => {},
					Got::Pending => return,
				}
			}
			if spec.sorts.iter().any(|s| s.follow) && st2.is_none() {
				match self.stat(&full, true) {
					Got::Ok(f) => st2 = Some(f),
					Got::Failed => st2 = st,
					Got::Pending => return,
				}
			}
		}
		match self.inserts.take() {
			Some(words) => {
				for w in words {
					self
						.matches
						.push(Gmatch { name: w, st, st2, ckey: Vec::new(), plain: Vec::new() });
				}
			},
			None => self
				.matches
				.push(Gmatch { name, st, st2, ckey: Vec::new(), plain: Vec::new() }),
		}
	}

	/// One qualifier test of the file `name` (`shown`: with its type
	/// marker, what `REPLY` gets); `None` while an answer is missing.
	fn qualtest(&mut self, q: &Qual, name: &[u8], shown: &[u8], st: &Stat) -> Option<bool> {
		let mode = i64::from(st.mode & 0o7777);
		Some(match q.func {
			QFunc::Eval => {
				let code = usize::try_from(q.data)
					.ok()
					.and_then(|i| self.spec.evals.get(i))?;
				let ask = (code.clone(), shown.to_vec());
				if let Some(f) = self.evals.get(&ask) {
					self.inserts.clone_from(&f.inserts);
					f.ok
				} else {
					self.eval_missing.push(ask);
					return None;
				}
			},
			QFunc::Islnk => st.kind == StatKind::Symlink,
			QFunc::Issock => st.kind == StatKind::Socket,
			QFunc::Isfifo => st.kind == StatKind::Fifo,
			QFunc::Isdir => st.kind == StatKind::Dir,
			QFunc::Isreg => st.kind == StatKind::File,
			QFunc::Isblk => st.kind == StatKind::BlockDev,
			QFunc::Ischr => st.kind == StatKind::CharDev,
			QFunc::Isdev => matches!(st.kind, StatKind::BlockDev | StatKind::CharDev),
			QFunc::Iscom => st.kind == StatKind::File && st.mode & 0o111 != 0,
			QFunc::Flags => mode & q.data != 0,
			QFunc::Modeflags => {
				let (y, n) = (q.data & 0o7777, q.data >> 12);
				(mode & y) == y && mode & n == 0
			},
			QFunc::Dev => i64::try_from(st.dev).unwrap_or(-1) == q.data,
			QFunc::Nlink => cmp_range(i64::try_from(st.nlink).unwrap_or(i64::MAX), q.data, q.range),
			QFunc::Uid => i64::from(st.uid) == q.data,
			QFunc::Gid => i64::from(st.gid) == q.data,
			QFunc::Nonemptydir => {
				if st.kind != StatKind::Dir {
					false
				} else if st.nlink > 2 {
					true
				} else {
					match self.list(name) {
						Got::Ok(l) => !l.is_empty(),
						Got::Failed => false,
						Got::Pending => return None,
					}
				}
			},
			QFunc::Time => {
				let t = match q.amc {
					0 => st.atime_ns,
					1 => st.mtime_ns,
					_ => st.ctime_ns,
				} / 1_000_000_000;
				let mut diff = self.now - t;
				diff /= match q.units {
					0 => 86_400,
					1 => 3600,
					2 => 60,
					3 => 604_800,
					4 => 2_592_000,
					_ => 1,
				};
				cmp_range(diff, q.data, q.range)
			},
			QFunc::Size => {
				let mut scaled = i64::try_from(st.size).unwrap_or(i64::MAX);
				let unit: i64 = match q.units {
					1 => 512,
					2 => 1024,
					3 => 1 << 20,
					4 => 1 << 30,
					5 => 1 << 40,
					_ => 1,
				};
				if unit > 1 {
					scaled = (scaled + unit - 1) / unit;
				}
				cmp_range(scaled, q.data, q.range)
			},
		})
	}
}

/// A stat that cannot be missing here (the caller checked).
const fn unreachable_stat() -> Stat {
	Stat {
		kind:     StatKind::File,
		mode:     0,
		size:     0,
		uid:      0,
		gid:      0,
		dev:      0,
		ino:      0,
		nlink:    0,
		mtime_ns: 0,
		atime_ns: 0,
		ctime_ns: 0,
		blocks:   0,
		rdev:     0,
		blksize:  0,
	}
}

/// `<`, `>` or `=` per zsh's `g_range`.
const fn cmp_range(v: i64, data: i64, range: i32) -> bool {
	if range < 0 {
		v < data
	} else if range > 0 {
		v > data
	} else {
		v == data
	}
}

/// zsh `file_type`: the `ls -F` marker of a file.
pub const fn file_type(st: &Stat) -> u8 {
	match st.kind {
		StatKind::BlockDev => b'#',
		StatKind::CharDev => b'%',
		StatKind::Dir => b'/',
		StatKind::Fifo => b'|',
		StatKind::Symlink => b'@',
		StatKind::File => {
			if st.mode & 0o111 != 0 {
				b'*'
			} else {
				b' '
			}
		},
		StatKind::Socket => b'=',
	}
}

/// zsh `gmatchcmp` in ascending output order.
fn gmatchcmp(a: &Gmatch, b: &Gmatch, sorts: &[Sort], numsort: bool) -> std::cmp::Ordering {
	use std::cmp::Ordering;
	for s in sorts {
		let pick = |m: &Gmatch| if s.follow { m.st2.or(m.st) } else { m.st };
		let r: Ordering = match s.key {
			SortKey::Name => {
				// zsh `zstrcmp`: `strcoll` (the collation keys; bytes when
				// equal or without a collation), then the numeric rules.
				let base = a.ckey.cmp(&b.ckey).then_with(|| a.plain.cmp(&b.plain));
				super::subst::eltpcmp_coll(&a.plain, &b.plain, i32::from(numsort), base)
			},
			SortKey::Depth => {
				#[allow(
					clippy::naive_bytecount,
					reason = "one path per comparison; no bytecount dependency"
				)]
				let depth = |m: &[u8]| m.iter().filter(|&&c| c == b'/').count();
				depth(&b.name).cmp(&depth(&a.name))
			},
			SortKey::Size => pick(a)
				.map_or(0, |s| s.size)
				.cmp(&pick(b).map_or(0, |s| s.size)),
			SortKey::Links => pick(a)
				.map_or(0, |s| s.nlink)
				.cmp(&pick(b).map_or(0, |s| s.nlink)),
			SortKey::Atime => pick(b)
				.map_or(0, |s| s.atime_ns)
				.cmp(&pick(a).map_or(0, |s| s.atime_ns)),
			SortKey::Mtime => pick(b)
				.map_or(0, |s| s.mtime_ns)
				.cmp(&pick(a).map_or(0, |s| s.mtime_ns)),
			SortKey::Ctime => pick(b)
				.map_or(0, |s| s.ctime_ns)
				.cmp(&pick(a).map_or(0, |s| s.ctime_ns)),
			SortKey::None => Ordering::Equal,
		};
		if r != Ordering::Equal {
			return if s.desc { r.reverse() } else { r };
		}
	}
	Ordering::Equal
}

/// The result of globbing one word.
enum Globbed {
	/// The matches (or the word itself under `nonomatch`).
	Words(Vec<Vec<u8>>),
	/// No match under `cshnullglob` (the word is dropped; all failing is
	/// an error).
	CshFail,
}

/// zsh `zglob` for one word: `Ok(None)` while the walk needs answers.
fn zglob_one(
	ex: &mut Expander<'_, '_>,
	word: &[u8],
	facts: &HashMap<Ask, Fact>,
	missing: &mut Vec<Ask>,
	evals: &HashMap<EvalAsk, EvalFact>,
	eval_missing: &mut Vec<EvalAsk>,
) -> X<Option<Globbed>> {
	let o = zpattern::opts(ex)?;
	let spec = parse_spec(ex, word, &o)?;
	let mut pattern = spec.pattern.clone();
	crate::bash::pattern::zsh::remnulargs(&mut pattern);
	let mut st = FileGlobState::start(&o);
	let (abs, body) = if pattern.first() == Some(&b'/') {
		(true, tail(&pattern, 1))
	} else {
		(false, &pattern[..])
	};
	let star_short = opt(ex, ZshOpt::Globstarshort)?;
	let comps = parsecomplist(body, &o, spec.noglobdots, star_short, &mut st);
	let Some(comps) = comps else {
		if !opt(ex, ZshOpt::Badpattern)? {
			let mut w = word.to_vec();
			untokenize(&mut w);
			return Ok(Some(Globbed::Words(vec![w])));
		}
		return Err(zpattern::bad_pattern(word));
	};
	let env = zpattern::char_env(ex)?;
	let now = ex.cx.host.wall().secs;
	let mut run = Run {
		facts,
		missing: Vec::new(),
		evals,
		eval_missing: Vec::new(),
		inserts: None,
		spec: &spec,
		env: env.env(),
		now,
		matches: Vec::new(),
		approx: Approx::START,
	};
	let mut pathbuf = if abs { b"/".to_vec() } else { Vec::new() };
	run.scanner(&comps, 0, false, &mut pathbuf);
	if !run.missing.is_empty() || !run.eval_missing.is_empty() {
		missing.append(&mut run.missing);
		eval_missing.append(&mut run.eval_missing);
		return Ok(None);
	}
	let mut matches = run.matches;
	if matches.is_empty() && !spec.nullglob {
		if opt(ex, ZshOpt::Cshnullglob)? {
			return Ok(Some(Globbed::CshFail));
		}
		if opt(ex, ZshOpt::Nomatch)? {
			let mut w = word.to_vec();
			untokenize(&mut w);
			return Err(Stop::Fail(Diag::NoMatch { pattern: BString::from(unmetafy(&w)) }));
		}
		let mut w = word.to_vec();
		untokenize(&mut w);
		return Ok(Some(Globbed::Words(vec![w])));
	}
	// zsh `insert` applies the colon modifiers as each match is found: the
	// sort sees the modified names (`**/(:h)`).
	if let Some(cm) = &spec.colonmod {
		let mut hist = HistSubst::default();
		for m in &mut matches {
			let mut pos = 0;
			modify::modify(ex, &mut m.name, cm, &mut pos, true, &mut hist)?;
		}
	}
	let unsorted = spec.sorts.first().is_some_and(|s| s.key == SortKey::None);
	if !unsorted {
		// zsh compares names with `strcoll`: their collation keys, once.
		if spec.sorts.iter().any(|s| s.key == SortKey::Name) {
			let coll = params::collator(ex);
			for m in &mut matches {
				m.plain = unmetafy(&m.name);
				if let Some(coll) = &coll {
					m.ckey = coll.key(&m.plain);
				}
			}
		}
		// Matched paths are distinct, so sorted by name alone they have no
		// ties (colon modifiers can make two equal): any sort gives the
		// same order, and the unstable one moves the matches less.
		if spec.colonmod.is_none() && matches!(spec.sorts.as_slice(), [s] if s.key == SortKey::Name) {
			matches.sort_unstable_by(|a, b| gmatchcmp(a, b, &spec.sorts, spec.numsort));
		} else {
			matches.sort_by(|a, b| gmatchcmp(a, b, &spec.sorts, spec.numsort));
		}
	}
	let ct = i64::try_from(matches.len()).unwrap_or(0);
	let mut first = spec.first;
	let mut end = spec.end;
	if first < 0 {
		first = (first + ct).max(0);
	}
	if end < 0 {
		end += ct + 1;
	} else if end > ct {
		end = ct;
	}
	let count = end - first;
	let picked = if count > 0 {
		let (a, b) = if unsorted {
			(ct - first - count, ct - first)
		} else {
			(first, first + count)
		};
		let a = usize::try_from(a.max(0)).unwrap_or(0);
		let b = usize::try_from(b.max(0)).unwrap_or(0).min(matches.len());
		a.min(b)..b
	} else {
		0..0
	};
	let per = 1 + spec.pre_words.len() + spec.post_words.len();
	let mut out = Vec::with_capacity(picked.len() * per);
	for m in matches.drain(picked) {
		out.extend(spec.pre_words.iter().cloned());
		out.push(m.name);
		out.extend(spec.post_words.iter().cloned());
	}
	Ok(Some(Globbed::Words(out)))
}

/// Replace the fields recorded in `globs` (`(index, tokenized zsh
/// word)`, ascending) by the words their filename generation gives
/// (zsh `globlist`): matches in zsh's order, the word itself under
/// `nonomatch`, nothing under `nullglob`/`(N)`; `no matches found: P`
/// (`nomatch`) or `no match` (`cshnullglob`, every pattern failing)
/// abandons the command. `Err` also parks the op while an fs call is
/// pending.
pub fn expand_globs(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	items: &mut Vec<BString>,
	globs: &[(u32, BString)],
	line: u32,
) -> Result<(), Flow> {
	if no_exec(k, vp, cx) {
		return Ok(());
	}
	let words = glob_words(k, vp, cx, globs, line)?;
	for ((i, _), ws) in globs.iter().zip(words).rev() {
		let i = *i as usize;
		if i < items.len() {
			items.splice(i..=i, ws);
		}
	}
	Ok(())
}

/// [`expand_globs`] over the elements of a compound assignment `(…)`:
/// every match becomes one unkeyed element.
pub fn expand_compound_globs(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	elems: &mut Vec<crate::bash::vm::expand::CompoundElem>,
	globs: &[(u32, BString)],
	line: u32,
) -> Result<(), Flow> {
	if no_exec(k, vp, cx) {
		return Ok(());
	}
	let words = glob_words(k, vp, cx, globs, line)?;
	for ((i, _), ws) in globs.iter().zip(words).rev() {
		let i = *i as usize;
		let Some(e) = elems.get(i).cloned() else {
			continue;
		};
		let new = ws
			.into_iter()
			.map(|value| crate::bash::vm::expand::CompoundElem { key: None, append: e.append, value });
		elems.splice(i..=i, new);
	}
	Ok(())
}

/// zsh `qualsheval`'s `inserts` after the code ran: the elements of the
/// array or the values of the association `reply`, else the scalar
/// `reply` or `REPLY` (metafied).
fn eval_inserts(ex: &mut Expander<'_, '_>) -> X<Option<Vec<Vec<u8>>>> {
	if let Some(p) = params::getparam(ex, b"reply")?
		&& !p.flags.contains(params::PmFlags::UNSET)
	{
		match &p.value {
			params::PValue::Array(a) => return Ok(Some(a.iter().map(|e| metafy(e)).collect())),
			params::PValue::Hash(h) => return Ok(Some(h.iter().map(|(_, v)| metafy(v)).collect())),
			params::PValue::Scalar(_) => {},
		}
	}
	for name in [&b"reply"[..], b"REPLY"] {
		if let Some(s) = params::getsparam(ex, name)? {
			return Ok(Some(vec![metafy(&s)]));
		}
	}
	Ok(None)
}

/// zsh `zglob` under `NO_EXEC`: words keep their text, nothing is
/// generated.
fn no_exec(k: &mut Kernel, vp: &Vproc, cx: &mut Cx<'_>) -> bool {
	!crate::bash::vm::state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Exec).unwrap_or(true)
}

/// The words each recorded glob becomes (empty for a `cshnullglob`
/// failure); the shared walk of [`expand_globs`] and
/// [`expand_compound_globs`].
fn glob_words(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	globs: &[(u32, BString)],
	line: u32,
) -> Result<Vec<Vec<BString>>, Flow> {
	if globs.is_empty() {
		return Ok(Vec::new());
	}
	let mut sc: Box<Scratch> = vp
		.frames
		.last_mut()
		.and_then(|f| f.scratch.take())
		.unwrap_or_default();
	let mut walk = sc.io().zsh().zglob.take().unwrap_or_default();
	// A shell-code qualifier ran above the op's frame: its status (`$?`
	// goes back to the caller's) and what it left in `reply`/`REPLY`.
	if let Some((ask, saved)) = walk.eval_running.take() {
		let status = std::mem::replace(&mut vp.status, saved);
		let mut log = Vec::new();
		let inserts = eval_inserts(&mut Expander::new(k, cx, vp, &mut log, false, line));
		match inserts {
			Ok(inserts) => {
				walk
					.evals
					.insert(ask, EvalFact { ok: status == 0, inserts });
			},
			Err(stop) => {
				if let Some(f) = vp.frames.last_mut() {
					f.scratch = Some(sc);
				}
				return Err(exec::stop_flow(k, vp, cx, line, stop));
			},
		}
	}
	let result = loop {
		// Ask every open question first.
		let mut tcx = Context::from_waker(&k.waker);
		let mut pending = None;
		while let Some(ask) = walk.asking.front() {
			match answer(ask, &mut walk.names, &mut tcx, cx, &mut sc, &vp.cwd) {
				Ok(fact) => {
					if let Some(ask) = walk.asking.pop_front() {
						walk.facts.insert(ask, fact);
					}
				},
				Err(key) => {
					pending = Some(key);
					break;
				},
			}
		}
		if let Some(key) = pending {
			sc.io().zsh().zglob = Some(walk);
			if let Some(f) = vp.frames.last_mut() {
				f.scratch = Some(sc);
			}
			return Err(Flow::Block(key));
		}
		let mut log = walk.probes.clone();
		let mut missing = Vec::new();
		let mut eval_missing = Vec::new();
		let mut words: Vec<Globbed> = Vec::with_capacity(globs.len());
		let r: X<()> = {
			let mut ex = Expander::new(k, cx, vp, &mut log, false, line);
			let mut r = Ok(());
			for (_, pattern) in globs {
				match zglob_one(
					&mut ex,
					pattern,
					&walk.facts,
					&mut missing,
					&walk.evals,
					&mut eval_missing,
				) {
					Ok(Some(g)) => words.push(g),
					Ok(None) => words.push(Globbed::CshFail),
					Err(e) => {
						r = Err(e);
						break;
					},
				}
			}
			r
		};
		match r {
			// A colon modifier needs a file-system answer: log it and run
			// again.
			Err(Stop::Probe(p)) => {
				let got = match probe::cached(&sc, &p) {
					Some(r) => Ok(r.clone()),
					None => probe::perform(k, cx, vp, &mut sc, &p),
				};
				match got {
					Ok(got) => walk.probes.push(exec::probe_atom(got)),
					Err(key) => {
						sc.io().zsh().zglob = Some(walk);
						if let Some(f) = vp.frames.last_mut() {
							f.scratch = Some(sc);
						}
						return Err(Flow::Block(key));
					},
				}
				continue;
			},
			Err(stop) => break Err(stop),
			Ok(()) => {},
		}
		if missing.is_empty() && eval_missing.is_empty() {
			break Ok(words);
		}
		for m in missing {
			if !walk.facts.contains_key(&m) && !walk.asking.contains(&m) {
				walk.asking.push_back(m);
			}
		}
		// File-system questions first: the code runs once the walk has
		// reached its file, in the walk's order.
		if !walk.asking.is_empty() {
			continue;
		}
		walk.eval_asking.clear();
		for m in eval_missing {
			if !walk.evals.contains_key(&m) && !walk.eval_asking.contains(&m) {
				walk.eval_asking.push_back(m);
			}
		}
		let Some(ask) = walk.eval_asking.pop_front() else {
			continue;
		};
		// zsh `qualsheval`: `reply` unset, `REPLY` the file, the code run
		// in the current shell.
		let set: X<()> = {
			let mut log = Vec::new();
			let mut ex = Expander::new(k, cx, vp, &mut log, false, line);
			params::unsetparam(&mut ex, b"reply")
				.and_then(|()| params::assignsparam(&mut ex, b"REPLY", &unmetafy(&ask.1), 0))
		};
		if let Err(stop) = set {
			break Err(stop);
		}
		let code = BString::from(unmetafy(&ask.0));
		walk.eval_running = Some((ask, vp.status));
		sc.io().zsh().zglob = Some(walk);
		if let Some(f) = vp.frames.last_mut() {
			f.scratch = Some(sc);
		}
		// The run loop pushes the code's frame once the op has put its
		// own state back.
		vp.zsh.get_or_insert_with(Box::default).glob_hook = Some((code, line));
		return Err(Flow::Call);
	};
	if let Some(f) = vp.frames.last_mut() {
		f.scratch = Some(sc);
	}
	let words = match result {
		Ok(w) => w,
		Err(stop) => return Err(exec::stop_flow(k, vp, cx, line, stop)),
	};
	let all_failed = words.iter().all(|w| matches!(w, Globbed::CshFail));
	if all_failed && words.iter().any(|w| matches!(w, Globbed::CshFail)) {
		let d = Diag::ZshFileExp { msg: BString::from("no match") };
		return Err(exec::stop_flow(k, vp, cx, line, Stop::Fail(d)));
	}
	Ok(words
		.into_iter()
		.map(|w| match w {
			Globbed::Words(ws) => ws
				.into_iter()
				.map(|w| BString::from(unmetafy(&w)))
				.collect(),
			Globbed::CshFail => Vec::new(),
		})
		.collect())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn glob_qualifiers_are_recognised_at_the_end() {
		let o = Opts::default();
		let w = [b'*', INPAR, b'/', OUTPAR];
		assert_eq!(checkglobqual(&w, false, &o), Some((1, 1)));
		assert_eq!(checkglobqual(&w, true, &o), None);
		let alt = [INPAR, b'a', BAR, b'b', OUTPAR];
		assert_eq!(checkglobqual(&alt, false, &o), None);
		let eo = Opts { extended_glob: true, ..Opts::default() };
		let q = [b'x', INPAR, POUND, b'q', b'N', OUTPAR];
		assert_eq!(checkglobqual(&q, true, &eo), Some((1, 2)));
	}

	#[test]
	fn mode_specs_parse_like_zsh() {
		let mut i = 0;
		// `no` covers only the nine permission bits the digits name.
		assert_eq!(qgetmodespec(b"755", &mut i).ok(), Some(0o755 | (0o022 << 12)));
		let mut i = 0;
		let v = qgetmodespec(b":u+x:", &mut i).ok();
		assert_eq!(v, Some(0o100));
	}

	#[test]
	fn file_type_markers() {
		let mut st = unreachable_stat();
		st.kind = StatKind::Dir;
		assert_eq!(file_type(&st), b'/');
		st.kind = StatKind::File;
		st.mode = 0o755;
		assert_eq!(file_type(&st), b'*');
	}
}
