//! Reading a widget name in the minibuffer (zsh 5.9 `Src/Zle/zle_misc.c`
//! `executenamedcommand`): `execute-named-cmd` (run from the core's key
//! reading, zsh `getkeycmd`), `where-is` (`zle_main.c`), and the plain
//! list printer they show matching names with (zsh `listlist` of
//! `zle_tricky.c`).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::{BString, ByteSlice};

use super::{misc::fixunmeta, yank::Paste};
use crate::bash::{
	syntax::zsh::tok::{metafy, unmetafy},
	vm::{
		builtins::zsh_prompt::Cap,
		zle::{
			display,
			exec::{self, Await, Got, WResult, Zw, then},
			keymap::Bind,
			utils,
		},
		zsh::{subst::strmetasort, wcwidth::wcwidth},
	},
	zshopt::ZshOpt,
};

/// zsh `NAMLEN`: the longest name the minibuffer takes.
const NAMLEN: usize = 60;

/// zsh `SORTIT_NUMERICALLY` (`strmetasort`).
const SORTIT_NUMERICALLY: u32 = 2;
/// zsh `SORTIT_IGNORING_BACKSLASHES` (`strmetasort`).
const SORTIT_IGNORING_BACKSLASHES: u32 = 16;

/// What runs once the minibuffer is done: the widget name read (`None`:
/// abandoned).
pub type NamedDone = Box<dyn FnOnce(&mut Zw<'_, '_>, Option<BString>) -> WResult + Send>;

/// What runs once a list is printed: zsh `listlist`'s status (1: nothing
/// listed or the user declined).
pub type ListDone = Box<dyn FnOnce(&mut Zw<'_, '_>, i32) -> WResult + Send>;

/// The terminal size as zsh's `zterm_columns`/`zterm_lines` (`$COLUMNS`,
/// `$LINES`, kept in step with the terminal).
fn term_size(zw: &mut Zw<'_, '_>) -> (i64, i64) {
	let (tc, tl) = zw.zle.tty.as_ref().map_or((80, 24), |t| t.size);
	let cols = zw
		.getsparam(b"COLUMNS")
		.map(|v| zw_int(&v))
		.filter(|&c| c > 0);
	let lines = zw
		.getsparam(b"LINES")
		.map(|v| zw_int(&v))
		.filter(|&c| c > 0);
	let or = |v: Option<i64>, t: usize, d: i64| {
		v.unwrap_or_else(|| {
			if t > 0 {
				i64::try_from(t).unwrap_or(d)
			} else {
				d
			}
		})
	};
	(or(cols, tc, 80), or(lines, tl, 24))
}

fn zw_int(v: &[u8]) -> i64 {
	crate::bash::vm::zsh::params::parse_int(v)
}

/// zsh `ZMB_nicewidth`: the columns `s` takes as `nicezputs` prints it.
fn nicewidth(s: &[u8]) -> i64 {
	utils::nicedup(s)
		.chars()
		.map(|c| i64::from(wcwidth(c).max(0)))
		.sum()
}

/// The layout zsh `listlist` computes.
struct Layout {
	/// zsh `ncols` (0: one item per line, wrapped).
	ncols:   usize,
	/// zsh `nlines`.
	nlines:  usize,
	/// zsh `pack`: the columns have their own widths.
	pack:    bool,
	/// zsh `widths`.
	widths:  Vec<i64>,
	/// zsh `longest`.
	longest: i64,
}

