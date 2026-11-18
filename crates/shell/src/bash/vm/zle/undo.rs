//! The undo system (zsh 5.9 `Src/Zle/zle_utils.c`): the change list of
//! the line being edited, what the core records after each widget
//! ([`handleundo`]), and the `undo`, `redo`, `split-undo` widgets and
//! vi's undo, plus `$UNDO_CHANGE_NO` / `$UNDO_LIMIT_NO`.
//!
//! zsh keeps a doubly linked list whose last node is an empty entry and
//! a `curchange` pointer: entries before `curchange` are applied, it and
//! those after it were undone (redo applies `curchange`). Here the list is
//! [`Undo::changes`] (its last element the empty entry) and `curchange`
//! the index [`Undo::cur`]; changes made since the last [`handleundo`]
//! wait in [`Undo::pending`] (zsh `nextchanges`).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use super::{
	Editor,
	exec::Zw,
	utils::{cutflags, foredel, spaceinline, zstrtol0},
};

/// `CH_*` flags of a [`Change`] (zsh `zle.h`).
pub mod chflags {
	/// The next entry belongs to the same change.
	pub const NEXT: u32 = 1 << 0;
	/// The previous entry belongs to the same change.
	pub const PREV: u32 = 1 << 1;
}

/// zsh `struct change`: one edit of the line.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Change {
	/// [`chflags`].
	pub flags:    u32,
	/// The history line the edit was made on (zsh `hist`).
	pub hist:     i64,
	/// Where the text changed.
	pub off:      usize,
	/// The text removed (zsh `del`/`dell`).
	pub del:      Vec<char>,
	/// The text inserted (zsh `ins`/`insl`).
	pub ins:      Vec<char>,
	/// The cursor before the edit.
	pub old_cs:   usize,
	/// The cursor after it.
	pub new_cs:   usize,
	/// Its number (`$UNDO_CHANGE_NO` when it was made).
	pub changeno: i64,
}

/// The undo state of the line being edited ([`Editor::undo`]).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Undo {
	/// zsh `changes`…: the change list; the last entry is the empty one
	/// new changes are inserted before.
	pub changes:       Vec<Change>,
	/// zsh `curchange`: index of the first change not applied.
	pub cur:           usize,
	/// zsh `nextchanges`…`endnextchanges`: changes not yet in the list.
	pub pending:       Vec<Change>,
	/// zsh `undo_changeno`: the number of the last change made.
	pub changeno:      i64,
	/// zsh `undo_limitno` (`$UNDO_LIMIT_NO`): `undo` without an argument
	/// stops at changes numbered this or lower.
	pub limitno:       i64,
	/// zsh `lastline`/`lastll`: the line as last recorded.
	pub lastline:      Vec<char>,
	/// zsh `lastcs`: the cursor as last recorded.
	pub lastcs:        usize,
	/// zsh `vistartchange`: the change number a vi insertion started at
	/// (`-1`: none), so `split-undo` and leaving insert mode can merge
	/// what was typed into one change.
	pub vistartchange: i64,
}

impl Undo {
	/// zsh `initundo` (and `vistartchange = -1` of `zleread`): an empty
	/// change list for a line starting as `line` with the cursor at `cs`.
	pub fn new(line: &[char], cs: usize) -> Self {
		Self {
			changes:       vec![Change::default()],
			cur:           0,
			pending:       Vec::new(),
			changeno:      0,
			limitno:       0,
			lastline:      line.to_vec(),
			lastcs:        cs,
			vistartchange: -1,
		}
	}

	/// Make sure the empty last entry exists (a defaulted [`Undo`] has
	/// none until the first change is registered).
	fn ensure_tail(&mut self) {
		if self.changes.is_empty() {
			self.changes.push(Change::default());
			self.cur = 0;
		}
	}
}

