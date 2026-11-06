//! The history search and history word widgets of zsh 5.9 `zle_hist.c`
//! other than the incremental search ([`super::isearch`]):
//! `history-search-*`, `history-beginning-search-*`, `up/down-line-or-search`,
//! `infer-next-history`, `accept-and-infer-next-history`, `insert-last-word`,
//! `set-local-history`, `vi-fetch-history` and the vi searches
//! (`vi-history-search-*`, `vi-repeat-search`, `vi-rev-repeat-search`).
//!
//! What zsh keeps in `static` variables between calls (the search prefix
//! of `history-search-*`, the word `insert-last-word` inserted, the last
//! vi search) lives in [`SearchState`]
//! ([`crate::bash::vm::zle::Zle::hsearch`]).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::BString;

use super::{
	super::{
		Editor,
		display::{self, clear_screen, redisplay},
		exec::{self, Await, Got, WResult, Zw, then},
		from_line,
		hist::{self, zlinecmp, zlinefind},
		modflags, readflags, to_line,
		utils::{self, iblank},
	},
	misc,
};
use crate::bash::{
	syntax::zsh::{
		bufferwords,
		tok::{metafy, unmetafy},
	},
	vm::builtins::history::model::{HIST_DUP, HIST_FOREIGN, Hist},
	zshopt::ZshOpt,
};

/// zsh's `static` state of the history widgets, kept between lines.
#[derive(Clone, Debug, Default)]
pub struct SearchState {
	/// `history-search-*`: zsh `histpos`, the length of the prefix searched
	/// for.
	histpos:         usize,
	/// zsh `srch_hl`: the history line the last search went to.
	srch_hl:         i64,
	/// zsh `srch_cs`: the cursor after the last search (`None`: zsh's -1).
	srch_cs:         Option<usize>,
	/// zsh `srch_str`: the prefix searched for.
	srch_str:        Vec<char>,
	/// `insert-last-word`: zsh `lastinsert`, the word inserted last (empty:
	/// none).
	lastinsert:      Vec<char>,
	/// zsh `lasthist`: the history line it came from.
	lasthist:        i64,
	/// zsh `lastpos`: where it was inserted.
	lastpos:         usize,
	/// zsh `visrchstr`: the last vi search.
	visrchstr:       Option<Vec<char>>,
	/// zsh `vipenultsrchstr`: the one before it.
	vipenultsrchstr: Option<Vec<char>>,
	/// zsh `visrchsense`: its direction (-1 `?`, 1 `/`).
	visrchsense:     i64,
}

/// The rest of a widget after something it waits for.
pub(super) type Then = Box<dyn FnOnce(&mut Zw<'_, '_>) -> WResult + Send>;

/// `f` as a [`Then`].
pub(super) fn after<F>(f: F) -> Then
where
	F: FnOnce(&mut Zw<'_, '_>) -> WResult + Send + 'static,
{
	Box::new(f)
}

/// Run the hook widgets native code queued ([`Editor::hooks`]:
/// `zle-history-line-set`, `zle-keymap-select`) now, as zsh calls them
/// where they happen, then go on with `k`.
pub(super) fn run_hooks(zw: &mut Zw<'_, '_>, k: Then) -> WResult {
	if zw.ed.hooks.is_empty() {
		return k(zw);
	}
	let (name, arg) = zw.ed.hooks.remove(0);
	then(Await::Hook { name, arg }, move |zw, _| run_hooks(zw, k))
}

/// Go on with `k` once the widget step `r` (a widget run from native code,
/// as zsh calls one function from another) is over.
pub(super) fn chain(zw: &mut Zw<'_, '_>, r: WResult, k: Then) -> WResult {
	match r {
		WResult::Done(_) => k(zw),
		WResult::Await(what, cont) => then(what, move |zw, got| {
			let r = cont.resume(zw, got);
			chain(zw, r, k)
		}),
	}
}

/// zsh `zle_setline(he)` of ring position `i`, its `zle-history-line-set`
/// hook run, then `k`.
pub(super) fn setline_then(zw: &mut Zw<'_, '_>, h: &Hist, i: usize, k: Then) -> WResult {
	hist::setline_at(zw.ed, h, i);
	run_hooks(zw, k)
}

/// `isset(HISTFINDNODUPS)` and the entry is a duplicate.
fn skip_dup(nodups: bool, h: &Hist, i: usize) -> bool {
	nodups && h.flags_at(i) & HIST_DUP != 0
}

