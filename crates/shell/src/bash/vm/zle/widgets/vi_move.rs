//! vi motions: the vi parts of zsh 5.9 `Src/Zle/zle_move.c` (characters,
//! line ends, columns, brackets, finds, marks, visual mode), the vi word
//! motions of `zle_word.c` and the vi line-or-history motions of
//! `zle_hist.c`.
//!
//! Several motions stop one character further while an operator reads
//! its range (zsh `virangeflag`,
//! [`crate::bash::vm::zle::utils::LineState::virangeflag`]), so that the range
//! includes the character they land on.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use super::vi::{ViState, at, vigetkey};
use crate::bash::vm::zle::{
	Editor,
	exec::{Await, Got, WResult, Zw, then},
	hist, modflags,
	utils::{self, iblank, invicmdmode},
};

/// zsh `ZC_inblank`: any white space, newlines included.
pub(super) const fn inblank(c: char) -> bool {
	c.is_whitespace()
}

/// zsh `wordclass`: 0 blank, 1 alphanumeric or `_`, 2 punctuation, 3
/// anything else (the NUL past the end included).
pub(super) fn wordclass(c: char) -> u8 {
	if iblank(c) {
		0
	} else if c.is_alphanumeric() || c == '_' {
		1
	} else if ipunct(c) {
		2
	} else {
		3
	}
}

/// zsh `ZC_ipunct` (`iswpunct`): a graphic character that is not
/// alphanumeric.
fn ipunct(c: char) -> bool {
	if c.is_ascii() {
		c.is_ascii_punctuation()
	} else {
		!c.is_control() && !c.is_whitespace() && !c.is_alphanumeric()
	}
}

/// Run `f` with the count negated (zsh's `zmult = -n; …; zmult = n`).
fn negated(ed: &mut Editor, f: impl FnOnce(&mut Editor) -> i32) -> i32 {
	ed.zmod.mult = ed.zmod.mult.wrapping_neg();
	let r = f(ed);
	ed.zmod.mult = ed.zmod.mult.wrapping_neg();
	r
}

// ---- characters and lines ---------------------------------------------------

/// zsh `viforwardchar`: `zmult` characters right within the line (not
/// onto its end in command mode, unless an operator reads its range).
pub fn vi_forward_char(ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		return negated(ed, vi_backward_char);
	}
	let mut lim = utils::findeol(ed);
	if invicmdmode(ed) && !ed.ls.virangeflag {
		utils::decpos(ed, &mut lim);
	}
	if ed.cs >= lim {
		return 1;
	}
	let mut n = ed.zmod.mult;
	while n > 0 && ed.cs < lim {
		n -= 1;
		utils::inccs(ed);
	}
	0
}

/// zsh `vibackwardchar`: `zmult` characters left within the line.
pub fn vi_backward_char(ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		return negated(ed, vi_forward_char);
	}
	if ed.cs == utils::findbol(ed) {
		return 1;
	}
	let mut n = ed.zmod.mult;
	while n > 0 && ed.cs > 0 {
		n -= 1;
		utils::deccs(ed);
		if ed.line[ed.cs] == '\n' {
			ed.cs += 1;
			break;
		}
	}
	0
}

/// Widget `vi-forward-char`.
pub fn viforwardchar(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_forward_char(zw.ed))
}

/// Widget `vi-backward-char`.
pub fn vibackwardchar(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_backward_char(zw.ed))
}

/// zsh `viendofline`: the last character of the `zmult`-th line from
/// the cursor's; line-wise motions then keep to line ends.
pub fn vi_end_of_line(ed: &mut Editor) -> i32 {
	let oldcs = ed.cs;
	let mut n = ed.zmod.mult;
	if n < 1 {
		return 1;
	}
	// zsh's cursor may go one past the end here.
	let mut cs = ed.cs;
	while n > 0 {
		n -= 1;
		if cs > ed.line.len() {
			ed.cs = oldcs;
			return 1;
		}
		cs = utils::findeol_at(&ed.line, cs) + 1;
	}
	if cs > ed.line.len() {
		ed.cs = ed.line.len();
	} else {
		ed.cs = cs;
		utils::deccs(ed);
	}
	ed.ls.lastcol = 1 << 30;
	0
}

