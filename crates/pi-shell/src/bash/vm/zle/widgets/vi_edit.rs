//! vi editing widgets that need no range (zsh 5.9 `Src/Zle/zle_vi.c`:
//! deleting, killing and yanking characters and lines, replacing,
//! joining, case, registers; `zle_misc.c`: the vi puts and
//! `put-replace-selection`; `zle_word.c`: `vi-backward-kill-word`;
//! `zle_utils.c`: `vi-undo-change`).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use super::{
	args, motion,
	vi::{at, swapcase, vichange, vigetkey},
	vi_move::wordclass,
	yank,
};
use crate::bash::vm::zle::{
	Editor, Zle,
	exec::{Await, Got, WResult, Zw, then},
	modflags, undo,
	utils::{self, KctBuf, cutflags, iblank, invicmdmode},
};

/// A count as a line length (negative counts are the callers').
fn count(n: i64) -> usize {
	usize::try_from(n).unwrap_or(if n < 0 { 0 } else { usize::MAX })
}

/// zsh `videletechar`: delete `zmult` characters under the cursor (as
/// many as the line has), backwards for a negative count.
pub fn vi_delete_char(zle: &mut Zle, ed: &mut Editor) -> i32 {
	super::vi::startvichange(&mut zle.vi, ed, -1);
	let n = ed.zmod.mult;
	if n < 0 {
		ed.zmod.mult = n.wrapping_neg();
		let r = vi_backward_delete_char(zle, ed);
		ed.zmod.mult = n;
		return r;
	}
	if ed.cs == ed.line.len() || ed.line[ed.cs] == '\n' {
		return 1;
	}
	let room = utils::findeol(ed) - ed.cs;
	if count(n) > room {
		utils::forekill(zle, ed, room, cutflags::RAW);
	} else {
		utils::forekill(zle, ed, count(n), 0);
	}
	0
}

/// zsh `vibackwarddeletechar`: delete `zmult` characters before the
/// cursor within the line (in insert mode, not before where the
/// insertion began).
pub fn vi_backward_delete_char(zle: &mut Zle, ed: &mut Editor) -> i32 {
	if invicmdmode(ed) {
		super::vi::startvichange(&mut zle.vi, ed, -1);
	}
	let n = ed.zmod.mult;
	if n < 0 {
		ed.zmod.mult = n.wrapping_neg();
		let r = vi_delete_char(zle, ed);
		ed.zmod.mult = n;
		return r;
	}
	let cs = i64::try_from(ed.cs).unwrap_or(i64::MAX);
	let begin = i64::try_from(ed.ls.viinsbegin).unwrap_or(i64::MAX);
	let bol = utils::findbol(ed);
	if (!invicmdmode(ed) && cs - n < begin) || ed.cs == bol {
		return 1;
	}
	let room = ed.cs - bol;
	if count(n) > room {
		utils::backkill(zle, ed, room, cutflags::FRONT | cutflags::RAW);
	} else {
		utils::backkill(zle, ed, count(n), cutflags::FRONT);
	}
	0
}

/// Widget `vi-delete-char` (`x`).
pub fn videletechar(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_delete_char(zw.zle, zw.ed))
}

/// Widget `vi-backward-delete-char` (`X`, backspace in `viins`).
pub fn vibackwarddeletechar(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_backward_delete_char(zw.zle, zw.ed))
}

/// Widget `vi-kill-line` (zsh `vikillline`): delete back to where the
/// insertion began.
pub fn vikillline(zw: &mut Zw<'_, '_>) -> WResult {
	let ed = &mut *zw.ed;
	if ed.ls.viinsbegin > ed.cs {
		return WResult::Done(1);
	}
	let n = ed.cs - ed.ls.viinsbegin;
	utils::backdel(ed, n, cutflags::RAW);
	WResult::Done(0)
}

/// Widget `vi-kill-eol` (zsh `vikilleol`, `D`): kill to the end of the
/// line.
pub fn vikilleol(zw: &mut Zw<'_, '_>) -> WResult {
	let n = utils::findeol(zw.ed) - zw.ed.cs;
	vichange(zw, -1);
	if n == 0 {
		return WResult::Done(1);
	}
	let ed = &mut *zw.ed;
	let ct = utils::findeol(ed) - ed.cs;
	utils::forekill(zw.zle, ed, ct, cutflags::RAW);
	WResult::Done(0)
}

