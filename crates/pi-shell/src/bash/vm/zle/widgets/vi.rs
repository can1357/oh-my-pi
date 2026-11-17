//! vi mode (zsh 5.9 `Src/Zle/zle_vi.c`): change recording for
//! `vi-repeat-change`, entering insert mode, the operators and the range
//! they read (`getvirange`, the `viopp` keymap), and the hooks the core
//! calls around every widget and at the start of each line.
//!
//! zsh records the bytes of a vi change as they are read (`getbyte`) while
//! `vichgflag` is set: 2 from the operator's `startvichange` until the
//! widget that started it returns, then 1 while the change goes on in
//! insert mode, until `vi-cmd-mode` makes it the last change.
//! `vi-repeat-change` feeds those bytes back as input with `viinrepeat`
//! set (3 until the first replayed widget starts, then 2, then 1 while
//! the replay inserts text), so the replayed widgets take the recorded
//! modifier instead of starting a new change.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::BString;

use super::yank;
use crate::bash::vm::zle::{
	Editor, Modifier, Zle,
	exec::{self, Await, Got, WResult, Zw, then},
	keymap::{Bind, Keymaps},
	modflags,
	utils::{self, cutflags, invicmdmode},
};

/// zsh `struct vichange`: a vi change as typed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ViChange {
	/// The modifier (count, register) the change started with.
	pub zmod: Modifier,
	/// The bytes of its keys (raw, as read).
	pub buf:  Vec<u8>,
}

/// The vi state zsh keeps in globals ([`Zle::vi`]): what outlives a
/// line (the last change, marks, the last find) and the change being
/// recorded.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct ViState {
	/// zsh `lastvichg`: the change `vi-repeat-change` repeats (`None`:
	/// zsh's `lastvichg.buf == NULL`).
	pub lastvichg:  Option<ViChange>,
	/// zsh `curvichg`: the change being recorded.
	pub curvichg:   Option<ViChange>,
	/// zsh `vichgflag`: 2 while the widget starting a change runs, 1
	/// while the change goes on in insert mode, 0 otherwise.
	pub vichgflag:  u8,
	/// zsh `viinrepeat`: 3 when `vi-repeat-change` fed its keys back, 2
	/// while the first replayed widget runs, 1 while the replay inserts.
	pub viinrepeat: u8,
	/// zsh `vfindchar`: the character the last find looked for (`None`:
	/// none could be read).
	pub vfindchar:  Option<char>,
	/// zsh `vfinddir`: the last find's direction (0: none yet).
	pub vfinddir:   i8,
	/// zsh `tailadd`: where the last find stops relative to the
	/// character (`t`/`T`).
	pub tailadd:    i8,
	/// zsh `vimarkcs`: the cursor of marks `a`–`z` and (index 26) the
	/// position before the last mark jump.
	pub vimarkcs:   [usize; 27],
	/// zsh `vimarkline`: their history lines (0: unset).
	pub vimarkline: [i64; 27],
}

/// zsh's `mark == -1` while an operator reads its motion: no motion has
/// set the mark (`$MARK` reads -1). Far from the line, so that line
/// edits a rejected motion makes cannot reach it.
pub const NOMARK: usize = usize::MAX / 2;

/// The character at `i`, zsh's terminating NUL past the end.
pub(super) fn at(line: &[char], i: usize) -> char {
	line.get(i).copied().unwrap_or('\0')
}

// ---- core hooks -------------------------------------------------------------

/// A byte read from the terminal or the input pushed back (zsh
/// `getbyte`): recorded while a vi change is.
pub fn record_byte(zle: &mut Zle, b: u8) {
	if zle.vi.vichgflag != 0
		&& let Some(c) = zle.vi.curvichg.as_mut()
	{
		c.buf.push(b);
	}
}

/// `n` bytes of a key sequence given back to the input (zsh
/// `getkeymapcmd`): no longer part of the change being recorded.
pub fn unrecord_bytes(zle: &mut Zle, n: usize) {
	if zle.vi.vichgflag != 0
		&& let Some(c) = zle.vi.curvichg.as_mut()
	{
		let keep = c.buf.len().saturating_sub(n);
		c.buf.truncate(keep);
	}
}