/// zsh `mkundoent`: if the line differs from what was last recorded,
/// queue a [`Change`] for the differing middle part.
pub fn mkundoent(ed: &mut Editor) {
	let u = &mut ed.undo;
	if u.lastline == ed.line {
		u.lastcs = ed.cs;
		return;
	}
	let ll = ed.line.len();
	let lastll = u.lastline.len();
	let sh = ll.min(lastll);
	let pre = ed
		.line
		.iter()
		.zip(&u.lastline)
		.take_while(|(a, b)| a == b)
		.count();
	let mut suf = 0;
	while suf < sh - pre && ed.line[ll - 1 - suf] == u.lastline[lastll - 1 - suf] {
		suf += 1;
	}
	u.changeno += 1;
	let flags = match u.pending.last_mut() {
		Some(last) => {
			last.flags |= chflags::NEXT;
			chflags::PREV
		},
		None => 0,
	};
	u.pending.push(Change {
		flags,
		hist: ed.histline,
		off: pre,
		del: u.lastline[pre..lastll - suf].to_vec(),
		ins: ed.line[pre..ll - suf].to_vec(),
		old_cs: u.lastcs,
		new_cs: ed.cs,
		changeno: u.changeno,
	});
}

/// zsh `setlastline`: record the line and cursor as they are now.
pub fn setlastline(ed: &mut Editor) {
	ed.undo.lastline.clone_from(&ed.line);
	ed.undo.lastcs = ed.cs;
}

/// zsh `handleundo`: register what changed since the last call in the
/// change list (dropping what was undone and not redone). The core calls
/// it after every key's widget and after taking a line from the buffer
/// stack; widgets that inspect the list call it first.
pub fn handleundo(ed: &mut Editor) {
	mkundoent(ed);
	if ed.undo.pending.is_empty() {
		return;
	}
	setlastline(ed);
	let u = &mut ed.undo;
	u.ensure_tail();
	if u.cur + 1 < u.changes.len() {
		u.changes.truncate(u.cur + 1);
		let tail = &mut u.changes[u.cur];
		tail.del.clear();
		tail.ins.clear();
	}
	let pending = std::mem::take(&mut u.pending);
	let n = pending.len();
	u.changes.splice(u.cur..u.cur, pending);
	u.cur += n;
}

/// zsh `get_undo_current_change` (`$UNDO_CHANGE_NO`): record pending
/// edits and return the number of the last change.
pub fn current_change(ed: &mut Editor) -> i64 {
	mkundoent(ed);
	setlastline(ed);
	ed.undo.changeno
}

/// What undoing and redoing need besides the line: switching to another
/// history line when a change was made there (zsh `zle_setline`).
pub trait UndoHost {
	/// The line being edited.
	fn ed(&mut self) -> &mut Editor;
	/// Show history line `hist` (zsh `zle_setline(quietgethist(hist))`):
	/// `false` when there is no such event.
	fn zle_setline(&mut self, hist: i64) -> bool;
}

impl UndoHost for Zw<'_, '_> {
	fn ed(&mut self) -> &mut Editor {
		&mut *self.ed
	}

	fn zle_setline(&mut self, hist: i64) -> bool {
		super::hist::zle_setline(self, hist)
	}
}

/// zsh `unapplychange`: undo change `i`. `false` when it was made on
/// another history line, which is shown instead (the change itself is
/// then still to undo).
fn unapplychange(h: &mut dyn UndoHost, i: usize) -> bool {
	let (hist, new_cs) = {
		let ch = &h.ed().undo.changes[i];
		(ch.hist, ch.new_cs)
	};
	if hist != h.ed().histline {
		if !h.zle_setline(hist) {
			return true;
		}
		let ed = h.ed();
		ed.cs = new_cs.min(ed.line.len());
		return false;
	}
	let ed = h.ed();
	let ch = &ed.undo.changes[i];
	let (off, insl, old_cs) = (ch.off, ch.ins.len(), ch.old_cs);
	let del = std::mem::take(&mut ed.undo.changes[i].del);
	ed.cs = off;
	if insl != 0 {
		foredel(ed, insl, cutflags::RAW);
	}
	if !del.is_empty() {
		spaceinline(ed, del.len());
		let cs = ed.cs;
		ed.line[cs..cs + del.len()].copy_from_slice(&del);
		ed.cs += del.len();
	}
	ed.undo.changes[i].del = del;
	ed.cs = old_cs.min(ed.line.len());
	true
}

