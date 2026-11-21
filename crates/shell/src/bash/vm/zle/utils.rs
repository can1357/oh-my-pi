//! Line-editing primitives (zsh 5.9 `Src/Zle/zle_utils.c`, plus the
//! cursor helpers of `zle_move.c` and `pastebuf`/`doinsert` of
//! `zle_misc.c`): making room in the line and removing text, the cut
//! buffer and kill ring, line boundaries, replacing the line, combining
//! character alignment, messages, beeps and the yes/no query.
//!
//! zsh keeps the line as a `ZLE_STRING_T` it grows by hand (`sizeline`)
//! and converts to and from a metafied string around completion; here
//! the line is [`Editor::line`] (`Vec<char>`, invalid bytes as
//! [`super::invalid_char`]s), so the sizing and metafication machinery
//! has no counterpart while the semantics (positions, mark and highlight
//! adjustment, `CCRIGHT` after an edit) stay zsh's.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::BString;

use super::{
	CUTBUFFER_LINE, CutBuffer, Editor, Zle,
	exec::{Await, Got, WResult, Zw, then},
	invalid_byte, modflags,
	refresh::ZRH_PREDISPLAY,
	to_line, wflags,
};
use crate::bash::{
	vm::{
		builtins::zsh_quote::{Charset, nicechar_sel, niceformat},
		zsh::wcwidth::wcwidth,
	},
	zshopt::ZshOpt,
};

/// `CUT_*` flags of [`cut`], [`cuttext`], [`forekill`], [`backkill`],
/// [`foredel`] and [`backdel`] (zsh `zle.h`).
pub mod cutflags {
	/// The text goes in front of the cut buffer.
	pub const FRONT: u32 = 1 << 0;
	/// The text replaces the cut buffer.
	pub const REPLACE: u32 = 1 << 1;
	/// Counts are raw line positions, not characters with their
	/// combining marks (not used by [`super::cuttext`] itself).
	pub const RAW: u32 = 1 << 2;
	/// A vi yank: the text goes to register `"0`, not `"1`–`"9`.
	pub const YANK: u32 = 1 << 3;
}

/// [`setline`] flag (zsh `ZSL_COPY`): zsh copies its argument instead of
/// taking it over; [`setline`] always copies (it borrows the text), so
/// the flag only documents the caller's intent as zsh's call sites do.
pub const ZSL_COPY: u32 = 1;
/// [`setline`] flag (zsh `ZSL_TOEND`): put the cursor at the end of the
/// new line (on its last character in vi command mode).
pub const ZSL_TOEND: u32 = 2;

/// zsh `KRINGCTDEF`: the kill ring size it starts with.
pub const KRINGCTDEF: usize = 8;

/// The buffer the last yank came from (zsh `kctbuf`): `yank-pop` cycles
/// from it through the kill ring and back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KctBuf {
	/// The cut buffer.
	Cut,
	/// vi register `n` (0–35).
	Vi(usize),
}

/// Editing state zsh keeps in globals for the line being read
/// ([`Editor::ls`]), reset by `zleread`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineState {
	/// zsh `lastcol`: the column line-wise motions return to (`-1`:
	/// none). The core sets it to `-1` before every widget without
	/// [`wflags::LASTCOL`] ([`pre_widget`]).
	pub lastcol:        i64,
	/// zsh `vilinerange`: the text being cut is whole lines. Set for
	/// [`wflags::LINEMOVE`] widgets ([`pre_widget`]) and by vi
	/// operators; the core clears it before reading each key.
	pub vilinerange:    bool,
	/// zsh `virangeflag`: a vi operator is reading its motion (the
	/// `…-or-history` motions then stay within the buffer).
	pub virangeflag:    bool,
	/// zsh `viinsbegin`: where the current vi insertion began.
	pub viinsbegin:     usize,
	/// zsh `kctbuf`: the buffer the last yank came from.
	pub kctbuf:         Option<KctBuf>,
	/// zsh `yankcs`: the cursor before the last yank.
	pub yankcs:         usize,
	/// `isset(COMBININGCHARS)`, as [`pre_widget`] last saw it: zero-width
	/// characters stay with the character before them.
	pub combining:      bool,
	/// `isset(PRINTEIGHTBIT)`, as [`pre_widget`] last saw it ([`showmsg`]).
	pub print_eight:    bool,
	/// zsh `hist_skip_flags & HIST_FOREIGN` (`set-local-history`):
	/// history motions skip other sessions' events.
	pub localhistory:   bool,
	/// zsh `isearch_startpos`/`isearch_endpos`: the match an incremental
	/// search shows.
	pub isearch:        (usize, usize),
	/// zsh `isearch_active`: an incremental search is running.
	pub isearch_active: bool,
	/// zsh `suffixlen`: the length of the auto-removable completion
	/// suffix (0: none).
	pub suffixlen:      usize,
	/// zsh `wordflag`: a vi operator (`getvirange`) runs a word motion,
	/// which stops at the end of the last word instead of the start of
	/// the next.
	pub wordflag:       bool,
}

impl LineState {
	/// The state of a fresh line.
	pub const fn new() -> Self {
		Self {
			lastcol:        -1,
			vilinerange:    false,
			virangeflag:    false,
			viinsbegin:     0,
			kctbuf:         None,
			yankcs:         0,
			combining:      false,
			print_eight:    false,
			localhistory:   false,
			isearch:        (0, 0),
			isearch_active: false,
			suffixlen:      0,
			wordflag:       false,
		}
	}
}