/// Widget `vi-end-of-line`.
pub fn viendofline(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_end_of_line(zw.ed))
}

/// Widget `vi-beginning-of-line` (zsh `vibeginningofline`).
pub fn vibeginningofline(zw: &mut Zw<'_, '_>) -> WResult {
	zw.ed.cs = utils::findbol(zw.ed);
	WResult::Done(0)
}

/// Widget `vi-first-non-blank` (zsh `vifirstnonblank`).
pub fn vifirstnonblank(zw: &mut Zw<'_, '_>) -> WResult {
	utils::vifirstnonblank(zw.ed);
	WResult::Done(0)
}

/// zsh `vigotocolumn`: column `zmult` of the line (from its end when
/// negative).
pub fn vi_goto_column(ed: &mut Editor) -> i32 {
	let (x, y) = utils::findline(ed);
	let mut n = ed.zmod.mult;
	if n >= 0 {
		if n != 0 {
			n -= 1;
		}
		ed.cs = x;
		while ed.cs < y && n > 0 {
			n -= 1;
			utils::inccs(ed);
		}
	} else {
		ed.cs = y;
		n = -n;
		while ed.cs > x && n > 0 {
			n -= 1;
			utils::deccs(ed);
		}
	}
	0
}

/// Widget `vi-goto-column`.
pub fn vigotocolumn(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_goto_column(zw.ed))
}

/// zsh `vimatchbracket`: to the bracket matching the first bracket from
/// the cursor on its line (one past it, or including the start when
/// going backwards, for an operator's range).
///
/// zsh takes the bracket kind from the character truncated to a byte
/// (`unsigned char me = zleline[zlecs]`), so a wide character whose low
/// byte is a bracket's starts a match too; this keeps that.
pub fn vi_match_bracket(ed: &mut Editor) -> i32 {
	let ocs = ed.cs;
	let len = ed.line.len();
	if (ed.cs == len || ed.line[ed.cs] == '\n') && ed.cs > 0 {
		utils::deccs(ed);
	}
	if ed.ls.virangeflag {
		ed.mark = ed.cs;
	}
	let (me, oth, dir) = loop {
		if ed.cs == len || ed.line[ed.cs] == '\n' {
			ed.cs = ocs;
			return 1;
		}
		let me = char::from((u32::from(ed.line[ed.cs]) & 0xff) as u8);
		match me {
			'{' => break (me, '}', 1),
			'}' => break (me, '{', -1),
			'(' => break (me, ')', 1),
			')' => break (me, '(', -1),
			'[' => break (me, ']', 1),
			']' => break (me, '[', -1),
			_ => utils::inccs(ed),
		}
	};
	if ed.ls.virangeflag && dir < 0 {
		let mut m = ed.mark;
		utils::incpos(ed, &mut m);
		ed.mark = m;
	}
	let mut ct = 1;
	let mut off = false;
	while ct > 0 {
		if dir < 0 {
			if ed.cs == 0 {
				off = true;
				break;
			}
			utils::deccs(ed);
		} else {
			utils::inccs(ed);
			if ed.cs >= len {
				off = true;
				break;
			}
		}
		let c = ed.line[ed.cs];
		if c == oth {
			ct -= 1;
		} else if c == me {
			ct += 1;
		}
	}
	if off {
		ed.cs = ocs;
		return 1;
	}
	if dir > 0 && ed.ls.virangeflag {
		utils::inccs(ed);
	}
	0
}

/// Widget `vi-match-bracket`.
pub fn vimatchbracket(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_match_bracket(zw.ed))
}