/// The start of zsh `execzlefunc`: whether a change is already being
/// recorded (`nestedvichg`) and whether this widget starts a repeat
/// (`isrepeat`).
pub const fn exec_begin(zle: &mut Zle) -> (bool, bool) {
	let vi = &mut zle.vi;
	let nested = vi.vichgflag != 0;
	let isrepeat = vi.viinrepeat == 3;
	if isrepeat {
		vi.viinrepeat = 2;
	}
	(nested, isrepeat)
}

/// The end of zsh `execzlefunc`: a widget that started a change ends it
/// (kept as the last change when it succeeded) unless it left the editor
/// in insert mode, where the change goes on.
pub fn exec_end(zle: &mut Zle, ed: &Editor, ret: i32, nested: bool, isrepeat: bool) {
	let vi = &mut zle.vi;
	if vi.vichgflag == 2 && !nested {
		if invicmdmode(ed) {
			let cur = vi.curvichg.take();
			if ret == 0 {
				vi.lastvichg = cur;
			}
			vi.vichgflag = 0;
		} else {
			vi.vichgflag = 1;
		}
	}
	if isrepeat {
		vi.viinrepeat = u8::from(!invicmdmode(ed));
	}
}

/// What zsh `zleread` does for vi before the line's first key: no change
/// or repeat in progress, and when `main` is `viins`, insert mode entered
/// as if by a key (zsh `viinsert_init`), so that `vi-repeat-change`
/// repeats the text typed first.
pub fn line_init(zle: &mut Zle, ed: &mut Editor) {
	zle.vi.vichgflag = 0;
	zle.vi.viinrepeat = 0;
	ed.ls.viinsbegin = 0;
	ed.ls.virangeflag = false;
	if zle.keymaps.same(b"main", b"viins") {
		startvitext(&mut zle.vi, &zle.keymaps, ed, -2);
	}
}

// ---- starting changes -------------------------------------------------------

/// zsh `startvichange(im)`: `im` >= 0 sets insert (1) or overwrite (0)
/// mode, -1 leaves it, -2 is the line start (a change synthesised from
/// the line as it is). In a repeat, the recorded modifier comes back;
/// otherwise a new change starts recording with the keys of the widget
/// running.
pub fn startvichange(vi: &mut ViState, ed: &mut Editor, im: i32) {
	if im > -1 {
		ed.insmode = im != 0;
	}
	if vi.viinrepeat != 0 && im != -2 {
		if let Some(last) = &vi.lastvichg {
			ed.zmod = last.zmod;
		}
		vi.vichgflag = 0;
	} else if vi.vichgflag == 0 {
		let mut buf = Vec::with_capacity(16 + ed.keybuf.len());
		if im == -2 {
			vi.vichgflag = 1;
			buf.push(if ed.line.is_empty() {
				b'o'
			} else if !ed.insmode {
				b'R'
			} else if ed.cs < ed.line.len() {
				b'i'
			} else {
				b'a'
			});
		} else {
			vi.vichgflag = 2;
			buf.extend_from_slice(&ed.keybuf);
		}
		vi.curvichg = Some(ViChange { zmod: ed.zmod, buf });
	}
}

/// zsh `startvitext(im)`: start a change and enter insert mode (`main`)
/// with the insertion starting at the cursor.
pub fn startvitext(vi: &mut ViState, km: &Keymaps, ed: &mut Editor, im: i32) {
	startvichange(vi, ed, im);
	let _ = exec::selectkeymap(km, ed, b"main", true);
	ed.undo.vistartchange = ed.undo.changeno;
	ed.ls.viinsbegin = ed.cs;
}

/// [`startvichange`] for a widget.
pub(super) fn vichange(zw: &mut Zw<'_, '_>, im: i32) {
	startvichange(&mut zw.zle.vi, zw.ed, im);
}

/// [`startvitext`] for a widget.
pub(super) fn vitext(zw: &mut Zw<'_, '_>, im: i32) {
	startvitext(&mut zw.zle.vi, &zw.zle.keymaps, zw.ed, im);
}