impl Default for LineState {
	fn default() -> Self {
		Self::new()
	}
}

/// What zsh's `execzlefunc` does to this state before an internal
/// widget with flags `wflags` runs (`ZLE_LINEMOVE` sets `vilinerange`,
/// no `ZLE_LASTCOL` forgets `lastcol`), plus reading `COMBININGCHARS`
/// (alignment helpers) and `PRINTEIGHTBIT` ([`showmsg`]).
pub fn pre_widget(zw: &mut Zw<'_, '_>, wflags: u32) {
	let combining = zw.isset(ZshOpt::Combiningchars);
	let print_eight = zw.isset(ZshOpt::Printeightbit);
	let ls = &mut zw.ed.ls;
	ls.combining = combining;
	ls.print_eight = print_eight;
	if wflags & wflags::LINEMOVE != 0 {
		ls.vilinerange = true;
	}
	if wflags & wflags::LASTCOL == 0 {
		ls.lastcol = -1;
	}
}

/// zsh `invicmdmode()`: the `vicmd` keymap is selected.
pub fn invicmdmode(ed: &Editor) -> bool {
	ed.keymap.as_slice() == b"vicmd"
}

/// zsh `IS_COMBINING`: a printable character taking no column.
pub fn is_combining(c: char) -> bool {
	c != '\0' && wcwidth(c) == 0
}

/// zsh `IS_BASECHAR`: a graphic character taking columns, which a
/// combining character can sit on.
pub fn is_basechar(c: char) -> bool {
	wcwidth(c) > 0 && !c.is_whitespace()
}

/// zsh `ZC_iblank`: white space other than a newline.
pub const fn iblank(c: char) -> bool {
	c != '\n' && c.is_whitespace()
}

/// zsh `alignmultiwordleft`: when `*pos` is on a combining character
/// (with [`LineState::combining`]), whether a base character precedes it
/// and, with `setpos`, move `*pos` there.
pub fn alignmultiwordleft(ed: &Editor, pos: &mut usize, setpos: bool) -> bool {
	let mut loccs = *pos;
	if !ed.ls.combining || loccs >= ed.line.len() || loccs == 0 {
		return false;
	}
	if !is_combining(ed.line[loccs]) {
		return false;
	}
	loccs -= 1;
	loop {
		let c = ed.line[loccs];
		if is_basechar(c) {
			if setpos {
				*pos = loccs;
			}
			return true;
		}
		if !is_combining(c) {
			return false;
		}
		if loccs == 0 {
			return false;
		}
		loccs -= 1;
	}
}

/// zsh `alignmultiwordright`: when `*pos` is on a combining character
/// that [`alignmultiwordleft`] would align, with `setpos` move `*pos`
/// past the combining characters.
pub fn alignmultiwordright(ed: &Editor, pos: &mut usize, setpos: bool) -> bool {
	let mut probe = *pos;
	if !alignmultiwordleft(ed, &mut probe, false) {
		return false;
	}
	let mut loccs = *pos + 1;
	while loccs < ed.line.len() {
		if !is_combining(ed.line[loccs]) {
			if setpos {
				*pos = loccs;
			}
			return true;
		}
		loccs += 1;
	}
	if setpos {
		*pos = loccs;
	}
	true
}

/// zsh `CCLEFT()`: align the cursor left onto its base character.
pub fn ccleft(ed: &mut Editor) {
	let mut cs = ed.cs;
	alignmultiwordleft(ed, &mut cs, true);
	ed.cs = cs;
}

/// zsh `CCRIGHT()`: move the cursor past combining characters it is on.
pub fn ccright(ed: &mut Editor) {
	let mut cs = ed.cs;
	alignmultiwordright(ed, &mut cs, true);
	ed.cs = cs;
}

/// zsh `INCCS()`: the cursor one character right.
pub fn inccs(ed: &mut Editor) {
	ed.cs += 1;
	ccright(ed);
}

/// zsh `DECCS()`: the cursor one character left (callers check it is
/// not at the start; zsh would go to -1 there, this stays at 0).
pub fn deccs(ed: &mut Editor) {
	ed.cs = ed.cs.saturating_sub(1);
	ccleft(ed);
}

/// zsh `INCPOS(pos)`: `pos` one character right.
pub fn incpos(ed: &Editor, pos: &mut usize) {
	*pos += 1;
	alignmultiwordright(ed, pos, true);
}

/// zsh `DECPOS(pos)`: `pos` one character left.
pub fn decpos(ed: &Editor, pos: &mut usize) {
	*pos = pos.saturating_sub(1);
	alignmultiwordleft(ed, pos, true);
}

/// The position of a region highlight relative to the line (zsh
/// subtracts `predisplaylen` for `ZRH_PREDISPLAY` entries).
fn hl_sub(ed: &Editor, flags: u32) -> i64 {
	if flags & ZRH_PREDISPLAY != 0 {
		i64::try_from(ed.predisplay.len()).unwrap_or(i64::MAX)
	} else {
		0
	}
}

/// A line position as a highlight offset.
fn hl_pos(n: usize) -> i64 {
	i64::try_from(n).unwrap_or(i64::MAX)
}