/// Widget `vi-yank-eol` (zsh `viyankeol`, `Y`).
pub fn viyankeol(zw: &mut Zw<'_, '_>) -> WResult {
	let x = utils::findeol(zw.ed);
	vichange(zw, -1);
	if x == zw.ed.cs {
		return WResult::Done(1);
	}
	let cs = zw.ed.cs;
	utils::cut(zw.zle, zw.ed, cs, x - cs, cutflags::YANK);
	WResult::Done(0)
}

/// Widget `vi-yank-whole-line` (zsh `viyankwholeline`): yank `zmult`
/// whole lines.
pub fn viyankwholeline(zw: &mut Zw<'_, '_>) -> WResult {
	let bol = utils::findbol(zw.ed);
	let oldcs = zw.ed.cs;
	vichange(zw, -1);
	let ed = &mut *zw.ed;
	let n = ed.zmod.mult;
	if n < 1 {
		return WResult::Done(1);
	}
	// zsh's cursor goes one past the end after the last line.
	let mut cs = ed.cs;
	for _ in 0..n {
		if cs > ed.line.len() {
			ed.cs = oldcs;
			return WResult::Done(1);
		}
		cs = utils::findeol_at(&ed.line, cs) + 1;
	}
	ed.ls.vilinerange = true;
	utils::cut(zw.zle, ed, bol, cs - bol - 1, cutflags::YANK);
	ed.cs = oldcs;
	WResult::Done(0)
}

/// Widget `vi-replace-chars` (zsh `vireplacechars`, `r`): replace
/// `zmult` characters (the region's when active) by the character read
/// next; a newline replaces them all by one line break.
///
/// zsh: a count past the end of the line fails without reading the
/// character, except in a repeat, which reads (and drops) it.
pub fn vireplacechars(zw: &mut Zw<'_, '_>) -> WResult {
	vichange(zw, 1);
	let ed = &mut *zw.ed;
	let mut n = ed.zmod.mult;
	let mut fail = false;
	let mut newchars = 0usize;
	if n > 0 {
		if ed.region_active != 0 {
			let (mut a, mut b) = if ed.region_active == 1 {
				let (a, mut b) = if ed.mark > ed.cs {
					(ed.cs, ed.mark)
				} else {
					(ed.mark, ed.cs)
				};
				utils::incpos(ed, &mut b);
				(a, b)
			} else {
				yank::regionlines(ed)
			};
			ed.cs = a;
			if b > ed.line.len() {
				b = ed.line.len();
			}
			n = i64::try_from(b - a).unwrap_or(i64::MAX);
			while a < b {
				newchars += 1;
				utils::incpos(ed, &mut a);
			}
			ed.region_active = 0;
		} else {
			let mut pos = ed.cs;
			while n > 0 {
				n -= 1;
				if pos == ed.line.len() || ed.line[pos] == '\n' {
					fail = true;
					break;
				}
				newchars += 1;
				utils::incpos(ed, &mut pos);
			}
			n = i64::try_from(pos - ed.cs).unwrap_or(i64::MAX);
		}
	}
	if n < 1 || fail {
		if zw.zle.vi.viinrepeat != 0 {
			return vigetkey(|_, _| WResult::Done(1));
		}
		return WResult::Done(1);
	}
	let n = count(n);
	vigetkey(move |zw, ch| {
		let Some(ch) = ch else {
			return WResult::Done(1);
		};
		let ed = &mut *zw.ed;
		if ch == '\r' || ch == '\n' {
			ed.cs += n - 1;
			utils::backkill(zw.zle, ed, n - 1, cutflags::RAW);
			ed.line[ed.cs] = '\n';
			ed.cs += 1;
		} else {
			if n > newchars {
				let cs = ed.cs;
				utils::shiftchars(ed, cs, n - newchars);
			} else if n < newchars {
				utils::spaceinline(ed, newchars - n);
			}
			for _ in 0..newchars {
				ed.line[ed.cs] = ch;
				ed.cs += 1;
			}
			ed.cs -= 1;
		}
		WResult::Done(0)
	})
}