/// Widget `vi-up-line-or-history` (zsh `viuplineorhistory`):
/// `up-line-or-history` to the first non-blank, `lastcol` kept.
pub fn viuplineorhistory(zw: &mut Zw<'_, '_>) -> WResult {
	let col = zw.ed.ls.lastcol;
	if let r @ WResult::Await(..) = hist::up_line_or_history(zw) {
		return r;
	}
	zw.ed.ls.lastcol = col;
	utils::vifirstnonblank(zw.ed);
	WResult::Done(0)
}

/// Widget `vi-down-line-or-history` (zsh `vidownlineorhistory`).
pub fn vidownlineorhistory(zw: &mut Zw<'_, '_>) -> WResult {
	let col = zw.ed.ls.lastcol;
	if let r @ WResult::Await(..) = hist::down_line_or_history(zw) {
		return r;
	}
	zw.ed.ls.lastcol = col;
	utils::vifirstnonblank(zw.ed);
	WResult::Done(0)
}

// ---- finds ------------------------------------------------------------------

/// zsh `vifindchar(repeat)`: to the `zmult`-th [`ViState::vfindchar`]
/// in [`ViState::vfinddir`] on the line (before or after it per
/// [`ViState::tailadd`]); a repeat of `t`/`T` first steps over the
/// character it stopped next to.
pub fn vi_find_char(vi: &mut ViState, ed: &mut Editor, repeat: bool) -> i32 {
	let ocs = ed.cs;
	let n = ed.zmod.mult;
	if vi.vfinddir == 0 {
		return 1;
	}
	if n < 0 {
		ed.zmod.mult = n.wrapping_neg();
		let r = vi_rev_repeat_find(vi, ed);
		ed.zmod.mult = n;
		return r;
	}
	let len = ed.line.len();
	let target = vi.vfindchar;
	if repeat && vi.tailadd != 0 {
		if vi.vfinddir > 0 {
			if ed.cs < len && Some(at(&ed.line, ed.cs + 1)) == target {
				utils::inccs(ed);
			}
		} else if ed.cs > 0 && Some(ed.line[ed.cs - 1]) == target {
			utils::deccs(ed);
		}
	}
	for _ in 0..n {
		loop {
			if vi.vfinddir > 0 {
				utils::inccs(ed);
			} else if ed.cs == 0 {
				ed.cs = ocs;
				return 1;
			} else {
				utils::deccs(ed);
			}
			if ed.cs >= len || Some(ed.line[ed.cs]) == target || ed.line[ed.cs] == '\n' {
				break;
			}
		}
		if ed.cs >= len || ed.line[ed.cs] == '\n' {
			ed.cs = ocs;
			return 1;
		}
	}
	if vi.tailadd > 0 {
		utils::inccs(ed);
	} else if vi.tailadd < 0 {
		utils::deccs(ed);
	}
	if vi.vfinddir == 1 && ed.ls.virangeflag {
		utils::inccs(ed);
	}
	0
}

/// zsh `virevrepeatfind`: the last find the other way.
pub fn vi_rev_repeat_find(vi: &mut ViState, ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		ed.zmod.mult = ed.zmod.mult.wrapping_neg();
		let r = vi_find_char(vi, ed, true);
		ed.zmod.mult = ed.zmod.mult.wrapping_neg();
		return r;
	}
	vi.tailadd = -vi.tailadd;
	vi.vfinddir = -vi.vfinddir;
	let r = vi_find_char(vi, ed, true);
	vi.vfinddir = -vi.vfinddir;
	vi.tailadd = -vi.tailadd;
	r
}

/// The find widgets: read the character, then find it.
fn find(dir: i8, tailadd: i8) -> WResult {
	vigetkey(move |zw, c| {
		zw.zle.vi.vfindchar = c;
		if c.is_none() {
			return WResult::Done(1);
		}
		zw.zle.vi.vfinddir = dir;
		zw.zle.vi.tailadd = tailadd;
		WResult::Done(vi_find_char(&mut zw.zle.vi, zw.ed, false))
	})
}