/// zsh `GETZLETEXT(he)` as characters.
fn zt_at(ed: &Editor, h: &Hist, i: usize) -> Vec<char> {
	to_line(&hist::zle_text(ed, h, i))
}

/// The prefix `history-search-*` look for: the first word of the line
/// and the blank after it, kept from the last search while the editor is
/// still where that left it (zsh's `srch_str` logic). `forward`:
/// `history-search-forward`, which aligns the cursor instead of the
/// prefix end on combining characters (as zsh does).
fn search_prefix(st: &mut SearchState, ed: &mut Editor, curhist: i64, forward: bool) -> Vec<char> {
	let line = from_line(&ed.line);
	let old = from_line(&st.srch_str);
	let n = st.histpos;
	let same_prefix = old.get(..n).unwrap_or(&old) == line.get(..n).unwrap_or(&line);
	if ed.histline == curhist
		|| ed.histline != st.srch_hl
		|| Some(ed.cs) != st.srch_cs
		|| ed.mark != 0
		|| !same_prefix
	{
		let ll = ed.line.len();
		let mut p = ed.line.iter().take_while(|&&c| !iblank(c)).count();
		if p < ll {
			p += 1;
		}
		if forward {
			utils::ccright(ed);
		} else {
			utils::alignmultiwordright(ed, &mut p, true);
		}
		st.histpos = p;
		st.srch_str = ed.line[..p.min(ll)].to_vec();
	}
	st.srch_str.clone()
}

/// zsh `historysearchbackward` (`dir` -1) and `historysearchforward`.
fn history_search(zw: &mut Zw<'_, '_>, dir: i64) -> WResult {
	let n = zw.mult();
	if n < 0 {
		zw.ed.zmod.mult = -n;
		let r = history_search(zw, -dir);
		zw.ed.zmod.mult = n;
		return r;
	}
	let Some(h) = hist::load(zw) else {
		return WResult::Done(1);
	};
	let curhist = h.st.curhist;
	let has_arg = !zw.args.is_empty();
	let needle = match zw.args.first() {
		Some(a) => to_line(a),
		None => search_prefix(&mut zw.zle.hsearch, zw.ed, curhist, dir > 0),
	};
	let Some(mut i) = h.index_of(zw.ed.histline) else {
		return WResult::Done(1);
	};
	let nodups = zw.isset(ZshOpt::Histfindnodups);
	let flags = hist::skip_flags(zw.ed);
	let mut n = n;
	while let Some(j) = h.movehistent(i, dir, flags) {
		i = j;
		if skip_dup(nodups, &h, i) {
			continue;
		}
		let zt = zt_at(zw.ed, &h, i);
		let limit = if dir < 0 {
			0
		} else {
			i32::from(h.num_at(i) == curhist)
		};
		if zlinecmp(&zt, &needle) < limit && (has_arg || zt != zw.ed.line) {
			n -= 1;
			if n <= 0 {
				return setline_then(
					zw,
					&h,
					i,
					after(|zw| {
						zw.zle.hsearch.srch_hl = zw.ed.histline;
						zw.zle.hsearch.srch_cs = Some(zw.ed.cs);
						WResult::Done(0)
					}),
				);
			}
		}
	}
	WResult::Done(1)
}

/// Widget `history-search-backward` (`zle history-search-backward [str]`).
pub fn historysearchbackward(zw: &mut Zw<'_, '_>) -> WResult {
	history_search(zw, -1)
}

/// Widget `history-search-forward` (`zle history-search-forward [str]`).
pub fn historysearchforward(zw: &mut Zw<'_, '_>) -> WResult {
	history_search(zw, 1)
}