/// zsh `listlist`'s layout of items whose printed widths plus 2 are
/// `lens` (`data` for the unpacked line count) on a `cols`-wide terminal.
fn layout(data: &[Vec<u8>], lens: &[i64], cols: i64, packed: bool, rowsfirst: bool) -> Layout {
	let num = lens.len();
	let longest = lens.iter().copied().max().unwrap_or(0);
	let shortest = lens.iter().copied().min().unwrap_or(cols).min(cols);
	let totl: i64 = lens.iter().sum();
	let mut widths = vec![0i64; usize::try_from(cols).unwrap_or(0) + 1];
	let ncols0 = if longest > 0 { (cols + 2) / longest } else { 0 };
	if ncols0 <= 0 {
		let nlines = data
			.iter()
			.map(|p| 1 + p.len() / usize::try_from(cols.max(1)).unwrap_or(1))
			.sum();
		return Layout { ncols: 0, nlines, pack: false, widths, longest };
	}
	let mut ncols = usize::try_from(ncols0).unwrap_or(1);
	let mut nlines = num.div_ceil(ncols);
	let mut pack = false;
	if packed {
		let mut tlines: i64 = 0;
		let mut tcols: i64 = 0;
		let set = |w: &mut Vec<i64>, i: i64, v: i64| {
			if let Some(s) = usize::try_from(i).ok().and_then(|i| w.get_mut(i)) {
				*s = v;
			}
		};
		let num_i = i64::try_from(num).unwrap_or(i64::MAX);
		if rowsfirst {
			let mut maxlines: i64 = 0;
			tcols = cols / shortest.max(1);
			while tcols > ncols0 {
				let (mut nth, mut first, mut maxlen, mut width, mut llines, mut tcol): (
					i64,
					i64,
					i64,
					i64,
					i64,
					i64,
				) = (0, 0, 0, 0, 0, 0);
				maxlines = 0;
				let mut count = num_i;
				while count > 0 {
					if nth % tcols == 0 {
						llines += 1;
					}
					let l = lens[usize::try_from(nth).unwrap_or(0)];
					if l > maxlen {
						maxlen = l;
					}
					nth += tcols;
					tlines += 1;
					if nth >= num_i {
						width += maxlen;
						if width >= cols {
							break;
						}
						set(&mut widths, tcol, maxlen);
						tcol += 1;
						maxlen = 0;
						first += 1;
						nth = first;
						if llines > maxlines {
							maxlines = llines;
						}
						llines = 0;
					}
					count -= 1;
				}
				if nth < num_i {
					set(&mut widths, tcol, maxlen);
					width += maxlen;
				}
				if count == 0 && width < cols {
					break;
				}
				tcols -= 1;
			}
			if tcols > ncols0 {
				tlines = maxlines;
			}
		} else {
			tlines = (totl + cols) / cols;
			while tlines < i64::try_from(nlines).unwrap_or(i64::MAX) {
				let (mut nth, mut tline, mut width, mut maxlen): (usize, i64, i64, i64) = (0, 0, 0, 0);
				tcols = 0;
				while nth < num {
					if lens[nth] > maxlen {
						maxlen = lens[nth];
					}
					tline += 1;
					if tline == tlines {
						width += maxlen;
						if width >= cols {
							break;
						}
						set(&mut widths, tcols, maxlen);
						tcols += 1;
						maxlen = 0;
						tline = 0;
					}
					nth += 1;
				}
				if tline != 0 {
					set(&mut widths, tcols, maxlen);
					tcols += 1;
					width += maxlen;
				}
				if nth == num && width < cols {
					break;
				}
				tlines += 1;
			}
		}
		if tlines < i64::try_from(nlines).unwrap_or(i64::MAX) {
			pack = true;
			nlines = usize::try_from(tlines).unwrap_or(0);
			ncols = usize::try_from(tcols).unwrap_or(0);
		}
	}
	Layout { ncols, nlines, pack, widths, longest }
}

