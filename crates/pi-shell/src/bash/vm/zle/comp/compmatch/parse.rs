//! complete.c's matcher spec parser (`parse_cmatcher`, `parse_pattern`,
//! `parse_class`) and pattern.c's class tests on the class
//! strings it builds (`mb_patmatchrange`, `mb_patmatchindex`,
//! `pattern_range_to_string`).

use std::sync::Arc;

use bstr::BString;

use super::{CHR_INVALID, PP_RANGE, class_env, mb_metacharlenconv};
use crate::bash::{
	pattern::zsh::{mb_class, metacharinc, pp_name, range_type},
	syntax::zsh::tok::{self, META},
	vm::zle::comp::types::{Cmatcher, Cpattern, cmatcher_flags as cmf},
};

/// zsh `inblank`: space, tab, newline.
const fn inblank(b: u8) -> bool {
	matches!(b, b' ' | b'\t' | b'\n')
}

/// zsh `PP_UNKWN`.
const PP_UNKWN: u8 = 20;
/// zsh `PP_FIRST`.
const PP_FIRST: u8 = 1;
/// zsh `PP_LAST`.
const PP_LAST: u8 = 19;

/// zsh `parse_cmatcher`: parse the matcher spec `s`. `Ok(None)` for an
/// empty spec; `Err(())` is zsh's `pcm_err`. zsh prints its messages
/// with `zwarnnam(name, …)`; they go to `warn` (without the name), which
/// is only called when `name` is given, except for errors in a pattern,
/// which zsh prints anyway (with a `NULL` name).
pub fn parse_cmatcher(
	name: Option<&[u8]>,
	s: &[u8],
	warn: &mut dyn FnMut(&[u8]),
) -> Result<Option<Arc<Cmatcher>>, ()> {
	let mut out: Vec<Cmatcher> = Vec::new();
	macro_rules! warnn {
		($m:expr) => {
			if name.is_some() {
				warn($m);
			}
		};
	}
	let finish = |v: Vec<Cmatcher>| {
		v.into_iter().rev().fold(None, |next, mut m| {
			m.next = next;
			Some(Arc::new(m))
		})
	};
	if s.first().is_none_or(|&b| b == 0) {
		return Ok(None);
	}
	let mut i = 0usize;
	let a = |i: usize| tok::at(s, i);
	while a(i) != 0 {
		let (mut lal, mut ral, mut both, mut fl2) = (0, 0, false, 0u32);
		let mut left: Vec<Cpattern> = Vec::new();
		let mut right: Vec<Cpattern> = Vec::new();
		while a(i) != 0 && inblank(a(i)) {
			i += 1;
		}
		if a(i) == 0 {
			break;
		}
		let fl = match a(i) {
			b'b' => {
				fl2 = cmf::INTER;
				cmf::LEFT
			},
			b'l' => cmf::LEFT,
			b'e' => {
				fl2 = cmf::INTER;
				cmf::RIGHT
			},
			b'r' => cmf::RIGHT,
			b'm' => 0,
			b'B' => {
				fl2 = cmf::INTER;
				cmf::LEFT | cmf::LINE
			},
			b'L' => cmf::LEFT | cmf::LINE,
			b'E' => {
				fl2 = cmf::INTER;
				cmf::RIGHT | cmf::LINE
			},
			b'R' => cmf::RIGHT | cmf::LINE,
			b'M' => cmf::LINE,
			b'x' => 0,
			ch => {
				let mut m = b"unknown match specification character `".to_vec();
				m.push(ch);
				m.push(b'\'');
				warnn!(&m);
				return Err(());
			},
		};
		if a(i + 1) != b':' {
			warnn!(b"missing `:'");
			return Err(());
		}
		if a(i) == b'x' {
			if a(i + 2) != 0 && !inblank(a(i + 2)) {
				warnn!(b"unexpected pattern following x: specification");
				return Err(());
			}
			return Ok(finish(out));
		}
		i += 2;
		if a(i) == 0 {
			warnn!(b"missing patterns");
			return Err(());
		}
		let mut err = false;
		if fl & cmf::LEFT != 0 && fl2 == 0 {
			left = parse_pattern(name, s, &mut i, &mut lal, b'|', &mut err, warn);
			if err {
				return Err(());
			}
			both = a(i) != 0 && a(i + 1) == b'|';
			if both {
				i += 1;
			}
			let bad = a(i) == 0 || {
				i += 1;
				a(i) == 0
			};
			if bad {
				warnn!(if both {
					b"missing right anchor"
				} else {
					b"missing line pattern"
				});
				return Err(());
			}
		}
		let mut ll = 0;
		let mut line = parse_pattern(
			name,
			s,
			&mut i,
			&mut ll,
			if fl & cmf::RIGHT != 0 && fl2 == 0 {
				b'|'
			} else {
				b'='
			},
			&mut err,
			warn,
		);
		if err {
			return Err(());
		}
		if both {
			right = core::mem::take(&mut line);
			ral = ll;
			ll = 0;
		}
		if fl & cmf::RIGHT != 0
			&& fl2 == 0
			&& (a(i) == 0 || {
				i += 1;
				a(i) == 0
			}) {
			warnn!(b"missing right anchor");
			return Err(());
		} else if fl & cmf::RIGHT == 0 || fl2 != 0 {
			if a(i) == 0 {
				warnn!(b"missing word pattern");
				return Err(());
			}
			i += 1;
		}
		if fl & cmf::RIGHT != 0 && fl2 == 0 {
			if a(i) == b'|' {
				left = core::mem::take(&mut line);
				lal = ll;
				ll = 0;
				i += 1;
			}
			right = parse_pattern(name, s, &mut i, &mut ral, b'=', &mut err, warn);
			if err {
				return Err(());
			}
			if a(i) == 0 {
				warnn!(b"missing word pattern");
				return Err(());
			}
			i += 1;
		}
		let word;
		let mut wl = 0;
		if a(i) == b'*' {
			if fl & (cmf::LEFT | cmf::RIGHT) == 0 {
				warnn!(b"need anchor for `*'");
				return Err(());
			}
			word = Vec::new();
			i += 1;
			if a(i) == b'*' {
				i += 1;
				wl = -2;
			} else {
				wl = -1;
			}
		} else {
			word = parse_pattern(name, s, &mut i, &mut wl, 0, &mut err, warn);
			if word.is_empty() && line.is_empty() && !err {
				warnn!(b"need non-empty word or line pattern");
				return Err(());
			}
		}
		if err {
			return Err(());
		}
		out.push(Cmatcher {
			next: None,
			flags: fl | fl2,
			line,
			llen: ll,
			word,
			wlen: wl,
			left,
			lalen: lal,
			right,
			ralen: ral,
		});
	}
	Ok(finish(out))
}