/// Widget `vi-find-next-char` (`f`).
pub fn vifindnextchar(_zw: &mut Zw<'_, '_>) -> WResult {
	find(1, 0)
}

/// Widget `vi-find-prev-char` (`F`).
pub fn vifindprevchar(_zw: &mut Zw<'_, '_>) -> WResult {
	find(-1, 0)
}

/// Widget `vi-find-next-char-skip` (`t`).
pub fn vifindnextcharskip(_zw: &mut Zw<'_, '_>) -> WResult {
	find(1, -1)
}

/// Widget `vi-find-prev-char-skip` (`T`).
pub fn vifindprevcharskip(_zw: &mut Zw<'_, '_>) -> WResult {
	find(-1, 1)
}

/// Widget `vi-repeat-find` (`;`).
pub fn virepeatfind(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_find_char(&mut zw.zle.vi, zw.ed, true))
}

/// Widget `vi-rev-repeat-find` (`,`).
pub fn virevrepeatfind(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_rev_repeat_find(&mut zw.zle.vi, zw.ed))
}

// ---- marks ------------------------------------------------------------------

/// Widget `vi-set-mark` (zsh `visetmark`): mark `a`–`z` here.
pub fn visetmark(_zw: &mut Zw<'_, '_>) -> WResult {
	then(Await::Char, |zw, got| {
		let Got::Char(Some(c @ 'a'..='z')) = got else {
			return WResult::Done(1);
		};
		let i = usize::from(c as u8 - b'a');
		zw.zle.vi.vimarkcs[i] = zw.ed.cs;
		zw.zle.vi.vimarkline[i] = zw.ed.histline;
		WResult::Done(0)
	})
}

/// zsh `vigotomark` once the mark is read: to mark `c` (`` ` ``/`'`:
/// where the last jump started; `.`: where the last change left the
/// cursor), on its history line.
fn goto_mark(zw: &mut Zw<'_, '_>, c: Option<char>) -> i32 {
	let oldcs = zw.ed.cs;
	let oldline = zw.ed.histline;
	let (markcs, markhist, slot) = match c {
		Some('\'' | '`') => (zw.zle.vi.vimarkcs[26], zw.zle.vi.vimarkline[26], Some(26)),
		Some('.') if zw.ed.undo.cur > 0 => {
			let ch = &zw.ed.undo.changes[zw.ed.undo.cur - 1];
			(ch.new_cs, ch.hist, None)
		},
		Some(c @ 'a'..='z') => {
			let i = usize::from(c as u8 - b'a');
			(zw.zle.vi.vimarkcs[i], zw.zle.vi.vimarkline[i], Some(i))
		},
		_ => return 1,
	};
	if markhist == 0 {
		return 1;
	}
	if zw.ed.histline != markhist && !hist::zle_goto_hist(zw, markhist, 0, false) {
		if let Some(i) = slot {
			zw.zle.vi.vimarkline[i] = 0;
		}
		return 1;
	}
	zw.ed.cs = markcs;
	zw.zle.vi.vimarkcs[26] = oldcs;
	zw.zle.vi.vimarkline[26] = oldline;
	if zw.ed.cs > zw.ed.line.len() {
		zw.ed.cs = zw.ed.line.len();
	}
	0
}

/// Widget `vi-goto-mark` (`` ` ``).
pub fn vigotomark(_zw: &mut Zw<'_, '_>) -> WResult {
	then(Await::Char, |zw, got| {
		let c = match got {
			Got::Char(c) => c,
			_ => None,
		};
		WResult::Done(goto_mark(zw, c))
	})
}

/// Widget `vi-goto-mark-line` (`'`): [`vigotomark`], then the first
/// non-blank (zsh succeeds even when the mark is not set).
pub fn vigotomarkline(_zw: &mut Zw<'_, '_>) -> WResult {
	then(Await::Char, |zw, got| {
		let c = match got {
			Got::Char(c) => c,
			_ => None,
		};
		goto_mark(zw, c);
		utils::vifirstnonblank(zw.ed);
		WResult::Done(0)
	})
}

