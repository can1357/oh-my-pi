//! The incremental history search of zsh 5.9 (`doisearch` in
//! `zle_hist.c`): `history-incremental-search-*` and
//! `history-incremental-pattern-search-*`.
//!
//! The search reads key commands through the `isearch` local keymap and
//! `main`, shows `bck-i-search: text_` (`failing …`/`invalid …` when
//! nothing matches or the pattern is bad) in the status line, keeps a stack
//! of the positions it went through (zsh `isrch_spots`) so deleting a
//! character goes back, calls `zle-isearch-update` before each key and
//! `zle-isearch-exit` at the end, and leaves `$LASTSEARCH` /
//! `$LASTABORTEDSEARCH`. The match is `$ISEARCHMATCH_START`/`_END` while
//! `$ISEARCHMATCH_ACTIVE` (and the `isearch` highlight).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::sync::Arc;

use bstr::BString;

use super::{
	super::{
		bindkey,
		display::{self, clear_screen, redisplay},
		exec::{self, Await, Got, WResult, Zw, then},
		from_line,
		hist::{self, zlinecmp, zlinefind},
		readflags, to_line, utils,
	},
	builtin,
	hist_search::{Then, after, chain, run_hooks, setline_then},
	misc,
	yank::Paste,
};
use crate::bash::{
	pattern::zsh::{PatFlags, Pattern, getmatchlist, remnulargs, tokenize},
	syntax::zsh::tok::metafy,
	vm::{
		builtins::history::model::{HIST_DUP, Hist},
		zsh::zpattern::{self, CharEnvBuf},
	},
	zshopt::ZshOpt,
};

/// zsh `FAILING_TEXT`.
const FAILING: &[u8] = b"failing";
/// zsh `INVALID_TEXT`.
const INVALID: &[u8] = b"invalid";

/// zsh `struct isrch_spot`: where the search was, to go back to.
#[derive(Clone, Copy, Debug, Default)]
struct Spot {
	hl:      i64,
	pos:     usize,
	pat_hl:  i64,
	pat_pos: usize,
	end_pos: usize,
	cs:      usize,
	len:     usize,
	dir:     i64,
	nomatch: u8,
}

/// `doisearch`'s locals.
struct Isearch {
	/// The search string (zsh `sbuf`, `sbptr` its length).
	sbuf:          Vec<char>,
	/// zsh `top_spot` and the spots.
	top_spot:      usize,
	spots:         Vec<Spot>,
	/// 1: failing, 2: invalid pattern.
	nomatch:       u8,
	skip_line:     bool,
	skip_pos:      bool,
	/// zsh `odir`, `dir`.
	odir:          i64,
	dir:           i64,
	/// `fwd`/`bck` as the status line shows it (zsh copies it into `ibuf`
	/// only at some points).
	shown_dir:     i64,
	/// The status line starts with `failing`/`invalid` (zsh `statusline =
	/// ibuf`) and which one (zsh's first bytes of `ibuf`).
	status_full:   bool,
	bad:           &'static [u8],
	/// zsh `sens`: 3 lets lower case match upper case.
	sens:          i32,
	pattern:       bool,
	hl:            i64,
	pos:           usize,
	pat_hl:        i64,
	pat_pos:       usize,
	revert_patpos: bool,
	dup_ok:        bool,
	end_pos:       usize,
	savekeys:      Option<usize>,
	feep:          bool,
	nosearch:      bool,
	okeymap:       BString,
	patprog:       Option<Arc<Pattern>>,
	/// Match ranges (characters) in the line being looked at.
	matchlist:     Option<Vec<(usize, usize)>>,
	/// The accept widget to run on the way out.
	exitfn:        Option<&'static str>,
	aborted:       bool,
	/// zsh `zt`: the text of history line `hl`.
	zt:            Vec<char>,
	last_line:     Vec<char>,
	env:           CharEnvBuf,
}