/// A highlight offset back into its field.
fn hl_store(v: i64) -> i32 {
	i32::try_from(v).unwrap_or(if v < 0 { i32::MIN } else { i32::MAX })
}

/// zsh `spaceinline`: make room for `ct` characters at the cursor (the
/// caller fills them; they are NULs until then). The mark, `viinsbegin`
/// and the region highlights after the cursor move along; the region is
/// deactivated.
pub fn spaceinline(ed: &mut Editor, ct: usize) {
	let cs = ed.cs.min(ed.line.len());
	drop(ed.line.splice(cs..cs, std::iter::repeat_n('\0', ct)));
	if ed.mark > ed.cs {
		ed.mark += ct;
	}
	if ed.ls.viinsbegin > ed.cs {
		ed.ls.viinsbegin = 0;
	}
	let at = hl_pos(ed.cs);
	let d = hl_pos(ct);
	for i in 0..ed.region_highlights.len() {
		let sub = hl_sub(ed, ed.region_highlights[i].flags);
		let rh = &mut ed.region_highlights[i];
		if i64::from(rh.start) - sub >= at {
			rh.start = hl_store(i64::from(rh.start) + d);
		}
		if i64::from(rh.end) - sub >= at {
			rh.end = hl_store(i64::from(rh.end) + d);
		}
	}
	ed.region_active = 0;
}

/// Insert `s` at the cursor and move the cursor after it (zsh's
/// `spaceinline(n); ZS_memcpy(zleline + zlecs, s, n); zlecs += n`).
pub fn insert_at_cs(ed: &mut Editor, s: &[char]) {
	spaceinline(ed, s.len());
	let cs = ed.cs.min(ed.line.len());
	ed.line[cs..cs + s.len()].copy_from_slice(s);
	ed.cs = cs + s.len();
}

/// zsh `shiftchars`: remove the `cnt` characters at `to`. The mark and
/// region highlights inside or after them move back; the region is
/// deactivated. The cursor is the caller's.
pub fn shiftchars(ed: &mut Editor, to: usize, cnt: usize) {
	if ed.mark >= to + cnt {
		ed.mark -= cnt;
	} else if ed.mark > to {
		ed.mark = to;
	}
	let at = hl_pos(to);
	let end = hl_pos(to + cnt);
	for i in 0..ed.region_highlights.len() {
		let sub = hl_sub(ed, ed.region_highlights[i].flags);
		let rh = &mut ed.region_highlights[i];
		if i64::from(rh.start) - sub > at {
			rh.start = if i64::from(rh.start) - sub > end {
				hl_store(i64::from(rh.start) - hl_pos(cnt))
			} else {
				hl_store(at)
			};
		}
		if i64::from(rh.end) - sub > at {
			rh.end = if i64::from(rh.end) - sub > end {
				hl_store(i64::from(rh.end) - hl_pos(cnt))
			} else {
				hl_store(at)
			};
		}
	}
	let len = ed.line.len();
	ed.line.drain(to.min(len)..(to + cnt).min(len));
	ed.region_active = 0;
}

/// zsh `cut`: [`cuttext`] of the `ct` characters at `i` (the text stays
/// in the line).
pub fn cut(zle: &mut Zle, ed: &Editor, i: usize, ct: usize, flags: u32) {
	let len = ed.line.len();
	let a = i.min(len);
	cuttext(zle, ed, &ed.line[a..(i + ct).min(len)], flags);
}

/// zsh `cuttext`: put `text` into the cut buffer (and vi registers):
///
/// - with a register selected (`"x`), into it (appended with `"X`); else a vi
///   yank ([`cutflags::YANK`]) into `"0`, any other cut into `"1` with
///   `"1`–`"8` shifted to `"2`–`"9`;
/// - the cut buffer is pushed onto the kill ring first unless the last widget
///   was a kill ([`wflags::KILL`] in [`Editor::lastcmd`]) and the text is not
///   to replace it ([`cutflags::REPLACE`]); successive kills append (or
///   prepend, [`cutflags::FRONT`]) instead.
///
/// Nothing happens for empty text outside a vi line range, or with the
/// `"_` register.
pub fn cuttext(zle: &mut Zle, ed: &Editor, text: &[char], flags: u32) {
	let vilinerange = ed.ls.vilinerange;
	if (text.is_empty() && !vilinerange) || ed.zmod.flags & modflags::NULL != 0 {
		return;
	}
	let lineflag = if vilinerange { CUTBUFFER_LINE } else { 0 };
	let fresh = || Some(CutBuffer { buf: text.to_vec(), flags: lineflag });
	if ed.zmod.flags & modflags::VIBUF != 0 {
		let append = ed.zmod.flags & modflags::VIAPP != 0;
		if let Some(slot) = zle.vibuf.get_mut(ed.zmod.vibuf as usize) {
			if append && let Some(b) = slot.as_mut() {
				if vilinerange {
					b.flags |= CUTBUFFER_LINE;
				}
				if b.flags & CUTBUFFER_LINE != 0 {
					b.buf.push('\n');
				}
				b.buf.extend_from_slice(text);
			} else {
				*slot = fresh();
			}
		}
	} else if flags & cutflags::YANK != 0 {
		if let Some(slot) = zle.vibuf.get_mut(26) {
			*slot = fresh();
		}
	} else if zle.vibuf.len() > 35 {
		zle.vibuf[27..=35].rotate_right(1);
		zle.vibuf[27] = fresh();
	}
	if zle.cutbuf.is_none() {
		zle.cutbuf = Some(CutBuffer::default());
	} else if ed.lastcmd & wflags::KILL == 0 || flags & cutflags::REPLACE != 0 {
		// zsh allocates the ring (KRINGCTDEF entries) on first use.
		if zle.kring_size == 0 {
			zle.kring_size = KRINGCTDEF;
		}
		if let Some(old) = zle.cutbuf.replace(CutBuffer::default()) {
			zle.kring.push_front(old);
			zle.kring.truncate(zle.kring_size);
		}
	}
	if let Some(cb) = zle.cutbuf.as_mut() {
		if flags & (cutflags::FRONT | cutflags::REPLACE) != 0 {
			drop(cb.buf.splice(0..0, text.iter().copied()));
		} else {
			cb.buf.extend_from_slice(text);
		}
		if vilinerange {
			cb.flags |= CUTBUFFER_LINE;
		} else {
			cb.flags &= !CUTBUFFER_LINE;
		}
	}
}

