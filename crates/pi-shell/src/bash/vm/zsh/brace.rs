//! zsh brace expansion: a port of zsh 5.9's `glob.c` `hasbraces`,
//! `bracechardots` and `xpandbraces` (`{a,b}`, `{1..10..2}`, `{a..z}`,
//! and `{a-mx}` under `braceccl`).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use super::text;
use crate::bash::syntax::zsh::tok::{
	COMMA, DASH, INBRACE, META, OUTBRACE, at, head, is_meta, is_tok, set_at, span, tok_char,
};

/// zsh `IS_DASH`.
const fn is_dash(c: u8) -> bool {
	c == b'-' || c == DASH
}

/// zsh `hasbraces`: whether `s` (tokenized) holds a brace expression to
/// expand. Braces that cannot expand are turned into literal characters in
/// place, as zsh does.
pub fn hasbraces(s: &mut [u8], braceccl: bool) -> bool {
	if braceccl {
		let mut bc = 0;
		let mut i = 0;
		while i < s.len() {
			let c = at(s, i);
			if c == INBRACE {
				if bc == 0 && s.get(i + 1) == Some(&OUTBRACE) {
					set_at(s, i, b'{');
					set_at(s, i + 1, b'}');
					i += 1;
				} else {
					bc += 1;
				}
			} else if c == OUTBRACE {
				if bc == 0 {
					set_at(s, i, b'}');
				} else {
					bc -= 1;
					if bc == 0 {
						return true;
					}
				}
			}
			i += 1;
		}
		return false;
	}
	let (mut lbr, mut mbr, mut comma): (Option<usize>, Option<usize>, Option<usize>) =
		(None, None, None);
	let mut i = 0;
	loop {
		let c = s.get(i).copied().unwrap_or(0);
		i += 1;
		match c {
			INBRACE => {
				if let Some(l) = lbr {
					let at = i - 1;
					let mut j = at;
					if text::skipparens(INBRACE, OUTBRACE, s, &mut j) {
						i = j;
						if mbr.is_none() {
							mbr = Some(at);
						}
					} else {
						set_at(s, l, b'{');
						set_at(s, at, b'{');
						i = j;
						if let Some(c) = comma {
							i = c;
						}
						if let Some(m) = mbr
							&& m < i
						{
							i = m;
						}
						lbr = None;
						mbr = None;
						comma = None;
					}
				} else {
					if bracechardots(s, i - 1).is_some() {
						return true;
					}
					lbr = Some(i - 1);
					let start = i - 1;
					let mut j = i;
					if s.get(j).is_some_and(|&c| is_dash(c)) {
						j += 1;
					}
					while s.get(j).is_some_and(u8::is_ascii_digit) {
						j += 1;
					}
					if s.get(j) == Some(&b'.') && s.get(j + 1) == Some(&b'.') {
						j += 2;
						if s.get(j).is_some_and(|&c| is_dash(c)) {
							j += 1;
						}
						while s.get(j).is_some_and(u8::is_ascii_digit) {
							j += 1;
						}
						let digits = |k: usize| s.get(k).is_some_and(u8::is_ascii_digit);
						if s.get(j) == Some(&OUTBRACE) && (digits(start + 1) || digits(j - 1)) {
							return true;
						} else if s.get(j) == Some(&b'.') && s.get(j + 1) == Some(&b'.') {
							j += 2;
							if s.get(j).is_some_and(|&c| is_dash(c)) {
								j += 1;
							}
							while s.get(j).is_some_and(u8::is_ascii_digit) {
								j += 1;
							}
							if s.get(j) == Some(&OUTBRACE) && (digits(start + 1) || digits(j - 1)) {
								return true;
							}
						}
					}
					i = j;
				}
			},
			OUTBRACE => {
				if let Some(l) = lbr {
					if comma.is_some() {
						return true;
					}
					set_at(s, l, b'{');
					set_at(s, i - 1, b'}');
					if let Some(m) = mbr {
						i = m;
					}
					mbr = None;
					lbr = None;
				} else {
					set_at(s, i - 1, b'}');
				}
			},
			COMMA => {
				if lbr.is_none() {
					set_at(s, i - 1, b',');
				} else if comma.is_none() {
					comma = Some(i - 1);
				}
			},
			0 if i > s.len() => {
				if let Some(l) = lbr {
					set_at(s, l, b'{');
				}
				if mbr.is_none() && comma.is_none() {
					return false;
				}
				if let Some(c) = comma {
					i = c;
				}
				if let Some(m) = mbr
					&& m < i
				{
					i = m;
				}
				lbr = None;
				mbr = None;
				comma = None;
			},
			_ => {},
		}
	}
}