impl Isearch {
	/// zsh `set_isrch_spot(num, …)` from the current state.
	fn set_spot(&mut self, num: usize, cs: usize) {
		if num >= self.spots.len() {
			self.spots.resize(num + 1, Spot::default());
		}
		self.spots[num] = Spot {
			hl: self.hl,
			pos: self.pos,
			pat_hl: self.pat_hl,
			pat_pos: self.pat_pos,
			end_pos: self.end_pos,
			cs,
			len: self.sbuf.len(),
			dir: self.dir,
			nomatch: self.nomatch,
		};
	}

	/// zsh `set_isrch_spot(top_spot++, …)`.
	fn push_spot(&mut self, cs: usize) {
		self.set_spot(self.top_spot, cs);
		self.top_spot += 1;
	}

	/// zsh `get_isrch_spot(num, …)`: the cursor it had.
	fn get_spot(&mut self, num: usize) -> usize {
		let s = self.spots.get(num).copied().unwrap_or_default();
		self.hl = s.hl;
		self.pos = s.pos;
		self.pat_hl = s.pat_hl;
		self.pat_pos = s.pat_pos;
		self.end_pos = s.end_pos;
		self.sbuf.truncate(s.len);
		self.dir = s.dir;
		self.nomatch = s.nomatch;
		s.cs
	}

	/// The search string is anchored (`^…`).
	fn anchored(&self) -> bool {
		self.sbuf.first() == Some(&'^')
	}

	/// zsh's status line: `ibuf` or `ibuf + NORM_PROMPT_POS`, with
	/// `cursor` after the search string.
	fn status(&self, cursor: char) -> BString {
		let mut s = BString::default();
		if self.status_full {
			s.extend_from_slice(self.bad);
			s.push(b' ');
		}
		s.extend_from_slice(if self.shown_dir == 1 { b"fwd" } else { b"bck" });
		s.extend_from_slice(b"-i-search: ");
		s.extend_from_slice(&from_line(&self.sbuf));
		s.extend_from_slice(&from_line(&[cursor]));
		s
	}
}

/// Widget `history-incremental-search-backward`.
pub fn historyincrementalsearchbackward(zw: &mut Zw<'_, '_>) -> WResult {
	doisearch(zw, -1, false)
}

/// Widget `history-incremental-search-forward`.
pub fn historyincrementalsearchforward(zw: &mut Zw<'_, '_>) -> WResult {
	doisearch(zw, 1, false)
}

/// Widget `history-incremental-pattern-search-backward`.
pub fn historyincrementalpatternsearchbackward(zw: &mut Zw<'_, '_>) -> WResult {
	doisearch(zw, -1, true)
}

/// Widget `history-incremental-pattern-search-forward`.
pub fn historyincrementalpatternsearchforward(zw: &mut Zw<'_, '_>) -> WResult {
	doisearch(zw, 1, true)
}

/// zsh `GETZLETEXT(he)` of history line `hl` (empty when there is none).
fn zt_of(zw: &Zw<'_, '_>, h: &Hist, hl: i64) -> Vec<char> {
	h.index_of(hl)
		.map_or_else(Vec::new, |i| to_line(&hist::zle_text(zw.ed, h, i)))
}

