//! Inserting, deleting, killing and the odd widgets of zsh 5.9
//! `Src/Zle/zle_misc.c` (and `undo`/`redo`/`split-undo`/`beep` of
//! `zle_utils.c`, `delete-char-or-list`/`magic-space` of `zle_tricky.c`).
//!
//! zsh's widgets here also call into the completion state
//! (`iremovesuffix`/`fixsuffix` of an auto-removable suffix,
//! `invalidatelist`); those belong to the completion listing and suffix
//! code and are done by it around the widgets.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use crate::bash::vm::zle::{
	Editor, Zle,
	exec::{Await, Got, WResult, Zw, then},
	from_line, undo,
	utils::{self, cutflags},
};

/// Run `f` with the numeric argument negated (zsh's `zmult = -zmult;
/// ret = other(args); zmult = -zmult;`).
pub(super) fn negated<T>(ed: &mut Editor, f: impl FnOnce(&mut Editor) -> T) -> T {
	ed.zmod.mult = ed.zmod.mult.wrapping_neg();
	let r = f(ed);
	ed.zmod.mult = ed.zmod.mult.wrapping_neg();
	r
}

/// A count as a line length (negative counts are the callers').
pub(super) fn count(n: i64) -> usize {
	usize::try_from(n).unwrap_or(if n < 0 { 0 } else { usize::MAX })
}

/// zsh `LASTFULLCHAR` once `getrestchar` made it valid: the character
/// the last key typed. A byte that is not a whole character on its own
/// is zsh's `WEOF` (`None`): the core completes multibyte characters
/// before it looks up their binding (zsh `getrestchar_keybuf`), so only
/// an invalid byte or end of input gets here.
fn lastfullchar(ed: &mut Editor) -> Option<char> {
	if let Some(c) = ed.lastchar_wide {
		return Some(c);
	}
	let c = u8::try_from(ed.lastchar)
		.ok()
		.filter(u8::is_ascii)
		.map(char::from);
	ed.lastchar_wide = c;
	c
}

/// zsh `selfinsert`: insert the character typed.
pub fn self_insert(ed: &mut Editor) -> i32 {
	match lastfullchar(ed) {
		Some(c) => {
			utils::doinsert(ed, &[c]);
			0
		},
		None => 1,
	}
}

/// Widget `self-insert`.
pub fn selfinsert(zw: &mut Zw<'_, '_>) -> WResult {
	self_insert_zw(zw)
}

/// [`self_insert`] with zsh `doinsert`'s completion steps first: the
/// auto-removable suffix reacts to the character (`iremovesuffix(c1, 0)`)
/// and the list is invalidated.
fn self_insert_zw(zw: &mut Zw<'_, '_>) -> WResult {
	use crate::bash::vm::zle::comp::compresult::suffix;
	let Some(c) = lastfullchar(zw.ed) else {
		return WResult::Done(1);
	};
	suffix::iremovesuffix(
		zw,
		Some(c),
		false,
		Box::new(move |zw, ()| {
			suffix::invalidatelist(zw);
			utils::doinsert(zw.ed, &[c]);
			WResult::Done(0)
		}),
	)
}

/// zsh `fixunmeta`: the last byte without its meta bit, a carriage return
/// as a newline.
pub fn fixunmeta(ed: &mut Editor) {
	ed.lastchar &= 0x7f;
	if ed.lastchar == i32::from(b'\r') {
		ed.lastchar = i32::from(b'\n');
	}
	ed.lastchar_wide = u8::try_from(ed.lastchar).ok().map(char::from);
}

/// Widget `self-insert-unmeta`.
pub fn selfinsertunmeta(zw: &mut Zw<'_, '_>) -> WResult {
	fixunmeta(zw.ed);
	self_insert_zw(zw)
}

/// zsh `deletechar`: delete `zmult` characters under the cursor (before
/// it for a negative count). 1, with the cursor at the end, when there
/// are fewer.
pub fn delete_char(ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		return negated(ed, backward_delete_char);
	}
	let mult = ed.zmod.mult;
	for _ in 0..mult {
		if ed.cs == ed.line.len() {
			return 1;
		}
		utils::inccs(ed);
	}
	utils::backdel(ed, count(mult), 0);
	0
}

/// zsh `backwarddeletechar`: delete `zmult` characters before the cursor
/// (as many as there are).
pub fn backward_delete_char(ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		return negated(ed, delete_char);
	}
	let n = count(ed.zmod.mult).min(ed.cs);
	utils::backdel(ed, n, 0);
	0
}