/// zsh `vigetkey`: the character for `r`, `f` and friends, read with the
/// `main` keymap deciding: a key bound to `vi-cmd-mode` or `send-break`
/// (or a prefix with no binding) is end of input (`None`), one bound to
/// `quoted-insert`/`vi-quoted-insert` quotes the next character.
pub(super) fn vigetkey<F>(next: F) -> WResult
where
	F: FnOnce(&mut Zw<'_, '_>, Option<char>) -> WResult + Send + 'static,
{
	then(Await::Char, move |zw, got| {
		let Got::Char(Some(c)) = got else {
			return next(zw, None);
		};
		let lead = utils::zlecharasstring(c)[0];
		let km = &zw.zle.keymaps;
		let cmd: Option<BString> = match km.lookup(b"main", &[lead]) {
			Some(Bind::Widget(w)) => Some(w.clone()),
			Some(Bind::Str(_)) => Some(BString::from("undefined-key")),
			None if km.is_prefix(b"main", &[lead]) => None,
			None => Some(BString::from("undefined-key")),
		};
		match cmd.as_ref().map(|c| c.as_slice()) {
			None | Some(b"send-break" | b"vi-cmd-mode") => next(zw, None),
			Some(b"quoted-insert") => then(Await::Char, move |zw, got| match got {
				Got::Char(Some(c)) => next(zw, Some(c)),
				_ => next(zw, None),
			}),
			Some(b"vi-quoted-insert") => {
				// zsh writes `^` over the character under the cursor (at the
				// end, over the NUL the display does not show) and redraws.
				let cs = zw.ed.cs;
				let sav = zw.ed.line.get(cs).copied();
				if let Some(slot) = zw.ed.line.get_mut(cs) {
					*slot = '^';
				}
				then(Await::Refresh, move |_, _| {
					then(Await::Char, move |zw, got| {
						if let (Some(s), Some(slot)) = (sav, zw.ed.line.get_mut(cs)) {
							*slot = s;
						}
						match got {
							Got::Char(Some(c)) => next(zw, Some(c)),
							_ => next(zw, None),
						}
					})
				})
			},
			Some(_) => next(zw, Some(c)),
		}
	})
}

// ---- ranges -----------------------------------------------------------------

/// The continuation of [`getvirange`]: the end of the range (the cursor
/// at its start), `None` when there is none.
type RangeNext = Box<dyn FnOnce(&mut Zw<'_, '_>, Option<usize>) -> WResult + Send>;

/// What [`getvirange`] keeps while its motion runs.
struct Range {
	pos:    usize,
	mpos:   usize,
	visual: u8,
	mult1:  i64,
	hist1:  i64,
	/// zsh `ret == -1`: the motion failed.
	failed: bool,
	/// zsh `virangeflag == 2`: a line count (`dd`, `3yy`) made the range.
	lines:  bool,
}

/// zsh `getvirange(wf)`: the range an operator acts on. With an active
/// region, the region; otherwise the motion read next (in the `viopp`
/// keymap, counts multiplied, the operator's own key repeated meaning
/// lines), which must not change the line. `wf` is zsh's `wordflag`
/// (`cw`: word motions stop at the end of the word). `next` gets the end
/// of the range with the cursor at its start, line-wise ranges extended
/// to whole lines (without the last newline).
pub(super) fn getvirange<F>(zw: &mut Zw<'_, '_>, wf: bool, next: F) -> WResult
where
	F: FnOnce(&mut Zw<'_, '_>, Option<usize>) -> WResult + Send + 'static,
{
	let ed = &mut *zw.ed;
	let mut r = Range {
		pos:    ed.cs,
		mpos:   ed.mark,
		visual: ed.region_active,
		mult1:  ed.zmod.mult,
		hist1:  ed.histline,
		failed: false,
		lines:  false,
	};
	if r.visual != 0 {
		if ed.line.is_empty() {
			return next(zw, None);
		}
		r.pos = ed.mark;
		ed.ls.vilinerange = r.visual == 2;
		ed.region_active = 0;
		let end = range_end(zw.ed, &r);
		return next(zw, Some(end));
	}
	ed.ls.virangeflag = true;
	ed.ls.wordflag = wf;
	ed.mark = NOMARK;
	if zw.zle.keymaps.exists(b"viopp") {
		ed.localkeymap = Some(BString::from("viopp"));
	}
	ed.zmod.flags &= !modflags::TMULT;
	ed.ls.vilinerange = false;
	ed.prefixflag = false;
	range_key(r, Box::new(next))
}