/// zsh `doisearch(args, dir, pattern)`.
fn doisearch(zw: &mut Zw<'_, '_>, dir: i64, pattern: bool) -> WResult {
	let Some(h) = hist::load(zw) else {
		return WResult::Done(1);
	};
	let hl = zw.ed.histline;
	let Some(he) = h.index_of(hl) else {
		return WResult::Done(1);
	};
	let env = zw.params(zpattern::char_env).unwrap_or_default();
	zw.ed.localkeymap = Some(BString::from("isearch"));
	zw.ed.clearlist = true;
	let mut savekeys = None;
	if let Some(a) = zw.args.first() {
		savekeys = Some(zw.ed.unget.len());
		for &b in bindkey::getkeys(a).iter().rev() {
			zw.ed.unget.push_front(b);
		}
	}
	let okeymap = zw.ed.keymap.clone();
	let _ = exec::selectkeymap(&zw.zle.keymaps, zw.ed, b"main", true);
	hist::remember_edits(zw.ed, &h);
	let zt = to_line(&hist::zle_text(zw.ed, &h, he));
	let cs = zw.ed.cs;
	let s = Isearch {
		sbuf: Vec::new(),
		top_spot: 0,
		spots: Vec::new(),
		nomatch: 0,
		skip_line: false,
		skip_pos: false,
		odir: dir,
		dir,
		shown_dir: dir,
		status_full: false,
		bad: b"XXXXXXX",
		sens: if zw.mult() == 1 { 3 } else { 1 },
		pattern,
		hl,
		pos: cs,
		pat_hl: hl,
		pat_pos: cs,
		revert_patpos: false,
		dup_ok: false,
		end_pos: 0,
		savekeys,
		feep: false,
		nosearch: false,
		okeymap,
		patprog: None,
		matchlist: None,
		exitfn: None,
		aborted: false,
		zt,
		last_line: Vec::new(),
		env,
	};
	top(zw, Box::new(s))
}

/// zsh `isearch_newpos`: the match at or before (`dir` < 0) or at or
/// after `curpos`: its start and end.
fn isearch_newpos(list: &[(usize, usize)], curpos: i64, dir: i64) -> Option<(usize, usize)> {
	let at = |b: usize| i64::try_from(b).unwrap_or(i64::MAX);
	if dir < 0 {
		list.iter().rev().find(|&&(b, _)| at(b) <= curpos).copied()
	} else {
		list.iter().find(|&&(b, _)| at(b) >= curpos).copied()
	}
}

/// The character index of metafied byte offset `off` in the metafied
/// form of `chars`.
fn char_index(chars: &[char], off: usize) -> usize {
	let mut bytes = 0;
	for (i, &c) in chars.iter().enumerate() {
		if bytes >= off {
			return i;
		}
		bytes += metafy(&from_line(&[c])).len();
	}
	chars.len()
}

/// Compile the search string as a pattern (zsh's `patcompile` with
/// `PAT_NOANCH`, `PAT_SCAN` unless anchored, `PAT_LCMATCHUC` for `sens`
/// 3); `None` when it is not a valid pattern.
fn compile(zw: &mut Zw<'_, '_>, s: &Isearch) -> Option<Arc<Pattern>> {
	let body = if s.anchored() {
		&s.sbuf[1..]
	} else {
		&s.sbuf[..]
	};
	let mut text = metafy(&from_line(body));
	tokenize(&mut text);
	remnulargs(&mut text);
	let mut flags = PatFlags::NOANCH;
	if !s.anchored() {
		flags |= PatFlags::SCAN;
	}
	if s.sens == 3 {
		flags |= PatFlags::LCMATCHUC;
	}
	zw.params(|ex| zpattern::try_compile(ex, &text, flags))
		.unwrap_or_default()
}