/// zsh `historybeginningsearchbackward` (`dir` -1) and
/// `historybeginningsearchforward`: the next line starting with the
/// buffer up to the cursor, the cursor kept.
fn history_beginning_search(zw: &mut Zw<'_, '_>, dir: i64) -> WResult {
	let n = zw.mult();
	if n < 0 {
		zw.ed.zmod.mult = -n;
		let r = history_beginning_search(zw, -dir);
		zw.ed.zmod.mult = n;
		return r;
	}
	let cpos = zw.ed.cs;
	let Some(h) = hist::load(zw) else {
		return WResult::Done(1);
	};
	let curhist = h.st.curhist;
	let Some(mut i) = h.index_of(zw.ed.histline) else {
		return WResult::Done(1);
	};
	let nodups = zw.isset(ZshOpt::Histfindnodups);
	let flags = hist::skip_flags(zw.ed);
	let mut n = n;
	while let Some(j) = h.movehistent(i, dir, flags) {
		i = j;
		if skip_dup(nodups, &h, i) {
			continue;
		}
		let zt = zt_at(zw.ed, &h, i);
		let prefix = &zw.ed.line[..cpos.min(zw.ed.line.len())];
		let limit = if dir < 0 {
			0
		} else {
			i32::from(h.num_at(i) == curhist)
		};
		if zlinecmp(&zt, prefix) < limit && zlinecmp(&zt, &zw.ed.line) != 0 {
			n -= 1;
			if n <= 0 {
				return setline_then(
					zw,
					&h,
					i,
					after(move |zw| {
						zw.ed.cs = cpos;
						utils::ccright(zw.ed);
						WResult::Done(0)
					}),
				);
			}
		}
	}
	WResult::Done(1)
}

/// Widget `history-beginning-search-backward`.
pub fn historybeginningsearchbackward(zw: &mut Zw<'_, '_>) -> WResult {
	history_beginning_search(zw, -1)
}

/// Widget `history-beginning-search-forward`.
pub fn historybeginningsearchforward(zw: &mut Zw<'_, '_>) -> WResult {
	history_beginning_search(zw, 1)
}

/// zsh `uplineorsearch` (`up` true) and `downlineorsearch`: a line within
/// the buffer, else `history-search-*` by the lines left.
fn line_or_search(zw: &mut Zw<'_, '_>, up: bool) -> WResult {
	let ocs = zw.ed.cs;
	let n = if up {
		utils::upline(zw)
	} else {
		utils::downline(zw)
	};
	if n == 0 {
		return WResult::Done(0);
	}
	zw.ed.cs = ocs;
	if zw.ed.ls.virangeflag || zw.ed.flags & readflags::HISTORY == 0 {
		return WResult::Done(1);
	}
	let m = zw.ed.zmod.mult;
	zw.ed.zmod.mult = n;
	let r = history_search(zw, if up { -1 } else { 1 });
	zw.ed.zmod.mult = m;
	r
}

/// Widget `up-line-or-search`.
pub fn uplineorsearch(zw: &mut Zw<'_, '_>) -> WResult {
	line_or_search(zw, true)
}

/// Widget `down-line-or-search`.
pub fn downlineorsearch(zw: &mut Zw<'_, '_>) -> WResult {
	line_or_search(zw, false)
}

/// zsh `infernexthist(he)`: the line after the newest line, two or more
/// before ring position `i`, that is the same as the buffer.
fn infernexthist(ed: &Editor, h: &Hist, i: usize) -> Option<usize> {
	let mut j = h.movehistent(i, -2, HIST_FOREIGN);
	while let Some(k) = j {
		if zlinecmp(&zt_at(ed, h, k), &ed.line) == 0 {
			return h.movehistent(k, 1, HIST_FOREIGN);
		}
		j = h.movehistent(k, -1, HIST_FOREIGN);
	}
	None
}

/// Widget `accept-and-infer-next-history` (zsh
/// `acceptandinfernexthistory`): accept the line; the next one starts
/// with the line that followed it the last time.
pub fn acceptandinfernexthistory(zw: &mut Zw<'_, '_>) -> WResult {
	let Some(h) = hist::load(zw) else {
		return WResult::Done(1);
	};
	let Some(top) = h.ring_len().checked_sub(1) else {
		return WResult::Done(1);
	};
	let Some(i) = infernexthist(zw.ed, &h, top) else {
		return WResult::Done(1);
	};
	zw.zle.bufstack.push(BString::from(h.text_at(i)));
	zw.ed.done = true;
	zw.zle.stack_hist = Some(h.num_at(i));
	WResult::Done(0)
}

/// Widget `infer-next-history` (zsh `infernexthistory`).
pub fn infernexthistory(zw: &mut Zw<'_, '_>) -> WResult {
	let Some(h) = hist::load(zw) else {
		return WResult::Done(1);
	};
	let Some(cur) = h.index_of(zw.ed.histline) else {
		return WResult::Done(1);
	};
	let Some(i) = infernexthist(zw.ed, &h, cur) else {
		return WResult::Done(1);
	};
	hist::setline_at(zw.ed, &h, i);
	WResult::Done(0)
}