/// One key of [`getvirange`]'s motion loop.
fn range_key(r: Range, next: RangeNext) -> WResult {
	then(Await::Key, move |zw, got| {
		let name = match got {
			Got::Key(Some(n)) if zw.zle.widgets.exists(&n) && n.as_slice() != b"send-break" => n,
			_ => {
				let ed = &mut *zw.ed;
				ed.ls.wordflag = false;
				ed.ls.virangeflag = false;
				ed.mark = r.mpos;
				return next(zw, None);
			},
		};
		if zw.ed.bindk.as_ref() == Some(&name) {
			let mut r = r;
			if dovilinerange(zw.ed, &mut r) {
				r.failed = true;
			}
			return range_after(zw, r, next);
		}
		// zsh `execzlefunc(k2, zlenoargs, 1, 0)`: `$WIDGET` is the motion
		// while it runs.
		let saved = zw.ed.bindk.replace(name.clone());
		then(Await::Widget { name, args: Vec::new() }, move |zw, got| {
			zw.ed.bindk = saved;
			let mut r = r;
			if !matches!(got, Got::Status(0)) {
				r.failed = true;
			}
			range_after(zw, r, next)
		})
	})
}

/// The rest of [`getvirange`] after a motion ran: another key after a
/// prefix (a count, `v`/`V`), else checks and the range.
fn range_after(zw: &mut Zw<'_, '_>, r: Range, next: RangeNext) -> WResult {
	{
		let ed = &mut *zw.ed;
		let vi = &mut zw.zle.vi;
		if vi.viinrepeat != 0 {
			ed.zmod.mult = r.mult1;
		} else {
			ed.zmod.mult = r.mult1.wrapping_mul(ed.zmod.tmult);
			if vi.vichgflag == 2
				&& let Some(c) = vi.curvichg.as_mut()
			{
				c.zmod.mult = ed.zmod.mult;
			}
		}
	}
	if zw.ed.prefixflag && !r.failed {
		zw.ed.ls.vilinerange = false;
		zw.ed.prefixflag = false;
		return range_key(r, next);
	}
	let mut r = r;
	let ed = &mut *zw.ed;
	ed.ls.wordflag = false;
	ed.localkeymap = None;
	// A motion that changed the line or the history line is no motion.
	if ed.histline != r.hist1 || ed.line != ed.undo.lastline {
		ed.histline = r.hist1;
		ed.line.clone_from(&ed.undo.lastline);
		ed.cs = r.pos.min(ed.line.len());
		ed.mark = r.mpos;
		ed.ls.virangeflag = false;
		return next(zw, None);
	}
	// Nor is one that failed or did not move (an empty line has no range).
	if ed.line.is_empty()
		|| (ed.cs == r.pos && (ed.mark == NOMARK || ed.mark == ed.cs) && !r.lines)
		|| r.failed
	{
		ed.mark = r.mpos;
		ed.ls.virangeflag = false;
		return next(zw, None);
	}
	ed.ls.virangeflag = false;
	if ed.mark != NOMARK {
		r.pos = ed.mark;
	}
	let end = range_end(ed, &r);
	next(zw, Some(end))
}

/// The common end of [`getvirange`]: the mark back, the range the right
/// way round, line-wise ranges made whole lines.
fn range_end(ed: &mut Editor, r: &Range) -> usize {
	let mut pos = r.pos;
	ed.mark = r.mpos;
	if ed.cs > pos {
		std::mem::swap(&mut ed.cs, &mut pos);
	}
	// A character-wise selection includes the character at its end.
	if r.visual == 1 && pos < ed.line.len() && invicmdmode(ed) {
		utils::incpos(ed, &mut pos);
	}
	ed.ls.vilinerange = ed.zmod.flags & modflags::LINE != 0
		|| (ed.ls.vilinerange && ed.zmod.flags & modflags::CHAR == 0);
	if ed.ls.vilinerange {
		let newcs = utils::findbol(ed);
		ed.ls.lastcol = i64::try_from(ed.cs - newcs).unwrap_or(i64::MAX);
		ed.cs = pos;
		pos = utils::findeol(ed);
		ed.cs = newcs;
	} else if r.visual == 0 {
		// A character-wise motion does not take the newline it ends at.
		let mut prev = pos;
		utils::decpos(ed, &mut prev);
		if at(&ed.line, prev) == '\n' {
			pos = prev;
		}
	}
	pos
}