// ---- visual mode ------------------------------------------------------------

/// zsh `visualmode`: toggle the character-wise region (from the line-wise
/// one); while an operator reads its range, force a character-wise one.
pub const fn visual_mode(ed: &mut Editor) -> i32 {
	if ed.ls.virangeflag {
		ed.prefixflag = true;
		ed.zmod.flags &= !modflags::LINE;
		ed.zmod.flags |= modflags::CHAR;
		return 0;
	}
	match ed.region_active {
		1 => ed.region_active = 0,
		0 => {
			ed.mark = ed.cs;
			ed.region_active = 1;
		},
		_ => ed.region_active = 1,
	}
	0
}

/// zsh `visuallinemode`: [`visual_mode`] for the line-wise region.
pub const fn visual_line_mode(ed: &mut Editor) -> i32 {
	if ed.ls.virangeflag {
		ed.prefixflag = true;
		ed.zmod.flags &= !modflags::CHAR;
		ed.zmod.flags |= modflags::LINE;
		return 0;
	}
	match ed.region_active {
		2 => ed.region_active = 0,
		0 => {
			ed.mark = ed.cs;
			ed.region_active = 2;
		},
		_ => ed.region_active = 2,
	}
	0
}

/// Widget `visual-mode`.
pub const fn visualmode(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(visual_mode(zw.ed))
}

/// Widget `visual-line-mode`.
pub const fn visuallinemode(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(visual_line_mode(zw.ed))
}

// ---- words ------------------------------------------------------------------

/// zsh `viforwardword`: to the start of the `zmult`-th next word (with
/// `wordflag`, the end of the last one); a blank line is a word.
pub fn vi_forward_word(ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		return negated(ed, vi_backward_word);
	}
	let len = ed.line.len();
	let mut n = ed.zmod.mult;
	while n > 0 {
		n -= 1;
		let cc = wordclass(at(&ed.line, ed.cs));
		while ed.cs != len && wordclass(ed.line[ed.cs]) == cc {
			utils::inccs(ed);
		}
		if ed.ls.wordflag && n == 0 {
			return 0;
		}
		let mut nl = u8::from(at(&ed.line, ed.cs) == '\n');
		while ed.cs != len && nl < 2 && inblank(ed.line[ed.cs]) {
			utils::inccs(ed);
			nl += u8::from(at(&ed.line, ed.cs) == '\n');
		}
	}
	0
}

/// zsh `viforwardblankword`: [`vi_forward_word`] with words separated
/// by blanks only.
pub fn vi_forward_blank_word(ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		return negated(ed, vi_backward_blank_word);
	}
	let len = ed.line.len();
	let mut n = ed.zmod.mult;
	while n > 0 {
		n -= 1;
		while ed.cs != len && !inblank(ed.line[ed.cs]) {
			utils::inccs(ed);
		}
		if ed.ls.wordflag && n == 0 {
			return 0;
		}
		let mut nl = u8::from(at(&ed.line, ed.cs) == '\n');
		while ed.cs != len && nl < 2 && inblank(ed.line[ed.cs]) {
			utils::inccs(ed);
			nl += u8::from(at(&ed.line, ed.cs) == '\n');
		}
	}
	0
}

/// zsh `viforwardblankwordend`: to the end of the `zmult`-th blank word
/// (one past it for an operator's range).
pub fn vi_forward_blank_word_end(ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		return negated(ed, vi_backward_blank_word_end);
	}
	let len = ed.line.len();
	for _ in 0..ed.zmod.mult {
		while ed.cs != len {
			let mut pos = ed.cs;
			utils::incpos(ed, &mut pos);
			if !inblank(at(&ed.line, pos)) {
				break;
			}
			ed.cs = pos;
		}
		while ed.cs != len {
			let mut pos = ed.cs;
			utils::incpos(ed, &mut pos);
			if inblank(at(&ed.line, pos)) {
				break;
			}
			ed.cs = pos;
		}
	}
	if ed.cs != len && ed.ls.virangeflag {
		utils::inccs(ed);
	}
	0
}