/// The top of `doisearch`'s loop: search for the string as it is now,
/// then show the result and read the next key command.
fn top(zw: &mut Zw<'_, '_>, mut s: Box<Isearch>) -> WResult {
	let Some(h) = hist::load(zw) else {
		return finish(zw, s);
	};
	let cs = zw.ed.cs;
	s.set_spot(s.top_spot, cs);
	let sbptr = s.sbuf.len();
	if sbptr == 1 && s.anchored() {
		zw.ed.cs = 0;
		s.nomatch = 0;
		s.status_full = false;
	} else if sbptr > 0 {
		let mut t: Option<usize> = None;
		s.last_line.clone_from(&s.zt);
		if s.pattern && s.patprog.is_none() && !s.nosearch {
			s.patprog = compile(zw, &s);
			s.matchlist = None;
			if s.patprog.is_some() {
				s.revert_patpos = true;
				s.skip_pos = false;
			} else {
				if s.nomatch != 2 {
					utils::handlefeep(zw.ed);
					s.nomatch = 2;
				}
				s.bad = INVALID;
				s.status_full = true;
			}
		}
		let nodups = zw.isset(ZshOpt::Histfindnodups);
		let flags = hist::skip_flags(zw.ed);
		let mut he = h.index_of(s.hl);
		while (!s.pattern || s.patprog.is_some()) && !s.nosearch {
			if let Some(prog) = s.patprog.clone() {
				if s.revert_patpos {
					s.revert_patpos = false;
					s.dup_ok = true;
					s.hl = s.pat_hl;
					he = h.index_of(s.hl);
					s.zt = zt_of(zw, &h, s.hl);
					s.pos = s.pat_pos;
				}
				if !s.skip_line {
					let subject = metafy(&from_line(&s.zt));
					let env = s.env.env();
					if s.anchored() {
						if !s.skip_pos
							&& let Some(len) = prog.try_match(&subject, &env, None)
						{
							s.end_pos = char_index(&s.zt, len);
							t = Some(0);
						}
					} else {
						if s.matchlist.is_none() && !s.skip_pos {
							let list: Vec<(usize, usize)> = getmatchlist(&subject, &prog, &env)
								.into_iter()
								.map(|r| (char_index(&s.zt, r.start), char_index(&s.zt, r.end)))
								.collect();
							if !list.is_empty() {
								s.matchlist = Some(list);
							}
						}
						if let Some(list) = &s.matchlist {
							let pos = i64::try_from(s.pos).unwrap_or(i64::MAX);
							let newpos = if !s.skip_pos {
								pos
							} else if s.dir < 0 {
								pos - 1
							} else {
								pos + 1
							};
							match isearch_newpos(list, newpos, s.dir) {
								Some((b, e)) => {
									s.end_pos = e;
									t = Some(b);
								},
								None => s.matchlist = None,
							}
						}
					}
				}
				s.skip_pos = false;
			} else {
				if s.skip_pos {
					if s.dir < 0 {
						if s.pos == 0 {
							s.skip_line = true;
						} else {
							s.pos -= 1;
						}
					} else if !s.anchored() {
						if s.pos + 1 >= s.zt.len() {
							s.skip_line = true;
						} else {
							s.pos += 1;
						}
					} else {
						s.skip_line = true;
					}
					s.skip_pos = false;
				}
				if !s.skip_line {
					if s.anchored() {
						if zlinecmp(&s.zt, &s.sbuf[1..]) < s.sens {
							t = Some(0);
						}
					} else {
						t = zlinefind(&s.zt, s.pos, &s.sbuf, if s.dir > 0 { 1 } else { -1 }, s.sens);
					}
					if let Some(tt) = t {
						s.end_pos = tt + s.sbuf.len() - usize::from(s.anchored());
					}
				}
			}
			if let Some(tt) = t {
				s.pos = tt;
				break;
			}
			// Not in this line: on through the history.
			let next = if zw.ed.flags & readflags::HISTORY == 0 {
				None
			} else {
				he.and_then(|i| h.movehistent(i, s.dir, flags))
			};
			let Some(i) = next else {
				let len = s.sbuf.len();
				if s.top_spot > 0 {
					let prev = s.spots.get(s.top_spot - 1).copied().unwrap_or_default();
					if len == prev.len && prev.nomatch != 0 {
						s.top_spot -= 1;
					}
				}
				zw.ed.cs = s.get_spot(s.top_spot);
				if s.nomatch != 1 {
					s.feep = true;
					s.nomatch = 1;
				}
				s.zt = zt_of(zw, &h, s.hl);
				s.skip_line = false;
				s.bad = if s.nomatch == 2 { INVALID } else { FAILING };
				s.status_full = true;
				break;
			};
			he = Some(i);
			s.hl = h.num_at(i);
			s.zt = to_line(&hist::zle_text(zw.ed, &h, i));
			s.pos = if s.dir == 1 { 0 } else { s.zt.len() };
			s.skip_line = if s.dup_ok {
				false
			} else if nodups {
				h.flags_at(i) & HIST_DUP != 0
			} else {
				s.zt == s.last_line
			};
		}
		s.dup_ok = false;
		if (t.is_some() || (s.nosearch && s.nomatch == 0))
			&& let Some(i) = h.index_of(s.hl)
		{
			let cs = if s.dir == 1 { s.end_pos } else { s.pos };
			return setline_then(
				zw,
				&h,
				i,
				after(move |zw| {
					zw.ed.cs = cs;
					s.status_full = false;
					s.nomatch = 0;
					top_tail(zw, s)
				}),
			);
		}
	} else {
		s.top_spot = 0;
		s.nomatch = 0;
		s.status_full = false;
	}
	top_tail(zw, s)
}

