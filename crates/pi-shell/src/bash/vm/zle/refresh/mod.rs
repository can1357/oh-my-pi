//! Screen update: a port of zsh 5.9 `Src/Zle/zle_refresh.c`.
//!
//! [`Display`] is everything zsh keeps between refreshes (the old and new
//! video buffers `obuf`/`nbuf`, the video cursor `vln`/`vcs`, the number of
//! lines shown, the completion-list bookkeeping, …). Each refresh gets the
//! editor and the terminal it draws for as a [`RefreshIn`] and appends the
//! bytes zsh would write to `SHTTY` to an output buffer; nothing here does
//! I/O, reads parameters or runs shell code. What zsh does around the
//! screen update that is not the screen's (terminal modes, listing
//! completions, re-expanding prompts) is reported back in a
//! [`RefreshOut`] or left to the caller as documented on each function.
//!
//! Video buffers hold one [`Elem`] per screen cell: a character (or, with
//! `combiningchars`, an index into the multiword buffer of a glyph made of
//! several characters) and its attributes. A cell continuing a wide
//! character holds `WEOF`.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

mod line;
#[cfg(test)]
mod tests;

use std::borrow::Cow;

use bstr::BString;

use super::{Editor, invalid_byte, to_line, wflags};
use crate::bash::{
	syntax::zsh::tok::{META, is_tok, metafy},
	vm::{
		builtins::zsh_prompt::{
			self as zp, Cap, ColourSeqs, NearColour, TXT_ATTR_BG_24BIT, TXT_ATTR_BG_COL_MASK,
			TXT_ATTR_BG_COL_SHIFT, TXT_ATTR_BG_ON_MASK, TXT_ATTR_FG_24BIT, TXT_ATTR_FG_COL_MASK,
			TXT_ATTR_FG_COL_SHIFT, TXT_ATTR_FG_ON_MASK, TXT_ATTR_OFF_MASK, TXT_ATTR_ON_MASK,
			TXTBGCOLOUR, TXTBOLDFACE, TXTFGCOLOUR, TXTNOBGCOLOUR, TXTNOBOLDFACE, TXTNOFGCOLOUR,
			TXTNOSTANDOUT, TXTNOUNDERLINE, TXTSTANDOUT, TXTUNDERLINE, TermCaps, Zattr,
		},
		zsh::{terminfo_db, text, wcwidth::wcwidth},
	},
};

/// zsh `ZRH_PREDISPLAY`: the region's offsets count `$PREDISPLAY` too
/// (`region_highlight` entries written with a `P` prefix).
pub const ZRH_PREDISPLAY: u32 = 1;

/// zsh `N_SPECIAL_HIGHLIGHTS`: the highlights zsh keeps before the user's
/// (`region`, `isearch`, `suffix`, `paste` from `zle_highlight`).
pub const N_SPECIAL_HIGHLIGHTS: usize = 4;

/// zsh `struct region_highlight`: one `region_highlight` entry.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RegionHighlight {
	/// First character highlighted (-1: unset).
	pub start: i32,
	/// Character after the last one highlighted (-1: unset).
	pub end:   i32,
	/// The attributes (`zattr`).
	pub atr:   Zattr,
	/// [`ZRH_PREDISPLAY`].
	pub flags: u32,
	/// The `memo=` token, if any.
	pub memo:  Option<BString>,
}

/// zsh `TXT_MULTIWORD_MASK`: the cell's character is an index into the
/// multiword glyph buffer.
const TXT_MULTIWORD_MASK: Zattr = 0x0400;
/// zsh `TXT_ATTR_ON_VALUES_MASK`.
const TXT_ATTR_ON_VALUES_MASK: Zattr = TXT_ATTR_ON_MASK
	| TXT_ATTR_FG_COL_MASK
	| TXT_ATTR_BG_COL_MASK
	| TXT_ATTR_FG_24BIT
	| TXT_ATTR_BG_24BIT;
/// zsh `TXT_ATTR_COLOUR_ON_MASK`.
const TXT_ATTR_COLOUR_ON_MASK: Zattr = TXT_ATTR_FG_ON_MASK | TXT_ATTR_BG_ON_MASK;

/// zsh `TXT_ATTR_OFF_FROM_ON`.
const fn off_from_on(atr: Zattr) -> Zattr {
	(atr & TXT_ATTR_ON_MASK) << 5
}

/// zsh `TXT_ATTR_ON_FROM_OFF`.
const fn on_from_off(atr: Zattr) -> Zattr {
	(atr & TXT_ATTR_OFF_MASK) >> 5
}

/// C `WEOF`: the cell continues the wide character to its left.
const WEOF: u32 = u32::MAX;

/// zsh `REFRESH_ELEMENT`: one screen cell.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Elem {
	/// The character (0: end of the line's text; [`WEOF`]: continuation
	/// of a wide character; with [`TXT_MULTIWORD_MASK`]: index into the
	/// multiword buffer).
	chr: u32,
	/// Attributes.
	atr: Zattr,
}

impl Elem {
	/// A cell showing `c` without attributes.
	const fn ch(c: char) -> Self {
		Self { chr: c as u32, atr: 0 }
	}
}

/// zsh `zr_cr`.
const ZR_CR: Elem = Elem::ch('\r');
/// zsh `zr_dt`.
const ZR_DT: Elem = Elem::ch('.');
/// zsh `zr_nl`.
const ZR_NL: Elem = Elem::ch('\n');
/// zsh `zr_sp`.
const ZR_SP: Elem = Elem::ch(' ');
/// zsh `zr_zr`.
const ZR_ZR: Elem = Elem::ch('\0');

/// zsh `zr_end_ellipsis`.
const ZR_END_ELLIPSIS: [Elem; 7] = [
	Elem::ch(' '),
	Elem::ch('<'),
	Elem::ch('.'),
	Elem::ch('.'),
	Elem::ch('.'),
	Elem::ch('.'),
	Elem::ch(' '),
];
/// zsh `zr_mid_ellipsis1`.
const ZR_MID_ELLIPSIS1: [Elem; 6] =
	[Elem::ch(' '), Elem::ch('<'), Elem::ch('.'), Elem::ch('.'), Elem::ch('.'), Elem::ch('.')];
/// zsh `zr_mid_ellipsis2`.
const ZR_MID_ELLIPSIS2: [Elem; 2] = [Elem::ch('>'), Elem::ch(' ')];
/// zsh `zr_start_ellipsis`.
const ZR_START_ELLIPSIS: [Elem; 5] =
	[Elem::ch('>'), Elem::ch('.'), Elem::ch('.'), Elem::ch('.'), Elem::ch('.')];

/// One video line (`winw + 2` cells: the text, a terminator, and whether
/// the text wrapped onto the next line).
type Line = Vec<Elem>;

/// The cell at `i` of `l` (an empty cell before the start or past the
/// end, like zsh's terminating NUL).
fn at(l: &[Elem], i: i32) -> Elem {
	usize::try_from(i)
		.ok()
		.and_then(|i| l.get(i))
		.copied()
		.unwrap_or(ZR_ZR)
}

/// Store `e` at `i` of `l` (nothing outside it).
fn put(l: &mut [Elem], i: i32, e: Elem) {
	if let Some(x) = usize::try_from(i).ok().and_then(|i| l.get_mut(i)) {
		*x = e;
	}
}

/// zsh `ZR_strlen` from `i`.
fn zr_strlen(l: &[Elem], i: i32) -> i32 {
	let mut n = 0;
	while at(l, i + n).chr != 0 {
		n += 1;
	}
	n
}

/// zsh `ZR_equal(old, new)`: cells equal, a multiword glyph compared
/// through the old (`omw`) and new (`nmw`) glyph buffers.
fn zr_equal(o: Elem, n: Elem, omw: &[u32], nmw: &[u32]) -> bool {
	if o.atr != n.atr {
		return false;
	}
	if o.atr & TXT_MULTIWORD_MASK == 0 {
		return o.chr == n.chr;
	}
	let (oi, ni) = (o.chr as usize, n.chr as usize);
	let (Some(&ol), Some(&nl)) = (omw.get(oi), nmw.get(ni)) else {
		return false;
	};
	ol == nl && omw.get(oi + 1..=oi + ol as usize) == nmw.get(ni + 1..=ni + nl as usize)
}

/// zsh `ZR_strncmp(old, new, len)`: whether the first `len` cells differ.
fn zr_strncmp(o: &[Elem], n: &[Elem], len: i32, omw: &[u32], nmw: &[u32]) -> bool {
	for k in 0..len {
		let (oe, ne) = (at(o, k), at(n, k));
		if (oe.atr & TXT_MULTIWORD_MASK == 0 && oe.chr == 0)
			|| (ne.atr & TXT_MULTIWORD_MASK == 0 && ne.chr == 0)
		{
			return !zr_equal(oe, ne, omw, nmw);
		}
		if !zr_equal(oe, ne, omw, nmw) {
			return true;
		}
	}
	false
}