/// Widget `set-local-history` (zsh `setlocalhistory`): with a numeric
/// argument, history motions skip other sessions' lines when it is not
/// zero; without one, toggle.
pub const fn setlocalhistory(zw: &mut Zw<'_, '_>) -> WResult {
	let ed = &mut *zw.ed;
	if ed.zmod.flags & modflags::MULT != 0 {
		ed.ls.localhistory = ed.zmod.mult != 0;
	} else {
		ed.ls.localhistory = !ed.ls.localhistory;
	}
	WResult::Done(0)
}

/// zsh `zstrtol(s, NULL, 10)`.
fn strtol10(s: &[u8]) -> i64 {
	let mut i = s
		.iter()
		.take_while(|&&c| matches!(c, b' ' | b'\t' | b'\n'))
		.count();
	let neg = s.get(i) == Some(&b'-');
	if neg || s.get(i) == Some(&b'+') {
		i += 1;
	}
	let mut v: i64 = 0;
	while let Some(d) = s.get(i).filter(|c| c.is_ascii_digit()) {
		v = v.wrapping_mul(10).wrapping_add(i64::from(d - b'0'));
		i += 1;
	}
	if neg { v.wrapping_neg() } else { v }
}

/// The shell words of the line being edited (zsh `bufferwords(NULL, …)`):
/// with the earlier lines of a continued command in front.
fn line_words(ed: &Editor, h: &Hist) -> Vec<Vec<char>> {
	let mut text = Vec::new();
	if !ed.isfirstln
		&& let Some(c) = &h.curline
	{
		text.extend_from_slice(&c.chline);
	}
	text.extend_from_slice(&from_line(&ed.line));
	bufferwords(
		&metafy(&text),
		0,
		crate::bash::syntax::Features::ZSH | crate::bash::syntax::Features::ZSH_SHORT_LOOPS,
	)
	.iter()
	.map(|w| to_line(&unmetafy(w)))
	.collect()
}

/// Widget `insert-last-word` (zsh `insertlastword`; `zle insert-last-word
/// [step [word [reset]]]`): the last word (or the numeric argument's) of
/// the previous history line; run again right after itself, it replaces
/// that word with the one of the line before.
pub fn insertlastword(zw: &mut Zw<'_, '_>) -> WResult {
	let Some(h) = hist::load(zw) else {
		return WResult::Done(1);
	};
	let curhist = h.st.curhist;
	let args = zw.args;
	let mut histstep = -1;
	let mut wordpos = 0;
	let st = &mut zw.zle.hsearch;
	if let Some(a) = args.first() {
		histstep = strtol10(a);
		if let Some(b) = args.get(1) {
			wordpos = strtol10(b);
			if args.len() > 2 {
				st.lasthist = curhist;
			}
		}
	}
	// zsh's `!*args` once `args` has moved past the arguments read: only
	// a third argument stops the search for a line with words.
	let more_args = args.len() > 2;
	let ed = &mut *zw.ed;
	// zsh `fixsuffix`.
	ed.ls.suffixlen = 0;
	let lastlen = st.lastinsert.len();
	let mut deleteword = lastlen != 0
		&& st.lastpos <= ed.cs
		&& lastlen == ed.cs - st.lastpos
		&& ed.line[st.lastpos..ed.cs] == st.lastinsert[..];
	if !deleteword {
		st.lasthist = curhist;
	}
	let mut evhist = if histstep == 0 {
		st.lasthist
	} else {
		h.addhistnum(st.lasthist, histstep, HIST_FOREIGN)
	};
	let (words, he) = if evhist == curhist {
		if deleteword {
			let pos = ed.cs;
			ed.cs = st.lastpos;
			utils::foredel(ed, pos - ed.cs, utils::cutflags::RAW);
			deleteword = false;
		}
		(Some(line_words(ed, &h)), None)
	} else {
		let mut he = h.index_of(evhist);
		while let Some(i) = he
			&& histstep == -1
			&& !more_args
		{
			if !h.words_at(i).is_empty() {
				break;
			}
			evhist = h.addhistnum(evhist, histstep, HIST_FOREIGN);
			he = h.index_of(evhist);
		}
		match he {
			Some(i) if h.words_at(i).len() >= 2 => (None, Some(i)),
			_ => return WResult::Done(1),
		}
	};
	let nwords = match (&words, he) {
		(Some(w), _) => i64::try_from(w.len()).unwrap_or(i64::MAX),
		(None, Some(i)) => i64::try_from(h.words_at(i).len() / 2).unwrap_or(i64::MAX),
		(None, None) => 0,
	};
	let zmult = ed.zmod.mult;
	let n = if wordpos != 0 {
		if wordpos > 0 {
			wordpos
		} else {
			nwords + wordpos + 1
		}
	} else if zmult > 0 {
		nwords - (zmult - 1)
	} else {
		1 - zmult
	};
	if n < 1 || n > nwords {
		st.lasthist = evhist;
		return WResult::Done(1);
	}
	if deleteword {
		let pos = ed.cs;
		ed.cs = st.lastpos;
		utils::foredel(ed, pos - ed.cs, utils::cutflags::RAW);
	}
	let k = usize::try_from(n - 1).unwrap_or(0);
	let word = match (words, he) {
		(Some(w), _) => w.into_iter().nth(k).unwrap_or_default(),
		(None, Some(i)) => {
			let b = h.words_at(i);
			let text = h.text_at(i);
			let at = |j: usize| b.get(j).and_then(|&o| usize::try_from(o).ok()).unwrap_or(0);
			let (s, t) = (at(2 * k), at(2 * k + 1));
			to_line(text.get(s..t.min(text.len())).unwrap_or_default())
		},
		(None, None) => Vec::new(),
	};
	st.lasthist = evhist;
	st.lastpos = ed.cs;
	st.lastinsert.clone_from(&word);
	ed.zmod.mult = 1;
	utils::doinsert(ed, &word);
	ed.zmod.mult = zmult;
	WResult::Done(0)
}