/// zsh `dovilinerange`: the operator's key again (`dd`): `zmult` lines
/// from the cursor's (up for a negative count). `true` when there are
/// not that many.
fn dovilinerange(ed: &mut Editor, r: &mut Range) -> bool {
	let pos = ed.cs;
	let mut n = ed.zmod.mult;
	ed.ls.vilinerange = true;
	if n == 0 {
		return true;
	}
	// zsh's cursor goes one past either end of the buffer here.
	let len = i64::try_from(ed.line.len()).unwrap_or(i64::MAX);
	let mut cs = i64::try_from(ed.cs).unwrap_or(i64::MAX);
	let pos_of = |line: &[char], cs: i64| usize::try_from(cs).unwrap_or(0).min(line.len());
	if n > 0 {
		while n > 0 && cs <= len {
			n -= 1;
			cs = i64::try_from(utils::findeol_at(&ed.line, pos_of(&ed.line, cs))).unwrap_or(i64::MAX)
				+ 1;
		}
		if n != 0 {
			ed.cs = pos;
			return true;
		}
		// zsh's `DECCS()` from one past the end of the last line.
		ed.cs = pos_of(&ed.line, cs);
		if cs > len {
			ed.cs = ed.line.len();
		} else {
			utils::deccs(ed);
		}
	} else {
		while n < 0 && cs >= 0 {
			n += 1;
			cs = i64::try_from(utils::findbol_at(&ed.line, pos_of(&ed.line, cs))).unwrap_or(0) - 1;
		}
		if n != 0 {
			ed.cs = pos;
			return true;
		}
		ed.cs = pos_of(&ed.line, cs.max(0));
		if cs >= 0 {
			utils::inccs(ed);
		}
	}
	r.lines = true;
	false
}

// ---- insert mode ------------------------------------------------------------

/// Widget `vi-add-next` (zsh `viaddnext`): insert after the cursor.
pub fn viaddnext(zw: &mut Zw<'_, '_>) -> WResult {
	if zw.ed.cs != utils::findeol(zw.ed) {
		utils::inccs(zw.ed);
	}
	vitext(zw, 1);
	WResult::Done(0)
}

/// Widget `vi-add-eol` (zsh `viaddeol`): insert at the end of the line.
pub fn viaddeol(zw: &mut Zw<'_, '_>) -> WResult {
	zw.ed.cs = utils::findeol(zw.ed);
	vitext(zw, 1);
	WResult::Done(0)
}

/// Widget `vi-insert` (zsh `viinsert`).
pub fn viinsert(zw: &mut Zw<'_, '_>) -> WResult {
	vitext(zw, 1);
	WResult::Done(0)
}

/// Widget `vi-insert-bol` (zsh `viinsertbol`): insert at the first
/// non-blank of the line.
pub fn viinsertbol(zw: &mut Zw<'_, '_>) -> WResult {
	utils::vifirstnonblank(zw.ed);
	vitext(zw, 1);
	WResult::Done(0)
}

/// Widget `vi-replace` (zsh `vireplace`): overwrite mode.
pub fn vireplace(zw: &mut Zw<'_, '_>) -> WResult {
	vitext(zw, 0);
	WResult::Done(0)
}

/// Widget `vi-open-line-below` (zsh `viopenlinebelow`).
pub fn viopenlinebelow(zw: &mut Zw<'_, '_>) -> WResult {
	let ed = &mut *zw.ed;
	ed.cs = utils::findeol(ed);
	utils::insert_at_cs(ed, &['\n']);
	vitext(zw, 1);
	zw.ed.clearlist = true;
	WResult::Done(0)
}

/// Widget `vi-open-line-above` (zsh `viopenlineabove`).
pub fn viopenlineabove(zw: &mut Zw<'_, '_>) -> WResult {
	let ed = &mut *zw.ed;
	ed.cs = utils::findbol(ed);
	utils::spaceinline(ed, 1);
	ed.line[ed.cs] = '\n';
	vitext(zw, 1);
	zw.ed.clearlist = true;
	WResult::Done(0)
}

/// Widget `vi-cmd-mode` (zsh `vicmdmode`): leave insert mode; the change
/// typed there becomes the last change, its edits one undo step.
pub fn vicmdmode(zw: &mut Zw<'_, '_>) -> WResult {
	if invicmdmode(zw.ed) || exec::selectkeymap(&zw.zle.keymaps, zw.ed, b"vicmd", false).is_err() {
		return WResult::Done(1);
	}
	crate::bash::vm::zle::undo::mergeundo(zw.ed);
	let overstrike = zw.isset(crate::bash::zshopt::ZshOpt::Overstrike);
	zw.ed.insmode = !overstrike;
	let vi = &mut zw.zle.vi;
	if vi.vichgflag == 1 {
		vi.vichgflag = 0;
		vi.lastvichg = vi.curvichg.take();
	}
	if vi.viinrepeat == 1 {
		vi.viinrepeat = 0;
	}
	if zw.ed.cs != utils::findbol(zw.ed) {
		utils::deccs(zw.ed);
	}
	WResult::Done(0)
}

