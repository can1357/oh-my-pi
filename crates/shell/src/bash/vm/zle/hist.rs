//! History lines in the editor (zsh 5.9 `zle_hist.c`): moving to another
//! history line (`zle_setline`, `zle_goto_hist`), the edits kept per
//! history line while moving (`remember_edits`), `$HISTNO`, and the
//! line-or-history widgets.

use bstr::BString;

use super::{
	Editor,
	exec::{WResult, Zw},
	from_line, to_line, undo, utils,
};
use crate::bash::{
	store::StateStore,
	vm::{
		builtins::history::model::{HIST_FOREIGN, Hist},
		expand::Expander,
		proc::Vproc,
	},
	zshopt::ZshOpt,
};

/// zsh `hist_skip_flags`: the history lines moves skip.
pub(crate) const fn skip_flags(ed: &Editor) -> u32 {
	if ed.ls.localhistory { HIST_FOREIGN } else { 0 }
}

/// zsh `GETZLETEXT(he)`: the text of history line `i` as the editor
/// shows it (its edits, if it was edited).
pub(crate) fn zle_text(ed: &Editor, h: &Hist, i: usize) -> BString {
	let num = h.num_at(i);
	ed.hist_edits
		.get(&num)
		.cloned()
		.unwrap_or_else(|| BString::from(h.text_at(i)))
}

/// zsh `remember_edits`: keep the line as edited for the history line
/// being shown.
pub fn remember_edits(ed: &mut Editor, h: &Hist) {
	if h.index_of(ed.histline).is_none() {
		return;
	}
	let line = from_line(&ed.line);
	ed.hist_edits.insert(ed.histline, line);
}

/// zsh `zlinecmp(hist, input)`: 0 when the two are the same, -1 when
/// `input` is a prefix of `hist`, 1 when `input` is `hist` in lower case,
/// 2 when it is a lower-case prefix of it, 3 otherwise.
pub(crate) fn zlinecmp(hist: &[char], input: &[char]) -> i32 {
	let same = hist.iter().zip(input).take_while(|(h, i)| h == i).count();
	if same == input.len() {
		return if same == hist.len() { 0 } else { -1 };
	}
	let mut k = 0;
	while k < hist.len() && k < input.len() {
		if lower(hist[k]) != input[k] {
			return 3;
		}
		k += 1;
	}
	if k == input.len() {
		if k == hist.len() { 1 } else { 2 }
	} else {
		3
	}
}

/// zsh `towlower` of one character (characters that lower-case to more
/// than one are kept).
fn lower(c: char) -> char {
	let mut l = c.to_lowercase();
	match (l.next(), l.next()) {
		(Some(x), None) => x,
		_ => c,
	}
}

/// zsh `zlinefind(haystack, pos, needle, dir, sens)`: the first position
/// from `pos` (forwards when `dir` > 0, else backwards) where `needle`
/// compares below `sens` ([`zlinecmp`]).
pub(crate) fn zlinefind(
	haystack: &[char],
	pos: usize,
	needle: &[char],
	dir: i32,
	sens: i32,
) -> Option<usize> {
	if dir > 0 {
		(pos..haystack.len()).find(|&s| zlinecmp(&haystack[s..], needle) < sens)
	} else {
		let start = pos.min(haystack.len());
		(0..=start)
			.rev()
			.find(|&s| zlinecmp(&haystack[s..], needle) < sens)
	}
}

/// zsh `zle_setline(he)` of the history line at ring position `i`.
pub(crate) fn setline_at(ed: &mut Editor, h: &Hist, i: usize) {
	remember_edits(ed, h);
	undo::mkundoent(ed);
	ed.histline = h.num_at(i);
	let text = zle_text(ed, h, i);
	utils::setline(ed, &text, utils::ZSL_COPY | utils::ZSL_TOEND);
	ed.hooks.push((BString::from("zle-history-line-set"), None));
	undo::setlastline(ed);
	ed.clearlist = true;
}

/// The history, or `None` when the store fails (the caller beeps).
pub(crate) fn load(zw: &mut Zw<'_, '_>) -> Option<Hist> {
	Hist::load(&zw.k.root, zw.cx.store, zw.vp).ok()
}

/// zsh `zle_setline(quietgethist(hist))`: show history line `hist`;
/// `false` when there is no such line.
pub fn zle_setline(zw: &mut Zw<'_, '_>, hist: i64) -> bool {
	let Some(h) = load(zw) else {
		return false;
	};
	let Some(i) = h.index_of(hist) else {
		return false;
	};
	setline_at(zw.ed, &h, i);
	true
}

