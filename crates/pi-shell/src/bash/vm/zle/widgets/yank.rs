//! Yanking, the region and bracketed paste (zsh 5.9 `Src/Zle/zle_misc.c`:
//! `yank`, `yankpop`, `killregion`, `copyregionaskill`,
//! `bracketedpaste`).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use crate::bash::{
	syntax::zsh::tok::{metafy, unmetafy},
	vm::{
		expand::Stop,
		zle::{
			CutBuffer, Editor, Zle,
			exec::{Await, Got, WResult, Zw, then},
			modflags, to_line,
			utils::{self, KctBuf, cutflags},
			wflags,
		},
		zsh::{
			params,
			text::{Qt, QuoteOpts, quotestring},
		},
	},
	zshopt::ZshOpt,
};

/// zsh `yank`: insert the cut buffer (or the selected vi register)
/// `zmult` times, the mark before it.
pub fn do_yank(zle: &mut Zle, ed: &mut Editor) -> i32 {
	let n = ed.zmod.mult;
	if n < 0 {
		return 1;
	}
	let k = if ed.zmod.flags & modflags::VIBUF != 0 {
		KctBuf::Vi(ed.zmod.vibuf as usize)
	} else {
		KctBuf::Cut
	};
	ed.ls.kctbuf = Some(k);
	if utils::kctbuf_get(zle, k).is_none() {
		return 1;
	}
	ed.yank.0 = ed.cs;
	ed.ls.yankcs = ed.cs;
	ed.mark = ed.cs;
	if n > 0 {
		zle.kct = None;
	}
	let Some(buf) = utils::kctbuf_get(zle, k) else {
		return 1;
	};
	for _ in 0..n {
		utils::insert_at_cs(ed, &buf.buf);
		ed.yank.1 = ed.cs;
	}
	0
}

/// Widget `yank`.
pub fn yank(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(do_yank(zw.zle, zw.ed))
}

/// Whether a buffer `yank-pop` reaches is skipped: unset or empty.
fn skipped(b: Option<&CutBuffer>) -> bool {
	b.is_none_or(|b| matches!(b.buf.first(), None | Some('\0')))
}

/// zsh `yankpop`: right after a yank, replace the text yanked with the
/// next kill-ring entry (from the newest; after the oldest, the buffer
/// first yanked again).
pub fn yank_pop(zle: &mut Zle, ed: &mut Editor) -> i32 {
	let kctstart = zle.kct;
	let Some(kctbuf) = ed
		.ls
		.kctbuf
		.filter(|_| ed.lastcmd & wflags::YANK != 0 && !zle.kring.is_empty())
	else {
		ed.ls.kctbuf = None;
		return 1;
	};
	let size = zle.kring_size.max(zle.kring.len());
	loop {
		zle.kct = match zle.kct {
			None => Some(0),
			Some(i) if i + 1 >= size => None,
			Some(i) => Some(i + 1),
		};
		let buf = match zle.kct {
			None => utils::kctbuf_get(zle, kctbuf),
			Some(i) => zle.kring.get(i),
		};
		if zle.kct == kctstart {
			return 1;
		}
		if !skipped(buf) {
			break;
		}
	}
	ed.cs = ed.yank.0;
	let n = ed.yank.1.saturating_sub(ed.yank.0);
	utils::foredel(ed, n, cutflags::RAW);
	ed.cs = ed.ls.yankcs.min(ed.line.len());
	let buf = match zle.kct {
		None => utils::kctbuf_get(zle, kctbuf),
		Some(i) => zle.kring.get(i),
	};
	if let Some(buf) = buf {
		utils::pastebuf(ed, buf, 1, u8::from(ed.lastcmd & wflags::YANKAFTER != 0));
	}
	0
}

/// Widget `yank-pop`.
pub fn yankpop(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(yank_pop(zw.zle, zw.ed))
}

/// zsh `regionlines`: the start of the first and the end of the last
/// line the region touches.
pub fn regionlines(ed: &Editor) -> (usize, usize) {
	if ed.cs < ed.mark {
		let start = utils::findbol(ed);
		let end = utils::findeol_at(&ed.line, ed.mark.min(ed.line.len()));
		(start, end)
	} else {
		let end = utils::findeol(ed);
		let start = utils::findbol_at(&ed.line, ed.mark);
		(start, end)
	}
}

/// zsh `killregion`: kill the text between the cursor and the mark
/// (whole lines with a line-wise region; including the character under
/// the cursor or mark in vi command mode).
pub fn kill_region(zle: &mut Zle, ed: &mut Editor) -> i32 {
	if ed.mark > ed.line.len() {
		ed.mark = ed.line.len();
	}
	if ed.region_active == 2 {
		let (a, b) = regionlines(ed);
		ed.cs = a;
		ed.region_active = 0;
		utils::cut(zle, ed, a, b - a, cutflags::RAW);
		utils::shiftchars(ed, a, b - a);
		if !ed.line.is_empty() {
			if ed.cs == ed.line.len() {
				utils::deccs(ed);
			}
			utils::foredel(ed, 1, 0);
			utils::vifirstnonblank(ed);
		}
	} else if ed.mark > ed.cs {
		if utils::invicmdmode(ed) {
			let mut m = ed.mark;
			utils::incpos(ed, &mut m);
			ed.mark = m;
		}
		let ct = ed.mark - ed.cs;
		utils::forekill(zle, ed, ct, cutflags::RAW);
	} else {
		if utils::invicmdmode(ed) {
			utils::inccs(ed);
		}
		let ct = ed.cs.saturating_sub(ed.mark);
		utils::backkill(zle, ed, ct, cutflags::FRONT | cutflags::RAW);
	}
	0
}