// ---- operators --------------------------------------------------------------

/// Widget `vi-delete` (zsh `videlete`): delete the range; whole lines
/// take their newline with them.
pub fn videlete(zw: &mut Zw<'_, '_>) -> WResult {
	vichange(zw, 1);
	getvirange(zw, false, |zw, c2| {
		let Some(c2) = c2 else {
			return WResult::Done(1);
		};
		let ed = &mut *zw.ed;
		let ct = c2 - ed.cs;
		utils::forekill(zw.zle, ed, ct, cutflags::RAW);
		if ed.ls.vilinerange && !ed.line.is_empty() {
			ed.ls.lastcol = -1;
			if ed.cs == ed.line.len() {
				utils::deccs(ed);
			}
			utils::foredel(ed, 1, 0);
			utils::vifirstnonblank(ed);
		}
		WResult::Done(0)
	})
}

/// Widget `vi-change` (zsh `vichange`): delete the range and insert.
pub fn vichange_widget(zw: &mut Zw<'_, '_>) -> WResult {
	vichange(zw, 1);
	getvirange(zw, true, |zw, c2| {
		let Some(c2) = c2 else {
			return WResult::Done(1);
		};
		let ed = &mut *zw.ed;
		let ct = c2 - ed.cs;
		utils::forekill(zw.zle, ed, ct, cutflags::RAW);
		let _ = exec::selectkeymap(&zw.zle.keymaps, zw.ed, b"main", true);
		zw.ed.ls.viinsbegin = zw.ed.cs;
		zw.ed.undo.vistartchange = zw.ed.undo.changeno;
		WResult::Done(0)
	})
}

/// Widget `vi-yank` (zsh `viyank`): copy the range (into `"0`); the
/// cursor goes to its start, for whole lines to the column it was at.
pub fn viyank(zw: &mut Zw<'_, '_>) -> WResult {
	vichange(zw, 1);
	getvirange(zw, false, |zw, c2| {
		let ret = if let Some(c2) = c2 {
			let cs = zw.ed.cs;
			utils::cut(zw.zle, zw.ed, cs, c2 - cs, cutflags::YANK);
			0
		} else {
			1
		};
		let ed = &mut *zw.ed;
		if ed.ls.vilinerange && ed.ls.lastcol != -1 {
			let x = utils::findeol(ed);
			ed.cs = ed
				.cs
				.saturating_add(usize::try_from(ed.ls.lastcol).unwrap_or(0));
			if ed.cs >= x {
				ed.cs = x;
				if ed.cs > utils::findbol(ed) && invicmdmode(ed) {
					utils::deccs(ed);
				}
			} else {
				utils::ccright(ed);
			}
			ed.ls.lastcol = -1;
		}
		WResult::Done(ret)
	})
}

/// The case operators: `f` maps each character of the range.
fn case_operator(zw: &mut Zw<'_, '_>, f: fn(char) -> char) -> WResult {
	vichange(zw, 1);
	getvirange(zw, false, move |zw, c2| {
		let Some(c2) = c2 else {
			return WResult::Done(1);
		};
		let ed = &mut *zw.ed;
		let oldcs = ed.cs;
		while ed.cs < c2 {
			if let Some(c) = ed.line.get_mut(ed.cs) {
				*c = f(*c);
			}
			utils::inccs(ed);
		}
		ed.cs = oldcs;
		WResult::Done(0)
	})
}

/// zsh `ZC_toupper`: `c` upper-cased when that is one character.
pub(super) fn toupper(c: char) -> char {
	let mut u = c.to_uppercase();
	match (u.next(), u.next()) {
		(Some(x), None) => x,
		_ => c,
	}
}

/// zsh `ZC_tolower`: `c` lower-cased when that is one character.
pub(super) fn tolower(c: char) -> char {
	let mut l = c.to_lowercase();
	match (l.next(), l.next()) {
		(Some(x), None) => x,
		_ => c,
	}
}

/// zsh's swap of case: lower to upper, upper to lower.
pub(super) fn swapcase(c: char) -> char {
	if c.is_lowercase() {
		toupper(c)
	} else if c.is_uppercase() {
		tolower(c)
	} else {
		c
	}
}