/// zsh `bracechardots`: `{c1..c2}` at `s[at]` (an `Inbrace`): the two
/// characters.
fn bracechardots(s: &[u8], at: usize) -> Option<(u32, u32)> {
	let one = |i: usize| -> Option<(u32, usize)> {
		let c = *s.get(i)?;
		if is_tok(c) {
			if c == INBRACE {
				return None;
			}
			return Some((u32::from(tok_char(c)?), i + 1));
		}
		if c == META {
			return Some((u32::from(s.get(i + 1)? ^ 32), i + 2));
		}
		Some((u32::from(c), i + 1))
	};
	let (c1, mut p) = one(at + 1)?;
	if s.get(p) != Some(&b'.') || s.get(p + 1) != Some(&b'.') {
		return None;
	}
	p += 2;
	let (c2, p) = one(p)?;
	if s.get(p) != Some(&OUTBRACE) {
		return None;
	}
	Some((c1, c2))
}

/// zsh `zstrtol(s, &end, 10)` on bytes: value and end index (no digits:
/// end = start).
fn strtol(s: &[u8], at: usize) -> (i64, usize) {
	let mut i = at;
	let neg = s.get(i).is_some_and(|&c| is_dash(c) || c == b'+');
	let sign_neg = s.get(i).is_some_and(|&c| is_dash(c));
	if neg {
		i += 1;
	}
	let ds = i;
	let mut v: i64 = 0;
	while let Some(&c) = s.get(i).filter(|c| c.is_ascii_digit()) {
		v = v.wrapping_mul(10).wrapping_add(i64::from(c - b'0'));
		i += 1;
	}
	if i == ds {
		return (0, at);
	}
	(if sign_neg { -v } else { v }, i)
}

/// zsh `xpandbraces`: expand the first brace expression of `word`; the
/// words it becomes, in order.
#[expect(clippy::too_many_lines, reason = "a faithful port of one C function")]
pub fn xpandbraces(word: &[u8], braceccl: bool) -> Vec<Vec<u8>> {
	let Some(str_at) = word.iter().position(|&c| c == INBRACE) else {
		return vec![word.to_vec()];
	};
	let mut bc = 0;
	let mut comma = 0;
	let mut dotdot = 0;
	let mut str2 = str_at;
	while str2 < word.len() {
		let c = at(word, str2);
		if c == INBRACE {
			bc += 1;
		} else if c == OUTBRACE {
			bc -= 1;
			if bc == 0 {
				break;
			}
		} else if bc == 1 {
			if c == COMMA {
				comma += 1;
			} else if c == b'.' && word.get(str2 + 1) == Some(&b'.') {
				dotdot += 1;
				str2 += 1;
			}
		}
		str2 += 1;
	}
	let pre = head(word, str_at);
	let post = word.get(str2 + 1..).unwrap_or_default();
	let cat = |mid: &[u8]| {
		let mut v = Vec::with_capacity(pre.len() + mid.len() + post.len());
		v.extend_from_slice(pre);
		v.extend_from_slice(mid);
		v.extend_from_slice(post);
		v
	};
	if comma == 0 && dotdot > 0 {
		if let Some((mut cstart, mut cend)) = bracechardots(word, str_at) {
			let rev = if cend < cstart {
				std::mem::swap(&mut cstart, &mut cend);
				true
			} else {
				false
			};
			let mut out = Vec::new();
			let mut c = cend;
			loop {
				let mut mid = Vec::new();
				if let Ok(b) = u8::try_from(c) {
					nicechar_into(b, &mut mid);
				}
				out.push(cat(&mid));
				if c <= cstart {
					break;
				}
				c -= 1;
			}
			if !rev {
				out.reverse();
			}
			return out;
		}
		let (rstart, dots) = strtol(word, str_at + 1);
		let mut err =
			dots == str_at + 1 || word.get(dots) != Some(&b'.') || word.get(dots + 1) != Some(&b'.');
		let mut rend = 0;
		let mut rincr: i64 = 1;
		let wid1 = dots.saturating_sub(str_at + 1);
		let mut wid2 = str2.saturating_sub(dots + 2);
		let mut wid3 = 0;
		let mut dots2 = None;
		if !err {
			let (e, p) = strtol(word, dots + 2);
			rend = e;
			if p == dots + 2 {
				err = true;
			}
			if p != str2 {
				wid2 = p - dots - 2;
				dots2 = Some(p);
				if dotdot == 2 && word.get(p) == Some(&b'.') && word.get(p + 1) == Some(&b'.') {
					let (inc, q) = strtol(word, p + 2);
					rincr = inc;
					wid3 = q - p - 2;
					if q != str2 || rincr == 0 {
						err = true;
					}
				} else {
					err = true;
				}
			}
		}
		if !err {
			let zero_at = |i: usize| {
				word.get(i) == Some(&b'0')
					|| (word.get(i).is_some_and(|&c| is_dash(c)) && word.get(i + 1) == Some(&b'0'))
			};
			let minw = if zero_at(str_at + 1) {
				wid1
			} else if zero_at(dots + 2) {
				wid2
			} else if dots2.is_some_and(|d| zero_at(d + 2)) {
				wid3
			} else {
				0
			};
			let mut rev = false;
			let (mut rstart, mut rend) = (rstart, rend);
			if rincr < 0 {
				rincr = -rincr;
				rev = !rev;
			}
			if rstart > rend {
				std::mem::swap(&mut rstart, &mut rend);
				rev = !rev;
			} else if rincr > 1 {
				rend -= (rend - rstart) % rincr;
			}
			let mut out = Vec::new();
			while rend >= rstart {
				let n = if rend < 0 {
					format!("-{:0w$}", -rend, w = minw.saturating_sub(1))
				} else {
					format!("{rend:0minw$}")
				};
				out.push(cat(n.as_bytes()));
				rend -= rincr;
			}
			if !rev {
				out.reverse();
			}
			return out;
		}
	}
	if comma == 0 && braceccl {
		let mut ccl = [false; 256];
		let mut lastch: i32 = -1;
		let mut p = str_at + 1;
		while p < str2 {
			let mut c1 = at(word, p);
			p += 1;
			if is_tok(c1) {
				c1 = tok_char(c1).unwrap_or(c1);
			}
			if c1 == META && p < str2 {
				c1 = at(word, p) ^ 32;
				p += 1;
			}
			let mut c2 = word.get(p).copied().unwrap_or(0);
			if is_tok(c2) {
				c2 = tok_char(c2).unwrap_or(c2);
			}
			if c2 == META {
				c2 = word.get(p + 1).copied().unwrap_or(0) ^ 32;
			}
			if is_dash(c1) && lastch >= 0 && p < str2 && lastch <= i32::from(c2) {
				while lastch < i32::from(c2) {
					ccl[usize::try_from(lastch).unwrap_or(0)] = true;
					lastch += 1;
				}
				lastch = -1;
			} else {
				ccl[usize::from(c1)] = true;
				lastch = i32::from(c1);
			}
		}
		let mut out = Vec::new();
		for (c, on) in ccl.iter().enumerate() {
			if *on {
				let b = u8::try_from(c).unwrap_or(0);
				let mut mid = Vec::new();
				if is_meta(b) {
					mid.push(META);
					mid.push(b ^ 32);
				} else {
					mid.push(b);
				}
				out.push(cat(&mid));
			}
		}
		return out;
	}
	let mut out = Vec::new();
	let mut s = str_at + 1;
	loop {
		let start = s;
		let mut cnt = 0;
		while s < str2 && (cnt > 0 || (at(word, s) != COMMA && at(word, s) != OUTBRACE)) {
			if at(word, s) == INBRACE {
				cnt += 1;
			} else if at(word, s) == OUTBRACE {
				cnt -= 1;
			}
			s += 1;
		}
		out.push(cat(span(word, start, s)));
		if s >= str2 || at(word, s) == OUTBRACE {
			break;
		}
		s += 1;
	}
	out
}