/// Widget `delete-char`.
pub fn deletechar(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(delete_char(zw.ed))
}

/// Widget `backward-delete-char`.
pub fn backwarddeletechar(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(backward_delete_char(zw.ed))
}

/// zsh `killwholeline`: kill `zmult` whole lines of the buffer with their
/// newlines (the one before when on the last line).
pub fn kill_whole_line(zle: &mut Zle, ed: &mut Editor) -> i32 {
	let n = ed.zmod.mult;
	if n < 0 {
		return 1;
	}
	for _ in 0..n {
		let fg = ed.cs != 0 && ed.cs == ed.line.len();
		if fg {
			ed.cs -= 1;
		}
		while ed.cs != 0 && ed.line[ed.cs - 1] != '\n' {
			ed.cs -= 1;
		}
		let mut i = ed.cs;
		while i != ed.line.len() && ed.line[i] != '\n' {
			i += 1;
		}
		let ct = i - ed.cs + usize::from(i != ed.line.len());
		let flags = if fg {
			cutflags::FRONT | cutflags::RAW
		} else {
			cutflags::RAW
		};
		utils::forekill(zle, ed, ct, flags);
	}
	ed.clearlist = true;
	0
}

/// Widget `kill-whole-line`.
pub fn killwholeline(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(kill_whole_line(zw.zle, zw.ed))
}

/// zsh `killbuffer`: kill the whole buffer.
pub fn kill_buffer(zle: &mut Zle, ed: &mut Editor) -> i32 {
	ed.cs = 0;
	let ll = ed.line.len();
	utils::forekill(zle, ed, ll, cutflags::RAW);
	ed.clearlist = true;
	0
}

/// Widget `kill-buffer`.
pub fn killbuffer(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(kill_buffer(zw.zle, zw.ed))
}

/// zsh `backwardkillline`: kill back to the start of the line, `zmult`
/// times (a newline right before the cursor counts as a line).
pub fn backward_kill_line(zle: &mut Zle, ed: &mut Editor) -> i32 {
	let n = ed.zmod.mult;
	if n < 0 {
		ed.zmod.mult = -n;
		let r = kill_line(zle, ed);
		ed.zmod.mult = n;
		return r;
	}
	let mut i = 0;
	for _ in 0..n {
		if ed.cs != 0 && ed.line[ed.cs - 1] == '\n' {
			ed.cs -= 1;
			i += 1;
		} else {
			while ed.cs != 0 && ed.line[ed.cs - 1] != '\n' {
				ed.cs -= 1;
				i += 1;
			}
		}
	}
	utils::forekill(zle, ed, i, cutflags::FRONT | cutflags::RAW);
	ed.clearlist = true;
	0
}

/// zsh `killline`: kill to the end of the line, `zmult` times (on a
/// newline, the newline).
pub fn kill_line(zle: &mut Zle, ed: &mut Editor) -> i32 {
	let n = ed.zmod.mult;
	if n < 0 {
		ed.zmod.mult = -n;
		let r = backward_kill_line(zle, ed);
		ed.zmod.mult = n;
		return r;
	}
	let mut i = 0;
	for _ in 0..n {
		if ed.line.get(ed.cs) == Some(&'\n') {
			ed.cs += 1;
			i += 1;
		} else {
			while ed.cs != ed.line.len() && ed.line[ed.cs] != '\n' {
				ed.cs += 1;
				i += 1;
			}
		}
	}
	utils::backkill(zle, ed, i, cutflags::RAW);
	ed.clearlist = true;
	0
}

/// Widget `kill-line`.
pub fn killline(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(kill_line(zw.zle, zw.ed))
}

/// Widget `backward-kill-line`.
pub fn backwardkillline(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(backward_kill_line(zw.zle, zw.ed))
}

/// zsh `transpose_swap`: exchange `line[start..middle]` and
/// `line[middle..end]`.
fn transpose_swap(ed: &mut Editor, start: usize, middle: usize, end: usize) {
	ed.line[start..end].rotate_left(middle - start);
}