/// The list as zsh `listlist` prints it (no trailing newline).
fn list_text(data: &[Vec<u8>], lens: &[i64], l: &Layout, rowsfirst: bool) -> Vec<u8> {
	let mut out = Vec::new();
	let pad = |out: &mut Vec<u8>, col: usize, len: i64| {
		let w = if l.pack {
			l.widths.get(col - 1).copied().unwrap_or(0)
		} else {
			l.longest
		};
		for _ in 0..(w - len + 2).max(0) {
			out.push(b' ');
		}
	};
	if l.ncols == 0 {
		for (i, p) in data.iter().enumerate() {
			out.extend_from_slice(&utils::nicedup(p));
			if i + 1 < data.len() {
				out.push(b'\n');
			}
		}
		return out;
	}
	if rowsfirst {
		let mut col = 1;
		for (i, p) in data.iter().enumerate() {
			out.extend_from_slice(&utils::nicedup(p));
			if col == l.ncols {
				col = 0;
				if i + 1 < data.len() {
					out.push(b'\n');
				}
			} else {
				pad(&mut out, col, lens[i]);
			}
			col += 1;
		}
		return out;
	}
	for line in 0..l.nlines {
		let mut p = line;
		let mut col = 1;
		while p < data.len() {
			out.extend_from_slice(&utils::nicedup(&data[p]));
			if col == l.ncols {
				break;
			}
			pad(&mut out, col, lens[p]);
			p += l.nlines;
			col += 1;
		}
		if line + 1 < l.nlines {
			out.push(b'\n');
		}
	}
	out
}

/// zsh `listlist`: print `items` (raw bytes) sorted in columns below the
/// line (asking first when there are more than `$LISTMAX`, or more lines
/// than the terminal has), then run `next` with 1 when nothing was
/// listed or the user declined, else 0. With `ALWAYS_LAST_PROMPT` (and a
/// numeric argument of 1) the cursor goes back up to the line, which the
/// next refresh redraws above the list.
pub fn listlist(zw: &mut Zw<'_, '_>, items: Vec<BString>, next: ListDone) -> WResult {
	let numeric = zw.isset(ZshOpt::Numericglobsort);
	let mut data: Vec<Vec<u8>> = items.iter().map(|s| metafy(s)).collect();
	let coll = crate::bash::vm::zsh::params::collator_in(&mut zw.k.root, zw.cx.store, zw.vp);
	strmetasort(
		&mut data,
		SORTIT_IGNORING_BACKSLASHES | if numeric { SORTIT_NUMERICALLY } else { 0 },
		coll.as_ref(),
	);
	let data: Vec<Vec<u8>> = data.iter().map(|s| unmetafy(s)).collect();
	let lens: Vec<i64> = data.iter().map(|p| nicewidth(p) + 2).collect();
	let (cols, lines) = term_size(zw);
	let packed = zw.isset(ZshOpt::Listpacked);
	let rowsfirst = zw.isset(ZshOpt::Listrowsfirst);
	let l = layout(&data, &lens, cols, packed, rowsfirst);
	display::trashzle(zw);
	let caps = display::term_caps(zw);
	let tolast = (zw.mult() == 1) == zw.isset(ZshOpt::Alwayslastprompt);
	let clearflag = zw.isset(ZshOpt::Zle) && caps.termflags == 0 && tolast;
	zw.zle.display.clearflag = clearflag;
	let num = data.len();
	let max = zw.getiparam(b"LISTMAX");
	let nlines = i64::try_from(l.nlines).unwrap_or(i64::MAX);
	let p = Print { data, lens, l, rowsfirst, clearflag, lines, next };
	let ask =
		(max > 0 && i64::try_from(num).unwrap_or(i64::MAX) > max) || (max == 0 && nlines > lines);
	if !ask {
		return print_list(zw, p);
	}
	let flow = zw.isset(ZshOpt::Flowcontrol);
	if let Some(t) = zw.zle.tty.as_mut() {
		t.zsetterm(zw.k, zw.cx, flow);
	}
	let q = if num > 0 {
		format!("zsh: do you wish to see all {num} possibilities ({nlines} lines)? ")
	} else {
		format!("zsh: do you wish to see all {nlines} lines? ")
	};
	let qlen = i64::try_from(q.len()).unwrap_or(0);
	let qup = (qlen + cols - 1) / cols - 1;
	if let Some(t) = zw.zle.tty.as_mut() {
		t.put(q.as_bytes());
	}
	utils::getzlequery(move |zw, yes, echo| {
		let mut out = Vec::new();
		let mut b = [0u8; 4];
		out.extend_from_slice(echo.encode_utf8(&mut b).as_bytes());
		let caps = display::term_caps(zw);
		if clearflag {
			out.push(b'\r');
			display::tcmultout(&caps, &mut out, Cap::Up, Cap::MultUp, qup);
			if caps.tccan(Cap::ClearEod) {
				out.extend_from_slice(&caps.tputs(Cap::ClearEod));
			}
		} else {
			out.push(b'\n');
		}
		if !yes {
			if clearflag {
				let nlnct = i64::from(zw.zle.display.nlnct);
				display::tcmultout(&caps, &mut out, Cap::Up, Cap::MultUp, nlnct);
			}
			if let Some(t) = zw.zle.tty.as_mut() {
				t.put(&out);
			}
			return (p.next)(zw, 1);
		}
		if let Some(t) = zw.zle.tty.as_mut() {
			t.put(&out);
			t.settyinfo(zw.k, zw.cx);
		}
		print_list(zw, p)
	})
}