/// The rest of the top of the loop: beep if owed, the match for the
/// `isearch` highlight, then show and read.
fn top_tail(zw: &mut Zw<'_, '_>, mut s: Box<Isearch>) -> WResult {
	s.nosearch = false;
	if s.feep {
		utils::handlefeep(zw.ed);
		s.feep = false;
	}
	let sbptr = s.sbuf.len();
	if s.nomatch == 0 && sbptr > 0 && (sbptr > 1 || !s.anchored()) {
		if s.pos < s.end_pos {
			zw.ed.ls.isearch.0 = s.pos;
		}
		zw.ed.ls.isearch.1 = s.end_pos;
		zw.ed.ls.isearch_active = true;
	} else {
		zw.ed.ls.isearch_active = false;
	}
	show(zw, s)
}

/// zsh's `ref:` label: hooks, display, then the next key command.
fn show(zw: &mut Zw<'_, '_>, s: Box<Isearch>) -> WResult {
	zw.ed.statusline = Some(s.status('_'));
	run_hooks(
		zw,
		after(move |_| {
			then(Await::Hook { name: BString::from("zle-isearch-update"), arg: None }, move |_, _| {
				then(Await::RedrawHook, move |zw, _| {
					// The hooks may have shown something else.
					zw.ed.statusline = Some(s.status('_'));
					display::refresh(zw);
					then(Await::Key, move |zw, got| on_key(zw, s, got))
				})
			})
		}),
	)
}

/// The end of the loop's body: beep if owed and search again.
fn bottom(zw: &mut Zw<'_, '_>, mut s: Box<Isearch>) -> WResult {
	if s.feep {
		utils::handlefeep(zw.ed);
	}
	s.feep = false;
	top(zw, s)
}

/// zsh `ungetkeycmd`: the keys of the last command are read again.
fn ungetkeycmd(zw: &mut Zw<'_, '_>) {
	let keys = zw.ed.keybuf.clone();
	for &b in keys.iter().rev() {
		zw.ed.unget.push_front(b);
	}
}