/// C `iswprint` in a UTF-8 locale.
fn iswprint(c: char) -> bool {
	c != '\0' && wcwidth(c) >= 0
}

/// C `iswcntrl`.
fn iswcntrl(c: char) -> bool {
	matches!(u32::from(c), 0..0x20 | 0x7f..0xa0)
}

/// zsh `IS_COMBINING`.
fn is_combining(c: char) -> bool {
	c != '\0' && wcwidth(c) == 0
}

/// zsh `IS_BASECHAR` (`iswgraph` and wider than nothing).
fn is_basechar(c: char) -> bool {
	!c.is_whitespace() && wcwidth(c) > 0
}

/// The width of `c` when zsh's refresh shows it as itself (printable, not
/// an invalid byte, not zero width).
fn shown_width(c: char) -> Option<i32> {
	if invalid_byte(c).is_some() {
		return None;
	}
	let w = wcwidth(c);
	(w > 0).then_some(w)
}

/// zsh's `^X` notation for control character `c` (the `X`).
fn ctrl_char(c: u32) -> u32 {
	if (c & !0x80) > 31 {
		u32::from(b'?')
	} else {
		c | u32::from(b'@')
	}
}

/// zsh `ztrlen`: characters of metafied `s` (a `Meta` pair is one).
const fn ztrlen(s: &[u8]) -> i32 {
	let mut n = 0;
	let mut i = 0;
	while i < s.len() {
		i += if s[i] == META { 2 } else { 1 };
		n += 1;
	}
	n
}

/// zsh `incpos` on `line`: one character right, past the combining
/// characters of a glyph when `combining` (`alignmultiwordright`).
fn incpos(line: &[char], pos: usize, combining: bool) -> usize {
	let pos = pos + 1;
	let ll = line.len();
	if !combining || pos >= ll || pos == 0 || !is_combining(line[pos]) {
		return pos;
	}
	// zsh `alignmultiwordleft(pos, 0)`: on a combining character of a
	// glyph with a base character?
	let mut loc = pos - 1;
	loop {
		if is_basechar(line[loc]) {
			break;
		}
		if !is_combining(line[loc]) || loc == 0 {
			return pos;
		}
		loc -= 1;
	}
	let mut loc = pos + 1;
	while loc < ll {
		if !is_combining(line[loc]) {
			return loc;
		}
		loc += 1;
	}
	loc
}

/// What zsh's `zrefresh` and friends need besides the [`Display`]: the
/// editor, the terminal and the options and parameters consulted.
pub struct RefreshIn<'a> {
	/// The line, cursor, mark, region, `$PREDISPLAY`/`$POSTDISPLAY`,
	/// prompts ([`Editor::lprompt`]/[`Editor::rprompt`]: zsh's metafied
	/// `promptexpand(…, ns = 1)` buffers), `zle -M` status line (raw
	/// bytes), `region_highlight` entries, `lastcmd` and yank bounds.
	pub ed:               &'a Editor,
	/// The terminal (zsh `tcstr`, `hasam`, `termflags`, …).
	pub term:             &'a TermCaps,
	/// zsh `zterm_columns`.
	pub columns:          i32,
	/// zsh `zterm_lines`.
	pub lines:            i32,
	/// The `SINGLE_LINE_ZLE` option.
	pub singlelinezle:    bool,
	/// The `COMBINING_CHARS` option.
	pub combiningchars:   bool,
	/// The `TRANSIENT_RPROMPT` option.
	pub transientrprompt: bool,
	/// `$ZLE_RPROMPT_INDENT` (zsh `rprompt_indent`, 1 when unset).
	pub rprompt_indent:   i32,
	/// `$zle_highlight` (`None`: unset).
	pub zle_highlight:    Option<&'a [BString]>,
	/// The `zsh/nearcolor` hook when that module is loaded.
	pub nearcolor:        Option<NearColour>,
	/// zsh `pmpt_attr`: attributes the left prompt left on.
	pub pmpt_attr:        Zattr,
	/// zsh `rpmpt_attr`: attributes the right prompt left on.
	pub rpmpt_attr:       Zattr,
	/// zsh `invicmdmode()`: the `vicmd` keymap is selected.
	pub vicmd:            bool,
	/// zsh `isearch_active`: the incremental search match
	/// (`isearch_startpos`, `isearch_endpos`).
	pub isearch:          Option<(i32, i32)>,
	/// zsh `suffixlen`: length of the auto-removable completion suffix
	/// before the cursor.
	pub suffixlen:        i32,
	/// zsh `postedit`: text written after the line is finished (raw
	/// bytes).
	pub postedit:         Option<&'a [u8]>,
}

/// What a screen update asks of the caller.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RefreshOut {
	/// zsh called `zsetterm()`: set the terminal modes for editing before
	/// writing the bytes. zsh also cleared the prompt attribute state
	/// (`txtattrmask = 0`) at that point.
	pub setterm:        bool,
	/// zsh would now list completions (`listmatches()`): do so, refresh
	/// again unless that failed (`errflag`), then call
	/// [`Display::list_done`].
	pub list:           bool,
	/// zsh called `invalidatelist()` (clearing a list below the line on a
	/// terminal that cannot clear to the end of the screen): drop the
	/// completion list state. The display side (`showinglist = 0`) is done.
	pub invalidatelist: bool,
}

/// zsh's screen state (`zle_refresh.c` statics and the globals the
/// completion lister shares).
pub struct Display {
	/// zsh `nbuf`: the new video buffer, `winh + 1` lines.
	nbuf:            Vec<Option<Line>>,
	/// zsh `obuf`: what the screen shows.
	obuf:            Vec<Option<Line>>,
	/// zsh `nmwbuf`: multiword glyphs of `nbuf` (its length is zsh's
	/// `nmw_ind`; element 0 unused).
	nmw:             Vec<u32>,
	/// zsh `omwbuf`: multiword glyphs of `obuf`.
	omw:             Vec<u32>,
	/// zsh `more_start`: text before the start of the screen.
	more_start:      bool,
	/// zsh `more_end`: text after the end of the screen.
	more_end:        bool,
	/// zsh `olnct`: lines shown last time.
	olnct:           i32,
	/// zsh `lpromptw`.
	lpromptw:        i32,
	/// zsh `rpromptw`.
	rpromptw:        i32,
	/// zsh `lpromptwof`: left prompt width with its real end position.
	lpromptwof:      i32,
	/// zsh `lprompth`.
	lprompth:        i32,
	/// zsh `rprompth`.
	rprompth:        i32,
	/// zsh `vcs`: video cursor column.
	vcs:             i32,
	/// zsh `vln`: video cursor line.
	vln:             i32,
	/// zsh `vmaxln`.
	vmaxln:          i32,
	/// zsh `winw`.
	winw:            i32,
	/// zsh `winh`.
	winh:            i32,
	/// zsh `rwinh`: the real number of lines.
	rwinh:           i32,
	/// zsh `winpos` (single-line mode).
	winpos:          i32,
	/// zsh `winprompt` (single-line mode).
	winprompt:       i32,
	/// zsh `winw_alloc`.
	winw_alloc:      i32,
	/// zsh `winh_alloc`.
	winh_alloc:      i32,
	/// zsh `cleareol`.
	cleareol:        bool,
	/// zsh `clearf`.
	clearf:          bool,
	/// zsh `put_rpmpt`.
	put_rpmpt:       bool,
	/// zsh `oput_rpmpt`.
	oput_rpmpt:      bool,
	/// zsh `numscrolls`.
	numscrolls:      i32,
	/// zsh `onumscrolls`.
	onumscrolls:     i32,
	/// zsh `lastatr`: attributes last turned on.
	lastatr:         Zattr,
	/// zsh `default_atr_on`.
	default_atr_on:  Zattr,
	/// zsh `special_atr_on`.
	special_atr_on:  Zattr,
	/// Attributes of zsh's special `region_highlights` (region, isearch,
	/// suffix, paste).
	special_atr:     [Zattr; N_SPECIAL_HIGHLIGHTS],
	/// zsh `termflags & TERM_SHORT`.
	term_short:      bool,
	/// zsh `fg_bg_sequences` (`zle_highlight`'s `fg_start_code:` …).
	pub colseqs:     ColourSeqs,
	/// zsh `nlnct`: lines displayed.
	pub nlnct:       i32,
	/// zsh `showinglist`: most lines of the buffer shown with the list
	/// showing; 0 no list, -1 a list was just shown, -2 one is to be shown.
	pub showinglist: i32,
	/// zsh `listshown`: > 0 a list is below the prompt, < 0 above it.
	pub listshown:   i32,
	/// zsh `lastlistlen`.
	pub lastlistlen: i32,
	/// zsh `clearflag`: `ALWAYS_LAST_PROMPT` was used.
	pub clearflag:   bool,
	/// zsh `clearlist`: clear the list below the prompt.
	pub clearlist:   bool,
	/// zsh `trashedzle`: the display was given up for other output.
	pub trashedzle:  bool,
	/// zsh `resetneeded`: redraw everything at the next refresh.
	pub resetneeded: bool,
	/// zsh `winchanged`: the window size changed.
	pub winchanged:  bool,
	/// zsh `zrefresh`'s `inlist`: a list is being shown (refreshes do
	/// nothing).
	pub inlist:      bool,
}