/// A list laid out by [`listlist`], to print.
struct Print {
	data:      Vec<Vec<u8>>,
	lens:      Vec<i64>,
	l:         Layout,
	rowsfirst: bool,
	/// zsh `clearflag` as `listlist` set it.
	clearflag: bool,
	/// zsh `zterm_lines`.
	lines:     i64,
	next:      ListDone,
}

/// The printing end of zsh `listlist`.
fn print_list(zw: &mut Zw<'_, '_>, p: Print) -> WResult {
	let caps = display::term_caps(zw);
	let nlines = i64::try_from(p.l.nlines).unwrap_or(i64::MAX);
	zw.zle.display.lastlistlen = if p.clearflag {
		i32::try_from(p.l.nlines).unwrap_or(i32::MAX)
	} else {
		0
	};
	let mut out = list_text(&p.data, &p.lens, &p.l, p.rowsfirst);
	let mut clear = p.clearflag;
	if clear {
		let n = nlines + i64::from(zw.zle.display.nlnct) - 1;
		if n < p.lines {
			display::tcmultout(&caps, &mut out, Cap::Up, Cap::MultUp, n);
			zw.zle.display.showinglist = -1;
		} else {
			clear = false;
			out.push(b'\n');
		}
	} else {
		out.push(b'\n');
	}
	zw.zle.display.clearflag = clear;
	if let Some(t) = zw.zle.tty.as_mut() {
		t.put(&out);
	}
	(p.next)(zw, i32::from(p.data.is_empty()))
}

/// The minibuffer of `executenamedcommand` between keys.
struct Named {
	/// The prompt (`execute: `, `Where is: `).
	prompt:  BString,
	/// The name typed so far (zsh `cmdbuf` after the prompt).
	typed:   Vec<u8>,
	/// zsh `listed`: a list of names is shown.
	listed:  bool,
	/// zsh `curlist`: the list shown is of the current name.
	curlist: bool,
	/// zsh `ols`: a valid completion list was shown before.
	ols:     bool,
	/// zsh `olll`: its `lastlistlen`.
	olll:    i32,
	/// The keymap to go back to.
	okeymap: BString,
	/// The names last matched (zsh `namedcmdll`).
	matches: Vec<BString>,
	/// Where the name goes.
	done:    NamedDone,
}

/// zsh `executenamedcommand(prmt)`: read a widget name in the status
/// line with the `command` local keymap over `main` (editing keys,
/// completion of names, listing), then run `done` with it (`None` when
/// abandoned with `send-break` or at end of input).
pub fn executenamedcommand(zw: &mut Zw<'_, '_>, prompt: &[u8], done: NamedDone) -> WResult {
	let ols = zw.zle.display.listshown != 0 && zw.zle.comp.tricky.validlist != 0;
	let st = Named {
		prompt: BString::from(prompt),
		typed: Vec::new(),
		listed: false,
		curlist: false,
		ols,
		olll: zw.zle.display.lastlistlen,
		okeymap: zw.ed.keymap.clone(),
		matches: Vec::new(),
		done,
	};
	zw.ed.clearlist = true;
	zw.ed.localkeymap = Some(BString::from("command"));
	let _ = exec::selectkeymap(&zw.zle.keymaps, zw.ed, b"main", true);
	prompt_step(zw, st)
}