/// A key command read during the search.
fn on_key(zw: &mut Zw<'_, '_>, mut s: Box<Isearch>, got: Got) -> WResult {
	let cmd = match got {
		Got::Key(Some(cmd)) if cmd.as_slice() != b"send-break" => cmd,
		_ => {
			s.aborted = true;
			zw.zle.last_aborted = from_line(&s.sbuf);
			let cs = s.get_spot(0);
			let Some(h) = hist::load(zw) else {
				return finish(zw, s);
			};
			let Some(i) = h.index_of(s.hl) else {
				return finish(zw, s);
			};
			s.zt = to_line(&hist::zle_text(zw.ed, &h, i));
			return setline_then(
				zw,
				&h,
				i,
				after(move |zw| {
					zw.ed.cs = cs;
					finish(zw, s)
				}),
			);
		},
	};
	match cmd.as_slice() {
		b"clear-screen" => {
			let r = clear_screen(zw);
			chain(zw, r, after(move |zw| show(zw, s)))
		},
		b"redisplay" => {
			let r = redisplay(zw);
			chain(zw, r, after(move |zw| show(zw, s)))
		},
		b"vi-cmd-mode" => {
			let to: &[u8] = if exec::invicmdmode(&zw.zle.keymaps, zw.ed) {
				b"main"
			} else {
				b"vicmd"
			};
			if exec::selectkeymap(&zw.zle.keymaps, zw.ed, to, false).is_err() {
				s.feep = true;
			}
			show(zw, s)
		},
		b"vi-backward-delete-char"
		| b"backward-delete-char"
		| b"vi-backward-kill-word"
		| b"backward-kill-word"
		| b"backward-delete-word" => {
			let only_one =
				matches!(cmd.as_slice(), b"vi-backward-delete-char" | b"backward-delete-char");
			let old_sbptr = s.sbuf.len();
			if s.top_spot > 0 {
				loop {
					s.top_spot -= 1;
					zw.ed.cs = s.get_spot(s.top_spot);
					if only_one || s.top_spot == 0 || old_sbptr != s.sbuf.len() {
						break;
					}
				}
				s.patprog = None;
				s.nosearch = true;
				s.skip_pos = false;
			} else {
				s.feep = true;
			}
			if s.nomatch != 0 {
				s.bad = if s.nomatch == 2 { INVALID } else { FAILING };
				s.status_full = true;
				s.skip_pos = true;
			}
			let Some(h) = hist::load(zw) else {
				return finish(zw, s);
			};
			s.zt = zt_of(zw, &h, s.hl);
			s.shown_dir = s.dir;
			let sbptr = s.sbuf.len();
			if (s.nomatch != 0 || sbptr == 0 || (sbptr == 1 && s.anchored()))
				&& let Some(i) = h.index_of(s.hl)
			{
				let cs = zw.ed.cs;
				return setline_then(
					zw,
					&h,
					i,
					after(move |zw| {
						zw.ed.cs = cs;
						top(zw, s)
					}),
				);
			}
			top(zw, s)
		},
		b"accept-and-hold"
		| b"accept-and-infer-next-history"
		| b"accept-line-and-down-history"
		| b"accept-line" => {
			s.exitfn = builtin(&String::from_utf8_lossy(&cmd)).map(|b| b.name);
			finish(zw, s)
		},
		b"history-incremental-search-backward"
		| b"history-incremental-pattern-search-backward"
		| b"history-incremental-search-forward"
		| b"history-incremental-pattern-search-forward"
		| b"vi-rev-repeat-search"
		| b"vi-repeat-search" => {
			s.pat_hl = s.hl;
			s.pat_pos = s.pos;
			let cs = zw.ed.cs;
			s.push_spot(cs);
			match cmd.as_slice() {
				b"vi-rev-repeat-search" => {
					s.dir = -s.odir;
					s.skip_pos = true;
				},
				b"vi-repeat-search" => {
					s.dir = s.odir;
					s.skip_pos = true;
				},
				c => {
					let want = if c.ends_with(b"backward") { -1 } else { 1 };
					if s.dir == want {
						s.skip_pos = true;
					} else {
						s.dir = want;
					}
				},
			}
			// zsh's `rpt:` label.
			if s.sbuf.is_empty() && !zw.zle.last_search.is_empty() && s.dir == s.odir {
				s.sbuf = to_line(&zw.zle.last_search);
			}
			s.shown_dir = s.dir;
			top(zw, s)
		},
		b"vi-quoted-insert" | b"quoted-insert" => {
			if cmd.as_slice() == b"vi-quoted-insert" {
				zw.ed.statusline = Some(s.status('^'));
				display::refresh(zw);
			}
			then(Await::Char, move |zw, got| {
				let mut s = s;
				if let Got::Char(Some(c)) = got {
					zw.ed.lastchar_wide = Some(c);
					insert(zw, s)
				} else {
					s.feep = true;
					bottom(zw, s)
				}
			})
		},
		b"bracketed-paste" => read_paste(zw, s, Paste::default()),
		b"accept-search" => finish(zw, s),
		b"self-insert-unmeta" => {
			misc::fixunmeta(zw.ed);
			insert(zw, s)
		},
		b"magic-space" => {
			misc::fixmagicspace(zw.ed);
			insert(zw, s)
		},
		b"self-insert" => {
			if zw.ed.lastchar_wide.is_none() {
				utils::handlefeep(zw.ed);
				return top(zw, s);
			}
			insert(zw, s)
		},
		_ => {
			ungetkeycmd(zw);
			finish(zw, s)
		},
	}
}