/// Widget `kill-region`.
pub fn killregion(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(kill_region(zw.zle, zw.ed))
}

/// zsh `copyregionaskill`: put the region into the cut buffer without
/// removing it; with an argument, that text replaces the cut buffer.
pub fn copy_region_as_kill(zle: &mut Zle, ed: &mut Editor, arg: Option<&[u8]>) -> i32 {
	if let Some(arg) = arg {
		let line = to_line(arg);
		utils::cuttext(zle, ed, &line, cutflags::REPLACE);
		return 0;
	}
	if ed.mark > ed.line.len() {
		ed.mark = ed.line.len();
	}
	let (start, mut end) = if ed.mark > ed.cs {
		(ed.cs, ed.mark)
	} else {
		(ed.mark, ed.cs)
	};
	if utils::invicmdmode(ed) {
		utils::incpos(ed, &mut end);
	}
	let flags = if ed.mark > ed.cs { 0 } else { cutflags::FRONT };
	utils::cut(zle, ed, start, end - start, flags);
	0
}

/// Widget `copy-region-as-kill` (`zle copy-region-as-kill text`).
pub fn copyregionaskill(zw: &mut Zw<'_, '_>) -> WResult {
	let args = zw.args;
	WResult::Done(copy_region_as_kill(zw.zle, zw.ed, args.first().map(|a| a.as_slice())))
}

/// The sequence that ends a bracketed paste.
const ENDESC: &[u8] = b"\x1b[201~";

/// zsh `bracketedstring` as it goes: the bytes pasted so far and how
/// much of [`ENDESC`] they end with.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Paste {
	/// The text (a carriage return stored as a newline).
	pub buf:    Vec<u8>,
	/// zsh `endpos`.
	pub endpos: usize,
}

impl Paste {
	/// Take byte `next`; `true` once the end sequence is complete.
	pub fn push(&mut self, next: u8) -> bool {
		self.endpos = if self.endpos != 0 && next == ENDESC[self.endpos] {
			self.endpos + 1
		} else {
			usize::from(next == ENDESC[0])
		};
		self.buf.push(if next == b'\r' { b'\n' } else { next });
		self.endpos == ENDESC.len()
	}

	/// The pasted text, without the part of the end sequence read.
	pub fn finish(mut self) -> Vec<u8> {
		let n = self.buf.len() - self.endpos;
		self.buf.truncate(n);
		self.buf
	}
}

/// Read the paste character by character until the end sequence or end
/// of input, then run `done` with the text (zsh reads bytes with
/// `KEYTIMEOUT` applying between them; the core's character reads wait
/// for each character).
fn read_paste(p: Paste, done: fn(&mut Zw<'_, '_>, Vec<u8>) -> WResult) -> WResult {
	then(Await::Char, move |zw, got| {
		let mut p = p;
		let Got::Char(Some(c)) = got else {
			return done(zw, p.finish());
		};
		for b in utils::zlecharasstring(c) {
			if p.push(b) {
				return done(zw, p.finish());
			}
		}
		read_paste(p, done)
	})
}

/// zsh `bracketedpaste` once the text is read: assign it to the
/// parameter given as argument, or insert it as a yank (quoted with
/// `(q-)` when a numeric argument other than 1 was given), replacing an
/// active region; the text also replaces the cut buffer.
fn paste_text(zw: &mut Zw<'_, '_>, pbuf: Vec<u8>) -> WResult {
	if let Some(name) = zw.args.first() {
		let name = name.clone();
		return match zw.params(|ex| params::assignsparam(ex, &name, &pbuf, params::ASSPM_WARN)) {
			Ok(()) => WResult::Done(0),
			Err(Stop::Store(e)) => {
				zw.fail(e);
				WResult::Done(1)
			},
			Err(Stop::Fail(d) | Stop::Fatal(d)) => {
				zw.k.diag(zw.cx, zw.vp, 0, d);
				WResult::Done(1)
			},
			Err(_) => WResult::Done(1),
		};
	}
	let text = if zw.ed.zmod.mult == 1 {
		pbuf
	} else {
		let (bang, bang_special) = params::bang_quoting(&mut zw.k.root, zw.cx.store, zw.vp);
		let o = QuoteOpts {
			rcquotes: zw.isset(ZshOpt::Rcquotes),
			magic_equal_subst: zw.isset(ZshOpt::Magicequalsubst),
			extended_glob: zw.isset(ZshOpt::Extendedglob),
			bang,
			bang_special,
			mb: params::mb_quiet(zw.k, zw.cx.store, zw.vp),
		};
		unmetafy(&quotestring(&metafy(&pbuf), Qt::SingleOptional, o))
	};
	let wpaste = to_line(&text);
	paste_insert(zw.zle, zw.ed, &wpaste);
	WResult::Done(0)
}