/// zsh `transposechars`: exchange the characters before and at the
/// cursor and move on (at the end of a line, the two before it; at the
/// start, the first two), `zmult` times; a negative count works
/// backwards.
pub fn transpose_chars(ed: &mut Editor) -> i32 {
	let mut n = ed.zmod.mult;
	let neg = n < 0;
	if neg {
		n = -n;
	}
	while n > 0 {
		n -= 1;
		let mut ct = ed.cs;
		if ct == 0 || ed.line[ed.cs - 1] == '\n' {
			if ed.line.len() == ed.cs || ed.line[ed.cs] == '\n' {
				return 1;
			}
			if !neg {
				utils::inccs(ed);
			}
			utils::incpos(ed, &mut ct);
		}
		if neg {
			if ed.cs != 0 && ed.line[ed.cs - 1] != '\n' {
				utils::deccs(ed);
				if ct > 1 && ed.line[ct - 2] != '\n' {
					utils::decpos(ed, &mut ct);
				}
			}
		} else if ed.cs != ed.line.len() && ed.line[ed.cs] != '\n' {
			utils::inccs(ed);
		}
		if ct == ed.line.len() || ed.line[ct] == '\n' {
			utils::decpos(ed, &mut ct);
		}
		if ct < 1 || ed.line[ct - 1] == '\n' {
			return 1;
		}
		let mut start = ct;
		let mut end = ct;
		utils::decpos(ed, &mut start);
		utils::incpos(ed, &mut end);
		let end = end.min(ed.line.len());
		transpose_swap(ed, start, ct, end);
	}
	0
}

/// Widget `transpose-chars`.
pub fn transposechars(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(transpose_chars(zw.ed))
}

/// zsh `acceptline`: the line is done.
pub const fn acceptline(zw: &mut Zw<'_, '_>) -> WResult {
	zw.ed.done = true;
	WResult::Done(0)
}

/// zsh `acceptandhold`: accept the line and push it onto the buffer
/// stack, with the cursor, for the next line.
pub fn accept_and_hold(zle: &mut Zle, ed: &mut Editor) -> i32 {
	zle.bufstack.push(from_line(&ed.line));
	zle.stack_cs = Some(ed.cs);
	ed.done = true;
	0
}

/// Widget `accept-and-hold`.
pub fn acceptandhold(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(accept_and_hold(zw.zle, zw.ed))
}

/// Widget `quoted-insert` (zsh `quotedinsert`): read the next character
/// raw and insert it; 1 at end of input. (zsh puts a terminal without
/// `termios` into raw mode around the read; the core reads raw.)
pub fn quotedinsert(_zw: &mut Zw<'_, '_>) -> WResult {
	then(Await::Char, |zw, got| match got {
		Got::Char(Some(c)) => {
			zw.ed.lastchar_wide = Some(c);
			WResult::Done(self_insert(zw.ed))
		},
		_ => WResult::Done(1),
	})
}

/// Widget `overwrite-mode` (zsh `overwritemode`): toggle insert and
/// overwrite.
pub const fn overwritemode(zw: &mut Zw<'_, '_>) -> WResult {
	zw.ed.insmode = !zw.ed.insmode;
	WResult::Done(0)
}

/// Widget `undo` (`zle undo [N]`).
pub fn undo(zw: &mut Zw<'_, '_>) -> WResult {
	let args = zw.args;
	WResult::Done(undo::undo(zw, args.first().map(|a| a.as_slice())))
}

/// Widget `redo`.
pub fn redo(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(undo::redo(zw))
}

/// Widget `split-undo`.
pub fn splitundo(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(undo::splitundo(zw.ed))
}

/// zsh `sendbreak`: abandon the line as an interrupt does
/// (`errflag |= ERRFLAG_ERROR|ERRFLAG_INT`).
pub const fn send_break(ed: &mut Editor) -> i32 {
	ed.aborted = true;
	1
}

/// Widget `send-break`.
pub const fn sendbreak(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(send_break(zw.ed))
}

/// Widget `undefined-key` (zsh `undefinedkey`): fail, so the core beeps.
pub const fn undefinedkey(_zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(1)
}

/// Widget `beep` (zsh `handlefeep`).
pub const fn beep(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(utils::handlefeep(zw.ed))
}

/// A builtin widget zsh has no function for (`accept-search`,
/// `execute-named-cmd`, `execute-last-named-cmd` outside the code that
/// acts on their names): `execzlefunc` beeps and succeeds.
pub const fn nullwidget(zw: &mut Zw<'_, '_>) -> WResult {
	utils::handlefeep(zw.ed);
	WResult::Done(0)
}