/// zsh's `ins:` label: the character typed joins the search string.
fn insert(zw: &mut Zw<'_, '_>, mut s: Box<Isearch>) -> WResult {
	// zsh limits the search string to `PATH_MAX` bytes.
	if from_line(&s.sbuf).len() == crate::sys::PATH_MAX {
		s.feep = true;
		return top(zw, s);
	}
	let cs = zw.ed.cs;
	s.push_spot(cs);
	if let Some(c) = zw.ed.lastchar_wide {
		s.sbuf.push(c);
	}
	s.patprog = None;
	bottom(zw, s)
}

/// zsh `bracketedstring()` during the search: the pasted text joins the
/// search string.
fn read_paste(_zw: &mut Zw<'_, '_>, s: Box<Isearch>, p: Paste) -> WResult {
	then(Await::Char, move |zw, got| {
		let mut p = p;
		let mut s = s;
		let end = match got {
			Got::Char(Some(c)) => utils::zlecharasstring(c).into_iter().any(|b| p.push(b)),
			_ => true,
		};
		if !end {
			return read_paste(zw, s, p);
		}
		let cs = zw.ed.cs;
		s.push_spot(cs);
		s.sbuf.extend(to_line(&p.finish()));
		s.patprog = None;
		bottom(zw, s)
	})
}

/// The end of `doisearch`: remember the search, run `zle-isearch-exit`,
/// then the accept widget the search ended with, if any.
fn finish(zw: &mut Zw<'_, '_>, s: Box<Isearch>) -> WResult {
	if !s.sbuf.is_empty() {
		zw.zle.last_search = from_line(&s.sbuf);
	}
	zw.ed.statusline = None;
	run_hooks(
		zw,
		after(move |_| {
			then(Await::Hook { name: BString::from("zle-isearch-exit"), arg: None }, move |_, _| {
				then(Await::RedrawHook, move |zw, _| {
					let exitfn = s.exitfn;
					let rest: Then = after(move |zw| finish_tail(zw, &s));
					match exitfn.and_then(builtin) {
						Some(b) => {
							if let Some(f) = b.func {
								let r = f(zw);
								chain(zw, r, rest)
							} else {
								let mut msg = BString::from("zle: widget not implemented: ");
								msg.extend_from_slice(b.name.as_bytes());
								utils::showmsg(zw.ed, &msg);
								utils::handlefeep(zw.ed);
								rest(zw)
							}
						},
						None => rest(zw),
					}
				})
			})
		}),
	)
}

/// The keymaps back, the leftover argument keys dropped, the status.
fn finish_tail(zw: &mut Zw<'_, '_>, s: &Isearch) -> WResult {
	let _ = exec::selectkeymap(&zw.zle.keymaps, zw.ed, &s.okeymap, true);
	zw.ed.ls.isearch_active = false;
	if let Some(n) = s.savekeys {
		while zw.ed.unget.len() > n {
			zw.ed.unget.pop_front();
		}
	}
	zw.ed.localkeymap = None;
	WResult::Done(if s.aborted { 3 } else { i32::from(s.nomatch) })
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn newpos_picks_the_match_in_direction() {
		let l = [(1, 3), (5, 7), (9, 10)];
		assert_eq!(isearch_newpos(&l, 5, -1), Some((5, 7)));
		assert_eq!(isearch_newpos(&l, 4, -1), Some((1, 3)));
		assert_eq!(isearch_newpos(&l, 0, -1), None);
		assert_eq!(isearch_newpos(&l, 6, 1), Some((9, 10)));
		assert_eq!(isearch_newpos(&l, 11, 1), None);
	}

	#[test]
	fn char_index_maps_metafied_offsets() {
		let line: Vec<char> = "aé b".chars().collect();
		assert_eq!(char_index(&line, 0), 0);
		assert_eq!(char_index(&line, 1), 1);
		assert_eq!(char_index(&line, 3), 2);
		assert_eq!(char_index(&line, 5), 4);
	}
}