/// zsh `vijoin` (`J`): join the next `zmult` - 1 lines (at least one) to
/// this one, their leading blanks replaced by a space; with a region,
/// the lines it covers.
pub fn vi_join(zle: &mut Zle, ed: &mut Editor) -> i32 {
	let visual = ed.region_active != 0;
	super::vi::startvichange(&mut zle.vi, ed, -1);
	let mut n = ed.zmod.mult;
	if n < 1 {
		return 1;
	}
	let len = |ed: &Editor| ed.line.len();
	let mut x;
	if visual && ed.cs > ed.mark {
		motion::exchange_point_and_mark(ed);
		x = utils::findeol(ed);
		if x >= ed.mark {
			motion::exchange_point_and_mark(ed);
			return 1;
		}
	} else {
		x = utils::findeol(ed);
		if x == len(ed) || (visual && x >= ed.mark) {
			return 1;
		}
	}
	loop {
		ed.cs = x + 1;
		let pos = ed.cs;
		while ed.cs != len(ed) && iblank(ed.line[ed.cs]) {
			let mut c = ed.cs;
			utils::incpos(ed, &mut c);
			ed.cs = c;
		}
		x = 1 + (ed.cs - pos);
		utils::backdel(ed, x, cutflags::RAW);
		let mut blank_before = false;
		if ed.cs > 0 {
			let mut p = ed.cs;
			utils::decpos(ed, &mut p);
			if iblank(ed.line[p]) {
				ed.cs = p;
				blank_before = true;
			}
		}
		if !blank_before {
			utils::spaceinline(ed, 1);
			ed.line[ed.cs] = ' ';
		}
		if !visual {
			n -= 1;
			if n < 2 {
				break;
			}
		}
		x = utils::findeol(ed);
		if x == len(ed) || (visual && x >= ed.mark) {
			break;
		}
	}
	0
}

/// Widget `vi-join`.
pub fn vijoin(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_join(zw.zle, zw.ed))
}

/// Widget `vi-swap-case` (zsh `viswapcase`, `~`): swap the case of
/// `zmult` characters, the cursor after them.
pub fn viswapcase(zw: &mut Zw<'_, '_>) -> WResult {
	vichange(zw, -1);
	let ed = &mut *zw.ed;
	let mut n = ed.zmod.mult;
	if n < 1 {
		return WResult::Done(1);
	}
	let eol = utils::findeol(ed);
	if ed.cs == eol {
		return WResult::Done(1);
	}
	while ed.cs < eol && n > 0 {
		n -= 1;
		ed.line[ed.cs] = swapcase(ed.line[ed.cs]);
		utils::inccs(ed);
	}
	if ed.cs > 0 && ed.cs == eol {
		utils::deccs(ed);
	}
	WResult::Done(0)
}

/// Widget `vi-caps-lock-panic` (zsh `vicapslockpanic`): beep, then wait
/// for a lower-case key under a message. (zsh would spin at end of
/// input; this gives up there.)
pub fn vicapslockpanic(zw: &mut Zw<'_, '_>) -> WResult {
	zw.ed.clearlist = true;
	zw.ed.feep = true;
	zw.ed.statusline = Some("press a lowercase key to continue".into());
	then(Await::Refresh, |_, _| panic_key())
}

/// One key of `vi-caps-lock-panic`.
fn panic_key() -> WResult {
	then(Await::Char, |zw, got| match got {
		Got::Char(Some(c)) if !c.is_lowercase() => panic_key(),
		_ => {
			zw.ed.statusline = None;
			WResult::Done(0)
		},
	})
}

/// zsh `visetbuffer` with the register character `ch` (`None`: none
/// could be read): `"_` discards, `"a`–`"z` and `"0`–`"9` select,
/// `"A`–`"Z` append.
pub fn set_buffer(ed: &mut Editor, ch: Option<char>) -> i32 {
	if ch == Some('_') {
		ed.zmod.flags |= modflags::NULL;
		ed.prefixflag = true;
		return 0;
	}
	ed.zmod.flags &= !modflags::NULL;
	let Some(c) = ch.filter(char::is_ascii_alphanumeric) else {
		return 1;
	};
	if c.is_ascii_uppercase() {
		ed.zmod.flags |= modflags::VIAPP;
	} else {
		ed.zmod.flags &= !modflags::VIAPP;
	}
	let c = c.to_ascii_lowercase() as u8;
	ed.zmod.vibuf = u32::from(if c.is_ascii_digit() {
		c - b'0' + 26
	} else {
		c - b'a'
	});
	ed.zmod.flags |= modflags::VIBUF;
	ed.prefixflag = true;
	0
}

/// Widget `vi-set-buffer` (`"`; `zle vi-set-buffer x`).
pub fn visetbuffer(zw: &mut Zw<'_, '_>) -> WResult {
	let args = zw.args;
	if let Some(a) = args.first() {
		if args.len() > 1 || a.len() > 1 {
			return WResult::Done(1);
		}
		let ch = a.first().map_or('\0', |&b| char::from(b));
		return WResult::Done(set_buffer(zw.ed, Some(ch)));
	}
	then(Await::Char, |zw, got| {
		let ch = match got {
			Got::Char(c) => c,
			_ => None,
		};
		WResult::Done(set_buffer(zw.ed, ch))
	})
}