/// zsh `backkill`: kill `ct` characters before the cursor (whole
/// characters with their combining marks unless [`cutflags::RAW`]).
pub fn backkill(zle: &mut Zle, ed: &mut Editor, ct: usize, flags: u32) {
	let ct = if flags & cutflags::RAW != 0 {
		ed.cs = ed.cs.saturating_sub(ct);
		ct
	} else {
		let origcs = ed.cs;
		for _ in 0..ct {
			deccs(ed);
		}
		origcs - ed.cs
	};
	cut(zle, ed, ed.cs, ct, flags);
	shiftchars(ed, ed.cs, ct);
	ccright(ed);
}

/// zsh `forekill`: kill `ct` characters from the cursor.
pub fn forekill(zle: &mut Zle, ed: &mut Editor, ct: usize, flags: u32) {
	let i = ed.cs;
	let ct = if flags & cutflags::RAW == 0 {
		for _ in 0..ct {
			inccs(ed);
		}
		let n = ed.cs - i;
		ed.cs = i;
		n
	} else {
		ct
	};
	cut(zle, ed, i, ct, flags);
	shiftchars(ed, i, ct);
	ccright(ed);
}

/// zsh `backdel`: delete `ct` characters before the cursor, not into the
/// cut buffer.
pub fn backdel(ed: &mut Editor, ct: usize, flags: u32) {
	if flags & cutflags::RAW != 0 {
		ed.cs = ed.cs.saturating_sub(ct);
		shiftchars(ed, ed.cs, ct);
	} else {
		let origcs = ed.cs;
		for _ in 0..ct {
			deccs(ed);
		}
		shiftchars(ed, ed.cs, origcs - ed.cs);
	}
	ccright(ed);
}

/// zsh `foredel`: delete `ct` characters from the cursor, not into the
/// cut buffer.
pub fn foredel(ed: &mut Editor, ct: usize, flags: u32) {
	if flags & cutflags::RAW != 0 {
		shiftchars(ed, ed.cs, ct);
	} else {
		let origcs = ed.cs;
		for _ in 0..ct {
			inccs(ed);
		}
		let n = ed.cs - origcs;
		ed.cs = origcs;
		shiftchars(ed, ed.cs, n);
	}
	ccright(ed);
}

/// zsh `setline`: replace the line with `s` (bytes, decoded as
/// [`to_line`] does). With [`ZSL_TOEND`] the cursor goes to the end
/// (onto the last character in vi command mode), else it is kept within
/// the new line.
pub fn setline(ed: &mut Editor, s: &[u8], flags: u32) {
	ed.ls.viinsbegin = 0;
	ed.line = to_line(s);
	if flags & ZSL_TOEND != 0 && !ed.line.is_empty() {
		ed.cs = ed.line.len();
		if invicmdmode(ed) {
			deccs(ed);
		}
	} else if ed.cs > ed.line.len() {
		ed.cs = ed.line.len();
	}
	ccright(ed);
}

/// zsh `findbol`: the start of the line (within the buffer) the cursor
/// is on.
pub fn findbol(ed: &Editor) -> usize {
	findbol_at(&ed.line, ed.cs)
}

/// zsh `findeol`: the end of the line the cursor is on (its newline, or
/// the end of the buffer).
pub fn findeol(ed: &Editor) -> usize {
	findeol_at(&ed.line, ed.cs)
}

/// [`findbol`] from position `x`.
pub fn findbol_at(line: &[char], x: usize) -> usize {
	let mut x = x.min(line.len());
	while x > 0 && line[x - 1] != '\n' {
		x -= 1;
	}
	x
}

/// [`findeol`] from position `x`.
pub fn findeol_at(line: &[char], x: usize) -> usize {
	let mut x = x.min(line.len());
	while x != line.len() && line[x] != '\n' {
		x += 1;
	}
	x
}

/// zsh `findline`: ([`findbol`], [`findeol`]).
pub fn findline(ed: &Editor) -> (usize, usize) {
	(findbol(ed), findeol(ed))
}

/// zsh `zlecharasstring`: one line character as bytes (an
/// [`super::invalid_char`] as its byte).
pub fn zlecharasstring(c: char) -> Vec<u8> {
	match invalid_byte(c) {
		Some(b) => vec![b],
		None => c.encode_utf8(&mut [0; 4]).as_bytes().to_vec(),
	}
}

