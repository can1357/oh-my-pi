//! Cursor motion widgets of zsh 5.9 `Src/Zle/zle_move.c` and the
//! buffer parts of the line/history motions of `zle_hist.c`.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use super::misc::negated;
use crate::bash::vm::zle::{
	Editor,
	exec::{WResult, Zw},
	hist, utils,
};

/// zsh `forwardchar`: `zmult` characters right (left when negative),
/// stopping at the end.
pub fn forward_char(ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		return negated(ed, backward_char);
	}
	let mut n = ed.zmod.mult;
	while ed.cs < ed.line.len() && n > 0 {
		n -= 1;
		utils::inccs(ed);
	}
	0
}

/// zsh `backwardchar`: `zmult` characters left, stopping at the start.
pub fn backward_char(ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		return negated(ed, forward_char);
	}
	let mut n = ed.zmod.mult;
	while ed.cs > 0 && n > 0 {
		n -= 1;
		utils::deccs(ed);
	}
	0
}

/// Widget `forward-char`.
pub fn forwardchar(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(forward_char(zw.ed))
}

/// Widget `backward-char`.
pub fn backwardchar(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(backward_char(zw.ed))
}

/// zsh `beginningofline`: to the start of the line, `zmult` times (from
/// the start of a line, to the start of the one before).
pub fn beginning_of_line(ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		return negated(ed, end_of_line);
	}
	for _ in 0..ed.zmod.mult {
		if ed.cs == 0 {
			return 0;
		}
		let mut pos = ed.cs;
		utils::decpos(ed, &mut pos);
		if ed.line[pos] == '\n' {
			ed.cs = pos;
			if ed.cs == 0 {
				return 0;
			}
		}
		while ed.cs != 0 && ed.line[ed.cs - 1] != '\n' {
			ed.cs -= 1;
		}
	}
	0
}

/// zsh `endofline`: to the end of the line, `zmult` times.
pub fn end_of_line(ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		return negated(ed, beginning_of_line);
	}
	for _ in 0..ed.zmod.mult {
		if ed.cs >= ed.line.len() {
			ed.cs = ed.line.len();
			return 0;
		}
		ed.cs += usize::from(utils::invicmdmode(ed));
		if ed.cs == ed.line.len() {
			break;
		}
		if ed.line[ed.cs] == '\n' {
			ed.cs += 1;
			if ed.cs == ed.line.len() {
				return 0;
			}
		}
		while ed.cs != ed.line.len() && ed.line[ed.cs] != '\n' {
			ed.cs += 1;
		}
	}
	0
}

/// Widget `beginning-of-line`.
pub fn beginningofline(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(beginning_of_line(zw.ed))
}

/// Widget `end-of-line`.
pub fn endofline(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(end_of_line(zw.ed))
}

/// zsh `beginningoflinehist`: `beginning-of-line`, going on into the
/// history (`up-history`) for the counts left at the start of the
/// buffer, the cursor then at the start.
pub fn beginningoflinehist(zw: &mut Zw<'_, '_>) -> WResult {
	let mult = zw.ed.zmod.mult;
	if mult < 0 {
		zw.ed.zmod.mult = -mult;
		let r = endoflinehist(zw);
		zw.ed.zmod.mult = mult;
		return r;
	}
	let ed = &mut *zw.ed;
	let mut n = mult;
	while n != 0 {
		if ed.cs == 0 {
			break;
		}
		let mut pos = ed.cs;
		utils::decpos(ed, &mut pos);
		if ed.line[pos] == '\n' {
			ed.cs = pos;
			if pos == 0 {
				break;
			}
		}
		while ed.cs != 0 && ed.line[ed.cs - 1] != '\n' {
			ed.cs -= 1;
		}
		n -= 1;
	}
	if n == 0 {
		return WResult::Done(0);
	}
	zw.ed.zmod.mult = n;
	let r = hist::up_history(zw);
	zw.ed.zmod.mult = mult;
	zw.ed.cs = 0;
	r
}

/// zsh `endoflinehist`: `end-of-line`, going on into the history
/// (`down-history`) for the counts left at the end of the buffer.
pub fn endoflinehist(zw: &mut Zw<'_, '_>) -> WResult {
	let mult = zw.ed.zmod.mult;
	if mult < 0 {
		zw.ed.zmod.mult = -mult;
		let r = beginningoflinehist(zw);
		zw.ed.zmod.mult = mult;
		return r;
	}
	let vicmd = utils::invicmdmode(zw.ed);
	let ed = &mut *zw.ed;
	let mut n = mult;
	while n != 0 {
		if ed.cs >= ed.line.len() {
			ed.cs = ed.line.len();
			break;
		}
		ed.cs += usize::from(vicmd);
		if ed.cs == ed.line.len() {
			break;
		}
		if ed.line[ed.cs] == '\n' {
			ed.cs += 1;
			if ed.cs == ed.line.len() {
				break;
			}
		}
		while ed.cs != ed.line.len() && ed.line[ed.cs] != '\n' {
			ed.cs += 1;
		}
		n -= 1;
	}
	if n == 0 {
		return WResult::Done(0);
	}
	zw.ed.zmod.mult = n;
	let r = hist::down_history(zw);
	zw.ed.zmod.mult = mult;
	r
}