/// Show the name with the cursor mark (`_`, or `^` while a quoted
/// character is read).
fn show(zw: &mut Zw<'_, '_>, st: &Named, mark: u8) {
	let mut sl = st.prompt.clone();
	sl.extend_from_slice(&st.typed);
	sl.push(mark);
	zw.ed.statusline = Some(sl);
}

/// The top of zsh's loop: show the line, read a key.
fn prompt_step(zw: &mut Zw<'_, '_>, st: Named) -> WResult {
	show(zw, &st, b'_');
	display::refresh(zw);
	then(Await::Key, move |zw, got| on_key(zw, st, got))
}

/// Leave the minibuffer (zsh's `statusline = NULL; selectkeymap(okeymap,
/// 1); …` and `done:`'s `selectlocalmap(NULL)`).
fn finish(zw: &mut Zw<'_, '_>, st: Named, name: Option<BString>) -> WResult {
	zw.ed.statusline = None;
	let _ = exec::selectkeymap(&zw.zle.keymaps, zw.ed, &st.okeymap, true);
	zw.zle.display.listshown = i32::from(st.ols);
	if st.ols {
		zw.zle.display.showinglist = -2;
		zw.zle.display.lastlistlen = st.olll;
	} else if st.listed {
		zw.zle.display.clearlist = true;
		zw.zle.display.listshown = 1;
	}
	zw.ed.localkeymap = None;
	(st.done)(zw, name)
}

/// Remove the last character of the name (zsh `backwardmetafiedchar`);
/// the character removed.
fn pop_char(typed: &mut Vec<u8>) -> Option<char> {
	let (start, c) = match bstr::decode_last_utf8(typed.as_slice()) {
		(Some(c), n) => (typed.len() - n, Some(c)),
		(None, n) => (typed.len() - n.max(1), None),
	};
	typed.truncate(start);
	c
}

/// List the names matched (zsh `zmult = 1; listlist(namedcmdll);
/// showinglist = 0;`), then go on with the next key.
fn list_then_prompt(zw: &mut Zw<'_, '_>, st: Named, feep: bool) -> WResult {
	let items = st.matches.clone();
	let m = zw.ed.zmod.mult;
	zw.ed.zmod.mult = 1;
	listlist(
		zw,
		items,
		Box::new(move |zw, _| {
			zw.ed.zmod.mult = m;
			zw.zle.display.showinglist = 0;
			if feep {
				utils::handlefeep(zw.ed);
			}
			prompt_step(zw, st)
		}),
	)
}

/// The name typed so far as a widget name (zsh `rthingy(cmdbuf)` of an
/// enabled thingy).
fn named_widget(zw: &Zw<'_, '_>, typed: &[u8]) -> Option<BString> {
	zw.zle.widgets.exists(typed).then(|| BString::from(typed))
}

/// Append a character (zsh `zlecharasstring` into `cmdbuf`).
fn push_char(typed: &mut Vec<u8>, c: char) {
	typed.extend_from_slice(&utils::zlecharasstring(c));
}