/// zsh `nicechar` of a range character (`{a..z}` output).
fn nicechar_into(c: u8, out: &mut Vec<u8>) {
	out.extend_from_slice(&text::nicedupstring(&[c]));
}

#[cfg(test)]
mod tests {
	use super::*;

	fn tok(s: &str) -> Vec<u8> {
		s.bytes()
			.map(|c| match c {
				b'{' => INBRACE,
				b'}' => OUTBRACE,
				b',' => COMMA,
				c => c,
			})
			.collect()
	}

	fn words(v: Vec<Vec<u8>>) -> Vec<String> {
		v.into_iter()
			.map(|w| String::from_utf8(w).unwrap())
			.collect()
	}

	#[test]
	fn comma_lists_expand_in_order() {
		assert_eq!(words(xpandbraces(&tok("a{b,c}d"), false)), ["abd", "acd"]);
	}

	#[test]
	fn numeric_ranges_pad_and_step_like_zsh() {
		// zsh: print {1..10..3} {05..3} {3..1}
		assert_eq!(words(xpandbraces(&tok("{1..10..3}"), false)), ["1", "4", "7", "10"]);
		assert_eq!(words(xpandbraces(&tok("{05..3}"), false)), ["05", "04", "03"]);
		assert_eq!(words(xpandbraces(&tok("{3..1}"), false)), ["3", "2", "1"]);
	}

	#[test]
	fn character_ranges_expand() {
		assert_eq!(words(xpandbraces(&tok("x{a..c}"), false)), ["xa", "xb", "xc"]);
		assert_eq!(words(xpandbraces(&tok("{c..a}"), false)), ["c", "b", "a"]);
	}

	#[test]
	fn braceccl_expands_characters_in_order() {
		assert_eq!(words(xpandbraces(&tok("{ca-b}"), true)), ["a", "b", "c"]);
	}

	#[test]
	fn hasbraces_needs_a_comma_or_range() {
		let mut s = tok("{a}");
		assert!(!hasbraces(&mut s, false));
		assert_eq!(s, b"{a}");
		let mut s = tok("{a,b}");
		assert!(hasbraces(&mut s, false));
	}
}