/// Widget `vi-oper-swap-case` (zsh `vioperswapcase`).
pub fn vioperswapcase(zw: &mut Zw<'_, '_>) -> WResult {
	case_operator(zw, swapcase)
}

/// Widget `vi-up-case` (zsh `viupcase`).
pub fn viupcase(zw: &mut Zw<'_, '_>) -> WResult {
	case_operator(zw, toupper)
}

/// Widget `vi-down-case` (zsh `vidowncase`).
pub fn vidowncase(zw: &mut Zw<'_, '_>) -> WResult {
	case_operator(zw, tolower)
}

/// Widget `vi-indent` (zsh `viindent`): a tab before each non-blank line
/// of a line-wise range.
pub fn viindent(zw: &mut Zw<'_, '_>) -> WResult {
	let oldcs = zw.ed.cs;
	vichange(zw, 1);
	if zw.ed.region_active == 1 {
		zw.ed.region_active = 2;
	}
	getvirange(zw, false, move |zw, c2| {
		let Some(c2) = c2 else {
			return WResult::Done(1);
		};
		let ed = &mut *zw.ed;
		if !ed.ls.vilinerange {
			ed.cs = oldcs;
			return WResult::Done(1);
		}
		let oldcs = ed.cs;
		while ed.cs <= c2 + 1 {
			if at(&ed.line, ed.cs) == '\n' {
				ed.cs += 1;
			} else {
				utils::spaceinline(ed, 1);
				ed.line[ed.cs] = '\t';
				ed.cs = utils::findeol(ed) + 1;
			}
		}
		ed.cs = oldcs;
		utils::vifirstnonblank(ed);
		WResult::Done(0)
	})
}

/// Widget `vi-unindent` (zsh `viunindent`): one leading tab off each
/// line of a line-wise range.
pub fn viunindent(zw: &mut Zw<'_, '_>) -> WResult {
	let oldcs = zw.ed.cs;
	vichange(zw, 1);
	if zw.ed.region_active == 1 {
		zw.ed.region_active = 2;
	}
	getvirange(zw, false, move |zw, c2| {
		let Some(c2) = c2 else {
			return WResult::Done(1);
		};
		let ed = &mut *zw.ed;
		if !ed.ls.vilinerange {
			ed.cs = oldcs;
			return WResult::Done(1);
		}
		let oldcs = ed.cs;
		while ed.cs < c2 {
			if at(&ed.line, ed.cs) == '\t' {
				utils::foredel(ed, 1, 0);
			}
			ed.cs = utils::findeol(ed) + 1;
		}
		ed.cs = oldcs.min(ed.line.len());
		utils::vifirstnonblank(ed);
		WResult::Done(0)
	})
}

/// Widget `vi-repeat-change` (zsh `virepeatchange`): feed the keys of
/// the last change back as input, a count or register given now
/// replacing the recorded one (`"1`–`"8` advance to the next register).
pub fn virepeatchange(zw: &mut Zw<'_, '_>) -> WResult {
	let ed = &mut *zw.ed;
	let vi = &mut zw.zle.vi;
	if vi.vichgflag != 0 || ed.ls.virangeflag {
		return WResult::Done(1);
	}
	let Some(last) = vi.lastvichg.as_mut() else {
		return WResult::Done(1);
	};
	if ed.zmod.flags & modflags::MULT != 0 {
		last.zmod.mult = ed.zmod.mult;
		last.zmod.flags |= modflags::MULT;
	}
	if ed.zmod.flags & modflags::VIBUF != 0 {
		last.zmod.vibuf = ed.zmod.vibuf;
		last.zmod.flags =
			(last.zmod.flags & !modflags::VIAPP) | modflags::VIBUF | (ed.zmod.flags & modflags::VIAPP);
	} else if last.zmod.flags & modflags::VIBUF != 0 && (27..=34).contains(&last.zmod.vibuf) {
		last.zmod.vibuf += 1;
	}
	vi.viinrepeat = 3;
	for &b in last.buf.iter().rev() {
		ed.unget.push_front(b);
	}
	WResult::Done(0)
}

/// Widget `vi-change-eol` (zsh `vichangeeol`): change to the end of the
/// line (with a region, its whole lines).
pub fn vichangeeol(zw: &mut Zw<'_, '_>) -> WResult {
	let ed = &mut *zw.ed;
	if ed.region_active != 0 {
		let (a, b) = yank::regionlines(ed);
		ed.cs = a;
		ed.region_active = 0;
		utils::cut(zw.zle, ed, a, b - a, cutflags::RAW);
		utils::shiftchars(ed, a, b - a);
	} else {
		let n = utils::findeol(ed) - ed.cs;
		utils::forekill(zw.zle, ed, n, cutflags::RAW);
	}
	vitext(zw, 1);
	WResult::Done(0)
}