/// zsh `parse_pattern`: a matcher pattern of `s` from `*i` up to `e`
/// (a blank when 0); `lp` gets its length in characters.
fn parse_pattern(
	name: Option<&[u8]>,
	s: &[u8],
	i: &mut usize,
	lp: &mut i32,
	e: u8,
	err: &mut bool,
	warn: &mut dyn FnMut(&[u8]),
) -> Vec<Cpattern> {
	let a = |i: usize| tok::at(s, i);
	let _ = name;
	let mut ret = Vec::new();
	let mut l = 0;
	*err = false;
	while a(*i) != 0 && (if e != 0 { a(*i) != e } else { !inblank(a(*i)) }) {
		let ch = a(*i);
		if ch == b'[' || ch == b'{' {
			let (n, end) = parse_class(s, *i);
			*i = end;
			if a(*i) == 0 {
				*err = true;
				warn(b"unterminated character class");
				return Vec::new();
			}
			*i += 1;
			ret.push(n);
		} else if ch == b'?' {
			ret.push(Cpattern::Any);
			*i += 1;
		} else if matches!(ch, b'*' | b'(' | b')' | b'=') {
			*err = true;
			let mut m = b"invalid pattern character `".to_vec();
			m.push(ch);
			m.push(b'\'');
			warn(&m);
			return Vec::new();
		} else {
			if ch == b'\\' && a(*i + 1) != 0 {
				*i += 1;
			}
			let (inlen, mut inchar) = mb_metacharlenconv(tok::tail(s, *i));
			if inchar == CHR_INVALID {
				let b = if a(*i) == META { a(*i + 1) ^ 32 } else { a(*i) };
				// C's `(convchar_t)` of a signed `char`.
				inchar = i32::from(b as i8) as u32;
			}
			*i += inlen.max(1);
			ret.push(Cpattern::Char(char::from_u32(inchar).unwrap_or(char::REPLACEMENT_CHARACTER)));
		}
		l += 1;
	}
	*lp = l;
	ret
}