impl Default for Display {
	fn default() -> Self {
		Self {
			nbuf:           Vec::new(),
			obuf:           Vec::new(),
			nmw:            vec![0],
			omw:            vec![0],
			more_start:     false,
			more_end:       false,
			olnct:          0,
			lpromptw:       0,
			rpromptw:       0,
			lpromptwof:     0,
			lprompth:       0,
			rprompth:       0,
			vcs:            0,
			vln:            0,
			vmaxln:         0,
			winw:           0,
			winh:           0,
			rwinh:          0,
			winpos:         0,
			winprompt:      0,
			winw_alloc:     -1,
			winh_alloc:     -1,
			cleareol:       false,
			clearf:         false,
			put_rpmpt:      false,
			oput_rpmpt:     false,
			numscrolls:     0,
			onumscrolls:    0,
			lastatr:        0,
			default_atr_on: 0,
			special_atr_on: 0,
			special_atr:    [0; N_SPECIAL_HIGHLIGHTS],
			term_short:     false,
			colseqs:        ColourSeqs::default(),
			nlnct:          0,
			showinglist:    0,
			listshown:      0,
			lastlistlen:    0,
			clearflag:      false,
			clearlist:      false,
			trashedzle:     false,
			resetneeded:    false,
			winchanged:     false,
			inlist:         false,
		}
	}
}

impl Display {
	/// zsh `freevideo`: drop the video buffers (the next refresh after a
	/// reset allocates them again).
	pub fn freevideo(&mut self) {
		if !self.nbuf.is_empty() {
			self.nbuf.clear();
			self.obuf.clear();
			self.nmw = vec![0];
			self.omw = vec![0];
			self.winw_alloc = -1;
			self.winh_alloc = -1;
		}
	}

	/// Whether the next [`zrefresh`] redraws from scratch after the
	/// display was trashed, the point where zsh calls `reexpandprompt()`:
	/// the caller re-expands [`Editor::lprompt`]/[`Editor::rprompt`] (and
	/// the prompt attributes) before refreshing when this is true.
	pub const fn needs_reexpand(&self, term: &TermCaps) -> bool {
		let (resetneeded, clearflag) =
			if self.clearlist && self.listshown > 0 && !term.tccan(Cap::ClearEod) {
				(true, false)
			} else {
				(self.resetneeded, self.clearflag)
			};
		resetneeded && self.trashedzle && !clearflag
	}

	/// The end of zsh's `zrefresh` after it listed completions
	/// ([`RefreshOut::list`]): a list just shown keeps the lines the
	/// buffer takes.
	pub const fn list_done(&mut self) {
		if self.showinglist == -1 {
			self.showinglist = self.nlnct;
		}
	}
}

/// zsh `zrefresh`: bring the screen up to date with `input`, appending
/// the bytes to write to `out`.
///
/// Call it with [`Display::resetneeded`] set for a fresh line (zsh's
/// `zleread`). When [`Display::needs_reexpand`] holds the caller must
/// re-expand the prompts first (zsh `reexpandprompt`).
pub fn zrefresh(d: &mut Display, input: &RefreshIn<'_>, out: &mut Vec<u8>) -> RefreshOut {
	R { d, i: input, out }.zrefresh()
}

/// zsh `trashzle`'s display part: show the line as it is with the cursor
/// after it, move below it and give the screen up for other output
/// (`postedit` is written); the next refresh redraws everything. Does
/// nothing when the display is already trashed. The caller restores the
/// terminal modes (zsh `settyinfo`) unless `ZLRF_NOSETTY`.
pub fn trashzle(d: &mut Display, input: &RefreshIn<'_>, out: &mut Vec<u8>) {
	if d.trashedzle {
		return;
	}
	let mut r = R { d, i: input, out };
	// The refresh only gets the editor display right and the cursor in
	// place: no list.
	let sl = r.d.showinglist;
	r.d.showinglist = 0;
	r.d.trashedzle = true;
	r.zrefresh();
	r.d.showinglist = sl;
	r.moveto(r.d.nlnct, 0);
	if r.d.clearflag && r.i.term.tccan(Cap::ClearEod) {
		r.tcout(Cap::ClearEod);
		r.d.clearflag = false;
		r.d.listshown = 0;
	}
	if let Some(p) = r.i.postedit {
		// `fprintf(shout, "%s", unmeta(postedit))`.
		let end = p.iter().position(|&b| b == 0).unwrap_or(p.len());
		r.out.extend_from_slice(&p[..end]);
	}
	r.d.resetneeded = true;
}

/// zsh `clearscreen` (the `clear-screen` widget's display part): clear the
/// terminal and redraw everything at the next refresh. The caller then
/// re-expands the prompts (zsh `reexpandprompt`).
pub fn clearscreen(d: &mut Display, input: &RefreshIn<'_>, out: &mut Vec<u8>) {
	let mut r = R { d, i: input, out };
	r.tcoutclear(Cap::ClearScreen);
	r.d.resetneeded = true;
	r.d.clearflag = false;
}

/// zsh `redisplay`: move to the start of the prompt and redraw everything
/// at the next refresh.
pub fn redisplay(d: &mut Display, input: &RefreshIn<'_>, out: &mut Vec<u8>) {
	let mut r = R { d, i: input, out };
	r.moveto(0, 0);
	r.zputc(ZR_CR);
	r.tcmultout(Cap::Up, Cap::MultUp, r.d.lprompth - 1);
	r.d.resetneeded = true;
	r.d.clearflag = false;
}