/// zsh `applychange`: redo change `i`; `false` as for [`unapplychange`].
fn applychange(h: &mut dyn UndoHost, i: usize) -> bool {
	let (hist, old_cs) = {
		let ch = &h.ed().undo.changes[i];
		(ch.hist, ch.old_cs)
	};
	if hist != h.ed().histline {
		if !h.zle_setline(hist) {
			return true;
		}
		let ed = h.ed();
		ed.cs = old_cs.min(ed.line.len());
		return false;
	}
	let ed = h.ed();
	let ch = &ed.undo.changes[i];
	let (off, dell, new_cs) = (ch.off, ch.del.len(), ch.new_cs);
	let ins = std::mem::take(&mut ed.undo.changes[i].ins);
	ed.cs = off;
	if dell != 0 {
		foredel(ed, dell, cutflags::RAW);
	}
	if !ins.is_empty() {
		spaceinline(ed, ins.len());
		let cs = ed.cs;
		ed.line[cs..cs + ins.len()].copy_from_slice(&ins);
		ed.cs += ins.len();
	}
	ed.undo.changes[i].ins = ins;
	ed.cs = new_cs.min(ed.line.len());
	true
}

/// zsh `undo` (widget `undo`, `zle undo [N]`): undo the last change
/// (with the entries joined to it), or with `arg` every change numbered
/// above `N` (`$UNDO_CHANGE_NO` taken earlier). Without `arg`, changes
/// at or below [`Undo::limitno`] are not undone. 1 when nothing could be
/// undone.
pub fn undo(h: &mut dyn UndoHost, arg: Option<&[u8]>) -> i32 {
	let last_change = arg.map_or(-1, zstrtol0);
	handleundo(h.ed());
	h.ed().undo.ensure_tail();
	loop {
		let u = &h.ed().undo;
		if u.cur == 0 {
			return 1;
		}
		let prev = u.cur - 1;
		let no = u.changes[prev].changeno;
		if no <= last_change {
			break;
		}
		if no <= u.limitno && arg.is_none() {
			return 1;
		}
		if unapplychange(h, prev) {
			h.ed().undo.cur = prev;
		} else if last_change >= 0 {
			unapplychange(h, prev);
			h.ed().undo.cur = prev;
		}
		let u = &h.ed().undo;
		if !(last_change >= 0 || u.changes[u.cur].flags & chflags::PREV != 0) {
			break;
		}
	}
	setlastline(h.ed());
	0
}

/// zsh `redo` (widget `redo`): reapply the change last undone (with
/// the entries joined to it). 1 when there is none.
pub fn redo(h: &mut dyn UndoHost) -> i32 {
	handleundo(h.ed());
	h.ed().undo.ensure_tail();
	loop {
		let u = &h.ed().undo;
		if u.cur + 1 >= u.changes.len() {
			return 1;
		}
		let cur = u.cur;
		if !applychange(h, cur) {
			break;
		}
		let u = &mut h.ed().undo;
		u.cur = cur + 1;
		if u.changes[cur].flags & chflags::NEXT == 0 {
			break;
		}
	}
	setlastline(h.ed());
	0
}

/// zsh `viundochange` (vi `u`): redo everything undone, or when nothing
/// was, [`undo`].
pub fn viundochange(h: &mut dyn UndoHost, arg: Option<&[u8]>) -> i32 {
	handleundo(h.ed());
	h.ed().undo.ensure_tail();
	let u = &h.ed().undo;
	if u.cur + 1 < u.changes.len() {
		loop {
			let cur = h.ed().undo.cur;
			applychange(h, cur);
			let u = &mut h.ed().undo;
			u.cur = cur + 1;
			if u.cur + 1 >= u.changes.len() {
				break;
			}
		}
		setlastline(h.ed());
		0
	} else {
		undo(h, arg)
	}
}