/// zsh `handlesuffix` (`auto-suffix-remove`, `auto-suffix-retain`):
/// nothing itself; whether the completion suffix stays is decided by the
/// widget's `ZLE_KEEPSUFFIX` flag as it runs.
pub const fn handlesuffix(_zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(0)
}

/// zsh `fixmagicspace`: the key typed is a space.
pub const fn fixmagicspace(ed: &mut Editor) {
	ed.lastchar = b' ' as i32;
	ed.lastchar_wide = Some(' ');
}

/// Whether `magic-space` expands history after inserting at a cursor
/// that is now `cs`: unless a `bang"` sequence (at the start or after a
/// backslash, where it stops history expansion) begins at least two
/// characters before the cursor. `line` is the line before the space
/// went in.
pub fn magicspace_expands(line: &[char], bang: char, cs: usize) -> bool {
	let mut q = 0;
	while q < line.len() {
		if line[q] == bang && line.get(q + 1) == Some(&'"') && (q == 0 || line[q - 1] == '\\') {
			break;
		}
		q += 1;
	}
	q + 2 > cs
}

/// Widget `magic-space` (zsh `magicspace`): insert a space, then expand
/// history on the line as `expand-history` does (zsh `doexpandhist`, its
/// result ignored).
pub fn magicspace(zw: &mut Zw<'_, '_>) -> WResult {
	fixmagicspace(zw.ed);
	let bangchar = zw
		.getsparam(b"histchars")
		.and_then(|h| h.first().copied())
		.unwrap_or(b'!');
	// zsh converts bangchar with mbrtowc: a byte that is no character
	// alone just inserts the space.
	if !bangchar.is_ascii() {
		return WResult::Done(self_insert(zw.ed));
	}
	let bang = char::from(bangchar);
	let before = zw.ed.line.clone();
	let ret = self_insert(zw.ed);
	if ret != 0 || !magicspace_expands(&before, bang, zw.ed.cs) {
		return WResult::Done(ret);
	}
	super::edit::doexpandhist(zw, Box::default(), move |_, _| WResult::Done(ret))
}

/// The message of `what-cursor-position` (zsh `whatcursorposition`).
pub fn whatcursorposition_msg(ed: &Editor) -> Vec<u8> {
	let mut s = Vec::with_capacity(80);
	let bol = utils::findbol(ed);
	match ed.line.get(ed.cs) {
		None => s.extend_from_slice(b"EOF"),
		Some(&c) => {
			s.extend_from_slice(b"Char: ");
			match c {
				' ' => s.extend_from_slice(b"SPC"),
				'\t' => s.extend_from_slice(b"TAB"),
				'\n' => s.extend_from_slice(b"LFD"),
				_ => s.extend_from_slice(&utils::zlecharasstring(c)),
			}
			let n = u32::from(c);
			s.extend_from_slice(format!(" (0{n:o}, {n}, 0x{n:x})").as_bytes());
		},
	}
	let ll = ed.line.len();
	let pct = (100 * ed.cs).checked_div(ll).unwrap_or(0);
	s.extend_from_slice(
		format!("  point {} of {}({pct}%)  column {}", ed.cs + 1, ll + 1, ed.cs - bol).as_bytes(),
	);
	s
}

/// Widget `what-cursor-position`.
pub fn whatcursorposition(zw: &mut Zw<'_, '_>) -> WResult {
	let msg = whatcursorposition_msg(zw.ed);
	utils::showmsg(zw.ed, &msg);
	WResult::Done(0)
}

#[cfg(test)]
mod tests {
	use bstr::BString;

	use super::*;
	use crate::bash::vm::zle::{Context, wflags};

	fn ed(s: &str, cs: usize) -> Editor {
		let mut e = Editor::new(Context::LineStart, 0);
		e.line = s.chars().collect();
		e.cs = cs;
		e
	}

	fn line(e: &Editor) -> String {
		e.line.iter().collect()
	}

	fn cut(zle: &Zle) -> String {
		zle.cutbuf
			.as_ref()
			.map(|c| c.buf.iter().collect())
			.unwrap_or_default()
	}