fn on_key(zw: &mut Zw<'_, '_>, mut st: Named, got: Got) -> WResult {
	let cmd = match got {
		Got::Key(Some(c)) if c.as_slice() != b"send-break" => c,
		_ => return finish(zw, st, None),
	};
	match cmd.as_slice() {
		b"clear-screen" | b"redisplay" => {
			if cmd.as_slice() == b"clear-screen" {
				let _ = display::clear_screen(zw);
			} else {
				let _ = display::redisplay(zw);
			}
			if st.curlist {
				return list_then_prompt(zw, st, false);
			}
		},
		b"vi-quoted-insert" => {
			show(zw, &st, b'^');
			display::refresh(zw);
			return then(Await::Char, move |zw, got| {
				match got {
					Got::Char(Some(c)) if c != '\0' && st.typed.len() < NAMLEN => {
						push_char(&mut st.typed, c);
						st.curlist = false;
					},
					_ => {
						utils::handlefeep(zw.ed);
					},
				}
				prompt_step(zw, st)
			});
		},
		b"quoted-insert" => {
			return then(Await::Char, move |zw, got| {
				match got {
					Got::Char(Some(c)) if c != '\0' && st.typed.len() != NAMLEN => {
						push_char(&mut st.typed, c);
						st.curlist = false;
					},
					_ => {
						utils::handlefeep(zw.ed);
					},
				}
				prompt_step(zw, st)
			});
		},
		b"backward-delete-char" | b"vi-backward-delete-char" => {
			if !st.typed.is_empty() {
				pop_char(&mut st.typed);
				st.curlist = false;
			}
		},
		b"kill-region" | b"backward-kill-word" | b"vi-backward-kill-word" => {
			if !st.typed.is_empty() {
				st.curlist = false;
			}
			while !st.typed.is_empty() {
				if pop_char(&mut st.typed) == Some('-') {
					break;
				}
			}
		},
		b"kill-whole-line" | b"vi-kill-line" | b"backward-kill-line" => {
			st.typed.clear();
			if st.listed {
				zw.zle.display.clearlist = true;
				zw.zle.display.listshown = 1;
			}
			st.curlist = false;
		},
		b"bracketed-paste" => return read_paste(Paste::default(), st),
		_ => return on_other(zw, st, cmd),
	}
	prompt_step(zw, st)
}

/// zsh `bracketedstring()` read for the minibuffer, then its insertion.
fn read_paste(p: Paste, st: Named) -> WResult {
	then(Await::Char, move |zw, got| {
		let mut p = p;
		let mut st = st;
		let end = match got {
			Got::Char(Some(c)) => utils::zlecharasstring(c).into_iter().any(|b| p.push(b)),
			_ => true,
		};
		if !end {
			return read_paste(p, st);
		}
		let insert = p.finish();
		if st.typed.len() + insert.len() > NAMLEN {
			utils::handlefeep(zw.ed);
		} else {
			st.typed.extend_from_slice(&insert);
			if st.listed {
				zw.zle.display.clearlist = true;
				zw.zle.display.listshown = 1;
				st.listed = false;
			} else {
				st.curlist = false;
			}
		}
		prompt_step(zw, st)
	})
}