/// Widget `vi-pound-insert` (zsh `vipoundinsert`): toggle a `#` at the
/// first non-blank of the line.
pub fn vipoundinsert(zw: &mut Zw<'_, '_>) -> WResult {
	let mut oldcs = zw.ed.cs;
	vichange(zw, -1);
	let ed = &mut *zw.ed;
	utils::vifirstnonblank(ed);
	if at(&ed.line, ed.cs) == '#' {
		utils::foredel(ed, 1, 0);
		if ed.cs < ed.ls.viinsbegin {
			let mut v = ed.ls.viinsbegin;
			utils::decpos(ed, &mut v);
			ed.ls.viinsbegin = v;
		}
		if ed.cs < oldcs {
			utils::decpos(ed, &mut oldcs);
		}
	} else {
		utils::spaceinline(ed, 1);
		ed.line[ed.cs] = '#';
		if ed.cs <= ed.ls.viinsbegin {
			let mut v = ed.ls.viinsbegin;
			utils::incpos(ed, &mut v);
			ed.ls.viinsbegin = v;
		}
		if ed.cs <= oldcs {
			utils::incpos(ed, &mut oldcs);
		}
	}
	ed.cs = oldcs;
	WResult::Done(0)
}

/// Widget `vi-quoted-insert` (zsh `viquotedinsert`): show `^` at the
/// cursor, read a character raw and insert it.
pub fn viquotedinsert(zw: &mut Zw<'_, '_>) -> WResult {
	let ed = &mut *zw.ed;
	utils::spaceinline(ed, 1);
	ed.line[ed.cs] = '^';
	then(Await::Refresh, |_, _| {
		then(Await::Char, |zw, got| {
			utils::foredel(zw.ed, 1, 0);
			match got {
				Got::Char(Some(c)) => {
					zw.ed.lastchar_wide = Some(c);
					WResult::Done(super::misc::self_insert(zw.ed))
				},
				_ => WResult::Done(1),
			}
		})
	})
}

/// Widget `vi-digit-or-beginning-of-line` (`0`): a digit of a count being
/// typed, else `vi-beginning-of-line`.
pub fn vidigitorbeginningofline(zw: &mut Zw<'_, '_>) -> WResult {
	if zw.ed.zmod.flags & modflags::TMULT != 0 {
		return args::digitargument(zw);
	}
	zw.ed.cs = utils::findbol(zw.ed);
	WResult::Done(0)
}

/// Widget `vi-undo-change` (zsh `viundochange`, `u`).
pub fn viundochange(zw: &mut Zw<'_, '_>) -> WResult {
	let args = zw.args;
	WResult::Done(undo::viundochange(zw, args.first().map(|a| a.as_slice())))
}

/// zsh `vibackwardkillword` (`^W` in `viins`): kill `zmult` vi words
/// back, not past where the insertion began or the line's start.
pub fn vi_backward_kill_word(zle: &mut Zle, ed: &mut Editor) -> i32 {
	let mut x = ed.cs;
	let bol = utils::findbol(ed);
	let lim = ed.ls.viinsbegin.max(bol);
	let n = ed.zmod.mult;
	if n < 0 {
		return 1;
	}
	for _ in 0..n {
		while x > lim {
			let mut pos = x;
			utils::decpos(ed, &mut pos);
			if !iblank(ed.line[pos]) {
				break;
			}
			x = pos;
		}
		if x > lim {
			let mut pos = x;
			utils::decpos(ed, &mut pos);
			let cc = wordclass(ed.line[pos]);
			loop {
				x = pos;
				if x <= lim {
					break;
				}
				utils::decpos(ed, &mut pos);
				if wordclass(ed.line[pos]) != cc {
					break;
				}
			}
		}
	}
	let ct = ed.cs - x;
	utils::backkill(zle, ed, ct, cutflags::FRONT | cutflags::RAW);
	0
}

/// Widget `vi-backward-kill-word`.
pub fn vibackwardkillword(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_backward_kill_word(zw.zle, zw.ed))
}

// ---- puts -------------------------------------------------------------------

/// The buffer a put takes: the selected register, else the cut buffer.
const fn put_source(ed: &Editor) -> KctBuf {
	if ed.zmod.flags & modflags::VIBUF != 0 {
		KctBuf::Vi(ed.zmod.vibuf as usize)
	} else {
		KctBuf::Cut
	}
}