/// Widget `beginning-of-buffer-or-history` (zsh
/// `beginningofbufferorhistory`): to the start of the buffer, or when
/// already on its first line, `beginning-of-history`.
pub fn beginningofbufferorhistory(zw: &mut Zw<'_, '_>) -> WResult {
	if utils::findbol(zw.ed) != 0 {
		zw.ed.cs = 0;
		return WResult::Done(0);
	}
	hist::beginning_of_history(zw)
}

/// Widget `end-of-buffer-or-history` (zsh `endofbufferorhistory`): to
/// the end of the buffer, or when already on its last line,
/// `end-of-history`.
pub fn endofbufferorhistory(zw: &mut Zw<'_, '_>) -> WResult {
	if utils::findeol(zw.ed) != zw.ed.line.len() {
		zw.ed.cs = zw.ed.line.len();
		return WResult::Done(0);
	}
	hist::end_of_history(zw)
}

/// The status zsh's `upline`/`downline` widgets return: the lines not
/// moved (non-zero beeps).
fn lines_left(n: i64) -> i32 {
	i32::try_from(n).unwrap_or(if n < 0 { i32::MIN } else { i32::MAX })
}

/// Widget `up-line` (zsh `upline`): `zmult` lines up within the buffer.
pub fn upline(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(lines_left(utils::upline(zw)))
}

/// Widget `down-line` (zsh `downline`): `zmult` lines down within the
/// buffer.
pub fn downline(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(lines_left(utils::downline(zw)))
}

/// zsh `setmarkcommand`: the mark at the cursor, region active; a
/// negative count deactivates the region instead.
pub const fn set_mark_command(ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		ed.region_active = 0;
		return 0;
	}
	ed.mark = ed.cs;
	ed.region_active = 1;
	0
}

/// Widget `set-mark-command`.
pub const fn setmarkcommand(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(set_mark_command(zw.ed))
}

/// zsh `exchangepointandmark`: swap cursor and mark; a positive count
/// activates the region, 0 only activates it.
pub fn exchange_point_and_mark(ed: &mut Editor) -> i32 {
	if ed.zmod.mult == 0 {
		ed.region_active = 1;
		return 0;
	}
	let x = ed.mark;
	ed.mark = ed.cs;
	ed.cs = x.min(ed.line.len());
	if ed.zmod.mult > 0 {
		ed.region_active = 1;
	}
	0
}

/// Widget `exchange-point-and-mark`.
pub fn exchangepointandmark(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(exchange_point_and_mark(zw.ed))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::vm::zle::Context;

	fn ed(s: &str, cs: usize) -> Editor {
		let mut e = Editor::new(Context::LineStart, 0);
		e.line = s.chars().collect();
		e.cs = cs;
		e
	}

	#[test]
	fn chars_and_lines() {
		let mut e = ed("ab\ncd\nef", 7);
		e.zmod.mult = -3;
		assert_eq!(forward_char(&mut e), 0);
		assert_eq!(e.cs, 4);
		e.zmod.mult = 10;
		assert_eq!(forward_char(&mut e), 0);
		assert_eq!(e.cs, 8);
		e.zmod.mult = 1;
		assert_eq!(beginning_of_line(&mut e), 0);
		assert_eq!(e.cs, 6);
		// From a line start: the start of the line before.
		assert_eq!(beginning_of_line(&mut e), 0);
		assert_eq!(e.cs, 3);
		assert_eq!(end_of_line(&mut e), 0);
		assert_eq!(e.cs, 5);
		assert_eq!(end_of_line(&mut e), 0);
		assert_eq!(e.cs, 8);
		e.zmod.mult = 2;
		e.cs = 1;
		assert_eq!(end_of_line(&mut e), 0);
		assert_eq!(e.cs, 5);
	}

	#[test]
	fn mark() {
		let mut e = ed("abcd", 3);
		assert_eq!(set_mark_command(&mut e), 0);
		assert_eq!((e.mark, e.region_active), (3, 1));
		e.cs = 1;
		e.region_active = 0;
		assert_eq!(exchange_point_and_mark(&mut e), 0);
		assert_eq!((e.cs, e.mark, e.region_active), (3, 1, 1));
		e.zmod.mult = -1;
		e.region_active = 0;
		assert_eq!(exchange_point_and_mark(&mut e), 0);
		assert_eq!((e.cs, e.mark, e.region_active), (1, 3, 0));
		assert_eq!(set_mark_command(&mut e), 0);
		assert_eq!(e.mark, 3);
	}
}