/// Widget `vi-fetch-history` (zsh `vifetchhistory`): history line
/// `zmult`, or without a numeric argument the line being read.
pub fn vifetchhistory(zw: &mut Zw<'_, '_>) -> WResult {
	if zw.mult() < 0 {
		return WResult::Done(1);
	}
	let cur = hist::curhist(zw.cx.store, zw.vp);
	let has_mult = zw.ed.zmod.flags & modflags::MULT != 0;
	if zw.ed.histline == cur && !has_mult {
		zw.ed.cs = zw.ed.line.len();
		zw.ed.cs = utils::findbol(zw.ed);
		return WResult::Done(0);
	}
	let ev = if has_mult { zw.mult() } else { cur };
	if !hist::zle_goto_hist(zw, ev, 0, false) && zw.isset(ZshOpt::Histbeep) {
		return WResult::Done(1);
	}
	WResult::Done(0)
}

/// zsh `ZC_iident`.
fn iident(c: char) -> bool {
	c == '_' || c.is_alphanumeric()
}

/// zsh `getvisrchstr`: read the search string after `/` or `?` in the
/// status line, then run `done` with whether one was entered.
fn getvisrchstr(zw: &mut Zw<'_, '_>, done: fn(&mut Zw<'_, '_>, bool) -> WResult) -> WResult {
	let st = &mut zw.zle.hsearch;
	st.vipenultsrchstr = st.visrchstr.take();
	zw.ed.clearlist = true;
	let lead = if st.visrchsense == -1 { '?' } else { '/' };
	let okeymap = zw.ed.keymap.clone();
	let _ = exec::selectkeymap(&zw.zle.keymaps, zw.ed, b"main", true);
	visrch_key(zw, ViRead { lead, sbuf: Vec::new(), okeymap, done })
}

/// The vi search string being read.
struct ViRead {
	/// `/` or `?`.
	lead:    char,
	/// The text after it.
	sbuf:    Vec<char>,
	/// The keymap to go back to.
	okeymap: BString,
	/// What runs once it is read.
	done:    fn(&mut Zw<'_, '_>, bool) -> WResult,
}

/// The status line of the vi search being read, `cursor` after the text.
fn visrch_status(r: &ViRead, cursor: char) -> BString {
	let mut s = Vec::with_capacity(r.sbuf.len() + 2);
	s.push(r.lead);
	s.extend_from_slice(&r.sbuf);
	s.push(cursor);
	from_line(&s)
}

/// One round of `getvisrchstr`'s loop: show, then read a key command.
fn visrch_key(zw: &mut Zw<'_, '_>, r: ViRead) -> WResult {
	zw.ed.statusline = Some(visrch_status(&r, '_'));
	display::refresh(zw);
	then(Await::Key, move |zw, got| visrch_cmd(zw, r, got))
}

