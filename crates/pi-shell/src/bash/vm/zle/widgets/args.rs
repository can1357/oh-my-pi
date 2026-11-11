//! Numeric arguments (zsh 5.9 `Src/Zle/zle_misc.c`: `digitargument`,
//! `negargument`, `universalargument`, `argumentbase`). These widgets are
//! prefixes: they set [`Editor::prefixflag`] so the core keeps
//! [`Editor::zmod`] for the next widget (zsh `handleprefixes`).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use crate::bash::vm::zle::{
	Editor,
	exec::{Await, Got, WResult, Zw, then},
	modflags,
	utils::{self, zstrtol0},
};

/// zsh `parsedigit`: the value of digit `inkey` (a byte) in base `base`,
/// letters standing for digits above 9; -1 when it is not one.
pub fn parsedigit(base: u32, inkey: i32) -> i32 {
	let base = i32::try_from(base).unwrap_or(10);
	let lower = i32::from(b'a');
	let upper = i32::from(b'A');
	let zero = i32::from(b'0');
	if base > 10 {
		if inkey >= lower && inkey < lower + base - 10 {
			return inkey - lower + 10;
		}
		if inkey >= upper && inkey < upper + base - 10 {
			return inkey - upper + 10;
		}
		if (zero..=zero + 9).contains(&inkey) {
			return inkey - zero;
		}
		return -1;
	}
	if inkey >= zero && inkey < zero + base {
		return inkey - zero;
	}
	-1
}

/// zsh `digitargument`: the digit typed extends the argument being
/// typed (or, right after `neg-argument`, starts it negative).
pub fn digit_argument(ed: &mut Editor) -> i32 {
	let sign: i64 = if ed.zmod.mult < 0 { -1 } else { 1 };
	let newdigit = parsedigit(ed.zmod.base, ed.lastchar);
	if newdigit < 0 {
		return 1;
	}
	let newdigit = i64::from(newdigit);
	if ed.zmod.flags & modflags::TMULT == 0 {
		ed.zmod.tmult = 0;
	}
	if ed.zmod.flags & modflags::NEG != 0 {
		ed.zmod.tmult = sign * newdigit;
		ed.zmod.flags &= !modflags::NEG;
	} else {
		ed.zmod.tmult = ed
			.zmod
			.tmult
			.wrapping_mul(i64::from(ed.zmod.base))
			.wrapping_add(sign * newdigit);
	}
	ed.zmod.flags |= modflags::TMULT;
	ed.prefixflag = true;
	0
}

/// Widget `digit-argument`.
pub fn digitargument(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(digit_argument(zw.ed))
}

/// zsh `negargument`: start a negative argument (-1 until a digit
/// follows); fails once digits were typed.
pub const fn neg_argument(ed: &mut Editor) -> i32 {
	if ed.zmod.flags & modflags::TMULT != 0 {
		return 1;
	}
	ed.zmod.tmult = -1;
	ed.zmod.flags |= modflags::TMULT | modflags::NEG;
	ed.prefixflag = true;
	0
}

/// Widget `neg-argument`.
pub const fn negargument(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(neg_argument(zw.ed))
}

/// zsh `atoi`: leading blanks, a sign, decimal digits.
fn atoi(s: &[u8]) -> i64 {
	let mut i = 0;
	while s.get(i).is_some_and(u8::is_ascii_whitespace) {
		i += 1;
	}
	let neg = s.get(i) == Some(&b'-');
	if neg || s.get(i) == Some(&b'+') {
		i += 1;
	}
	let mut v: i32 = 0;
	while let Some(d) = s.get(i).filter(|c| c.is_ascii_digit()) {
		v = v.wrapping_mul(10).wrapping_add(i32::from(d - b'0'));
		i += 1;
	}
	i64::from(if neg { v.wrapping_neg() } else { v })
}

/// The end of `universal-argument`'s reading: `digcnt` characters made
/// the number `minus * pref` (no digits: 1), or with none typed, the
/// argument is multiplied by four.
pub fn universal_argument_done(ed: &mut Editor, digcnt: u32, pref: i32, minus: i32) {
	if digcnt != 0 {
		ed.zmod.tmult = i64::from(minus.wrapping_mul(if pref != 0 { pref } else { 1 }));
	} else {
		ed.zmod.tmult = ed.zmod.tmult.wrapping_mul(4);
	}
	ed.zmod.flags |= modflags::TMULT;
	ed.prefixflag = true;
}