/// zsh `parse_class`: the class at `s[start]` (`[`…`]`, `[!`…`]`,
/// `{`…`}`) and the position of its closing character (of the NUL when
/// unterminated). The class string has `Meta + PP_*` codes as zsh's.
fn parse_class(s: &[u8], start: usize) -> (Cpattern, usize) {
	let a = |i: usize| tok::at(s, i);
	let mut ip = start;
	let open = a(ip);
	ip += 1;
	let (endchar, kind) = if open == b'[' {
		if (a(ip) == b'!' || a(ip) == b'^') && a(ip + 1) != b']' {
			ip += 1;
			(b']', 1)
		} else {
			(b']', 0)
		}
	} else {
		(b'}', 2)
	};
	let mut op = ip;
	while op == ip || a(op) != endchar {
		if a(op) == 0 {
			return (Cpattern::Any, op);
		}
		op += 1;
	}
	let mut out = Vec::with_capacity(op - ip + 1);
	let mut first = true;
	while first || a(ip) != endchar {
		if a(ip) == 0 {
			return (Cpattern::Any, ip);
		}
		let nptr = if a(ip) == b'[' && a(ip + 1) == b':' {
			tok::tail(s, ip + 2)
				.iter()
				.take_while(|&&b| b != 0)
				.position(|&b| b == b':')
				.map(|p| ip + 2 + p)
		} else {
			None
		};
		if let Some(np) = nptr.filter(|&np| a(np + 1) == b']') {
			let ch = range_type(&s[ip + 2..np]);
			ip = np + 2;
			if ch != PP_UNKWN {
				out.push(META.wrapping_add(ch));
			}
		} else {
			let p1 = ip;
			if a(ip) == META {
				ip += 1;
			}
			ip += 1;
			let push1 = |out: &mut Vec<u8>| {
				if a(p1) == META {
					out.push(META);
					out.push(a(p1 + 1) ^ 32);
				} else {
					out.push(a(p1));
				}
			};
			if a(ip) == b'-' && a(ip + 1) != 0 && a(ip + 1) != endchar {
				ip += 1;
				out.push(META + PP_RANGE);
				push1(&mut out);
				out.push(a(ip));
				if a(ip) == META {
					out.push(a(ip + 1));
					ip += 2;
				} else {
					ip += 1;
				}
			} else {
				push1(&mut out);
			}
		}
		first = false;
	}
	let str = BString::from(out);
	(
		match kind {
			0 => Cpattern::CClass(str),
			1 => Cpattern::NClass(str),
			_ => Cpattern::Equiv(str),
		},
		ip,
	)
}

/// zsh `mb_patmatchrange(range, ch, ZMB_VALID, indptr, mtp)`: whether
/// `ch` is in the class string `range`; `indptr` gets the index of the
/// element that matched, `mtp` its type (0: a character, else the
/// `PP_*` code; set as zsh sets it, also when nothing matched).
pub fn mb_patmatchrange(
	range: &[u8],
	ch: u32,
	mut indptr: Option<&mut u32>,
	mut mtp: Option<&mut i32>,
) -> bool {
	let env = class_env();
	if let Some(p) = indptr.as_deref_mut() {
		*p = 0;
	}
	let mut i = 0usize;
	while tok::at(range, i) != 0 {
		let b = range[i];
		if tok::is_meta(b) {
			let swtype = b - META;
			i += 1;
			if let Some(m) = mtp.as_deref_mut() {
				*m = i32::from(swtype);
			}
			match swtype {
				0 => {
					i -= 1;
					if metacharinc(range, &mut i, true) == ch {
						return true;
					}
				},
				PP_RANGE => {
					let r1 = metacharinc(range, &mut i, true);
					let r2 = metacharinc(range, &mut i, true);
					if r1 <= ch && ch <= r2 {
						if let Some(p) = indptr.as_deref_mut() {
							*p = p.wrapping_add(ch - r1);
						}
						return true;
					}
					if let Some(p) = indptr.as_deref_mut()
						&& r1 < r2
					{
						*p = p.wrapping_add(r2 - r1);
					}
				},
				18 | 19 => {
					// `[:INCOMPLETE:]`, `[:INVALID:]`: never with ZMB_VALID.
				},
				PP_FIRST..=17 if mb_class(swtype, ch, &env) => {
					return true;
				},
				_ => {},
			}
		} else if metacharinc(range, &mut i, true) == ch {
			if let Some(m) = mtp.as_deref_mut() {
				*m = 0;
			}
			return true;
		}
		if let Some(p) = indptr.as_deref_mut() {
			*p = p.wrapping_add(1);
		}
	}
	false
}