/// zsh `viputbefore`/`viputafter`: put the buffer `zmult` times before
/// (`position` 0) or after (1) the cursor, line-wise buffers on lines of
/// their own.
fn vi_put(zle: &mut Zle, ed: &mut Editor, position: u8) -> i32 {
	let n = ed.zmod.mult;
	super::vi::startvichange(&mut zle.vi, ed, -1);
	if n < 0 {
		return 1;
	}
	if ed.zmod.flags & modflags::NULL != 0 {
		return 0;
	}
	let k = put_source(ed);
	ed.ls.kctbuf = Some(k);
	let Some(buf) = utils::kctbuf_get(zle, k).cloned() else {
		return 1;
	};
	zle.kct = None;
	ed.ls.yankcs = ed.cs;
	utils::pastebuf(ed, &buf, n, position);
	0
}

/// Widget `vi-put-before` (`P`).
pub fn viputbefore(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_put(zw.zle, zw.ed, 0))
}

/// Widget `vi-put-after` (`p`).
pub fn viputafter(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_put(zw.zle, zw.ed, 1))
}

/// zsh `putreplaceselection` (`p` in `visual`): replace the region by
/// the buffer (the region's text going to the kill ring and `"1` as a
/// kill does).
pub fn put_replace_selection(zle: &mut Zle, ed: &mut Editor) -> i32 {
	let n = ed.zmod.mult;
	super::vi::startvichange(&mut zle.vi, ed, -1);
	if n < 0 || ed.zmod.flags & modflags::NULL != 0 {
		return 1;
	}
	let Some(prevbuf) = utils::kctbuf_get(zle, put_source(ed)).cloned() else {
		return 1;
	};
	// zsh hands `"9` over to the kill, which shifts it out.
	if ed.zmod.vibuf == 35 {
		zle.vibuf[35] = None;
	}
	ed.zmod.flags = 0;
	let pos = if ed.region_active == 2 && prevbuf.flags & crate::bash::vm::zle::CUTBUFFER_LINE != 0 {
		let (_, b) = yank::regionlines(ed);
		u8::from(b == ed.line.len())
	} else {
		2
	};
	yank::kill_region(zle, ed);
	utils::pastebuf(ed, &prevbuf, n, pos);
	0
}

/// Widget `put-replace-selection`.
pub fn putreplaceselection(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(put_replace_selection(zw.zle, zw.ed))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::vm::zle::Context;

	fn ed(s: &str, cs: usize) -> Editor {
		let mut e = Editor::new(Context::LineStart, 0);
		e.line = s.chars().collect();
		e.cs = cs;
		e.keymap = bstr::BString::from("vicmd");
		e
	}

	fn line(e: &Editor) -> String {
		e.line.iter().collect()
	}

	#[test]
	fn join_lines() {
		let mut zle = Zle::new(true);
		let mut e = ed("one\n  two\nthree\n four", 0);
		e.zmod.mult = 3;
		assert_eq!(vi_join(&mut zle, &mut e), 0);
		assert_eq!(line(&e), "one two three\n four");
		assert_eq!(e.cs, 7);
		let mut e = ed("one\ntwo", 0);
		e.zmod.mult = 3;
		assert_eq!(vi_join(&mut zle, &mut e), 0);
		assert_eq!((line(&e), e.cs), ("one two".into(), 3));
	}

	#[test]
	fn registers() {
		let mut e = ed("", 0);
		assert_eq!(set_buffer(&mut e, Some('B')), 0);
		assert_eq!(e.zmod.vibuf, 1);
		assert_ne!(e.zmod.flags & modflags::VIAPP, 0);
		assert_eq!(set_buffer(&mut e, Some('3')), 0);
		assert_eq!((e.zmod.vibuf, e.zmod.flags & modflags::VIAPP), (29, 0));
		assert_eq!(set_buffer(&mut e, Some('_')), 0);
		assert_ne!(e.zmod.flags & modflags::NULL, 0);
		assert_eq!(set_buffer(&mut e, Some('%')), 1);
	}

	#[test]
	fn delete_and_put() {
		let mut zle = Zle::new(true);
		let mut e = ed("abcdef", 1);
		e.zmod.mult = 2;
		assert_eq!(vi_delete_char(&mut zle, &mut e), 0);
		assert_eq!(line(&e), "adef");
		// "1 has the deletion; put it after the cursor.
		e.zmod.mult = 1;
		assert_eq!(vi_put(&mut zle, &mut e, 1), 0);
		assert_eq!((line(&e), e.cs), ("adbcef".into(), 3));
		e.cs = 0;
		e.zmod.mult = 1;
		assert_eq!(vi_backward_delete_char(&mut zle, &mut e), 1);
	}
}