/// zsh `wcs_nicechar` (not quotable) for a decoded character: control
/// and unprintable characters shown visibly (`^X`, `\n`, `\M-…`,
/// `\uXXXX`).
fn wcs_nicechar(c: char, print_eight: bool, out: &mut Vec<u8>) {
	let n = u32::from(c);
	let printable = if n < 0x80 {
		(0x20..0x7f).contains(&n)
	} else {
		wcwidth(c) >= 0 && n >= 0xa0
	};
	if !printable && (n < 0x80 || !print_eight) {
		if n >= 0x1_0000 {
			out.extend_from_slice(format!("\\U{n:08x}").as_bytes());
		} else if n >= 0x100 {
			out.extend_from_slice(format!("\\u{n:04x}").as_bytes());
		} else {
			nicechar_sel(n.to_le_bytes()[0], false, print_eight, out);
		}
		return;
	}
	out.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes());
}

/// The text zsh `showmsg` prints for `msg` (UTF-8 bytes): every
/// character shown with `wcs_nicechar` (a byte that does not decode with
/// `nicechar`), newlines kept as line breaks.
pub fn format_msg(msg: &[u8], print_eight: bool) -> BString {
	let mut out = Vec::with_capacity(msg.len());
	for chunk in msg.utf8_chunks() {
		for c in chunk.valid().chars() {
			if c == '\n' {
				out.push(b'\n');
			} else {
				wcs_nicechar(c, print_eight, &mut out);
			}
		}
		for &b in chunk.invalid() {
			nicechar_sel(b, false, print_eight, &mut out);
		}
	}
	BString::from(out)
}

/// zsh `showmsg`: show `msg` below the line, control characters made
/// visible (`PRINT_EIGHT_BIT` as [`LineState::print_eight`] last saw it).
/// zsh gives the display up and prints the message at once; here it is
/// queued ([`Editor::msg`]) and the display code prints it the same way
/// before anything else is drawn (`display::show_msg`).
pub fn showmsg(ed: &mut Editor, msg: &[u8]) {
	let m = format_msg(msg, ed.ls.print_eight);
	match &mut ed.msg {
		Some(prev) => {
			prev.push(b'\n');
			prev.extend_from_slice(&m);
		},
		None => ed.msg = Some(m),
	}
}

/// zsh `nicedup` (`mb_niceformat` without flags): `s` with unprintable
/// characters shown visibly, a newline as `\n`. zsh consults
/// `PRINT_EIGHT_BIT` for characters above 0x7f that do not print; this
/// takes the option's default (unset).
pub fn nicedup(s: &[u8]) -> Vec<u8> {
	niceformat(s, false, Charset { utf8: true, print_eight: false, ..Charset::default() })
}

/// zsh `handlefeep` (the `beep` widget): ask for a beep, which the core
/// sounds at the next refresh (zsh `zbeep`).
pub const fn handlefeep(ed: &mut Editor) -> i32 {
	ed.feep = true;
	0
}

/// zsh `bindztrdup`: key sequence `s` keybinding style (`^X`, `\M-x`,
/// `\\`, `\^`), then double-quoted as `dquotedztrdup` does
/// (`cshjunkiequotes`: the `CSH_JUNKIE_QUOTES` form).
pub fn bindztrdup(s: &[u8], cshjunkiequotes: bool) -> Vec<u8> {
	let mut buf = Vec::with_capacity(s.len() * 2);
	for &b in s {
		let mut c = b;
		if c & 0x80 != 0 {
			buf.extend_from_slice(b"\\M-");
			c &= 0x7f;
		}
		if c < 32 || c == 0x7f {
			buf.push(b'^');
			c ^= 64;
		}
		if c == b'\\' || c == b'^' {
			buf.push(b'\\');
		}
		buf.push(c);
	}
	dquotedztrdup(&buf, cshjunkiequotes)
}

/// zsh `dquotedztrdup`: `s` in double quotes.
fn dquotedztrdup(s: &[u8], cshjunkiequotes: bool) -> Vec<u8> {
	let mut p = Vec::with_capacity(s.len() * 4 + 2);
	if cshjunkiequotes {
		let mut inquote = false;
		for &c in s {
			match c {
				b'"' | b'$' | b'`' => {
					if inquote {
						p.push(b'"');
						inquote = false;
					}
					p.push(b'\\');
					p.push(c);
				},
				_ => {
					if !inquote {
						p.push(b'"');
						inquote = true;
					}
					if c == b'\n' {
						p.push(b'\\');
					}
					p.push(c);
				},
			}
		}
		if inquote {
			p.push(b'"');
		}
	} else {
		let mut pending = false;
		p.push(b'"');
		for &c in s {
			match c {
				b'\\' => {
					if pending {
						p.push(b'\\');
					}
					p.push(b'\\');
					pending = true;
				},
				b'"' | b'$' | b'`' => {
					if pending {
						p.push(b'\\');
					}
					p.push(b'\\');
					p.push(c);
					pending = false;
				},
				_ => {
					p.push(c);
					pending = false;
				},
			}
		}
		if pending {
			p.push(b'\\');
		}
		p.push(b'"');
	}
	p
}

