//! The buffer stack widgets (zsh 5.9 `Src/Zle/zle_hist.c`: `pushline`,
//! `pushlineoredit`, `pushinput`, `zgetline`). The stack is
//! [`Zle::bufstack`] (top last); `zleread` starts the next line with its
//! top.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::BString;

use crate::bash::vm::zle::{
	Editor, Zle,
	exec::{WResult, Zw},
	from_line, to_line, utils,
};

/// zsh `pushline`: push the line onto the buffer stack (with `zmult - 1`
/// empty lines above it) and clear it; the next line starts with it.
///
/// zsh's `while (--n)` would push about 2^32 empty lines for a count of
/// 0; a count of 0 pushes the line alone.
pub fn push_line(zle: &mut Zle, ed: &mut Editor) -> i32 {
	let n = ed.zmod.mult;
	if n < 0 {
		return 1;
	}
	zle.bufstack.push(from_line(&ed.line));
	for _ in 1..n {
		zle.bufstack.push(BString::default());
	}
	if utils::invicmdmode(ed) {
		utils::inccs(ed);
	}
	zle.stack_cs = Some(ed.cs);
	ed.line.clear();
	ed.cs = 0;
	ed.clearlist = true;
	0
}

/// Widget `push-line`.
pub fn pushline(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(push_line(zw.zle, zw.ed))
}

/// zsh `pushlineoredit`: on a continuation line, put the earlier lines
/// of the command ([`Editor::hline`], zsh `hgetline`) in front of the
/// buffer, push it all and abandon the command so it is edited as one
/// line; on a first line, `push-line`.
pub fn push_line_or_edit(zle: &mut Zle, ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		return 1;
	}
	if let Some(hline) = ed.hline.take().filter(|h| !h.is_empty()) {
		let zh = to_line(&hline);
		let ics = zh.len();
		drop(ed.line.splice(0..0, zh));
		ed.cs += ics;
	}
	let ret = push_line(zle, ed);
	if !ed.isfirstln {
		ed.aborted = true;
		ed.done = true;
	}
	ed.clearlist = true;
	ret
}

/// Widget `push-line-or-edit`.
pub fn pushlineoredit(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(push_line_or_edit(zw.zle, zw.ed))
}

/// zsh `pushinput`: `push-line-or-edit`, with one more empty line pushed
/// on a continuation line.
pub fn push_input(zle: &mut Zle, ed: &mut Editor) -> i32 {
	if ed.zmod.mult < 0 {
		return 1;
	}
	let i = i64::from(!ed.isfirstln);
	ed.zmod.mult += i;
	let ret = push_line_or_edit(zle, ed);
	ed.zmod.mult -= i;
	ret
}

/// Widget `push-input`.
pub fn pushinput(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(push_input(zw.zle, zw.ed))
}

/// zsh `zgetline`: pop the top of the buffer stack into the line at the
/// cursor; 1 when the stack is empty.
pub fn get_line(zle: &mut Zle, ed: &mut Editor) -> i32 {
	let Some(s) = zle.bufstack.pop() else {
		return 1;
	};
	let lineadd = to_line(&s);
	utils::insert_at_cs(ed, &lineadd);
	ed.clearlist = true;
	zle.stack_hist = None;
	0
}

/// Widget `get-line`.
pub fn zgetline(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(get_line(zw.zle, zw.ed))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::vm::zle::Context;

	fn ed(s: &str, cs: usize, context: Context) -> Editor {
		let mut e = Editor::new(context, 0);
		e.line = s.chars().collect();
		e.cs = cs;
		e
	}

	#[test]
	fn push_and_get() {
		let mut zle = Zle::new(false);
		let mut e = ed("echo hi", 4, Context::LineStart);
		e.zmod.mult = 2;
		assert_eq!(push_line(&mut zle, &mut e), 0);
		assert_eq!(zle.bufstack, vec![BString::from("echo hi"), BString::default()]);
		assert_eq!((e.line.len(), e.cs, zle.stack_cs), (0, 0, Some(4)));
		assert_eq!(get_line(&mut zle, &mut e), 0);
		assert_eq!(get_line(&mut zle, &mut e), 0);
		assert_eq!(e.line.iter().collect::<String>(), "echo hi");
		assert_eq!(get_line(&mut zle, &mut e), 1);
	}

	#[test]
	fn push_input_on_a_continuation_line() {
		let mut zle = Zle::new(false);
		let mut e = ed("done", 4, Context::LineCont);
		e.hline = Some(BString::from("for i in 1; do\n"));
		assert_eq!(push_input(&mut zle, &mut e), 0);
		assert_eq!(zle.bufstack, vec![BString::from("for i in 1; do\ndone"), BString::default()]);
		assert_eq!(zle.stack_cs, Some(19));
		assert!(e.done && e.aborted);
		assert_eq!(e.zmod.mult, 1);
	}
}