/// zsh `viforwardwordend`: to the end of the `zmult`-th word (one past
/// it for an operator's range).
pub fn vi_forward_word_end(ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		return negated(ed, vi_backward_word_end);
	}
	let len = ed.line.len();
	for _ in 0..ed.zmod.mult {
		while ed.cs != len {
			let mut pos = ed.cs;
			utils::incpos(ed, &mut pos);
			if !inblank(at(&ed.line, pos)) {
				break;
			}
			ed.cs = pos;
		}
		if ed.cs != len {
			let mut pos = ed.cs;
			utils::incpos(ed, &mut pos);
			let cc = wordclass(at(&ed.line, pos));
			loop {
				ed.cs = pos;
				if ed.cs == len {
					break;
				}
				utils::incpos(ed, &mut pos);
				if wordclass(at(&ed.line, pos)) != cc {
					break;
				}
			}
		}
	}
	if ed.cs != len && ed.ls.virangeflag {
		utils::inccs(ed);
	}
	0
}

/// zsh `vibackwardword`: to the start of the `zmult`-th word back (a
/// blank line counts as one).
pub fn vi_backward_word(ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		return negated(ed, vi_forward_word);
	}
	for _ in 0..ed.zmod.mult {
		let mut nl = 0;
		while ed.cs > 0 {
			utils::deccs(ed);
			if !inblank(ed.line[ed.cs]) {
				break;
			}
			nl += u8::from(ed.line[ed.cs] == '\n');
			if nl == 2 {
				utils::inccs(ed);
				break;
			}
		}
		if ed.cs > 0 {
			let mut pos = ed.cs;
			let cc = wordclass(ed.line[pos]);
			loop {
				ed.cs = pos;
				if ed.cs == 0 {
					break;
				}
				utils::decpos(ed, &mut pos);
				let c = ed.line[pos];
				if wordclass(c) != cc || inblank(c) {
					break;
				}
			}
		}
	}
	0
}

/// zsh `vibackwardblankword`: [`vi_backward_word`] for blank words.
pub fn vi_backward_blank_word(ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		return negated(ed, vi_forward_blank_word);
	}
	for _ in 0..ed.zmod.mult {
		let mut nl = 0;
		while ed.cs > 0 {
			let mut pos = ed.cs;
			utils::decpos(ed, &mut pos);
			let c = ed.line[pos];
			if !inblank(c) {
				break;
			}
			nl += u8::from(c == '\n');
			if nl == 2 {
				break;
			}
			ed.cs = pos;
		}
		while ed.cs > 0 {
			let mut pos = ed.cs;
			utils::decpos(ed, &mut pos);
			if inblank(ed.line[pos]) {
				break;
			}
			ed.cs = pos;
		}
	}
	0
}

/// zsh `vibackwardwordend`: to the end of the `zmult`-th word back.
pub fn vi_backward_word_end(ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		return negated(ed, vi_forward_word_end);
	}
	let mut n = ed.zmod.mult;
	while n > 0 && ed.cs > 1 {
		n -= 1;
		let cc = wordclass(at(&ed.line, ed.cs));
		utils::deccs(ed);
		while ed.cs > 0 {
			let c = ed.line[ed.cs];
			if wordclass(c) != cc || iblank(c) {
				break;
			}
			utils::deccs(ed);
		}
		while ed.cs > 0 && iblank(ed.line[ed.cs]) {
			utils::deccs(ed);
		}
	}
	0
}

/// zsh `vibackwardblankwordend`: to the end of the `zmult`-th blank word
/// back.
pub fn vi_backward_blank_word_end(ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		return negated(ed, vi_forward_blank_word_end);
	}
	for _ in 0..ed.zmod.mult {
		while ed.cs > 0 && !inblank(at(&ed.line, ed.cs)) {
			utils::deccs(ed);
		}
		while ed.cs > 0 && inblank(at(&ed.line, ed.cs)) {
			utils::deccs(ed);
		}
	}
	0
}