/// The answer zsh `getzlequery` makes of character `c` (`None`: end of
/// input): `(yes, character to echo)`. Tab is yes, any control
/// character or EOF no, otherwise the lower-cased character decides.
pub fn zlequery_answer(c: Option<char>) -> (bool, char) {
	let c = match c {
		Some('\t') => 'y',
		None => 'n',
		Some(c) if c.is_control() => 'n',
		Some(c) => c.to_lowercase().next().unwrap_or(c),
	};
	(c == 'y', c)
}

/// zsh `getzlequery`: read a character for a yes/no question the caller
/// has printed, then run `next` with the answer and the character zsh
/// echoes after the question (the caller writes it where it printed the
/// question; zsh echoes every answer but a newline, which the mapping of
/// control characters to `n` makes impossible).
///
/// zsh first checks the terminal for typeahead (`FIONREAD`) and answers
/// no without reading when there is some; the editor's input source
/// reports no such count, so the character is always read.
pub fn getzlequery<F>(next: F) -> WResult
where
	F: FnOnce(&mut Zw<'_, '_>, bool, char) -> WResult + Send + 'static,
{
	then(Await::Char, move |zw, got| {
		let c = match got {
			Got::Char(c) => c,
			_ => None,
		};
		let (yes, echo) = zlequery_answer(c);
		next(zw, yes, echo)
	})
}

/// zsh `upline`: the cursor `zmult` lines up within the buffer
/// ([`upline_by`]); the lines that could not be moved.
pub fn upline(zw: &mut Zw<'_, '_>) -> i64 {
	let n = zw.ed.zmod.mult;
	upline_by(zw.ed, n)
}

/// zsh `downline`: the cursor `zmult` lines down within the buffer
/// ([`downline_by`]); the lines that could not be moved.
pub fn downline(zw: &mut Zw<'_, '_>) -> i64 {
	let n = zw.ed.zmod.mult;
	downline_by(zw.ed, n)
}

/// zsh `upline` with count `n`: the cursor `n` lines up within the buffer, at
/// [`LineState::lastcol`] (set from the cursor when unset). Returns the
/// lines that could not be moved (negative `n` moves down, and the
/// remainder comes back negated).
pub fn upline_by(ed: &mut Editor, n: i64) -> i64 {
	if n < 0 {
		return -downline_by(ed, -n);
	}
	let mut n = n;
	if ed.ls.lastcol == -1 {
		ed.ls.lastcol = hl_pos(ed.cs - findbol(ed));
	}
	ed.cs = findbol(ed);
	while n != 0 {
		if ed.cs == 0 {
			break;
		}
		ed.cs -= 1;
		ed.cs = findbol(ed);
		n -= 1;
	}
	if n == 0 {
		line_col(ed);
	}
	n
}

/// zsh `downline` with count `n`: the cursor `n` lines down within the
/// buffer; see [`upline_by`].
pub fn downline_by(ed: &mut Editor, n: i64) -> i64 {
	if n < 0 {
		return -upline_by(ed, -n);
	}
	let mut n = n;
	if ed.ls.lastcol == -1 {
		ed.ls.lastcol = hl_pos(ed.cs - findbol(ed));
	}
	while n != 0 {
		let x = findeol(ed);
		if x == ed.line.len() {
			break;
		}
		ed.cs = x + 1;
		n -= 1;
	}
	if n == 0 {
		line_col(ed);
	}
	n
}

/// The end of [`upline_by`]/[`downline_by`]: from the start of the target
/// line, go to `lastcol` or the end of that line.
fn line_col(ed: &mut Editor) {
	let x = findeol(ed);
	let col = usize::try_from(ed.ls.lastcol).unwrap_or(0);
	if ed.cs + col >= x {
		ed.cs = x;
		if ed.cs > findbol(ed) && invicmdmode(ed) {
			deccs(ed);
		}
	} else {
		ed.cs += col;
		ccright(ed);
	}
}

/// zsh `vifirstnonblank`: the cursor to the first non-blank of its line.
pub fn vifirstnonblank(ed: &mut Editor) {
	ed.cs = findbol(ed);
	while ed.cs != ed.line.len() && iblank(ed.line[ed.cs]) {
		inccs(ed);
	}
}

/// The buffer [`KctBuf`] names, if set.
pub fn kctbuf_get(zle: &Zle, k: KctBuf) -> Option<&CutBuffer> {
	match k {
		KctBuf::Cut => zle.cutbuf.as_ref(),
		KctBuf::Vi(n) => zle.vibuf.get(n).and_then(Option::as_ref),
	}
}