/// Widget `vi-change-whole-line` (zsh `vichangewholeline`).
pub fn vichangewholeline(zw: &mut Zw<'_, '_>) -> WResult {
	utils::vifirstnonblank(zw.ed);
	vichangeeol(zw)
}

/// Widget `vi-substitute` (zsh `visubstitute`): change `zmult`
/// characters (the region when active).
pub fn visubstitute(zw: &mut Zw<'_, '_>) -> WResult {
	vichange(zw, 1);
	let ed = &mut *zw.ed;
	let mut n = ed.zmod.mult;
	if n < 0 {
		return WResult::Done(1);
	}
	if ed.cs == ed.line.len() || ed.line[ed.cs] == '\n' {
		return WResult::Done(1);
	}
	if ed.region_active != 0 {
		yank::kill_region(zw.zle, ed);
	} else {
		let room = i64::try_from(utils::findeol(ed) - ed.cs).unwrap_or(i64::MAX);
		if n > room {
			n = room;
		}
		utils::forekill(zw.zle, ed, usize::try_from(n).unwrap_or(0), cutflags::RAW);
	}
	vitext(zw, 1);
	WResult::Done(0)
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
	fn change_recording_ends_with_the_widget_or_in_insert_mode() {
		let mut zle = Zle::new(true);
		let mut e = ed("abc", 1);
		e.keymap = BString::from("vicmd");
		e.keybuf = b"d".to_vec();
		let (nested, rep) = exec_begin(&mut zle);
		startvichange(&mut zle.vi, &mut e, 1);
		record_byte(&mut zle, b'w');
		record_byte(&mut zle, b'x');
		unrecord_bytes(&mut zle, 1);
		exec_end(&mut zle, &e, 0, nested, rep);
		assert_eq!(zle.vi.lastvichg.as_ref().map(|c| c.buf.as_slice()), Some(&b"dw"[..]));
		assert_eq!(zle.vi.vichgflag, 0);
		// A change left in insert mode goes on.
		e.keybuf = b"c".to_vec();
		let (nested, rep) = exec_begin(&mut zle);
		startvichange(&mut zle.vi, &mut e, 1);
		e.keymap = BString::from("main");
		exec_end(&mut zle, &e, 0, nested, rep);
		assert_eq!(zle.vi.vichgflag, 1);
	}

	#[test]
	fn line_start_synthesises_an_insert() {
		let mut zle = Zle::new(true);
		let mut e = ed("", 0);
		line_init(&mut zle, &mut e);
		assert_eq!(zle.vi.curvichg.as_ref().map(|c| c.buf.as_slice()), Some(&b"o"[..]));
		assert_eq!(zle.vi.vichgflag, 1);
		let mut e = ed("before", 6);
		line_init(&mut zle, &mut e);
		assert_eq!(zle.vi.curvichg.as_ref().map(|c| c.buf.as_slice()), Some(&b"a"[..]));
		let mut zle = Zle::new(false);
		line_init(&mut zle, &mut e);
		assert_eq!(zle.vi.vichgflag, 0);
	}

	#[test]
	fn line_counts() {
		let mut e = ed("one\ntwo\nthree", 5);
		let mut r = Range {
			pos:    5,
			mpos:   0,
			visual: 0,
			mult1:  1,
			hist1:  0,
			failed: false,
			lines:  false,
		};
		e.zmod.mult = 2;
		assert!(!dovilinerange(&mut e, &mut r));
		// The end of "three" (zsh's cursor one past it, moved back).
		assert_eq!(e.cs, 13);
		e.cs = 5;
		e.zmod.mult = 3;
		assert!(dovilinerange(&mut e, &mut r));
		assert_eq!(e.cs, 5);
		e.zmod.mult = -2;
		assert!(!dovilinerange(&mut e, &mut r));
		assert_eq!(e.cs, 0);
	}

	#[test]
	fn case_mappings() {
		assert_eq!(swapcase('a'), 'A');
		assert_eq!(swapcase('Ä'), 'ä');
		assert_eq!(toupper('ß'), 'ß');
		assert_eq!(swapcase('-'), '-');
	}
}