/// zsh `output_highlight`: attributes `atr` as a `zle_highlight` /
/// `region_highlight` specification (`fg=red,bold`; `none` when empty).
pub fn output_highlight(atr: Zattr) -> Vec<u8> {
	const ANSI_COLOURS: [&str; 8] =
		["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
	fn colour(out: &mut Vec<u8>, colour: u64, fg: bool, truecol: bool) {
		out.extend_from_slice(if fg { b"fg=" } else { b"bg=" });
		if truecol {
			out.extend_from_slice(
				format!("#{:02x}{:02x}{:02x}", colour >> 16, (colour >> 8) & 0xff, colour & 0xff)
					.as_bytes(),
			);
		} else if colour > 7 {
			out.extend_from_slice(colour.to_string().as_bytes());
		} else {
			out.extend_from_slice(ANSI_COLOURS[colour as usize].as_bytes());
		}
	}
	let mut out = Vec::new();
	if atr & TXTFGCOLOUR != 0 {
		let c = (atr & TXT_ATTR_FG_COL_MASK) >> TXT_ATTR_FG_COL_SHIFT;
		colour(&mut out, c, true, atr & TXT_ATTR_FG_24BIT != 0);
	}
	if atr & TXTBGCOLOUR != 0 {
		if !out.is_empty() {
			out.push(b',');
		}
		let c = (atr & TXT_ATTR_BG_COL_MASK) >> TXT_ATTR_BG_COL_SHIFT;
		colour(&mut out, c, false, atr & TXT_ATTR_BG_24BIT != 0);
	}
	for (name, mask) in [
		(&b"bold"[..], TXTBOLDFACE),
		(&b"standout"[..], TXTSTANDOUT),
		(&b"underline"[..], TXTUNDERLINE),
	] {
		if atr & mask != 0 {
			if !out.is_empty() {
				out.push(b',');
			}
			out.extend_from_slice(name);
		}
	}
	if out.is_empty() {
		out.extend_from_slice(b"none");
	}
	out
}

/// zsh `get_region_highlight`: the `$region_highlight` elements for the
/// user entries `rh` (`[P]start end attrs[ memo=…]`).
pub fn get_region_highlight(rh: &[RegionHighlight]) -> Vec<BString> {
	rh.iter()
		.map(|h| {
			let mut s = Vec::new();
			if h.flags & ZRH_PREDISPLAY != 0 {
				s.push(b'P');
			}
			s.extend_from_slice(format!("{} {} ", h.start, h.end).as_bytes());
			s.extend_from_slice(&output_highlight(h.atr));
			if let Some(m) = &h.memo {
				s.extend_from_slice(b" memo=");
				s.extend_from_slice(m);
			}
			BString::from(s)
		})
		.collect()
}

/// zsh `inblank`.
const fn inblank(c: u8) -> bool {
	c == b' ' || c == b'\t'
}

/// zsh `zstrtol(s, &end, 10)`: the number at the start of `s` (blanks and
/// a sign first) and the bytes it took.
fn zstrtol10(s: &[u8]) -> (i64, usize) {
	let mut i = 0;
	while s.get(i).is_some_and(|&c| inblank(c)) {
		i += 1;
	}
	let neg = s.get(i) == Some(&b'-');
	if neg || s.get(i) == Some(&b'+') {
		i += 1;
	}
	let mut v: i64 = 0;
	while let Some(&c) = s.get(i).filter(|c| c.is_ascii_digit()) {
		v = v.wrapping_mul(10).wrapping_add(i64::from(c - b'0'));
		i += 1;
	}
	(if neg { v.wrapping_neg() } else { v }, i)
}

/// zsh `set_region_highlight`: parse `$region_highlight` elements (raw
/// bytes) into entries (`None`: unset, no entries). Colours are checked
/// against `term`.
pub fn set_region_highlight(
	aval: Option<&[BString]>,
	term: &TermCaps,
	nearcolor: Option<NearColour>,
) -> Vec<RegionHighlight> {
	let Some(aval) = aval else {
		return Vec::new();
	};
	aval
		.iter()
		.map(|v| {
			let v: &[u8] = v;
			let mut i = 0;
			let flags = if v.first() == Some(&b'P') {
				i = 1;
				ZRH_PREDISPLAY
			} else {
				0
			};
			while v.get(i).is_some_and(|&c| inblank(c)) {
				i += 1;
			}
			let (n, used) = zstrtol10(&v[i..]);
			let start = if used == 0 { -1 } else { n as i32 };
			i += used;
			while v.get(i).is_some_and(|&c| inblank(c)) {
				i += 1;
			}
			let (n, used) = zstrtol10(&v[i..]);
			let end = if used == 0 { -1 } else { n as i32 };
			i += used;
			while v.get(i).is_some_and(|&c| inblank(c)) {
				i += 1;
			}
			let (atr, used) = zp::match_highlight(&v[i..], term, nearcolor);
			i += used;
			while v.get(i).is_some_and(|&c| inblank(c)) {
				i += 1;
			}
			let memo = v[i..].strip_prefix(b"memo=").map(|m| {
				// Ends at a NUL, a comma or a blank (room for extensions).
				let end = m
					.iter()
					.position(|&c| c == 0 || c == b',' || inblank(c))
					.unwrap_or(m.len());
				BString::from(&m[..end])
			});
			RegionHighlight { start, end, atr, flags, memo }
		})
		.collect()
}

/// zsh `struct rparams`: state of the video-buffer build.
#[derive(Clone, Copy, Debug, Default)]
struct Rp {
	/// Lines we may still scroll.
	canscroll:   i32,
	/// The line being built.
	ln:          i32,
	/// More text in the status line than shown.
	more_status: bool,
	/// New cursor column.
	nvcs:        i32,
	/// New cursor line (-1: not found yet).
	nvln:        i32,
	/// Status line start.
	tosln:       i32,
	/// Next cell of line `ln`.
	s:           i32,
	/// End of line `ln` (`winw`).
	sen:         i32,
}

/// One refresh at work: the display, its input and the output.
struct R<'r, 'a> {
	/// The display state.
	d:   &'r mut Display,
	/// The editor and terminal.
	i:   &'r RefreshIn<'a>,
	/// Bytes for the terminal.
	out: &'r mut Vec<u8>,
}

impl R<'_, '_> {
	/// The cell at `i` of new line `ln`.
	fn nget(&self, ln: i32, i: i32) -> Elem {
		usize::try_from(ln)
			.ok()
			.and_then(|ln| self.d.nbuf.get(ln)?.as_deref())
			.map_or(ZR_ZR, |l| at(l, i))
	}

	/// Store `e` at `i` of new line `ln`.
	fn nset(&mut self, ln: i32, i: i32, e: Elem) {
		if let Some(l) = usize::try_from(ln)
			.ok()
			.and_then(|ln| self.d.nbuf.get_mut(ln)?.as_deref_mut())
		{
			put(l, i, e);
		}
	}

	/// Turn on attributes `atr` at `i` of new line `ln`.
	fn nor(&mut self, ln: i32, i: i32, atr: Zattr) {
		let e = self.nget(ln, i);
		self.nset(ln, i, Elem { chr: e.chr, atr: e.atr | atr });
	}

	/// Whether new line `ln` exists.
	fn nhas(&self, ln: i32) -> bool {
		usize::try_from(ln)
			.ok()
			.and_then(|ln| self.d.nbuf.get(ln))
			.is_some_and(Option::is_some)
	}

	/// Whether old line `ln` exists.
	fn ohas(&self, ln: i32) -> bool {
		usize::try_from(ln)
			.ok()
			.and_then(|ln| self.d.obuf.get(ln))
			.is_some_and(Option::is_some)
	}

	/// Allocate new line `ln` if it is not.
	fn ensure_nline(&mut self, ln: i32) {
		let w = usize::try_from(self.d.winw).unwrap_or(0) + 2;
		if let Some(slot) = usize::try_from(ln)
			.ok()
			.and_then(|ln| self.d.nbuf.get_mut(ln))
			&& slot.is_none()
		{
			*slot = Some(vec![ZR_ZR; w]);
		}
	}

	/// zsh `ZR_equal(old, new)`.
	fn eq(&self, o: Elem, n: Elem) -> bool {
		zr_equal(o, n, &self.d.omw, &self.d.nmw)
	}

	/// zsh `tcout`.
	fn tcout(&mut self, cap: Cap) {
		self.out.extend_from_slice(&self.i.term.tputs(cap));
	}

	/// zsh `tcoutarg`: `cap` with argument `arg` (`tgoto(cap, arg, arg)`).
	fn tcoutarg(&mut self, cap: Cap, arg: i32) {
		if let Some(s) = self.i.term.tcstr[cap as usize].as_deref() {
			let s = terminfo_db::tgoto(s, arg, arg);
			self.out.extend_from_slice(&terminfo_db::tputs(&s));
		}
	}

	/// zsh `tsetcap(cap, 0)`.
	fn tsetcap(&mut self, cap: Cap) {
		self
			.out
			.extend_from_slice(&zp::tsetcap(self.i.term, cap, self.i.singlelinezle));
	}

	/// zsh `set_colour_attribute(atr, fg_bg, 0)`.
	fn set_colour_attribute(&mut self, atr: Zattr, fg: bool) {
		if let Some(s) = zp::colour_sequence(self.i.term, &self.d.colseqs, atr, fg) {
			self.out.extend_from_slice(&s);
		}
	}

	/// zsh `settextattributes`.
	fn settextattributes(&mut self, atr: Zattr) {
		if atr & TXTNOBOLDFACE != 0 {
			self.tsetcap(Cap::AllAttrsOff);
		}
		if atr & TXTNOSTANDOUT != 0 {
			self.tsetcap(Cap::StandoutEnd);
		}
		if atr & TXTNOUNDERLINE != 0 {
			self.tsetcap(Cap::UnderlineEnd);
		}
		if atr & TXTBOLDFACE != 0 {
			self.tsetcap(Cap::BoldBeg);
		}
		if atr & TXTSTANDOUT != 0 {
			self.tsetcap(Cap::StandoutBeg);
		}
		if atr & TXTUNDERLINE != 0 {
			self.tsetcap(Cap::UnderlineBeg);
		}
		if atr & (TXTFGCOLOUR | TXTNOFGCOLOUR) != 0 {
			self.set_colour_attribute(atr, true);
		}
		if atr & (TXTBGCOLOUR | TXTNOBGCOLOUR) != 0 {
			self.set_colour_attribute(atr, false);
		}
	}

	/// zsh `clearattributes`: turn off the attributes last turned on.
	fn clearattributes(&mut self) {
		if self.d.lastatr != 0 {
			self.settextattributes(off_from_on(self.d.lastatr));
			self.d.lastatr = 0;
		}
	}

	/// zsh `tcoutclear`.
	fn tcoutclear(&mut self, cap: Cap) {
		self.clearattributes();
		self.tcout(cap);
	}

	/// The bytes of character `c` (C `wcrtomb`; nothing for `WEOF` or a
	/// value that is no character).
	fn put_wc(&mut self, c: u32) {
		if let Some(c) = char::from_u32(c) {
			let mut b = [0u8; 4];
			self.out.extend_from_slice(c.encode_utf8(&mut b).as_bytes());
		}
	}

	/// zsh `zwcputc`: write cell `c` (of the new buffer) with its
	/// attribute changes; `curatr` tracks attributes across a run.
	fn zwcputc(&mut self, c: Elem, curatr: Option<&mut Zattr>) {
		if self.d.lastatr & !c.atr != 0 {
			// Turn off what is on that we do not want.
			self.settextattributes(off_from_on(self.d.lastatr & !c.atr));
			self.d.lastatr = 0;
		}
		// No "on" attributes within a run of characters with the same
		// ones (a colour may change).
		if c.atr & TXT_ATTR_ON_MASK != 0
			&& curatr
				.as_deref()
				.is_none_or(|&cur| cur & TXT_ATTR_ON_VALUES_MASK != c.atr & TXT_ATTR_ON_VALUES_MASK)
		{
			self.d.lastatr = c.atr & TXT_ATTR_ON_MASK;
			self.settextattributes(c.atr & TXT_ATTR_ON_VALUES_MASK);
		}
		if c.atr & TXT_MULTIWORD_MASK != 0 {
			let i = c.chr as usize;
			let n = self.d.nmw.get(i).copied().unwrap_or(0) as usize;
			for k in 0..n {
				let wc = self.d.nmw.get(i + 1 + k).copied().unwrap_or(WEOF);
				self.put_wc(wc);
			}
		} else if c.chr != WEOF {
			self.put_wc(c.chr);
		}
		// "Off" attributes are always written: they end a run.
		if c.atr & TXT_ATTR_OFF_MASK != 0 {
			self.settextattributes(c.atr & TXT_ATTR_OFF_MASK);
			self.d.lastatr &= !on_from_off(c.atr);
		}
		if let Some(cur) = curatr {
			*cur = (c.atr & TXT_ATTR_ON_VALUES_MASK) & !on_from_off(c.atr);
		}
	}

	/// zsh `zputc`.
	fn zputc(&mut self, c: Elem) {
		self.zwcputc(c, None);
	}

	/// zsh `zputs`: metafied `s` unmetafied, tokens skipped.
	fn zputs(&mut self, s: &[u8]) {
		let mut i = 0;
		while i < s.len() {
			let c = s[i];
			if c == META {
				i += 1;
				if let Some(&n) = s.get(i) {
					self.out.push(n ^ 32);
				}
			} else if !is_tok(c) {
				self.out.push(c);
			}
			i += 1;
		}
	}

	/// zsh `addmultiword`: store the glyph `chars` in the new multiword
	/// buffer; its index.
	fn addmultiword(&mut self, chars: &[char]) -> u32 {
		let idx = self.d.nmw.len() as u32;
		self.d.nmw.push(chars.len() as u32);
		self.d.nmw.extend(chars.iter().map(|&c| u32::from(c)));
		idx
	}

	/// zsh `bufswap`: the new buffer becomes the old one.
	fn bufswap(&mut self) {
		std::mem::swap(&mut self.d.nbuf, &mut self.d.obuf);
		std::mem::swap(&mut self.d.nmw, &mut self.d.omw);
		self.d.nmw.clear();
		self.d.nmw.push(0);
	}

	/// zsh `zle_set_highlight`: the attributes of `$zle_highlight` (and
	/// zsh `allocate_colour_buffer`'s colour codes).
	fn zle_set_highlight(&mut self) {
		let (term, nc) = (self.i.term, self.i.nearcolor);
		let mut special_set = false;
		let mut set = [false; N_SPECIAL_HIGHLIGHTS];
		self.d.special_atr_on = 0;
		self.d.default_atr_on = 0;
		self.d.special_atr = [0; N_SPECIAL_HIGHLIGHTS];
		for a in self.i.zle_highlight.unwrap_or_default() {
			let a: &[u8] = a;
			if a == b"none" {
				self.d.special_atr_on = 0;
				self.d.default_atr_on = 0;
				special_set = true;
				set = [true; N_SPECIAL_HIGHLIGHTS];
			} else if let Some(v) = a.strip_prefix(b"default:") {
				self.d.default_atr_on = zp::match_highlight(v, term, nc).0;
			} else if let Some(v) = a.strip_prefix(b"special:") {
				self.d.special_atr_on = zp::match_highlight(v, term, nc).0;
				special_set = true;
			} else {
				let names: [&[u8]; N_SPECIAL_HIGHLIGHTS] =
					[b"region:", b"isearch:", b"suffix:", b"paste:"];
				for (k, p) in names.into_iter().enumerate() {
					if let Some(v) = a.strip_prefix(p) {
						self.d.special_atr[k] = zp::match_highlight(v, term, nc).0;
						set[k] = true;
					}
				}
			}
		}
		if !special_set {
			self.d.special_atr_on = TXTSTANDOUT;
		}
		for (k, dflt) in [TXTSTANDOUT, TXTUNDERLINE, TXTBOLDFACE, TXTSTANDOUT]
			.into_iter()
			.enumerate()
		{
			if !set[k] {
				self.d.special_atr[k] = dflt;
			}
		}
		// zsh `allocate_colour_buffer`: colour codes persist until set again.
		for a in self.i.zle_highlight.unwrap_or_default() {
			let a: &[u8] = a;
			let codes: [(&[u8], bool, usize); 6] = [
				(b"fg_start_code:", true, 0),
				(b"fg_default_code:", true, 1),
				(b"fg_end_code:", true, 2),
				(b"bg_start_code:", false, 0),
				(b"bg_default_code:", false, 1),
				(b"bg_end_code:", false, 2),
			];
			for (p, fg, k) in codes {
				if let Some(v) = a.strip_prefix(p) {
					let keys = text::getkeystring(&metafy(v), text::getkey::KEYS_BINDKEY).text;
					let code = BString::from(metafy(&keys));
					if fg {
						self.d.colseqs.fg[k] = code;
					} else {
						self.d.colseqs.bg[k] = code;
					}
				}
			}
		}
	}

	/// zsh's special `region_highlights` for this refresh: start, end and
	/// attributes of the region, the isearch match, the completion suffix
	/// and the last yank.
	fn special_regions(&self) -> [(i64, i64, Zattr); N_SPECIAL_HIGHLIGHTS] {
		let ed = self.i.ed;
		let sa = self.d.special_atr;
		let region = if ed.region_active != 0 {
			let (mut start, mut end) = if ed.cs <= ed.mark {
				(ed.cs, ed.mark)
			} else {
				(ed.mark, ed.cs)
			};
			if ed.region_active == 2 {
				// findeol from the end, findbol from the start.
				let line = &ed.line;
				let mut x = end;
				while x < line.len() && line[x] != '\n' {
					x += 1;
				}
				end = x;
				let mut x = start.min(line.len());
				while x > 0 && line[x - 1] != '\n' {
					x -= 1;
				}
				start = x;
			} else if self.i.vicmd {
				end = incpos(&ed.line, end, self.i.combiningchars);
			}
			(start as i64, end as i64)
		} else {
			(-1, -1)
		};
		let isearch = self
			.i
			.isearch
			.map_or((-1, -1), |(s, e)| (i64::from(s), i64::from(e)));
		let suffix = if self.i.suffixlen != 0 {
			let cs = ed.cs as i64;
			(cs - i64::from(self.i.suffixlen), cs)
		} else {
			(-1, -1)
		};
		let paste = if ed.lastcmd & wflags::YANK != 0 {
			(ed.yank.0 as i64, ed.yank.1 as i64)
		} else {
			(-1, -1)
		};
		[
			(region.0, region.1, sa[0]),
			(isearch.0, isearch.1, sa[1]),
			(suffix.0, suffix.1, sa[2]),
			(paste.0, paste.1, sa[3]),
		]
	}

	/// The attributes of the character at `pos` of the displayed text
	/// (`len` characters, `$PREDISPLAY` of `prelen` first) from the
	/// region highlights: zsh's `base_atr_on` and `base_atr_off`, starting
	/// from `base`. `single` selects `singlerefresh`'s colour rule.
	fn region_atr(
		&self,
		specials: &[(i64, i64, Zattr); N_SPECIAL_HIGHLIGHTS],
		pos: i64,
		len: i64,
		prelen: i64,
		base: Zattr,
		single: bool,
	) -> (Zattr, Zattr) {
		let (mut on, mut off) = (base, 0);
		let users = self
			.i
			.ed
			.region_highlights
			.iter()
			.map(|h| (i64::from(h.start), i64::from(h.end), h.atr, h.flags));
		for (start, end, atr, flags) in specials.iter().map(|&(s, e, a)| (s, e, a, 0)).chain(users) {
			let offset = if flags & ZRH_PREDISPLAY != 0 {
				0
			} else {
				prelen
			};
			if start + offset <= pos && pos < end + offset {
				if single {
					if on & (TXTFGCOLOUR | TXTBGCOLOUR) != 0 {
						// Keep the colour already set.
						on |= atr & !TXT_ATTR_COLOUR_ON_MASK;
					} else {
						on |= atr;
					}
				} else if atr & (TXTFGCOLOUR | TXTBGCOLOUR) != 0 {
					// A later entry's colour wins.
					on = (on & !TXT_ATTR_ON_VALUES_MASK) | atr;
				} else {
					on |= atr;
				}
				if pos == end + offset - 1 || pos == len - 1 {
					off |= off_from_on(atr);
				}
			}
		}
		(on, off)
	}

	/// zsh's `all_atr_on`/`all_atr_off` for special characters given
	/// `base_atr_on`.
	const fn all_atr(&self, base_on: Zattr) -> (Zattr, Zattr) {
		let sp = self.d.special_atr_on;
		let on = if sp & (TXTFGCOLOUR | TXTBGCOLOUR) != 0 {
			// Keep the colours of the special attributes.
			sp | (base_on & !TXT_ATTR_COLOUR_ON_MASK)
		} else {
			sp | base_on
		};
		(on, off_from_on(on))
	}

	/// zsh `resetvideo`.
	fn resetvideo(&mut self) {
		let i = self.i;
		self.d.winw = i.columns;
		self.d.winh = if self.d.term_short {
			1
		} else if i.lines < 2 {
			24
		} else {
			i.lines
		};
		self.d.rwinh = i.lines;
		self.d.vln = 0;
		self.d.vmaxln = 0;
		self.d.winprompt = 0;
		self.d.winpos = -1;
		let w = usize::try_from(self.d.winw).unwrap_or(0) + 2;
		let h = usize::try_from(self.d.winh).unwrap_or(0) + 1;
		if self.d.winw_alloc != self.d.winw || self.d.winh_alloc != self.d.winh {
			self.d.freevideo();
			self.d.nbuf = vec![None; h];
			self.d.obuf = vec![None; h];
			self.d.nbuf[0] = Some(vec![ZR_ZR; w]);
			self.d.obuf[0] = Some(vec![ZR_ZR; w]);
			self.d.nmw = vec![0];
			self.d.omw = vec![0];
			self.d.winw_alloc = self.d.winw;
			self.d.winh_alloc = self.d.winh;
		}
		for l in self
			.d
			.nbuf
			.iter_mut()
			.chain(self.d.obuf.iter_mut())
			.flatten()
		{
			put(l, 0, ZR_NL);
			put(l, 1, ZR_ZR);
		}
		let cols = usize::try_from(i.columns).unwrap_or(0);
		let (w, h) = zp::countprompt(&i.ed.lprompt, cols, 1);
		self.d.lpromptwof = i32::try_from(w).unwrap_or(i32::MAX);
		self.d.lprompth = i32::try_from(h).unwrap_or(i32::MAX);
		let (w, h) = zp::countprompt(&i.ed.rprompt, cols, 0);
		self.d.rpromptw = i32::try_from(w).unwrap_or(i32::MAX);
		self.d.rprompth = i32::try_from(h).unwrap_or(i32::MAX);
		if self.d.lpromptwof == self.d.winw {
			self.d.lpromptw = 0;
			self.d.lprompth += 1;
		} else {
			self.d.lpromptw = self.d.lpromptwof;
		}
		let lpw = self.d.lpromptw;
		if lpw != 0 {
			for b in [&mut self.d.nbuf, &mut self.d.obuf] {
				if let Some(l) = b.get_mut(0).and_then(Option::as_mut) {
					for k in 0..lpw {
						put(l, k, ZR_SP);
					}
					put(l, lpw, ZR_ZR);
				}
			}
		}
		self.d.vcs = lpw;
		self.d.olnct = 0;
		self.d.nlnct = 0;
		if self.d.showinglist > 0 {
			self.d.showinglist = -2;
		}
		self.d.trashedzle = false;
	}

	/// zsh `scrollwindow`: scroll the new buffer up from line `tline`.
	fn scrollwindow(&mut self, tline: i32) {
		let (t, h) = (usize::try_from(tline).unwrap_or(0), usize::try_from(self.d.winh).unwrap_or(0));
		if t < h && h <= self.d.nbuf.len() {
			self.d.nbuf[t..h].rotate_left(1);
		} else if h > 0 && t < self.d.nbuf.len() {
			let (lo, hi) = self.d.nbuf.split_at_mut(t);
			lo[h - 1].clone_from(&hi[0]);
		}
		if tline == 0 {
			self.d.more_start = true;
		}
	}

	/// zsh `nextline`: go to the next line of the main display area
	/// (`wrapped`: the text wrapped); true to stop building.
	fn nextline(&mut self, rp: &mut Rp, wrapped: bool) -> bool {
		let (winw, winh) = (self.d.winw, self.d.winh);
		self.nset(rp.ln, winw + 1, if wrapped { ZR_NL } else { ZR_ZR });
		self.nset(rp.ln, rp.s, ZR_ZR);
		if rp.ln == winh - 1 {
			if rp.canscroll == 0 {
				if rp.nvln != -1
					&& rp.nvln != winh - 1
					&& (self.d.numscrolls != self.d.onumscrolls - 1 || rp.nvln <= winh / 2)
				{
					return true;
				}
				self.d.numscrolls += 1;
				rp.canscroll = winh / 2;
			}
			rp.canscroll -= 1;
			self.scrollwindow(0);
			if rp.nvln != -1 {
				rp.nvln -= 1;
			}
		} else {
			rp.ln += 1;
		}
		self.ensure_nline(rp.ln);
		rp.s = 0;
		rp.sen = winw;
		false
	}

	/// zsh `snextline`: go to the next line of the status area.
	fn snextline(&mut self, rp: &mut Rp) {
		self.nset(rp.ln, rp.s, ZR_ZR);
		if rp.ln != self.d.winh - 1 {
			rp.ln += 1;
		} else if rp.tosln > rp.ln {
			rp.tosln -= 1;
			if rp.nvln > 1 {
				self.scrollwindow(0);
				rp.nvln -= 1;
			} else {
				self.d.more_end = true;
			}
		} else if rp.tosln > 2 && rp.nvln > 1 {
			rp.tosln -= 1;
			if rp.tosln <= rp.nvln {
				self.scrollwindow(0);
				rp.nvln -= 1;
			} else {
				self.scrollwindow(rp.tosln);
				self.d.more_end = true;
			}
		} else {
			rp.more_status = true;
			self.scrollwindow(rp.tosln + 1);
		}
		self.ensure_nline(rp.ln);
		rp.s = 0;
		rp.sen = self.d.winw;
	}

	/// zsh `zrefresh`.
	fn zrefresh(&mut self) -> RefreshOut {
		let mut res = RefreshOut::default();
		// Called while a list is being shown: nothing to do.
		if self.d.inlist {
			return res;
		}
		let ed = self.i.ed;
		let tmpline: Cow<'_, [char]> = if ed.predisplay.is_empty() && ed.postdisplay.is_empty() {
			Cow::Borrowed(&ed.line)
		} else {
			let mut v = Vec::with_capacity(ed.predisplay.len() + ed.line.len() + ed.postdisplay.len());
			v.extend_from_slice(&ed.predisplay);
			v.extend_from_slice(&ed.line);
			v.extend_from_slice(&ed.postdisplay);
			Cow::Owned(v)
		};
		let tmpcs = ed.cs + ed.predisplay.len();

		self.zle_set_highlight();
		let specials = self.special_regions();

		if self.d.clearlist && self.d.listshown > 0 {
			if self.i.term.tccan(Cap::ClearEod) {
				let (ovln, ovcs) = (self.d.vln, self.d.vcs);
				let vl = usize::try_from(self.d.vln).unwrap_or(0);
				let old = self.d.obuf.get(vl).cloned().flatten();
				let nb = self
					.d
					.nbuf
					.get_mut(vl)
					.and_then(|s| std::mem::replace(s, old));
				self.moveto(self.d.nlnct, 0);
				self.tcoutclear(Cap::ClearEod);
				self.moveto(ovln, ovcs);
				let vl = usize::try_from(self.d.vln).unwrap_or(0);
				if let Some(s) = self.d.nbuf.get_mut(vl) {
					*s = nb;
				}
			} else {
				// zsh `invalidatelist()` (its display part here).
				res.invalidatelist = true;
				self.d.showinglist = 0;
				self.moveto(0, 0);
				self.d.clearflag = false;
				self.d.resetneeded = true;
			}
			self.d.listshown = 0;
			self.d.lastlistlen = 0;
			if self.d.showinglist != -2 {
				self.d.showinglist = 0;
			}
		}
		self.d.clearlist = false;

		self.d.cleareol = false;
		self.d.more_start = false;
		self.d.more_end = false;
		self.d.term_short = self.i.singlelinezle || self.i.lines < 3 || !self.i.term.usable();
		let mut t0 = -1;
		if self.d.resetneeded {
			self.d.onumscrolls = 0;
			res.setterm = true;
			if self.d.winchanged {
				self.moveto(0, 0);
				// Clear extra lines even when the terminal cannot clear to
				// the end of the screen.
				t0 = self.d.olnct;
				self.d.winchanged = false;
				self.d.listshown = 0;
			}
			// We probably should only have explicitly set attributes.
			self.tsetcap(Cap::AllAttrsOff);
			self.tsetcap(Cap::StandoutEnd);
			self.tsetcap(Cap::UnderlineEnd);
			self.resetvideo();
			self.d.resetneeded = false;
			// No right prompt on the screen.
			self.d.oput_rpmpt = false;
			if !self.d.clearflag {
				if self.i.term.tccan(Cap::ClearEod) {
					self.tcoutclear(Cap::ClearEod);
				} else {
					self.d.cleareol = true;
				}
				if self.d.listshown > 0 {
					self.d.listshown = 0;
				}
			}
			if t0 > -1 {
				self.d.olnct = t0.min(self.d.winh);
			}
			if self.d.term_short {
				self.d.vcs = 0;
			} else if !self.d.clearflag && !ed.lprompt.is_empty() {
				self.zputs(&ed.lprompt);
				if self.d.lpromptwof == self.d.winw {
					// Works with both hasam and !hasam.
					self.out.push(b'\n');
				}
			} else {
				self.settextattributes(self.i.pmpt_attr);
			}
			if self.d.clearflag {
				self.zputc(ZR_CR);
				self.d.vcs = 0;
				self.moveto(0, self.d.lpromptw);
			}
			self.d.clearf = self.d.clearflag;
		} else if self.d.winw != self.i.columns || self.d.rwinh != self.i.lines {
			self.resetvideo();
		}

		if self.d.term_short {
			self.singlerefresh(&tmpline, tmpcs, &specials);
		} else {
			self.refresh_lines(&tmpline, tmpcs, &specials);
		}

		// A new list showing, or part of the list overwritten: list again.
		if self.d.showinglist == -2 || (self.d.showinglist > 0 && self.d.showinglist < self.d.nlnct) {
			res.list = true;
			return res;
		}
		self.d.list_done();
		res
	}

	/// The multi-line part of zsh's `zrefresh`: build the new video
	/// buffer, then update the screen line by line.
	#[expect(clippy::too_many_lines, reason = "a faithful port of one C function")]
	fn refresh_lines(
		&mut self,
		tmpline: &[char],
		tmpcs: usize,
		specials: &[(i64, i64, Zattr); N_SPECIAL_HIGHLIGHTS],
	) {
		let ed = self.i.ed;
		let winw = self.d.winw;
		let tmpll = tmpline.len();
		let prelen = ed.predisplay.len() as i64;
		self.d.numscrolls = 0;

		// First the video line buffers: what to put on the screen, and
		// the cursor position (nvln, nvcs).
		self.ensure_nline(0);
		let mut rp = Rp { nvln: -1, s: self.d.lpromptw, sen: winw, ..Rp::default() };
		let mut t = 0usize;
		while t < tmpll {
			let (base_on, base_off) =
				self.region_atr(specials, t as i64, tmpll as i64, prelen, self.d.default_atr_on, false);
			let (all_on, all_off) = self.all_atr(base_on);
			if t == tmpcs {
				rp.nvln = rp.ln;
				rp.nvcs = rp.s;
			}
			let c = tmpline[t];
			if c == '\n' {
				// Text not wrapped.
				if self.nextline(&mut rp, false) {
					break;
				}
			} else if c == '\t' {
				let mut t0 = rp.s;
				if (t0 | 7) + 1 >= winw {
					// Text wrapped.
					if self.nextline(&mut rp, true) {
						break;
					}
				} else {
					loop {
						self.nset(rp.ln, rp.s, Elem { chr: u32::from(b' '), atr: base_on });
						rp.s += 1;
						t0 += 1;
						if t0 & 7 == 0 {
							break;
						}
					}
					self.nor(rp.ln, rp.s - 1, base_off);
				}
			} else if let Some(mut width) = shown_width(c) {
				if width > rp.sen - rp.s {
					// Too wide to fit: spaces to the end of the line.
					loop {
						self.nset(rp.ln, rp.s, Elem { chr: u32::from(b' '), atr: all_on });
						rp.s += 1;
						if rp.s >= rp.sen {
							break;
						}
					}
					self.nor(rp.ln, rp.s - 1, all_off);
					if self.nextline(&mut rp, true) {
						break;
					}
					if t == tmpcs {
						rp.nvln = rp.ln;
						rp.nvcs = rp.s;
					}
				}
				let mut ichars = 1;
				if self.i.combiningchars && is_basechar(c) {
					while t + ichars < tmpll && is_combining(tmpline[t + ichars]) {
						ichars += 1;
					}
				}
				if width > rp.sen - rp.s {
					// The screen cannot fit even one.
					self.nset(rp.ln, rp.s, Elem { chr: u32::from(b'?'), atr: all_on | all_off });
					rp.s += 1;
				} else {
					// Off attributes go with the character itself (the
					// WEOF cells are not written).
					let atr = base_on | base_off;
					let e = if ichars > 1 {
						let idx = self.addmultiword(&tmpline[t..t + ichars]);
						Elem { chr: idx, atr: atr | TXT_MULTIWORD_MASK }
					} else {
						Elem { chr: u32::from(c), atr }
					};
					self.nset(rp.ln, rp.s, e);
					rp.s += 1;
					width -= 1;
					while width > 0 {
						self.nset(rp.ln, rp.s, Elem { chr: WEOF, atr });
						rp.s += 1;
						width -= 1;
					}
				}
				t += ichars - 1;
			} else if iswcntrl(c) && u32::from(c) <= 0xff {
				// Other control character.
				self.nset(rp.ln, rp.s, Elem { chr: u32::from(b'^'), atr: all_on });
				rp.s += 1;
				if rp.s == rp.sen {
					// Text wrapped.
					self.nor(rp.ln, rp.s - 1, all_off);
					if self.nextline(&mut rp, true) {
						break;
					}
				}
				self.nset(rp.ln, rp.s, Elem { chr: ctrl_char(u32::from(c)), atr: all_on | all_off });
				rp.s += 1;
			} else {
				// Not printable or zero width: show the code.
				let disp = match invalid_byte(c) {
					Some(b) => format!("<{b:02x}>"),
					None if u32::from(c) > 0xffff => format!("<{:08x}>", u32::from(c)),
					None => format!("<{:04x}>", u32::from(c)),
				};
				let mut started = false;
				let mut stopped = false;
				for b in disp.bytes() {
					self.nset(rp.ln, rp.s, Elem { chr: u32::from(b), atr: all_on });
					started = true;
					rp.s += 1;
					if rp.s == rp.sen {
						// Text wrapped.
						if started {
							self.nor(rp.ln, rp.s - 1, all_off);
							started = false;
						}
						if self.nextline(&mut rp, true) {
							stopped = true;
							break;
						}
					}
				}
				if started {
					self.nor(rp.ln, rp.s - 1, all_off);
				}
				if stopped {
					break;
				}
			}
			if rp.s == rp.sen {
				// Text wrapped.
				if self.nextline(&mut rp, true) {
					break;
				}
			}
			t += 1;
		}

		// If we're really on the next line, don't fake it.
		if t == tmpcs {
			rp.nvln = rp.ln;
			rp.nvcs = rp.s;
			if rp.nvcs == winw {
				// Text wrapped.
				self.nextline(&mut rp, true);
				self.nset(rp.ln, rp.s, ZR_ZR);
				rp.nvcs = 0;
				rp.nvln += 1;
			}
		}

		if t != tmpll {
			self.d.more_end = true;
		}

		if let Some(sl) = &ed.statusline {
			let outputline = to_line(sl);
			let all_on = self.d.special_atr_on;
			let all_off = off_from_on(all_on);
			rp.tosln = rp.ln + 1;
			// Text not wrapped.
			self.nset(rp.ln, winw + 1, ZR_ZR);
			self.snextline(&mut rp);
			for &u in &outputline {
				if iswprint(u) {
					let width = wcwidth(u);
					// Wide characters as above.
					if width > rp.sen - rp.s {
						loop {
							self.nset(rp.ln, rp.s, ZR_SP);
							rp.s += 1;
							if rp.s >= rp.sen {
								break;
							}
						}
						self.nset(rp.ln, winw + 1, ZR_NL);
						self.snextline(&mut rp);
					}
					if width > rp.sen - rp.s {
						self.nset(rp.ln, rp.s, Elem { chr: u32::from(b'?'), atr: all_on | all_off });
						rp.s += 1;
					} else {
						self.nset(rp.ln, rp.s, Elem { chr: u32::from(u), atr: 0 });
						rp.s += 1;
						let mut w = width - 1;
						while w > 0 {
							self.nset(rp.ln, rp.s, Elem { chr: WEOF, atr: 0 });
							rp.s += 1;
							w -= 1;
						}
					}
				} else if iswcntrl(u) {
					// Simplified processing in the status line.
					self.nset(rp.ln, rp.s, Elem { chr: u32::from(b'^'), atr: all_on });
					rp.s += 1;
					if rp.s == rp.sen {
						// Text wrapped.
						self.nset(rp.ln, winw + 1, ZR_NL);
						self.snextline(&mut rp);
					}
					self.nset(rp.ln, rp.s, Elem { chr: ctrl_char(u32::from(u)), atr: all_on | all_off });
					rp.s += 1;
				} else {
					self.nset(rp.ln, rp.s, Elem { chr: u32::from(u), atr: 0 });
					rp.s += 1;
				}
				if rp.s == rp.sen {
					// Text wrapped.
					self.nset(rp.ln, winw + 1, ZR_NL);
					self.snextline(&mut rp);
				}
			}
			if rp.s == rp.sen {
				self.snextline(&mut rp);
			}
		}
		self.nset(rp.ln, rp.s, ZR_ZR);

		// `<....` at the end of the last line when there is more text past
		// the end of the screen.
		if self.d.more_end {
			if ed.statusline.is_none() {
				rp.tosln = self.d.winh;
			}
			let ln = rp.tosln - 1;
			let mut sen = winw - 7;
			for s in 0..sen.max(0) {
				if self.nget(ln, s).chr == 0 {
					for k in s..sen {
						self.nset(ln, k, ZR_SP);
					}
					// Do not trigger the WEOF test.
					let e = self.nget(ln, sen);
					self.nset(ln, sen, Elem { chr: 0, atr: e.atr });
					break;
				}
			}
			// Do not start overwriting in the middle of a wide character.
			let mut extra = 0;
			while sen > 0 && self.nget(ln, sen).chr == WEOF {
				extra += 1;
				sen -= 1;
			}
			for (k, &e) in ZR_END_ELLIPSIS.iter().enumerate() {
				self.nset(ln, sen + k as i32, e);
			}
			// Extend to the end if we backed off for a wide character.
			if extra != 0 {
				sen += ZR_END_ELLIPSIS.len() as i32;
				for k in 0..extra {
					self.nset(ln, sen + k, ZR_DT);
				}
			}
			self.nset(ln, winw, ZR_ZR);
			self.nset(ln, winw + 1, ZR_ZR);
		}

		// `<....>` at the end of the first status line when the status is
		// too big.
		if rp.more_status {
			let ln = rp.tosln;
			let mut sen = winw - 8;
			for s in 0..sen.max(0) {
				if self.nget(ln, s).chr == 0 {
					for k in s..sen {
						self.nset(ln, k, ZR_SP);
					}
					break;
				}
			}
			let mut extra = 0;
			while sen > 0 && self.nget(ln, sen).chr == WEOF {
				extra += 1;
				sen -= 1;
			}
			for (k, &e) in ZR_MID_ELLIPSIS1.iter().enumerate() {
				self.nset(ln, sen + k as i32, e);
			}
			sen += ZR_MID_ELLIPSIS1.len() as i32;
			for k in 0..extra {
				self.nset(ln, sen + k, ZR_DT);
			}
			sen += extra;
			for (k, &e) in ZR_MID_ELLIPSIS2.iter().enumerate() {
				self.nset(ln, sen + k as i32, e);
			}
			self.nset(ln, winw, ZR_ZR);
			self.nset(ln, winw + 1, ZR_ZR);
		}

		self.d.nlnct = rp.ln + 1;
		let from = usize::try_from(self.d.nlnct).unwrap_or(0);
		let to = usize::try_from(self.d.winh)
			.unwrap_or(0)
			.min(self.d.nbuf.len());
		for l in self.d.nbuf.iter_mut().take(to).skip(from) {
			*l = None;
		}

		// Does the right prompt exist and fit on the screen?
		let mut rprompt_off = 1;
		if self.d.more_start {
			// `>....` on the first line: there is text before the start of
			// the screen.
			let lpw = self.d.lpromptw;
			for k in 0..lpw {
				self.nset(0, k, ZR_SP);
			}
			let n = (winw - lpw).min(ZR_START_ELLIPSIS.len() as i32);
			for k in 0..n.max(0) {
				self.nset(0, lpw + k, ZR_START_ELLIPSIS[k as usize]);
			}
			for k in 0..(winw - n - lpw).max(0) {
				self.nset(0, lpw + n + k, ZR_SP);
			}
			self.nset(0, winw, ZR_ZR);
			self.nset(0, winw + 1, ZR_ZR);
		} else if self.d.trashedzle && self.i.transientrprompt {
			self.d.put_rpmpt = false;
		} else {
			let rp_buf = &ed.rprompt;
			self.d.put_rpmpt = self.d.rprompth == 1 && !rp_buf.is_empty() && !rp_buf.contains(&b'\t');
			if self.d.put_rpmpt {
				rprompt_off = self.i.rprompt_indent.max(0);
				let len0 = self
					.d
					.nbuf
					.first()
					.and_then(|l| l.as_deref())
					.map_or(0, |l| zr_strlen(l, 0));
				self.d.put_rpmpt = len0 + self.d.rpromptw < winw - rprompt_off;
			}
		}

		let mut iln = 0;
		while iln < self.d.nlnct {
			// More lines than last time: clear the newly used ones.
			if iln >= self.d.olnct {
				self.d.cleareol = true;
			}
			// If the lines differ, see whether inserting or deleting a line
			// is quicker.
			self.insdel_line(iln);
			self.refreshline(iln);

			// The right prompt.
			if self.d.put_rpmpt && iln == 0 && !self.d.oput_rpmpt {
				self.moveto(0, winw - rprompt_off - self.d.rpromptw);
				self.zputs(&ed.rprompt);
				if rprompt_off != 0 {
					self.d.vcs = winw - rprompt_off;
				} else {
					self.zputc(ZR_CR);
					self.d.vcs = 0;
				}
				// Back to the attributes the main prompt set, keeping
				// those that actually changed.
				let txtchange = self.i.pmpt_attr;
				let rpa = self.i.rpmpt_attr;
				let mut attrchange = txtchange & (off_from_on(rpa) | on_from_off(rpa));
				// Careful in case the colour changed.
				if txtchange & TXTFGCOLOUR != 0
					&& (rpa & TXTFGCOLOUR == 0 || (txtchange ^ rpa) & TXT_ATTR_FG_COL_MASK != 0)
				{
					attrchange |= txtchange & (TXTFGCOLOUR | TXT_ATTR_FG_COL_MASK);
				}
				if txtchange & TXTBGCOLOUR != 0
					&& (rpa & TXTBGCOLOUR == 0 || (txtchange ^ rpa) & TXT_ATTR_BG_COL_MASK != 0)
				{
					attrchange |= txtchange & (TXTBGCOLOUR | TXT_ATTR_BG_COL_MASK);
				}
				if attrchange != 0 {
					self.settextattributes(attrchange);
				}
			}
			iln += 1;
		}

		// Lines the old buffer had extra: clear them.
		if self.d.olnct > self.d.nlnct {
			self.d.cleareol = true;
			for iln in self.d.nlnct..self.d.olnct {
				self.refreshline(iln);
			}
		}

		// Reset character attributes.
		if self.d.clearf && self.i.postedit.is_some() {
			let txtchange = if self.i.pmpt_attr != 0 {
				self.i.pmpt_attr
			} else {
				self.i.rpmpt_attr
			};
			if txtchange != 0 {
				self.settextattributes(txtchange);
			}
		}
		self.d.clearf = false;
		self.d.oput_rpmpt = self.d.put_rpmpt;

		self.moveto(rp.nvln, rp.nvcs);
		self.bufswap();

		self.d.olnct = self.d.nlnct;
		self.d.onumscrolls = self.d.numscrolls;
		if self.d.nlnct > self.d.vmaxln {
			self.d.vmaxln = self.d.nlnct;
		}
	}

	/// zsh `zrefresh`'s line insertion and deletion: when old line `iln`
	/// differs from the new one but matches the next new line (or the new
	/// line matches the next old one), insert (delete) a terminal line.
	fn insdel_line(&mut self, iln: i32) {
		/// Line `k` of video buffer `b`.
		fn line(b: &[Option<Line>], k: usize) -> Option<&[Elem]> {
			b.get(k).and_then(|l| l.as_deref())
		}
		let d = &*self.d;
		let u = usize::try_from(iln).unwrap_or(0);
		let (Some(ol), Some(nl)) = (line(&d.obuf, u), line(&d.nbuf, u)) else {
			return;
		};
		if d.clearf
			|| iln == 0
			|| iln >= d.olnct - 1
			|| (self.i.term.hasam && d.vcs == d.winw)
			|| !zr_strncmp(ol, nl, 16, &d.omw, &d.nmw)
		{
			return;
		}
		let term = self.i.term;
		if term.tccan(Cap::DelLine)
			&& let Some(on) = line(&d.obuf, u + 1)
			&& at(on, 0).chr != 0
			&& !zr_strncmp(on, nl, 16, &d.omw, &d.nmw)
		{
			self.moveto(iln, 0);
			self.tcout(Cap::DelLine);
			let olnct = usize::try_from(self.d.olnct).unwrap_or(0);
			for t0 in u..olnct {
				let next = self.d.obuf.get(t0 + 1).cloned().flatten();
				if let Some(s) = self.d.obuf.get_mut(t0) {
					*s = next;
				}
			}
			self.d.olnct -= 1;
			if let Some(s) = self.d.obuf.get_mut(olnct - 1) {
				*s = None;
			}
		} else if term.tccan(Cap::InsLine)
			&& d.olnct < d.vmaxln
			&& let Some(nn) = line(&d.nbuf, u + 1)
			&& !zr_strncmp(ol, nn, 16, &d.omw, &d.nmw)
		{
			// Not when olnct = vmaxln (the lines this routine displayed):
			// we would go off the end of the screen.
			self.moveto(iln, 0);
			self.tcout(Cap::InsLine);
			let olnct = usize::try_from(self.d.olnct).unwrap_or(0);
			for t0 in (u + 1..=olnct).rev() {
				let prev = self.d.obuf.get_mut(t0 - 1).and_then(Option::take);
				if let Some(s) = self.d.obuf.get_mut(t0) {
					*s = prev;
				}
			}
			self.d.olnct += 1;
		}
	}
}