/// Widget `vi-forward-word`.
pub fn viforwardword(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_forward_word(zw.ed))
}

/// Widget `vi-forward-blank-word`.
pub fn viforwardblankword(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_forward_blank_word(zw.ed))
}

/// Widget `vi-forward-word-end`.
pub fn viforwardwordend(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_forward_word_end(zw.ed))
}

/// Widget `vi-forward-blank-word-end`.
pub fn viforwardblankwordend(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_forward_blank_word_end(zw.ed))
}

/// Widget `vi-backward-word`.
pub fn vibackwardword(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_backward_word(zw.ed))
}

/// Widget `vi-backward-blank-word`.
pub fn vibackwardblankword(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_backward_blank_word(zw.ed))
}

/// Widget `vi-backward-word-end`.
pub fn vibackwardwordend(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_backward_word_end(zw.ed))
}

/// Widget `vi-backward-blank-word-end`.
pub fn vibackwardblankwordend(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_backward_blank_word_end(zw.ed))
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

	#[test]
	fn word_classes() {
		assert_eq!(wordclass(' '), 0);
		assert_eq!(wordclass('_'), 1);
		assert_eq!(wordclass('あ'), 1);
		assert_eq!(wordclass('-'), 2);
		assert_eq!(wordclass('\0'), 3);
		assert_eq!(wordclass('\n'), 3);
	}

	#[test]
	fn words() {
		let mut e = ed("one two--three", 0);
		vi_forward_word(&mut e);
		assert_eq!(e.cs, 4);
		vi_forward_word(&mut e);
		assert_eq!(e.cs, 7);
		vi_forward_word_end(&mut e);
		assert_eq!(e.cs, 8);
		vi_backward_word(&mut e);
		assert_eq!(e.cs, 7);
		vi_backward_word_end(&mut e);
		assert_eq!(e.cs, 6);
		e.cs = 0;
		vi_forward_blank_word(&mut e);
		assert_eq!(e.cs, 4);
		// The NUL past the end is no blank: the end itself (the core then
		// steps back onto the last character in command mode).
		vi_forward_blank_word_end(&mut e);
		assert_eq!(e.cs, 14);
	}

	#[test]
	fn brackets_and_columns() {
		let mut e = ed("{ ({[}]) }", 0);
		assert_eq!(vi_match_bracket(&mut e), 0);
		assert_eq!(e.cs, 9);
		assert_eq!(vi_match_bracket(&mut e), 0);
		assert_eq!(e.cs, 0);
		e.zmod.mult = 3;
		vi_goto_column(&mut e);
		assert_eq!(e.cs, 2);
		e.zmod.mult = 1;
		let mut e = ed("abc", 0);
		e.zmod.mult = 1;
		assert_eq!(vi_end_of_line(&mut e), 0);
		assert_eq!(e.cs, 3);
	}

	#[test]
	fn finds() {
		let mut vi = ViState::default();
		let mut e = ed("a-b-c-d", 0);
		vi.vfindchar = Some('-');
		vi.vfinddir = 1;
		vi.tailadd = -1;
		assert_eq!(vi_find_char(&mut vi, &mut e, false), 0);
		assert_eq!(e.cs, 0);
		assert_eq!(vi_find_char(&mut vi, &mut e, true), 0);
		assert_eq!(e.cs, 2);
		// `T-` from just after a `-` steps over it and finds none before.
		assert_eq!(vi_rev_repeat_find(&mut vi, &mut e), 1);
		assert_eq!(e.cs, 2);
		vi.tailadd = 0;
		e.zmod.mult = 9;
		assert_eq!(vi_find_char(&mut vi, &mut e, true), 1);
		assert_eq!(e.cs, 2);
	}
}