/// The insertion part of `bracketed-paste`: `wpaste` replaces the cut
/// buffer and, without a vi register selected, is inserted as a yank
/// (over an active region).
pub fn paste_insert(zle: &mut Zle, ed: &mut Editor, wpaste: &[char]) {
	utils::cuttext(zle, ed, wpaste, cutflags::REPLACE);
	if ed.zmod.flags & modflags::VIBUF == 0 {
		zle.kct = None;
		ed.ls.kctbuf = Some(KctBuf::Cut);
		ed.zmod.mult = 1;
		if ed.region_active != 0 {
			kill_region(zle, ed);
		}
		ed.ls.yankcs = ed.cs;
		ed.yank.0 = ed.cs;
		utils::doinsert(ed, wpaste);
		ed.yank.1 = ed.cs;
	}
}

/// Widget `bracketed-paste` (`zle bracketed-paste [param]`): the text the
/// terminal sends between `\e[200~` (the key) and `\e[201~`.
pub fn bracketedpaste(_zw: &mut Zw<'_, '_>) -> WResult {
	read_paste(Paste::default(), paste_text)
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

	fn line(e: &Editor) -> String {
		e.line.iter().collect()
	}

	fn cb(s: &str) -> CutBuffer {
		CutBuffer { buf: s.chars().collect(), flags: 0 }
	}

	#[test]
	fn yank_and_pop_cycle_the_ring() {
		let mut zle = Zle::new(false);
		assert_eq!(do_yank(&mut zle, &mut ed("", 0)), 1);
		zle.cutbuf = Some(cb("C"));
		zle.kring = [cb("K1"), cb(""), cb("K3")].into_iter().collect();
		zle.kring_size = 4;
		let mut e = ed("ab", 1);
		assert_eq!(do_yank(&mut zle, &mut e), 0);
		assert_eq!((line(&e).as_str(), e.yank, e.mark), ("aCb", (1, 2), 1));
		e.lastcmd = wflags::YANKBEFORE;
		assert_eq!(yank_pop(&mut zle, &mut e), 0);
		assert_eq!((line(&e).as_str(), e.yank), ("aK1b", (1, 3)));
		// The empty entry and the unset fourth slot are skipped.
		assert_eq!(yank_pop(&mut zle, &mut e), 0);
		assert_eq!(line(&e), "aK3b");
		assert_eq!(yank_pop(&mut zle, &mut e), 0);
		assert_eq!(line(&e), "aCb");
		e.lastcmd = 0;
		assert_eq!(yank_pop(&mut zle, &mut e), 1);
	}

	#[test]
	fn regions() {
		let mut zle = Zle::new(false);
		let mut e = ed("hello world", 2);
		e.mark = 8;
		assert_eq!(copy_region_as_kill(&mut zle, &mut e, None), 0);
		assert_eq!(
			zle.cutbuf
				.as_ref()
				.map(|c| c.buf.iter().collect::<String>()),
			Some("llo wo".into())
		);
		assert_eq!(kill_region(&mut zle, &mut e), 0);
		assert_eq!((line(&e).as_str(), e.cs), ("herld", 2));
		let mut e = ed("one\ntwo\nthree", 5);
		e.mark = 9;
		e.region_active = 2;
		// Whole lines go, then the newline before them; the cursor ends
		// on the first non-blank.
		assert_eq!(kill_region(&mut zle, &mut e), 0);
		assert_eq!((line(&e).as_str(), e.cs), ("one", 0));
		assert_eq!(
			zle.cutbuf
				.as_ref()
				.map(|c| c.buf.iter().collect::<String>()),
			Some("two\nthree".into())
		);
		assert_eq!(copy_region_as_kill(&mut zle, &mut e, Some(b"new")), 0);
		assert_eq!(
			zle.cutbuf
				.as_ref()
				.map(|c| c.buf.iter().collect::<String>()),
			Some("new".into())
		);
	}

	#[test]
	fn paste_reading_and_inserting() {
		let mut p = Paste::default();
		let mut done = false;
		for &b in b"a\rb\x1b[2x\x1b[201~" {
			done = p.push(b);
		}
		assert!(done);
		assert_eq!(p.finish(), b"a\nb\x1b[2x");
		let mut p = Paste::default();
		for &b in b"ab\x1b[20" {
			p.push(b);
		}
		assert_eq!(p.finish(), b"ab");
		let mut zle = Zle::new(false);
		let mut e = ed("xy", 1);
		e.mark = 0;
		e.region_active = 1;
		paste_insert(&mut zle, &mut e, &['p', 'q']);
		assert_eq!((line(&e).as_str(), e.yank), ("pqy", (0, 2)));
	}
}