/// zsh `pastebuf`: insert `buf` `mult` times; `position` 0 before the
/// cursor, 1 after it, 2 splitting the line (line-wise buffers). Sets
/// the yank range ([`Editor::yank`]).
pub fn pastebuf(ed: &mut Editor, buf: &CutBuffer, mult: i64, position: u8) {
	let mut position = position;
	if buf.flags & CUTBUFFER_LINE != 0 {
		if position == 2 {
			if ed.cs == 0 {
				position = 0;
			} else if ed.cs == ed.line.len() {
				position = 1;
			}
		}
		let len = buf.buf.len();
		if position == 2 {
			ed.yank.0 = ed.cs;
			spaceinline(ed, len + 2);
			ed.line[ed.cs] = '\n';
			ed.cs += 1;
			ed.line[ed.cs..ed.cs + len].copy_from_slice(&buf.buf);
			ed.cs += len;
			ed.line[ed.cs] = '\n';
			ed.yank.1 = ed.cs + 1;
		} else if position != 0 {
			ed.cs = findeol(ed);
			ed.yank.0 = ed.cs;
			spaceinline(ed, len + 1);
			ed.line[ed.cs] = '\n';
			ed.cs += 1;
			ed.yank.1 = ed.cs + len;
			ed.line[ed.cs..ed.cs + len].copy_from_slice(&buf.buf);
		} else {
			ed.cs = findbol(ed);
			ed.yank.0 = ed.cs;
			spaceinline(ed, len + 1);
			ed.line[ed.cs..ed.cs + len].copy_from_slice(&buf.buf);
			ed.yank.1 = ed.cs + len + 1;
			ed.line[ed.cs + len] = '\n';
		}
		vifirstnonblank(ed);
	} else {
		if position == 1 && ed.cs != findeol(ed) {
			inccs(ed);
		}
		ed.yank.0 = ed.cs;
		for _ in 0..mult.max(0) {
			insert_at_cs(ed, &buf.buf);
		}
		ed.yank.1 = ed.cs;
		if ed.cs != 0 && invicmdmode(ed) {
			deccs(ed);
		}
	}
}

/// zsh `doinsert`: insert `zstr` `Editor::zmod.mult` times (after
/// the cursor for a negative count), overwriting what is there in
/// overwrite mode (never a newline; a character with its combining marks
/// counts as one).
///
/// zsh first lets the completion suffix react to the inserted character
/// (`iremovesuffix`) and invalidates the completion list; both belong to
/// the completion state, which the callers of this function handle.
pub fn doinsert(ed: &mut Editor, zstr: &[char]) {
	let len = zstr.len();
	let mult = ed.zmod.mult;
	let neg = mult < 0;
	let m = usize::try_from(mult.unsigned_abs()).unwrap_or(usize::MAX);
	let total = m.saturating_mul(len);
	// At the end, zleline[zlecs] is zsh's terminating NUL, not a newline:
	// overwrite mode takes the overwriting branch, which finds nothing to
	// replace there.
	if ed.insmode || ed.line.get(ed.cs) == Some(&'\n') {
		spaceinline(ed, total);
	} else {
		overwrite_room(ed, zstr, m, total);
	}
	for _ in 0..m {
		for &c in zstr {
			if let Some(slot) = ed.line.get_mut(ed.cs) {
				*slot = c;
			}
			ed.cs += 1;
		}
	}
	if neg {
		ed.cs = ed.cs.saturating_sub(total);
	}
	ccright(ed);
}

/// The overwrite-mode part of [`doinsert`]: make the text from the
/// cursor over as many characters as are inserted exactly the size of
/// the insertion.
fn overwrite_room(ed: &mut Editor, zstr: &[char], m: usize, total: usize) {
	let count = zstr
		.iter()
		.filter(|&&c| !is_combining(c))
		.count()
		.saturating_mul(m);
	let mut pos = ed.cs;
	let mut i = count;
	while pos < ed.line.len() && ed.line[pos] != '\n' && i > 0 {
		i -= 1;
		incpos(ed, &mut pos);
	}
	let span = pos - ed.cs;
	if span < total {
		spaceinline(ed, total - span);
	} else if span > total {
		shiftchars(ed, ed.cs, span - total);
	}
}

/// zsh `zstrtol(s, NULL, 0)`: leading blanks and a sign, then a number
/// in C notation (`0x`/`0X` hex, `0b`/`0B` binary, a leading `0` octal,
/// else decimal), up to the first character that is not a digit of the
/// base. Digits that would overflow are ignored (zsh truncates there).
pub fn zstrtol0(s: &[u8]) -> i64 {
	let mut i = 0;
	while s.get(i).is_some_and(|&c| c == b' ' || c == b'\t') {
		i += 1;
	}
	let neg = s.get(i) == Some(&b'-');
	if neg || s.get(i) == Some(&b'+') {
		i += 1;
	}
	let base: u64 = if s.get(i) == Some(&b'0') {
		i += 1;
		match s.get(i) {
			Some(b'x' | b'X') => {
				i += 1;
				16
			},
			Some(b'b' | b'B') => {
				i += 1;
				2
			},
			_ => 8,
		}
	} else {
		10
	};
	let mut calc: u64 = 0;
	let mut trunc = false;
	while let Some(d) = s
		.get(i)
		.and_then(|&c| char::from(c).to_digit(36))
		.filter(|&d| u64::from(d) < base)
	{
		if !trunc {
			match calc
				.checked_mul(base)
				.and_then(|v| v.checked_add(u64::from(d)))
			{
				Some(v) => calc = v,
				None => trunc = true,
			}
		}
		i += 1;
	}
	// zsh stores the unsigned accumulation in a signed zlong.
	#[allow(clippy::cast_possible_wrap, reason = "zsh's zulong to zlong conversion")]
	let v = calc as i64;
	if neg { v.wrapping_neg() } else { v }
}