	#[test]
	fn deleting_with_counts() {
		let mut e = ed("abcdef", 2);
		e.zmod.mult = 2;
		assert_eq!(delete_char(&mut e), 0);
		assert_eq!(line(&e), "abef");
		e.zmod.mult = -1;
		assert_eq!(delete_char(&mut e), 0);
		assert_eq!(line(&e), "aef");
		assert_eq!(e.zmod.mult, -1);
		e.zmod.mult = 5;
		assert_eq!(backward_delete_char(&mut e), 0);
		assert_eq!(line(&e), "ef");
		e.cs = 1;
		e.zmod.mult = 3;
		// Fewer characters than asked: fails, cursor left at the end.
		assert_eq!(delete_char(&mut e), 1);
		assert_eq!((line(&e).as_str(), e.cs), ("ef", 2));
	}

	#[test]
	fn self_insert_and_overwrite() {
		let mut e = ed("ab", 1);
		e.lastchar = i32::from(b'x');
		assert_eq!(self_insert(&mut e), 0);
		assert_eq!(line(&e), "axb");
		e.insmode = false;
		e.lastchar_wide = Some('Y');
		assert_eq!(self_insert(&mut e), 0);
		assert_eq!(line(&e), "axY");
		e.lastchar_wide = None;
		e.lastchar = 0xe9;
		assert_eq!(self_insert(&mut e), 1);
		e.lastchar = 0x8d;
		fixunmeta(&mut e);
		assert_eq!(e.lastchar_wide, Some('\n'));
	}

	#[test]
	fn killing_lines() {
		let mut zle = Zle::new(false);
		let mut e = ed("one\ntwo\nthree", 5);
		assert_eq!(kill_line(&mut zle, &mut e), 0);
		assert_eq!(line(&e), "one\nt\nthree");
		assert_eq!(cut(&zle), "wo");
		e.lastcmd = wflags::KILL;
		assert_eq!(kill_line(&mut zle, &mut e), 0);
		assert_eq!(line(&e), "one\ntthree");
		assert_eq!(cut(&zle), "wo\n");
		assert_eq!(backward_kill_line(&mut zle, &mut e), 0);
		assert_eq!(line(&e), "one\nthree");
		assert_eq!(cut(&zle), "two\n");
		e.lastcmd = 0;
		e.zmod.mult = 1;
		e.cs = e.line.len();
		// At the very end: back onto the last line's text, which goes
		// without a newline (there is none after it).
		assert_eq!(kill_whole_line(&mut zle, &mut e), 0);
		assert_eq!((line(&e).as_str(), e.cs), ("one\n", 4));
		assert_eq!(cut(&zle), "three");
		assert_eq!(kill_buffer(&mut zle, &mut e), 0);
		assert_eq!((line(&e).as_str(), e.cs), ("", 0));
		assert_eq!(zle.kring.len(), 2);
	}

	#[test]
	fn transposing() {
		let mut e = ed("abc", 1);
		assert_eq!(transpose_chars(&mut e), 0);
		assert_eq!((line(&e).as_str(), e.cs), ("bac", 2));
		e.cs = 3;
		assert_eq!(transpose_chars(&mut e), 0);
		assert_eq!((line(&e).as_str(), e.cs), ("bca", 3));
		e.cs = 0;
		assert_eq!(transpose_chars(&mut e), 0);
		assert_eq!((line(&e).as_str(), e.cs), ("cba", 2));
		let mut e = ed("a", 1);
		assert_eq!(transpose_chars(&mut e), 1);
	}

	#[test]
	fn hold_and_break() {
		let mut zle = Zle::new(false);
		let mut e = ed("ls -l", 2);
		assert_eq!(accept_and_hold(&mut zle, &mut e), 0);
		assert!(e.done);
		assert_eq!(zle.bufstack, vec![BString::from("ls -l")]);
		assert_eq!(zle.stack_cs, Some(2));
		assert_eq!(send_break(&mut e), 1);
		assert!(e.aborted);
	}

	#[test]
	fn magic_space_and_cursor_position() {
		let l: Vec<char> = "echo !\"x".chars().collect();
		// `!"` not at the start nor after a backslash: expand.
		assert!(magicspace_expands(&l, '!', 9));
		let l: Vec<char> = "\\!\"x".chars().collect();
		assert!(!magicspace_expands(&l, '!', 5));
		assert!(magicspace_expands(&l, '!', 2));
		let e = ed("a b", 1);
		assert_eq!(
			whatcursorposition_msg(&e),
			b"Char: SPC (040, 32, 0x20)  point 2 of 4(33%)  column 1"
		);
		let e = ed("x", 1);
		assert_eq!(whatcursorposition_msg(&e), b"EOF  point 2 of 2(100%)  column 1");
	}
}