/// The end of `getvisrchstr`.
fn visrch_end(zw: &mut Zw<'_, '_>, r: ViRead, ret: bool) -> WResult {
	zw.ed.statusline = None;
	let _ = exec::selectkeymap(&zw.zle.keymaps, zw.ed, &r.okeymap, true);
	(r.done)(zw, ret)
}

/// A key command read by `getvisrchstr`.
fn visrch_cmd(zw: &mut Zw<'_, '_>, mut r: ViRead, got: Got) -> WResult {
	let Got::Key(Some(mut cmd)) = got else {
		return visrch_end(zw, r, false);
	};
	match cmd.as_slice() {
		b"send-break" => return visrch_end(zw, r, false),
		b"magic-space" => {
			misc::fixmagicspace(zw.ed);
			cmd = BString::from("self-insert");
		},
		_ => {},
	}
	let mut feep = false;
	match cmd.as_slice() {
		b"redisplay" => {
			let _ = redisplay(zw);
		},
		b"clear-screen" => {
			let _ = clear_screen(zw);
		},
		b"accept-line" | b"vi-cmd-mode" => {
			let st = &mut zw.zle.hsearch;
			st.visrchstr = if r.sbuf.is_empty() {
				st.vipenultsrchstr.clone()
			} else {
				Some(r.sbuf.clone())
			};
			return visrch_end(zw, r, true);
		},
		b"backward-delete-char" | b"vi-backward-delete-char" => {
			r.sbuf.pop();
		},
		b"backward-kill-word" | b"vi-backward-kill-word" => {
			while r.sbuf.last().is_some_and(|&c| iblank(c)) {
				r.sbuf.pop();
			}
			if let Some(&c) = r.sbuf.last() {
				if iident(c) {
					while r.sbuf.last().is_some_and(|&c| iident(c)) {
						r.sbuf.pop();
					}
				} else {
					while r.sbuf.last().is_some_and(|&c| !iident(c) && !iblank(c)) {
						r.sbuf.pop();
					}
				}
			}
		},
		b"vi-quoted-insert" | b"quoted-insert" => {
			if cmd.as_slice() == b"vi-quoted-insert" {
				zw.ed.statusline = Some(visrch_status(&r, '^'));
				display::refresh(zw);
			}
			return then(Await::Char, move |zw, got| {
				let mut r = r;
				match got {
					Got::Char(Some(c)) => r.sbuf.push(c),
					_ => {
						utils::handlefeep(zw.ed);
					},
				}
				visrch_key(zw, r)
			});
		},
		b"self-insert-unmeta" | b"self-insert" => {
			if cmd.as_slice() == b"self-insert-unmeta" {
				misc::fixunmeta(zw.ed);
			}
			if let Some(c) = zw.ed.lastchar_wide {
				r.sbuf.push(c);
			} else {
				utils::handlefeep(zw.ed);
				return visrch_key(zw, r);
			}
		},
		_ => feep = true,
	}
	if feep {
		utils::handlefeep(zw.ed);
	}
	visrch_key(zw, r)
}

/// zsh `virepeatsearch`: the next line (in the last vi search's
/// direction) other than the buffer containing the search string (at
/// its start for `^…`).
fn vi_repeat(zw: &mut Zw<'_, '_>) -> i32 {
	let Some(pat) = zw.zle.hsearch.visrchstr.clone() else {
		return 1;
	};
	let mut n = zw.mult();
	if n < 0 {
		n = -n;
		zw.zle.hsearch.visrchsense = -zw.zle.hsearch.visrchsense;
	}
	let sense = zw.zle.hsearch.visrchsense;
	if sense == 0 {
		return 1;
	}
	let Some(h) = hist::load(zw) else {
		return 1;
	};
	let Some(mut i) = h.index_of(zw.ed.histline) else {
		return 1;
	};
	let nodups = zw.isset(ZshOpt::Histfindnodups);
	let flags = hist::skip_flags(zw.ed);
	while let Some(j) = h.movehistent(i, sense, flags) {
		i = j;
		if skip_dup(nodups, &h, i) {
			continue;
		}
		let zt = zt_at(zw.ed, &h, i);
		let found = match pat.split_first() {
			Some(('^', rest)) => zt.starts_with(rest),
			_ => zlinefind(&zt, 0, &pat, 1, 1).is_some(),
		};
		if zlinecmp(&zt, &zw.ed.line) != 0 && found {
			n -= 1;
			if n <= 0 {
				hist::setline_at(zw.ed, &h, i);
				return 0;
			}
		}
	}
	1
}