/// Give character `c` back to the input (zsh `ungetbyte` of its bytes):
/// the next read sees it first.
pub fn ungetchar(ed: &mut Editor, c: char) {
	for &b in zlecharasstring(c).iter().rev() {
		ed.unget.push_front(b);
	}
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

	#[test]
	fn spaceinline_and_shiftchars_move_mark() {
		let mut e = ed("abcdef", 2);
		e.mark = 4;
		spaceinline(&mut e, 2);
		assert_eq!(e.line.len(), 8);
		assert_eq!(e.mark, 6);
		e.line[2] = 'X';
		e.line[3] = 'Y';
		assert_eq!(line(&e), "abXYcdef");
		shiftchars(&mut e, 1, 3);
		assert_eq!(line(&e), "acdef");
		// zsh: mark >= to + cnt moves back by cnt.
		assert_eq!(e.mark, 3);
		e.mark = 2;
		shiftchars(&mut e, 1, 2);
		assert_eq!(e.mark, 1);
	}

	#[test]
	fn successive_kills_append_and_rotate_the_ring() {
		let mut zle = Zle::new(false);
		let mut e = ed("one two", 7);
		backkill(&mut zle, &mut e, 3, cutflags::RAW | cutflags::FRONT);
		assert_eq!(
			zle.cutbuf
				.as_ref()
				.map(|c| c.buf.iter().collect::<String>()),
			Some("two".into())
		);
		// The first cut does not push the unset buffer.
		assert!(zle.kring.is_empty());
		e.lastcmd = wflags::KILL;
		backkill(&mut zle, &mut e, 4, cutflags::RAW | cutflags::FRONT);
		assert_eq!(
			zle.cutbuf
				.as_ref()
				.map(|c| c.buf.iter().collect::<String>()),
			Some("one two".into())
		);
		e.lastcmd = 0;
		e.line = "xyz".chars().collect();
		e.cs = 0;
		forekill(&mut zle, &mut e, 2, cutflags::RAW);
		assert_eq!(line(&e), "z");
		assert_eq!(
			zle.cutbuf
				.as_ref()
				.map(|c| c.buf.iter().collect::<String>()),
			Some("xy".into())
		);
		assert_eq!(zle.kring.len(), 1);
		assert_eq!(zle.kring_size, KRINGCTDEF);
		// "1 got the kills, shifting.
		assert_eq!(zle.vibuf[27].as_ref().map(|c| c.buf.len()), Some(2));
		assert_eq!(zle.vibuf[28].as_ref().map(|c| c.buf.len()), Some(4));
	}

	#[test]
	fn setline_toend_and_bounds() {
		let mut e = ed("", 9);
		setline(&mut e, b"hello", ZSL_TOEND);
		assert_eq!(e.cs, 5);
		e.keymap = BString::from("vicmd");
		setline(&mut e, b"hi", ZSL_TOEND);
		assert_eq!(e.cs, 1);
		e.cs = 7;
		setline(&mut e, b"abc", 0);
		assert_eq!(e.cs, 3);
	}

	#[test]
	fn combining_alignment() {
		let mut e = ed("ae\u{301}x", 2);
		e.ls.combining = true;
		ccleft(&mut e);
		assert_eq!(e.cs, 1);
		e.cs = 2;
		ccright(&mut e);
		assert_eq!(e.cs, 3);
		e.cs = 1;
		inccs(&mut e);
		assert_eq!(e.cs, 3);
		deccs(&mut e);
		assert_eq!(e.cs, 1);
		e.ls.combining = false;
		e.cs = 1;
		inccs(&mut e);
		assert_eq!(e.cs, 2);
	}

	#[test]
	fn lines_and_columns() {
		let mut e = ed("abc\nde\nfghij", 9);
		assert_eq!(findline(&e), (7, 12));
		assert_eq!(upline_by(&mut e, 1), 0);
		// Column 2 clipped to the end of "de".
		assert_eq!(e.cs, 6);
		assert_eq!(upline_by(&mut e, 1), 0);
		assert_eq!(e.cs, 2);
		assert_eq!(upline_by(&mut e, 1), 1);
		assert_eq!(downline_by(&mut e, 2), 0);
		assert_eq!(e.cs, 9);
		assert_eq!(downline_by(&mut e, -1), 0);
		assert_eq!(e.cs, 6);
	}

	#[test]
	fn messages_and_bindings() {
		assert_eq!(format_msg(b"a\x01b\n\x7f", false), "a^Ab\n^?");
		assert_eq!(format_msg("\u{85}é".as_bytes(), false), "\\M-^Eé");
		assert_eq!(bindztrdup(b"\x1bx", false), b"\"^[x\"");
		// `\` becomes `\\`; quoting doubles the pending backslashes and
		// escapes `$`: five backslashes in all.
		assert_eq!(bindztrdup(b"\\$", false), b"\"\\\\\\\\\\$\"");
		assert_eq!(bindztrdup(b"\xe1", false), b"\"\\M-a\"");
		assert_eq!(zlequery_answer(Some('\t')), (true, 'y'));
		assert_eq!(zlequery_answer(Some('Y')), (true, 'y'));
		assert_eq!(zlequery_answer(Some('\n')), (false, 'n'));
		assert_eq!(zlequery_answer(None), (false, 'n'));
	}

	#[test]
	fn overwrite_insert() {
		let mut e = ed("abc\nd", 1);
		e.insmode = false;
		doinsert(&mut e, &['X', 'Y', 'Z']);
		// Overwriting stops at the newline, which is kept.
		assert_eq!(line(&e), "aXYZ\nd");
		assert_eq!(e.cs, 4);
		let mut e = ed("ab", 1);
		e.zmod.mult = -2;
		doinsert(&mut e, &['x']);
		assert_eq!(line(&e), "axxb");
		assert_eq!(e.cs, 1);
	}
}