/// The rest of zsh's loop body: accepting, completing and listing names,
/// inserting characters.
fn on_other(zw: &mut Zw<'_, '_>, mut st: Named, mut cmd: BString) -> WResult {
	let accept = matches!(cmd.as_slice(), b"accept-line" | b"vi-cmd-mode");
	if accept && let Some(name) = named_widget(zw, &st.typed) {
		return finish(zw, st, Some(name));
	}
	if cmd.as_slice() == b"self-insert-unmeta" {
		fixunmeta(zw.ed);
		cmd = BString::from("self-insert");
	}
	let lastchar = zw.ed.lastchar;
	let complete = accept
		|| matches!(
			cmd.as_slice(),
			b"list-choices"
				| b"delete-char-or-list"
				| b"expand-or-complete"
				| b"complete-word"
				| b"expand-or-complete-prefix"
		)
		|| lastchar == i32::from(b' ')
		|| lastchar == i32::from(b'\t');
	let mut feep = false;
	if complete {
		let mut ambig = 100usize;
		let mut matches: Vec<BString> = Vec::new();
		for (name, _) in zw.zle.widgets.iter() {
			if name.starts_with(&st.typed) {
				if let Some(first) = matches.first() {
					let l = first
						.iter()
						.zip(name.iter())
						.take_while(|(a, b)| a == b)
						.count();
					ambig = ambig.min(l);
				} else {
					ambig = ambig.min(name.len());
				}
				matches.push(name.clone());
			}
		}
		if matches.is_empty() {
			feep = true;
			if st.listed {
				zw.zle.display.clearlist = true;
				zw.zle.display.listshown = 1;
			}
			st.curlist = false;
		} else if matches!(cmd.as_slice(), b"list-choices" | b"delete-char-or-list") {
			st.matches = matches;
			st.listed = true;
			st.curlist = true;
			return list_then_prompt(zw, st, false);
		} else if matches.len() == 1 {
			st.typed = matches[0].to_vec();
			if accept && let Some(name) = named_widget(zw, &st.typed) {
				return finish(zw, st, Some(name));
			}
		} else {
			st.typed = matches[0][..ambig].to_vec();
			let len = st.typed.len();
			let autolist = zw.isset(ZshOpt::Autolist);
			let listambiguous = zw.isset(ZshOpt::Listambiguous);
			st.matches = matches;
			if autolist && !(listambiguous && ambig > len) {
				let beep = zw.isset(ZshOpt::Listbeep);
				st.listed = true;
				st.curlist = true;
				return list_then_prompt(zw, st, beep);
			}
		}
	} else if st.typed.len() == NAMLEN || cmd.as_slice() != b"self-insert" {
		feep = true;
	} else {
		match zw.ed.lastchar_wide.or_else(|| {
			u8::try_from(zw.ed.lastchar)
				.ok()
				.filter(u8::is_ascii)
				.map(char::from)
		}) {
			Some(c) if !c.is_control() => {
				push_char(&mut st.typed, c);
				if st.listed {
					zw.zle.display.clearlist = true;
					zw.zle.display.listshown = 1;
					st.listed = false;
				} else {
					st.curlist = false;
				}
			},
			_ => feep = true,
		}
	}
	if feep {
		utils::handlefeep(zw.ed);
	}
	prompt_step(zw, st)
}

/// The `KeyMode::Named` end of zsh `getkeycmd`: run the minibuffer for
/// `execute-named-cmd` and store the widget read in
/// [`crate::bash::vm::zle::Zle::named_result`] (`None`: abandoned), for
/// the key reader to return in its place.
pub fn named_for_key(zw: &mut Zw<'_, '_>) -> WResult {
	zw.zle.named_result = None;
	executenamedcommand(
		zw,
		b"execute: ",
		Box::new(|zw, name| {
			zw.zle.named_result = name;
			WResult::Done(0)
		}),
	)
}

/// The most key sequences `where-is` names (zsh `MAXFOUND`).
const MAXFOUND: usize = 4;

/// Widget `where-is` (zsh `whereis`): read a widget name and show the key
/// sequences bound to it in the current keymap.
pub fn whereis(zw: &mut Zw<'_, '_>) -> WResult {
	executenamedcommand(
		zw,
		b"Where is: ",
		Box::new(|zw, name| {
			let Some(name) = name else {
				return WResult::Done(1);
			};
			let mut msg = BString::from(utils::nicedup(&name));
			let km = zw.ed.keymap.clone();
			let mut found = 0usize;
			// zsh `scanfindfunc` over `scankeymap(curkeymap, 1, …)`: the
			// sequences bound to that very name.
			let mut seqs: Vec<BString> = Vec::new();
			zw.zle.keymaps.scan(&km, &mut |seq: &[u8], b: &Bind| {
				if let Bind::Widget(w) = b
					&& *w == name
				{
					seqs.push(BString::from(seq));
				}
			});
			for seq in seqs {
				found += 1;
				if found == 1 {
					msg.extend_from_slice(b" is on");
				}
				if found <= MAXFOUND {
					msg.push(b' ');
					msg.extend_from_slice(&utils::bindztrdup(&seq, false));
				}
			}
			if found == 0 {
				msg.extend_from_slice(b" is not bound to any key");
			} else if found > MAXFOUND {
				msg.extend_from_slice(b" et al");
			}
			utils::showmsg(zw.ed, &msg);
			WResult::Done(0)
		}),
	)
}