/// Widget `vi-repeat-search`.
pub fn virepeatsearch(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(vi_repeat(zw))
}

/// Widget `vi-rev-repeat-search`.
pub fn virevrepeatsearch(zw: &mut Zw<'_, '_>) -> WResult {
	let st = &mut zw.zle.hsearch;
	st.visrchsense = -st.visrchsense;
	let r = vi_repeat(zw);
	let st = &mut zw.zle.hsearch;
	st.visrchsense = -st.visrchsense;
	WResult::Done(r)
}

/// zsh `vihistorysearchbackward` (`sense` -1) and
/// `vihistorysearchforward`: search for the argument, or for a string
/// read after `?`/`/`.
fn vi_history_search(zw: &mut Zw<'_, '_>, sense: i64) -> WResult {
	if let Some(a) = zw.args.first() {
		let st = &mut zw.zle.hsearch;
		let ose = std::mem::replace(&mut st.visrchsense, sense);
		let ost = st.visrchstr.replace(to_line(a));
		let ret = vi_repeat(zw);
		let st = &mut zw.zle.hsearch;
		st.visrchsense = ose;
		st.visrchstr = ost;
		return WResult::Done(ret);
	}
	zw.zle.hsearch.visrchsense = sense;
	getvisrchstr(zw, |zw, ok| WResult::Done(if ok { vi_repeat(zw) } else { 1 }))
}

/// Widget `vi-history-search-backward`.
pub fn vihistorysearchbackward(zw: &mut Zw<'_, '_>) -> WResult {
	vi_history_search(zw, -1)
}

/// Widget `vi-history-search-forward`.
pub fn vihistorysearchforward(zw: &mut Zw<'_, '_>) -> WResult {
	vi_history_search(zw, 1)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn chars(s: &str) -> Vec<char> {
		s.chars().collect()
	}

	#[test]
	fn zlinecmp_orders_like_zsh() {
		assert_eq!(zlinecmp(&chars("echo"), &chars("echo")), 0);
		assert_eq!(zlinecmp(&chars("echo hi"), &chars("echo")), -1);
		assert_eq!(zlinecmp(&chars("ECHO"), &chars("echo")), 1);
		assert_eq!(zlinecmp(&chars("ECHO hi"), &chars("echo")), 2);
		assert_eq!(zlinecmp(&chars("echo"), &chars("ECHO")), 3);
		assert_eq!(zlinecmp(&chars("ls"), &chars("echo")), 3);
		assert_eq!(zlinecmp(&chars(""), &chars("")), 0);
	}

	#[test]
	fn zlinefind_both_ways() {
		let h = chars("abcabc");
		assert_eq!(zlinefind(&h, 0, &chars("bc"), 1, 1), Some(1));
		assert_eq!(zlinefind(&h, 2, &chars("bc"), 1, 1), Some(4));
		assert_eq!(zlinefind(&h, 6, &chars("bc"), -1, 1), Some(4));
		assert_eq!(zlinefind(&h, 3, &chars("bc"), -1, 1), Some(1));
		assert_eq!(zlinefind(&h, 0, &chars("BC"), 1, 3), None);
		assert_eq!(zlinefind(&chars("aBC"), 0, &chars("bc"), 1, 3), Some(1));
		assert_eq!(zlinefind(&chars("aBC"), 0, &chars("bc"), 1, 1), None);
	}

	#[test]
	fn strtol10_reads_like_zstrtol() {
		assert_eq!(strtol10(b" -2x"), -2);
		assert_eq!(strtol10(b"+7"), 7);
		assert_eq!(strtol10(b"010"), 10);
		assert_eq!(strtol10(b"z"), 0);
	}

	#[test]
	fn search_prefix_is_the_first_word() {
		let mut st = SearchState::default();
		let mut ed = Editor::new(super::super::super::Context::LineStart, 0);
		ed.line = chars("echo hi there");
		ed.histline = 5;
		assert_eq!(search_prefix(&mut st, &mut ed, 5, false), chars("echo "));
		ed.line = chars("ls");
		assert_eq!(search_prefix(&mut st, &mut ed, 5, false), chars("ls"));
		assert_eq!(st.histpos, 2);
	}
}