/// `HISTNO=n` (zsh `set_histno`): show history line `n` if there is one.
pub fn set_histno(ex: &mut Expander<'_, '_>, n: i64) {
	let Some(h) = Hist::load(&ex.k.root, ex.cx.store, ex.vp).ok() else {
		return;
	};
	let Some(i) = h.index_of(n) else {
		return;
	};
	if let Some(ed) = super::editor_mut(ex.vp) {
		setline_at(ed, &h, i);
	}
}

/// zsh `curhist`: the number the line being read gets.
pub fn curhist(store: &mut dyn StateStore, vp: &Vproc) -> i64 {
	Hist::load_state(store, vp).map_or(0, |st| st.curhist)
}

/// zsh `zle_goto_hist(ev, n, skipdups)`: move `n` history lines from
/// `ev`. As zsh's, `false` only when skipping lines the same as the
/// buffer (`skipdups`) runs off the history; no line `ev` or none `n`
/// lines away is `true` with the line unchanged.
pub fn zle_goto_hist(zw: &mut Zw<'_, '_>, ev: i64, n: i64, skipdups: bool) -> bool {
	let Some(h) = load(zw) else {
		return true;
	};
	let Some(start) = h.index_of(ev) else {
		return true;
	};
	let flags = skip_flags(zw.ed);
	let Some(mut i) = h.movehistent(start, n, flags) else {
		return true;
	};
	if skipdups && n != 0 {
		let step = n.signum();
		loop {
			if zlinecmp(&to_line(&zle_text(zw.ed, &h, i)), &zw.ed.line) != 0 {
				break;
			}
			match h.movehistent(i, step, flags) {
				Some(j) => i = j,
				None => return false,
			}
		}
	}
	setline_at(zw.ed, &h, i);
	true
}

/// zsh `uphistory`.
pub fn up_history(zw: &mut Zw<'_, '_>) -> WResult {
	let nodups = zw.isset(ZshOpt::Histignoredups);
	let (ev, n) = (zw.ed.histline, -zw.mult());
	if !zle_goto_hist(zw, ev, n, nodups) && zw.isset(ZshOpt::Histbeep) {
		return WResult::Done(1);
	}
	WResult::Done(0)
}

/// zsh `downhistory`.
pub fn down_history(zw: &mut Zw<'_, '_>) -> WResult {
	let nodups = zw.isset(ZshOpt::Histignoredups);
	let (ev, n) = (zw.ed.histline, zw.mult());
	if !zle_goto_hist(zw, ev, n, nodups) && zw.isset(ZshOpt::Histbeep) {
		return WResult::Done(1);
	}
	WResult::Done(0)
}

/// zsh `uplineorhistory`.
pub fn up_line_or_history(zw: &mut Zw<'_, '_>) -> WResult {
	let ocs = zw.ed.cs;
	let n = utils::upline(zw);
	if n == 0 {
		return WResult::Done(0);
	}
	zw.ed.cs = ocs;
	if zw.ed.ls.virangeflag || zw.ed.flags & super::readflags::HISTORY == 0 {
		return WResult::Done(1);
	}
	let m = zw.ed.zmod.mult;
	zw.ed.zmod.mult = n;
	let r = up_history(zw);
	zw.ed.zmod.mult = m;
	r
}

/// zsh `downlineorhistory`.
pub fn down_line_or_history(zw: &mut Zw<'_, '_>) -> WResult {
	let ocs = zw.ed.cs;
	let n = utils::downline(zw);
	if n == 0 {
		return WResult::Done(0);
	}
	zw.ed.cs = ocs;
	if zw.ed.ls.virangeflag || zw.ed.flags & super::readflags::HISTORY == 0 {
		return WResult::Done(1);
	}
	let m = zw.ed.zmod.mult;
	zw.ed.zmod.mult = n;
	let r = down_history(zw);
	zw.ed.zmod.mult = m;
	r
}

/// zsh `beginningofhistory`: the oldest history line.
pub fn beginning_of_history(zw: &mut Zw<'_, '_>) -> WResult {
	let first = load(zw).map_or_else(|| curhist(zw.cx.store, zw.vp), |h| h.firsthist());
	if !zle_goto_hist(zw, first, 0, false) && zw.isset(ZshOpt::Histbeep) {
		return WResult::Done(1);
	}
	WResult::Done(0)
}

/// zsh `endofhistory`: back to the line being read.
pub fn end_of_history(zw: &mut Zw<'_, '_>) -> WResult {
	let cur = curhist(zw.cx.store, zw.vp);
	zle_goto_hist(zw, cur, 0, false);
	WResult::Done(0)
}