/// zsh `PATMATCHRANGE` on a `char` (for computil): whether `c` is in the
/// class string `range`, with the index and match type.
pub fn patmatchrange(range: &[u8], c: char, ind: &mut u32, mt: &mut i32) -> bool {
	mb_patmatchrange(range, c as u32, Some(ind), Some(mt))
}

/// zsh `mb_patmatchindex`: the character at index `ind` of the class
/// string `range` (`chr`, [`CHR_INVALID`] for a `[:name:]` element whose
/// type goes to `mtp`); false when there is no such index.
pub fn mb_patmatchindex(range: &[u8], mut ind: u32, chr: &mut u32, mtp: &mut i32) -> bool {
	*chr = CHR_INVALID;
	*mtp = 0;
	let mut i = 0usize;
	while tok::at(range, i) != 0 {
		let b = range[i];
		if tok::is_meta(b) {
			let swtype = b - META;
			i += 1;
			match swtype {
				0 => {
					i -= 1;
					let rchr = metacharinc(range, &mut i, true);
					if ind == 0 {
						*chr = rchr;
						return true;
					}
				},
				PP_FIRST..=PP_LAST => {
					if ind == 0 {
						*mtp = i32::from(swtype);
						return true;
					}
				},
				PP_RANGE => {
					let r1 = metacharinc(range, &mut i, true);
					let r2 = metacharinc(range, &mut i, true);
					let rdiff = r2.wrapping_sub(r1);
					if rdiff >= ind {
						*chr = r1.wrapping_add(ind);
						return true;
					}
					ind = ind.wrapping_sub(rdiff);
				},
				_ => {},
			}
		} else {
			let rchr = metacharinc(range, &mut i, true);
			if ind == 0 {
				*chr = rchr;
				return true;
			}
		}
		if ind == 0 {
			break;
		}
		ind -= 1;
	}
	false
}

/// zsh `pattern_range_to_string`: the class string `range` written back
/// as class text (byte for byte as zsh 5.9, which also copies the
/// `PP_RANGE` code of a range).
pub fn pattern_range_to_string(range: &[u8]) -> Vec<u8> {
	let mut out = Vec::new();
	let mut i = 0usize;
	let a = |i: usize| tok::at(range, i);
	while a(i) != 0 {
		let b = a(i);
		if tok::is_meta(b) {
			let swtype = b - META;
			if swtype == 0 {
				out.push(META);
				out.push(a(i + 1) ^ 32);
				i += 2;
			} else if swtype == PP_RANGE {
				for k in 0..2 {
					if a(i) == META {
						out.push(META);
						out.push(a(i + 1));
						i += 2;
					} else {
						out.push(a(i));
						i += 1;
					}
					if k == 0 {
						out.push(b'-');
					}
				}
			} else if (PP_FIRST..=PP_LAST).contains(&swtype) {
				out.extend_from_slice(b"[:");
				out.extend_from_slice(pp_name(swtype).unwrap_or_default());
				out.extend_from_slice(b":]");
				i += 1;
			} else {
				i += 1;
			}
		} else {
			out.push(b);
			i += 1;
		}
	}
	out
}

#[cfg(test)]
pub(super) fn parse_class_for_test(s: &[u8]) -> (Cpattern, usize) {
	parse_class(s, 0)
}