/// One character of `universal-argument`'s number: a leading `-`, or a
/// digit of the current base; anything else is given back to the input
/// and ends it.
fn universal_step(digcnt: u32, pref: i32, minus: i32) -> WResult {
	then(Await::Char, move |zw, got| {
		let Got::Char(Some(c)) = got else {
			universal_argument_done(zw.ed, digcnt, pref, minus);
			return WResult::Done(0);
		};
		if c == '-' && digcnt == 0 {
			return universal_step(digcnt + 1, pref, -1);
		}
		let key = if c.is_ascii() {
			i32::from(u8::try_from(c).unwrap_or(0))
		} else {
			-1
		};
		let newdigit = parsedigit(zw.ed.zmod.base, key);
		if newdigit >= 0 {
			let base = i32::try_from(zw.ed.zmod.base).unwrap_or(10);
			return universal_step(digcnt + 1, pref.wrapping_mul(base).wrapping_add(newdigit), minus);
		}
		utils::ungetchar(zw.ed, c);
		universal_argument_done(zw.ed, digcnt, pref, minus);
		WResult::Done(0)
	})
}

/// Widget `universal-argument` (zsh `universalargument`): read an
/// optional `-` and digits as the argument (none: four times the
/// argument); `zle universal-argument N` sets the argument to `N`.
///
/// zsh reads bytes here; the number is ASCII, and the character ending
/// it goes back to the input whole.
pub fn universalargument(zw: &mut Zw<'_, '_>) -> WResult {
	if let Some(a) = zw.args.first() {
		zw.ed.zmod.mult = atoi(a);
		zw.ed.zmod.flags |= modflags::MULT;
		return WResult::Done(0);
	}
	universal_step(0, 0, 1)
}

/// zsh `argumentbase`: the base for digit arguments (2–36) from the
/// argument (`zle argument-base N`) or the numeric argument; the
/// modifier starts again otherwise, still as a prefix.
pub fn argument_base(ed: &mut Editor, arg: Option<&[u8]>) -> i32 {
	let multbase = match arg {
		Some(a) => i64::from(zstrtol0(a) as i32),
		None => ed.zmod.mult,
	};
	if !(2..=36).contains(&multbase) {
		return 1;
	}
	ed.zmod.base = u32::try_from(multbase).unwrap_or(10);
	ed.zmod.flags = 0;
	ed.zmod.mult = 1;
	ed.zmod.tmult = 1;
	ed.zmod.vibuf = 0;
	ed.prefixflag = true;
	0
}

/// Widget `argument-base`.
pub fn argumentbase(zw: &mut Zw<'_, '_>) -> WResult {
	let args = zw.args;
	WResult::Done(argument_base(zw.ed, args.first().map(|a| a.as_slice())))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::vm::zle::Context;

	#[test]
	fn digits_and_bases() {
		assert_eq!(parsedigit(10, i32::from(b'7')), 7);
		assert_eq!(parsedigit(8, i32::from(b'9')), -1);
		assert_eq!(parsedigit(16, i32::from(b'f')), 15);
		assert_eq!(parsedigit(16, i32::from(b'G')), -1);
		let mut e = Editor::new(Context::LineStart, 0);
		assert_eq!(neg_argument(&mut e), 0);
		e.zmod.mult = e.zmod.tmult;
		e.lastchar = i32::from(b'3');
		assert_eq!(digit_argument(&mut e), 0);
		assert_eq!(e.zmod.tmult, -3);
		e.zmod.mult = e.zmod.tmult;
		e.lastchar = i32::from(b'2');
		assert_eq!(digit_argument(&mut e), 0);
		assert_eq!(e.zmod.tmult, -32);
		assert_eq!(neg_argument(&mut e), 1);
		assert_eq!(argument_base(&mut e, Some(b"0x10")), 0);
		assert_eq!((e.zmod.base, e.zmod.mult, e.zmod.flags), (16, 1, 0));
		assert_eq!(argument_base(&mut e, Some(b"37")), 1);
		universal_argument_done(&mut e, 0, 0, 1);
		assert_eq!(e.zmod.tmult, 4);
		universal_argument_done(&mut e, 1, 0, -1);
		assert_eq!(e.zmod.tmult, -1);
		assert_eq!(atoi(b" -12x"), -12);
	}
}