/// zsh `mergeundo`: join the changes since [`Undo::vistartchange`] into
/// one, and forget the start.
pub fn mergeundo(ed: &mut Editor) {
	let u = &mut ed.undo;
	let mut i = u.cur;
	// current = curchange->prev, while it and its prev exist.
	while i >= 2 && u.changes[i - 1].changeno > u.vistartchange + 1 {
		u.changes[i - 1].flags |= chflags::PREV;
		u.changes[i - 2].flags |= chflags::NEXT;
		i -= 1;
	}
	u.vistartchange = -1;
}

/// zsh `splitundo` (widget `split-undo`): end the current undo unit (in
/// a vi insertion, merge what was typed so far and start a new unit).
pub fn splitundo(ed: &mut Editor) -> i32 {
	if ed.undo.vistartchange >= 0 {
		mergeundo(ed);
		ed.undo.vistartchange = ed.undo.changeno;
	}
	handleundo(ed);
	0
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::vm::zle::Context;

	/// An editor without history: changes on another history line are
	/// never made.
	struct Host(Editor);

	impl UndoHost for Host {
		fn ed(&mut self) -> &mut Editor {
			&mut self.0
		}

		fn zle_setline(&mut self, _hist: i64) -> bool {
			false
		}
	}

	fn host() -> Host {
		let mut e = Editor::new(Context::LineStart, 0);
		e.undo = Undo::new(&[], 0);
		Host(e)
	}

	fn type_text(h: &mut Host, s: &str) {
		for c in s.chars() {
			let ed = &mut h.0;
			spaceinline(ed, 1);
			let cs = ed.cs;
			ed.line[cs] = c;
			ed.cs += 1;
			handleundo(ed);
		}
	}

	fn line(h: &Host) -> String {
		h.0.line.iter().collect()
	}

	#[test]
	fn undo_and_redo_one_key_at_a_time() {
		let mut h = host();
		type_text(&mut h, "ab");
		assert_eq!(h.0.undo.changeno, 2);
		assert_eq!(undo(&mut h, None), 0);
		assert_eq!(line(&h), "a");
		assert_eq!(h.0.cs, 1);
		assert_eq!(undo(&mut h, None), 0);
		assert_eq!(line(&h), "");
		assert_eq!(undo(&mut h, None), 1);
		assert_eq!(redo(&mut h), 0);
		assert_eq!(line(&h), "a");
		assert_eq!(redo(&mut h), 0);
		assert_eq!(redo(&mut h), 1);
		assert_eq!(line(&h), "ab");
		// A new change drops what was undone.
		undo(&mut h, None);
		type_text(&mut h, "c");
		assert_eq!(line(&h), "ac");
		assert_eq!(redo(&mut h), 1);
	}

	#[test]
	fn undo_to_a_change_number_and_limit() {
		let mut h = host();
		type_text(&mut h, "x");
		let mark = current_change(&mut h.0);
		type_text(&mut h, "yz");
		assert_eq!(undo(&mut h, Some(format!("{mark}").as_bytes())), 0);
		assert_eq!(line(&h), "x");
		type_text(&mut h, "q");
		h.0.undo.limitno = current_change(&mut h.0);
		assert_eq!(undo(&mut h, None), 1);
		assert_eq!(line(&h), "xq");
	}

	#[test]
	fn joined_entries_undo_together() {
		let mut h = host();
		// Two edits before handleundo form one change of two entries.
		let ed = &mut h.0;
		ed.line = vec!['a'];
		ed.cs = 1;
		mkundoent(ed);
		setlastline(ed);
		ed.line = vec!['a', 'b', 'c'];
		ed.cs = 3;
		handleundo(ed);
		assert_eq!(ed.undo.changes.len(), 3);
		assert_eq!(undo(&mut h, None), 0);
		assert_eq!(line(&h), "");
		assert_eq!(redo(&mut h), 0);
		assert_eq!(line(&h), "abc");
	}

	#[test]
	fn split_undo_merges_vi_insertion() {
		let mut h = host();
		h.0.undo.vistartchange = 0;
		type_text(&mut h, "abc");
		assert_eq!(splitundo(&mut h.0), 0);
		assert_eq!(h.0.undo.vistartchange, 3);
		assert_eq!(undo(&mut h, None), 0);
		assert_eq!(line(&h), "");
	}
}
