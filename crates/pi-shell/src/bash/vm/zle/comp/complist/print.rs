//! complist.c's list printing: colours (`zlrputs`, `zcputs`, `zcoff`,
//! in-string colours `initiscol`/`doiscol`, `putmatchcol`,
//! `putfilecol`), the printers (`clprintfmt`, `clnicezputs`,
//! `compprintfmt`, `compzputs`, `compprintnl`, `compprintlist`,
//! `clprintm`), `LISTPROMPT` scrolling (`asklistscroll`) and the
//! two-entry redraw of menu selection (`singlecalc`, `singledraw`).
//!
//! zsh writes to `shout` as it goes and reads a key in the middle of a
//! listing when `LISTPROMPT` scrolling asks for one. Here a listing runs
//! over [`Penv::out`] against the answers read so far
//! ([`Penv::keys`]); when it needs another one it stops with [`Ask`],
//! the caller shows what was printed, reads the key and runs the
//! listing again from the same starting state, skipping the bytes
//! already shown ([`Penv::skip`]). The printers are deterministic given
//! that state and the answers, so the second run retraces the first.

use std::sync::Arc;

use bstr::BString;

use super::{
	State,
	colors::{
		COL_BD, COL_CD, COL_DI, COL_DU, COL_EC, COL_EX, COL_FI, COL_HI, COL_LC, COL_LN, COL_MA,
		COL_NO, COL_OR, COL_OW, COL_PI, COL_RC, COL_SA, COL_SG, COL_SO, COL_SP, COL_ST, COL_SU,
		COL_TC, COL_TW, LC_FOLLOW_SYMLINKS, Listcols, MAX_POS,
	},
};
use crate::bash::{
	pattern::zsh::Captures,
	syntax::zsh::tok::{META, at, is_tok, unmetafy, untokenize},
	vm::{
		builtins::{
			zsh_prompt::{
				Cap, ColourSeqs, NearColour, TXT_ERROR, TXTNOBGCOLOUR, TXTNOFGCOLOUR, TermCaps, Zattr,
				colour_sequence, match_colour,
			},
			zsh_quote::{Charset, nicechar_sel},
		},
		zle::{
			comp::{
				Comp, compresult,
				types::{GId, MRef, cgf, cmf},
			},
			refresh::Display,
		},
		zsh::{terminfo_db, wcwidth::wcwidth, zpattern::CharEnvBuf},
	},
};

/// A `Cmatch *` slot of zsh's `mtab`: the match shown at a screen
/// position, `mark` for zsh's `mtmark()` (an explanation line, or a
/// dummy match).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mt {
	/// The match (`NULL`: none).
	pub m:    Option<MRef>,
	/// zsh `MMARK`.
	pub mark: bool,
}

impl Mt {
	/// zsh's truth value of the pointer (a marked `NULL` is not `NULL`).
	pub const fn is_set(self) -> bool {
		self.m.is_some() || self.mark
	}
}

/// A listing stopped because `LISTPROMPT` scrolling needs a key that
/// was not read yet.
#[derive(Clone, Copy, Debug)]
pub struct Ask;

/// A printer's result.
pub type R<T> = Result<T, Ask>;

/// What a key read at the scrolling prompt does (zsh `asklistscroll`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScrollKey {
	/// Stop listing (`send-break`, `accept-search`, end of input, any
	/// other key, which is read again).
	Stop,
	/// One more line.
	Line,
	/// One more screen.
	Page,
}

impl ScrollKey {
	/// zsh `asklistscroll`'s classification of the widget `cmd` bound to
	/// the key read in the `listscroll` keymap; the bool says the key is
	/// to be read again (zsh `ungetkeycmd`).
	pub const fn of(cmd: Option<&[u8]>) -> (Self, bool) {
		match cmd {
			None | Some(b"send-break") => (Self::Stop, false),
			Some(
				b"accept-line"
				| b"down-history"
				| b"down-line-or-history"
				| b"down-line-or-search"
				| b"vi-down-line-or-history",
			) => (Self::Line, false),
			Some(
				b"complete-word"
				| b"expand-or-complete"
				| b"expand-or-complete-prefix"
				| b"menu-complete"
				| b"menu-expand-or-complete"
				| b"menu-select",
			) => (Self::Page, false),
			Some(b"accept-search") => (Self::Stop, false),
			Some(_) => (Self::Stop, true),
		}
	}
}

/// What the printers read and write besides the completion state: the
/// terminal, the colours, the in-string colour state, and the scrolling
/// answers. Lives as long as one `complistmatches` call.
pub struct Penv {
	/// zsh `shout`: the bytes printed by this run.
	pub out:         Vec<u8>,
	/// Bytes of [`Self::out`] already shown by an earlier run.
	pub skip:        usize,
	/// Scrolling answers read so far.
	pub keys:        Vec<ScrollKey>,
	/// How many of [`Self::keys`] this run used.
	pub used:        usize,
	/// The terminal.
	pub caps:        Arc<TermCaps>,
	/// zsh `zterm_columns`.
	pub columns:     i32,
	/// zsh `zterm_lines`.
	pub lines:       i32,
	/// zsh `mcolors`.
	pub mcolors:     Listcols,
	/// zsh `last_cap`: the colour last written.
	pub last_cap:    Vec<u8>,
	/// zsh `nrefs`: `(#b)` groups of the last pattern match.
	nrefs:           usize,
	/// zsh `begpos`.
	begpos:          [i32; MAX_POS],
	/// zsh `curisbeg`.
	curisbeg:        usize,
	/// zsh `endpos`.
	endpos:          [i32; MAX_POS],
	/// zsh `sendpos`: end positions, sorted.
	sendpos:         [i32; MAX_POS],
	/// zsh `curissend`.
	curissend:       usize,
	/// zsh `patcols`: the pattern's colours (its index in
	/// `mcolors.pats`) and the next one to use.
	patcols:         Option<(usize, usize)>,
	/// zsh `curiscols`: the colours in effect (indices into the
	/// pattern's colours).
	curiscols:       [usize; MAX_POS],
	/// zsh `curiscol`.
	curiscol:        usize,
	/// Character classes for pattern matching.
	pub env:         CharEnvBuf,
	/// The locale is UTF-8 (zsh's `mbrtowc`).
	pub utf8:        bool,
	/// `MULTIBYTE` in a UTF-8 locale (zsh's `MB_METACHARLENCONV`).
	pub multibyte:   bool,
	/// `PRINT_EIGHT_BIT`.
	pub print_eight: bool,
	/// `zle_highlight`'s colour sequences.
	pub colseqs:     ColourSeqs,
	/// zsh/nearcolor's hook.
	pub nearcolor:   Option<NearColour>,
	/// The enabled suffix aliases (zsh `sufaliastab`).
	pub sufaliases:  Vec<BString>,
	/// zsh `errflag`.
	pub errflag:     bool,
}

impl Penv {
	/// A printing environment.
	pub fn new(caps: Arc<TermCaps>, columns: i32, lines: i32, mcolors: Listcols) -> Self {
		Self {
			out: Vec::new(),
			skip: 0,
			keys: Vec::new(),
			used: 0,
			caps,
			columns: columns.max(1),
			lines,
			mcolors,
			last_cap: Vec::new(),
			nrefs: 0,
			begpos: [0; MAX_POS],
			curisbeg: 0,
			endpos: [0; MAX_POS],
			sendpos: [0; MAX_POS],
			curissend: 0,
			patcols: None,
			curiscols: [0; MAX_POS],
			curiscol: 0,
			env: CharEnvBuf::default(),
			utf8: true,
			multibyte: true,
			print_eight: false,
			colseqs: ColourSeqs::default(),
			nearcolor: None,
			sufaliases: Vec::new(),
			errflag: false,
		}
	}

	/// Start a run of a listing over: nothing printed, no answers used.
	pub fn rewind(&mut self) {
		self.out.clear();
		self.used = 0;
		self.last_cap.clear();
	}
}

/// Not a position (zsh's `0xfffffff`).
const NOPOS: i32 = 0xfff_ffff;

const S_IFMT: u32 = 0o170_000;
const S_IFDIR: u32 = 0o040_000;
const S_IFLNK: u32 = 0o120_000;
const S_IFIFO: u32 = 0o010_000;
const S_IFSOCK: u32 = 0o140_000;
const S_IFBLK: u32 = 0o060_000;
const S_IFCHR: u32 = 0o020_000;
const S_IFREG: u32 = 0o100_000;
const S_ISUID: u32 = 0o4000;
const S_ISGID: u32 = 0o2000;
const S_ISVTX: u32 = 0o1000;
const S_IWOTH: u32 = 0o002;
const S_IXUGO: u32 = 0o111;

/// zsh `mb_metacharlenconv` on metafied `s` at `i`: the bytes of the
/// character there and the character (`None`: zsh's `WEOF`). Without
/// `multibyte` every byte is a character.
pub fn metachar(s: &[u8], i: usize, multibyte: bool) -> (usize, Option<u32>) {
	let Some(&first) = s.get(i) else {
		return (0, Some(0));
	};
	if !multibyte {
		return if first == META {
			(2, Some(u32::from(at(s, i + 1) ^ 32)))
		} else {
			(1, Some(u32::from(first)))
		};
	}
	if first <= 0x7f {
		return (1, Some(u32::from(first)));
	}
	let mut buf = [0u8; 4];
	let mut n = 0;
	let mut p = i;
	while p < s.len() && n < buf.len() {
		let c = if s[p] == META {
			p += 1;
			at(s, p) ^ 32
		} else if is_tok(s[p]) {
			break;
		} else {
			s[p]
		};
		p += 1;
		buf[n] = c;
		n += 1;
		match std::str::from_utf8(&buf[..n]) {
			Ok(st) => return (p - i, st.chars().next().map(u32::from)),
			Err(e) if e.error_len().is_none() => {},
			Err(_) => break,
		}
	}
	(1 + usize::from(first == META), None)
}

/// zsh `zwcwidth` (`WCWIDTH_WINT`).
fn zwcwidth(c: Option<u32>, multibyte: bool, print_eight: bool) -> i32 {
	let Some(c) = c.filter(|_| multibyte) else {
		return 1;
	};
	let w = char::from_u32(c).map_or(-1, wcwidth);
	if w < 0 && print_eight { 1 } else { w }
}

/// zsh `WC_ISPRINT`.
fn wc_isprint(c: char) -> bool {
	let c = u32::from(c);
	(0x20..0x7f).contains(&c) || c >= 0xa0
}

/// zsh `wcs_nicechar_sel(c, &width, &swide, 0)`: the visible form of
/// `c` (raw bytes), its printing width, and where the character itself
/// starts in it (the rest before is ASCII prettification).
fn wcs_nicechar(c: char, print_eight: bool) -> (Vec<u8>, usize, usize) {
	let mut s = Vec::new();
	let mut cc = u32::from(c);
	let mut escape = false;
	if !wc_isprint(c) && (cc < 0x80 || !print_eight) {
		if cc == 0x7f {
			s.push(b'^');
			cc = u32::from(b'?');
		} else if cc == u32::from(b'\n') {
			s.push(b'\\');
			cc = u32::from(b'n');
		} else if cc == u32::from(b'\t') {
			s.push(b'\\');
			cc = u32::from(b't');
		} else if cc < 0x20 {
			s.push(b'^');
			cc += 0x40;
		} else if cc >= 0x80 {
			escape = true;
		}
	}
	if escape {
		if cc >= 0x1_0000 {
			let buf = format!("\\U{cc:08x}").into_bytes();
			return (buf, 10, 10);
		}
		if cc >= 0x100 {
			let buf = format!("\\u{cc:04x}").into_bytes();
			return (buf, 6, 6);
		}
		let mut buf = Vec::new();
		nicechar_sel(cc.to_le_bytes()[0], false, print_eight, &mut buf);
		let n = buf.len();
		return (buf, n, n);
	}
	let ch = char::from_u32(cc).unwrap_or(c);
	let w = wcwidth(ch);
	let width = s.len() + usize::try_from(if w >= 0 { w } else { 1 }).unwrap_or(1);
	let wide = s.len();
	let mut b = [0u8; 4];
	s.extend_from_slice(ch.encode_utf8(&mut b).as_bytes());
	(s, width, wide)
}

/// One character of an unmetafied, untokenized string as zsh's
/// `mbrtowc` loop in `clnicezputs`/`mb_niceformat` sees it: its visible
/// form, width, where the wide part starts, and the bytes it used.
/// `eol` is zsh's "incomplete character at the end" state.
fn nice_next(
	u: &[u8],
	i: usize,
	utf8: bool,
	print_eight: bool,
	eol: &mut bool,
) -> (Vec<u8>, usize, usize, usize) {
	let b = u[i];
	let invalid = |b: u8| {
		let mut v = Vec::new();
		nicechar_sel(b, false, print_eight, &mut v);
		let n = v.len();
		(v, n, n, 1)
	};
	if *eol {
		return invalid(b);
	}
	if !utf8 || b < 0x80 {
		if b >= 0x80 {
			return invalid(b);
		}
		let (s, w, wp) = wcs_nicechar(char::from(b), print_eight);
		return (s, w, wp, 1);
	}
	let (ch, n) = bstr::decode_utf8(&u[i..]);
	if let Some(ch) = ch {
		let (s, w, wp) = wcs_nicechar(ch, print_eight);
		(s, w, wp, n)
	} else {
		// An incomplete sequence at the end: every byte left is shown
		// as invalid.
		let rest = &u[i..];
		let lead = match b {
			0xc2..=0xdf => 2,
			0xe0..=0xef => 3,
			0xf0..=0xf4 => 4,
			_ => 0,
		};
		if lead > rest.len() && rest.iter().skip(1).all(|&c| (0x80..0xc0).contains(&c)) {
			*eol = true;
		}
		invalid(b)
	}
}

/// zsh `ZMB_nicewidth(s)`: the printing width of the visible form of
/// metafied, tokenized `s`.
pub fn nicewidth(s: &[u8], utf8: bool, print_eight: bool) -> i32 {
	let mut t = s.to_vec();
	untokenize(&mut t);
	let u = unmetafy(&t);
	let mut i = 0;
	let mut w = 0usize;
	let mut eol = false;
	while i < u.len() {
		let (_, width, _, cnt) = nice_next(&u, i, utf8, print_eight, &mut eol);
		w += width;
		i += cnt;
	}
	i32::try_from(w).unwrap_or(i32::MAX)
}

/// The printers: the completion state, the screen state, and the
/// printing environment.
pub struct P<'a> {
	/// The completion state.
	pub c: &'a mut Comp,
	/// The screen state (`showinglist`, `listshown`, …).
	pub d: &'a mut Display,
	/// The printing environment.
	pub e: &'a mut Penv,
}

impl P<'_> {
	const fn l(&mut self) -> &mut State {
		&mut self.c.list
	}

	/// zsh `dolist(X)`.
	const fn dolist(&self, x: i32) -> bool {
		x >= self.c.list.mlbeg && x < self.c.list.mlend
	}

	/// zsh `dolistcl(X)`.
	const fn dolistcl(&self, x: i32) -> bool {
		x >= self.c.list.mlbeg && x < self.c.list.mlend + 1
	}

	/// zsh `dolistnl(X)`.
	const fn dolistnl(&self, x: i32) -> bool {
		x >= self.c.list.mlbeg && x < self.c.list.mlend - 1
	}

	/// zsh `tcout(cap)`.
	pub fn tcout(&mut self, cap: Cap) {
		let s = self.e.caps.tputs(cap);
		self.e.out.extend_from_slice(&s);
	}

	/// zsh `tcoutarg(cap, arg)`.
	fn tcoutarg(&mut self, cap: Cap, arg: i32) {
		if let Some(s) = self.e.caps.tcstr[cap as usize].as_deref() {
			let b = terminfo_db::tputs(&terminfo_db::tgoto(s, arg, arg));
			self.e.out.extend_from_slice(&b);
		}
	}

	/// zsh `tcmultout(cap, multcap, ct)`.
	pub fn tcmultout(&mut self, cap: Cap, multcap: Cap, ct: i32) -> bool {
		let t = Arc::clone(&self.e.caps);
		if t.tccan(multcap)
			&& (!t.tccan(cap) || (t.tclen(multcap) as i64) <= (t.tclen(cap) as i64) * i64::from(ct))
		{
			self.tcoutarg(multcap, ct);
			true
		} else if t.tccan(cap) {
			for _ in 0..ct.max(0) {
				self.tcout(cap);
			}
			true
		} else {
			false
		}
	}

	/// zsh `tc_downcurs(ct)`.
	pub fn tc_downcurs(&mut self, ct: i32) {
		if ct != 0 && !self.tcmultout(Cap::Down, Cap::MultDown, ct) {
			for _ in 0..ct.max(0) {
				self.e.out.push(b'\n');
			}
			self.e.out.push(b'\r');
		}
	}

	/// zsh `zlrputs(cap)`: switch to colour `cap` (left code, `cap`,
	/// right code) unless it is the one in effect.
	fn zlrputs(&mut self, cap: &[u8]) {
		if self.e.last_cap.is_empty() || self.e.last_cap != cap {
			let mut buf = self.e.mcolors.col(COL_LC).unwrap_or_default().to_vec();
			buf.extend_from_slice(cap);
			buf.extend_from_slice(self.e.mcolors.col(COL_RC).unwrap_or_default());
			let b = terminfo_db::tputs(&buf);
			self.e.out.extend_from_slice(&b);
			self.e.last_cap = cap.to_vec();
		}
	}

	/// zsh `zcputs(group, colour)`: the colour of type `colour` for
	/// `group`.
	fn zcputs(&mut self, group: Option<&[u8]>, colour: usize) {
		let env = self.e.env.env();
		let hit = self.e.mcolors.files[colour]
			.iter()
			.find(|fc| {
				fc.col.is_some()
					&& match (&fc.prog, group) {
						(Some(p), Some(g)) => p.matches(g, &env),
						_ => true,
					}
			})
			.and_then(|fc| fc.col.clone());
		match hit {
			Some(col) => self.zlrputs(&col),
			None => self.zlrputs(b"0"),
		}
	}

	/// zsh `zcoff()`: colouring off.
	fn zcoff(&mut self) {
		if let Some(ec) = self.e.mcolors.col(COL_EC).map(<[u8]>::to_vec) {
			let b = terminfo_db::tputs(&ec);
			self.e.out.extend_from_slice(&b);
			self.e.last_cap.clear();
		} else {
			self.zcputs(None, COL_NO);
		}
	}

	/// zsh `cleareol()`: clear to the end of the line in menu selection,
	/// colouring off first so it does not bleed.
	fn cleareol(&mut self) {
		if self.c.list.mlbeg >= 0 && self.e.caps.tccan(Cap::ClearEol) {
			if !self.e.last_cap.is_empty() {
				self.zcoff();
			}
			self.tcout(Cap::ClearEol);
		}
	}

	/// The colour at index `i` of the current pattern's colours (zsh
	/// `patcols[i]`), if any.
	fn patcol(&self, i: usize) -> Option<Vec<u8>> {
		let (pi, _) = self.e.patcols?;
		self.e.mcolors.pats.get(pi)?.cols.get(i).cloned()
	}

	/// zsh `initiscol()`.
	fn initiscol(&mut self) {
		let Some((pi, pos)) = self.e.patcols else {
			return;
		};
		if let Some(c) = self.patcol(pos) {
			self.zlrputs(&c);
		}
		self.e.curiscol = 0;
		self.e.curiscols[0] = pos;
		self.e.patcols = Some((pi, pos + 1));
		self.e.curisbeg = 0;
		self.e.curissend = 0;
		let nrefs = self.e.nrefs.min(MAX_POS);
		self.e.sendpos[..nrefs].fill(NOPOS);
		for i in nrefs..MAX_POS {
			self.e.begpos[i] = NOPOS;
			self.e.endpos[i] = NOPOS;
			self.e.sendpos[i] = NOPOS;
		}
	}

	/// zsh `doiscol(pos)`: the in-string colour changes at character
	/// `pos`.
	fn doiscol(&mut self, pos: i32) {
		while self.e.curissend < MAX_POS && pos > self.e.sendpos[self.e.curissend] {
			self.e.curissend += 1;
			if self.e.curiscol > 0 {
				self.zcputs(None, COL_NO);
				self.e.curiscol -= 1;
				if let Some(c) = self.patcol(self.e.curiscols[self.e.curiscol]) {
					self.zlrputs(&c);
				}
			}
		}
		loop {
			let Some((pi, pp)) = self.e.patcols else {
				return;
			};
			let b = self.e.curisbeg;
			if b >= MAX_POS {
				return;
			}
			let fi = self.e.endpos[b] < self.e.begpos[b] || self.e.begpos[b] == -1;
			if !((fi || pos == self.e.begpos[b]) && self.patcol(pp).is_some()) {
				return;
			}
			if !fi {
				let e = self.e.endpos[b];
				let mut i = self.e.curissend;
				while i < MAX_POS && self.e.sendpos[i] <= e {
					i += 1;
				}
				let mut j = MAX_POS - 1;
				while j > i {
					self.e.sendpos[j] = self.e.sendpos[j - 1];
					j -= 1;
				}
				if i < MAX_POS {
					self.e.sendpos[i] = e;
				}
				self.zcputs(None, COL_NO);
				if let Some(c) = self.patcol(pp) {
					self.zlrputs(&c);
				}
				if self.e.curiscol + 1 < MAX_POS {
					self.e.curiscol += 1;
					self.e.curiscols[self.e.curiscol] = pp;
				}
			}
			self.e.patcols = Some((pi, pp + 1));
			self.e.curisbeg += 1;
		}
	}

	/// zsh `clprintfmt(p, ml)`: a display string with in-string colours.
	fn clprintfmt(&mut self, p: &[u8], mut ml: i32) -> R<i32> {
		let cols = self.e.columns;
		let mut cc = 0i32;
		let mut i = 0i32;
		self.initiscol();
		let mut idx = 0;
		while idx < p.len() {
			let mut chrlen = metachar(p, idx, self.e.multibyte).0.max(1);
			self.doiscol(i);
			i += 1;
			cc += 1;
			if p[idx] == b'\n' {
				self.cleareol();
				cc = 0;
			}
			if ml == self.c.list.mlend - 1 && cc % cols == cols - 1 {
				return Ok(0);
			}
			while chrlen > 0 && idx < p.len() {
				if p[idx] == META {
					idx += 1;
					chrlen -= 1;
					self.e.out.push(at(p, idx) ^ 32);
				} else {
					self.e.out.push(p[idx]);
				}
				chrlen = chrlen.saturating_sub(1);
				idx += 1;
			}
			if cc % cols == 0 {
				ml += 1;
			}
			if self.c.list.mscroll != 0 && cc % cols == 0 {
				self.l().mrestlines -= 1;
				if self.c.list.mrestlines == 0 {
					let ask = self.asklistscroll(ml)?;
					if ask != 0 {
						return Ok(ask);
					}
				}
			}
		}
		self.cleareol();
		Ok(0)
	}

	/// zsh `clnicezputs(do_colors, s, ml)`: `s` in its visible form,
	/// with in-string colours and scrolling.
	fn clnicezputs(&mut self, do_colors: bool, s: &[u8], mut ml: i32) -> R<i32> {
		let cols = self.e.columns;
		let oml = ml;
		let mut i = 0i32;
		let mut col = 0i32;
		let mut t = s.to_vec();
		untokenize(&mut t);
		let u = unmetafy(&t);
		if do_colors {
			self.initiscol();
		}
		let mut eol = false;
		let mut at_ = 0;
		while at_ < u.len() {
			let (sp, mut width, wptr, cnt) =
				nice_next(&u, at_, self.e.utf8, self.e.print_eight, &mut eol);
			at_ += cnt;
			if do_colors {
				for _ in 0..cnt {
					self.doiscol(i);
					i += 1;
				}
			}
			for (k, &nc) in sp.iter().enumerate() {
				if ml == self.c.list.mlend - 1 && col == cols - 1 {
					self.l().mlprinted = ml - oml;
					return Ok(0);
				}
				self.e.out.push(nc);
				if k < wptr {
					col += 1;
					width = width.saturating_sub(1);
				} else {
					if k + 1 < sp.len() {
						continue;
					}
					col += i32::try_from(width).unwrap_or(0);
				}
				if col > cols {
					ml += 1;
					if self.c.list.mscroll != 0 {
						self.l().mrestlines -= 1;
						if self.c.list.mrestlines == 0 {
							let ask = self.asklistscroll(ml)?;
							if ask != 0 {
								self.l().mlprinted = ml - oml;
								return Ok(ask);
							}
						}
					}
					col -= cols;
					if do_colors {
						self.e.out.extend_from_slice(b" \x08");
					}
				}
			}
		}
		self.l().mlprinted = ml - oml;
		Ok(0)
	}

	/// zsh `pattryrefs` of colour pattern `pi` against `n`, keeping the
	/// `(#b)` positions in `nrefs`/`begpos`/`endpos`.
	fn trypat(&mut self, pi: usize, group: Option<&[u8]>, n: &[u8]) -> bool {
		let res = {
			let env = self.e.env.env();
			let pc = &self.e.mcolors.pats[pi];
			match (&pc.prog, group) {
				(Some(p), Some(g)) if !p.matches(g, &env) => None,
				_ => {
					let mut caps = Captures::default();
					pc.pat
						.try_match(n, &env, Some(&mut caps))
						.map(|_| (pc.pat.npar(), caps.groups))
				},
			}
		};
		self.e.nrefs = 0;
		let Some((npar, groups)) = res else {
			return false;
		};
		if npar > 0 {
			self.e.nrefs = npar;
			if let Some(gr) = groups {
				for i in 0..npar.min(MAX_POS - 1) {
					if let Some(sp) = gr.get(i) {
						self.e.begpos[i] = i32::try_from(sp.begin).unwrap_or(NOPOS);
						self.e.endpos[i] = i32::try_from(sp.end).unwrap_or(NOPOS) - 1;
					} else {
						self.e.begpos[i] = -1;
						self.e.endpos[i] = -1;
					}
				}
			}
		}
		true
	}

	/// The pattern colours for a matching pattern: in-string colours
	/// (true) or one colour.
	fn usepat(&mut self, pi: usize) -> bool {
		let cols = &self.e.mcolors.pats[pi].cols;
		if cols.len() > 1 {
			self.e.patcols = Some((pi, 0));
			return true;
		}
		let c = cols.first().cloned().unwrap_or_default();
		self.zlrputs(&c);
		false
	}

	/// zsh `putmatchcol(group, n)`: the colour of a match by the
	/// patterns; true when it has in-string colours.
	fn putmatchcol(&mut self, group: Option<&[u8]>, n: &[u8]) -> bool {
		for pi in 0..self.e.mcolors.pats.len() {
			if self.trypat(pi, group, n) {
				return self.usepat(pi);
			}
		}
		self.zcputs(group, COL_NO);
		false
	}

	/// zsh `putfilecol(group, filename, m, special)`: the colour of a
	/// file by the patterns, its mode, its extension, a suffix alias.
	fn putfilecol(
		&mut self,
		group: Option<&[u8]>,
		filename: &[u8],
		m: u32,
		special: Option<usize>,
	) -> bool {
		for pi in 0..self.e.mcolors.pats.len() {
			if self.trypat(pi, group, filename) {
				return self.usepat(pi);
			}
		}
		let fmt = m & S_IFMT;
		let colour = if special.is_some() {
			special
		} else if fmt == S_IFDIR {
			Some(if m & S_IWOTH != 0 {
				if m & S_ISVTX != 0 { COL_TW } else { COL_OW }
			} else if m & S_ISVTX != 0 {
				COL_ST
			} else {
				COL_DI
			})
		} else if fmt == S_IFLNK {
			Some(COL_LN)
		} else if fmt == S_IFIFO {
			Some(COL_PI)
		} else if fmt == S_IFSOCK {
			Some(COL_SO)
		} else if fmt == S_IFBLK {
			Some(COL_BD)
		} else if fmt == S_IFCHR {
			Some(COL_CD)
		} else if m & S_ISUID != 0 {
			Some(COL_SU)
		} else if m & S_ISGID != 0 {
			Some(COL_SG)
		} else if fmt == S_IFREG && m & S_IXUGO != 0 {
			Some(COL_EX)
		} else {
			None
		};
		if let Some(colour) = colour {
			self.zcputs(group, colour);
			return false;
		}
		let env = self.e.env.env();
		let ext = self
			.e
			.mcolors
			.exts
			.iter()
			.find(|ec| {
				filename.ends_with(&ec.ext)
					&& match (&ec.prog, group) {
						(Some(p), Some(g)) => p.matches(g, &env),
						_ => true,
					}
			})
			.map(|ec| ec.col.clone());
		if let Some(col) = ext {
			self.zlrputs(&col);
			return false;
		}
		// A suffix alias; the shortest valid suffix format is `a.b`.
		let len = filename.len();
		if len > 2 {
			let mut suf = len - 1;
			while suf > 1 {
				if filename[suf - 1] == b'.' {
					if self
						.e
						.sufaliases
						.iter()
						.any(|a| a.as_slice() == &filename[suf..])
					{
						self.zcputs(group, COL_SA);
						return false;
					}
					break;
				}
				suf -= 1;
			}
		}
		self.zcputs(group, COL_FI);
		false
	}

	/// zsh `asklistscroll(ml)`: the scrolling prompt, then the key's
	/// answer: 1 to stop listing. [`Ask`] when the key was not read yet.
	fn asklistscroll(&mut self, ml: i32) -> R<i32> {
		self.compprintfmt(None, 1, 1, true, ml, None)?;
		let Some(&key) = self.e.keys.get(self.e.used) else {
			return Err(Ask);
		};
		self.e.used += 1;
		let ret = match key {
			ScrollKey::Stop => 1,
			ScrollKey::Line => {
				self.l().mrestlines = 1;
				0
			},
			ScrollKey::Page => {
				self.l().mrestlines = self.e.lines - 1;
				0
			},
		};
		self.e.out.push(b'\r');
		for _ in 0..(self.e.columns - 1).max(0) {
			self.e.out.push(b' ');
		}
		self.e.out.push(b'\r');
		Ok(ret)
	}

	/// zsh `compprintnl(ml)`.
	fn compprintnl(&mut self, ml: i32) -> R<i32> {
		self.cleareol();
		self.e.out.push(b'\n');
		if self.c.list.mscroll != 0 {
			self.l().mrestlines -= 1;
			if self.c.list.mrestlines == 0 {
				let ask = self.asklistscroll(ml)?;
				if ask != 0 {
					return Ok(ask);
				}
			}
		}
		Ok(0)
	}

	/// zsh `compprintfmt(fmt, n, dopr, doesc, ml, stop)`: print an
	/// explanation or display string (`fmt`; `None`: the status line,
	/// `MENUPROMPT` or `LISTPROMPT`), `%`-escapes when `doesc`; the lines
	/// it took (also in `mlprinted`).
	pub fn compprintfmt(
		&mut self,
		fmt: Option<&[u8]>,
		n: i32,
		mut dopr: i32,
		doesc: bool,
		mut ml: i32,
		mut stop: Option<&mut i32>,
	) -> R<i32> {
		let cols = self.e.columns;
		let stat = fmt.is_none();
		let mut cc = 0i32;
		let fmt: Vec<u8> = match fmt {
			Some(f) => f.to_vec(),
			None if self.c.list.mlbeg >= 0 => match self.c.list.mstatus.clone() {
				None => {
					self.l().mlprinted = 0;
					return Ok(0);
				},
				Some(s) => {
					cc = -1;
					s.into()
				},
			},
			None => self.c.list.mlistp.clone().map_or_default(Vec::from),
		};
		let (mut l, mut b, mut s, mut u) = (0i32, false, false, false);
		let mut nc: Vec<u8> = Vec::new();
		let mut p = 0;
		while p < fmt.len() {
			let (mut len, ch) = metachar(&fmt, p, self.e.multibyte);
			let (mut cchar, width) = match ch {
				None => (
					u32::from(if fmt[p] == META {
						at(&fmt, p + 1) ^ 32
					} else {
						fmt[p]
					}),
					1,
				),
				Some(c) => (c, zwcwidth(Some(c), self.e.multibyte, self.e.print_eight)),
			};
			if doesc && cchar == u32::from(b'%') {
				p += len;
				if p >= fmt.len() {
					break;
				}
				let arg: i32 = if fmt[p].is_ascii_digit() {
					let st = p;
					while p < fmt.len() && fmt[p].is_ascii_digit() {
						p += 1;
					}
					std::str::from_utf8(&fmt[st..p])
						.ok()
						.and_then(|x| x.parse().ok())
						.unwrap_or(i32::MAX)
				} else {
					0
				};
				let (l2, c2) = metachar(&fmt, p, self.e.multibyte);
				len = l2;
				cchar = c2.unwrap_or_else(|| {
					u32::from(if at(&fmt, p) == META {
						at(&fmt, p + 1) ^ 32
					} else {
						at(&fmt, p)
					})
				});
				p += len;
				let mut m = 0;
				match char::from_u32(cchar).unwrap_or('\0') {
					'%' => {
						if dopr == 1 {
							self.e.out.push(b'%');
						}
						cc += 1;
					},
					'n' => {
						if !stat {
							let t = n.to_string();
							if dopr == 1 {
								self.e.out.extend_from_slice(t.as_bytes());
							}
							cc += i32::try_from(t.len()).unwrap_or(0);
						}
					},
					'B' => {
						b = true;
						if dopr != 0 {
							self.tcout(Cap::BoldBeg);
						}
					},
					'b' => {
						b = false;
						m = 1;
						if dopr != 0 {
							self.tcout(Cap::AllAttrsOff);
						}
					},
					'S' => {
						s = true;
						if dopr != 0 {
							self.tcout(Cap::StandoutBeg);
						}
					},
					's' => {
						s = false;
						m = 1;
						if dopr != 0 {
							self.tcout(Cap::StandoutEnd);
						}
					},
					'U' => {
						u = true;
						if dopr != 0 {
							self.tcout(Cap::UnderlineBeg);
						}
					},
					'u' => {
						u = false;
						m = 1;
						if dopr != 0 {
							self.tcout(Cap::UnderlineEnd);
						}
					},
					c @ ('F' | 'K') => {
						let is_fg = c == 'F';
						let atr = if at(&fmt, p) == b'{' {
							p += 1;
							let mut rest: &[u8] = &fmt[p.min(fmt.len())..];
							let before = rest.len();
							let atr =
								match_colour(Some(&mut rest), is_fg, 0, &self.e.caps, self.e.nearcolor);
							p += before - rest.len();
							if at(&fmt, p) == b'}' {
								p += 1;
							}
							atr
						} else {
							match_colour(None, is_fg, i64::from(arg), &self.e.caps, self.e.nearcolor)
						};
						if atr != TXT_ERROR && dopr != 0 {
							self.set_colour_attribute(atr, is_fg);
						}
					},
					'f' => {
						if dopr != 0 {
							self.set_colour_attribute(TXTNOFGCOLOUR, true);
						}
					},
					'k' => {
						if dopr != 0 {
							self.set_colour_attribute(TXTNOBGCOLOUR, false);
						}
					},
					'{' => {
						if arg != 0 {
							cc += arg;
						}
						while p < fmt.len() && (fmt[p] != b'%' || at(&fmt, p + 1) != b'}') {
							if dopr != 0 {
								if fmt[p] == META {
									p += 1;
									self.e.out.push(at(&fmt, p) ^ 32);
								} else {
									self.e.out.push(fmt[p]);
								}
							}
							p += 1;
						}
						if p < fmt.len() {
							p += 2;
						}
					},
					c @ ('m' | 'M') if stat => {
						let v = if n != 0 {
							self.c.list.mlastm
						} else {
							self.c.list.mselect
						};
						let t = format!("{v}/{}", self.c.core.listdat.nlist);
						nc = if c == 'M' {
							format!("{t:<9}").into_bytes()
						} else {
							t.into_bytes()
						};
						m = 2;
					},
					c @ ('l' | 'L') if stat => {
						let t = format!("{}/{}", ml + 1, self.c.core.listdat.nlines);
						nc = if c == 'L' {
							format!("{t:<9}").into_bytes()
						} else {
							t.into_bytes()
						};
						m = 2;
					},
					c @ ('p' | 'P') if stat => {
						let nlines = self.c.core.listdat.nlines;
						let lst = &self.c.list;
						let pct = if n != 0 {
							lst.mfirstl != 0
						} else {
							lst.mlbeg > 0 || ml != lst.mfirstl
						};
						nc = if ml == nlines - 1 {
							b"Bottom".to_vec()
						} else if pct {
							let v = ((ml + 1) * 100) / nlines.max(1);
							if c == 'P' {
								format!("{v:2}%   ").into_bytes()
							} else {
								format!("{v}%").into_bytes()
							}
						} else if c == 'P' {
							b"Top   ".to_vec()
						} else {
							b"Top".to_vec()
						};
						m = 2;
					},
					_ => {},
				}
				if m == 2 && dopr == 1 {
					let mut ln = i32::try_from(nc.len()).unwrap_or(0);
					if ln + cc > cols - 2 {
						ln = (cols - 2 - cc).max(0);
						nc.truncate(usize::try_from(ln).unwrap_or(0));
					}
					self.e.out.extend_from_slice(&nc);
					cc += ln;
				} else if dopr != 0 && m == 1 {
					if b {
						self.tcout(Cap::BoldBeg);
					}
					if s {
						self.tcout(Cap::StandoutBeg);
					}
					if u {
						self.tcout(Cap::UnderlineBeg);
					}
				}
			} else {
				cc += width;
				if (cc >= cols - 2 || cchar == u32::from(b'\n')) && stat {
					dopr = 2;
				}
				if cchar == u32::from(b'\n') {
					if dopr == 1 {
						self.cleareol();
					}
					l += 1 + (cc - 1) / cols;
					cc = 0;
				}
				if dopr == 1 {
					if ml == self.c.list.mlend - 1 && cc % cols == cols - 1 {
						dopr = 0;
						p += len.max(1);
						continue;
					}
					let mut left = len.max(1);
					while left > 0 && p < fmt.len() {
						left -= 1;
						if fmt[p] == META {
							left = left.saturating_sub(1);
							p += 1;
							self.e.out.push(at(&fmt, p) ^ 32);
						} else {
							self.e.out.push(fmt[p]);
						}
						p += 1;
					}
					let beg = cc % cols == 0;
					if beg && !stat {
						ml += 1;
						self.e.out.extend_from_slice(b" \x08");
					}
					if self.c.list.mscroll != 0 && beg {
						self.l().mrestlines -= 1;
						if self.c.list.mrestlines == 0 {
							let ask = self.asklistscroll(ml)?;
							if ask != 0 {
								if let Some(st) = stop.as_deref_mut() {
									*st = 1;
								}
								if stat && n != 0 {
									self.l().mfirstl = -1;
								}
								let mp = l + if cc != 0 { (cc - 1) / cols } else { 0 };
								self.l().mlprinted = mp;
								return Ok(mp);
							}
						}
					}
				} else {
					p += len.max(1);
				}
			}
		}
		if dopr != 0 {
			if cc % cols == 0 {
				self.e.out.extend_from_slice(b" \x08");
			}
			self.cleareol();
		}
		if stat && n != 0 {
			self.l().mfirstl = -1;
		}
		let mp = l + cc / cols;
		self.l().mlprinted = mp;
		Ok(mp)
	}

	/// zsh `set_colour_attribute(atr, fg_bg, 0)`.
	fn set_colour_attribute(&mut self, atr: Zattr, fg: bool) {
		if let Some(s) = colour_sequence(&self.e.caps, &self.e.colseqs, atr, fg) {
			self.e.out.extend_from_slice(&s);
		}
	}

	/// zsh `compzputs(s, ml)`: `s` (tokens dropped) with scrolling.
	fn compzputs(&mut self, s: &[u8], mut ml: i32) -> R<i32> {
		let cols = self.e.columns;
		let mut col = 0;
		let mut i = 0;
		while i < s.len() {
			let c = if s[i] == META {
				i += 1;
				at(s, i) ^ 32
			} else if is_tok(s[i]) {
				i += 1;
				continue;
			} else {
				s[i]
			};
			i += 1;
			self.e.out.push(c);
			if c == b'\n' {
				self.cleareol();
			}
			if self.c.list.mscroll != 0 && {
				col += 1;
				col == cols || c == b'\n'
			} {
				ml += 1;
				self.l().mrestlines -= 1;
				if self.c.list.mrestlines == 0 {
					let ask = self.asklistscroll(ml)?;
					if ask != 0 {
						return Ok(ask);
					}
				}
				col = 0;
			}
		}
		Ok(0)
	}

	/// zsh's `cl = -1; if (tccan(TCCLEAREOD)) tcout(TCCLEAREOD);`.
	fn clear_eod(&mut self, cl: &mut i32) {
		*cl = -1;
		if self.e.caps.tccan(Cap::ClearEod) {
			self.tcout(Cap::ClearEod);
		}
	}

	/// zsh `compprintlist(showall)`: print the list (the part on screen
	/// in menu selection); the number of matches printed.
	pub fn compprintlist(&mut self, showall: bool) -> R<i32> {
		let lines = self.e.lines;
		let nlnct = self.d.nlnct;
		let nlines = self.c.core.listdat.nlines;
		let onlyexpl = self.c.core.listdat.onlyexpl;
		let mut pnl = false;
		let mut ml = 0i32;
		let mut printed = 0;
		let mut stop = 0;
		let mut asked = 1;
		let mut lastused = false;

		{
			let invcount = self.c.result.invcount;
			let l = &mut self.c.list;
			l.mfirstl = -1;
			if l.mnew != 0 || l.lastinvcount != invcount || l.lastbeg != l.mlbeg || l.mlbeg < 0 {
				l.lasttype = 0;
				l.lastg = None;
				l.lastexpl = 0;
				l.lastml = 0;
				l.lastnlnct = -1;
			}
		}
		let mhasstat = self.c.list.mhasstat;
		let mut cl = (if nlines > lines - nlnct - mhasstat {
			lines - nlnct - mhasstat
		} else {
			nlines
		}) - i32::from(self.c.list.lastnlnct > nlnct);
		self.l().lastnlnct = nlnct;
		self.l().mrestlines = lines - 1;
		self.l().lastinvcount = self.c.result.invcount;

		if cl < 2 {
			self.clear_eod(&mut cl);
		} else if self.c.list.mlbeg >= 0
			&& !self.e.caps.tccan(Cap::ClearEol)
			&& self.e.caps.tccan(Cap::ClearEod)
		{
			self.tcout(Cap::ClearEod);
		}

		let mut g = if self.c.list.lasttype != 0 && self.c.list.lastg.is_some() {
			self.c.list.lastg
		} else {
			self.c.core.amatches
		};
		'end: {
			while let Some(gid) = g {
				if self.e.errflag {
					break;
				}
				let Some(gr) = self.c.groups.try_get(gid) else {
					break;
				};
				let ylist = gr.ylist.clone();
				let nexpls = gr.expls.len();
				let gflags = gr.flags;
				let (lcount, mcount, dcount) = (gr.lcount, gr.mcount, gr.dcount);
				let (glins, gcols, gwidth) = (gr.lins, gr.cols, gr.width);
				let widths = gr.widths.clone();
				let nmatches = gr.matches.len();
				let next = gr.next;
				let wid = |mc: i32| -> i32 {
					match &widths {
						Some(w) => w
							.get(usize::try_from(mc).unwrap_or(0))
							.copied()
							.unwrap_or(0),
						None => gwidth,
					}
				};

				// Explanations.
				let mut e = 0usize;
				if !lastused && self.c.list.lasttype == 1 {
					e = self.c.list.lastexpl;
					ml = self.c.list.lastml;
					lastused = true;
				}
				while e < nexpls && !self.e.errflag {
					let (count, always, text) = {
						let x = &self.c.groups.get(gid).expls[e];
						(x.count, x.always, x.str.clone())
					};
					if (count != 0 || always)
						&& (onlyexpl == 0 || onlyexpl & (if always { 2 } else { 1 }) != 0)
					{
						if pnl {
							if self.dolistnl(ml) && self.compprintnl(ml)? != 0 {
								break 'end;
							}
							// zsh resets `pnl` here; it is set again below.
							ml += 1;
							if self.dolistcl(ml) && cl >= 0 && {
								cl -= 1;
								cl <= 1
							} {
								self.clear_eod(&mut cl);
							}
						}
						if self.c.list.mlbeg < 0 && self.c.list.mfirstl < 0 {
							self.l().mfirstl = ml;
						}
						let dl = i32::from(self.dolist(ml));
						self.compprintfmt(
							Some(text.as_slice()),
							if always { -1 } else { count },
							dl,
							true,
							ml,
							Some(&mut stop),
						)?;
						if self.c.list.mselect >= 0 {
							let mcols = self.c.list.mcols;
							let mm = mcols * ml;
							for i in (0..mcols).rev() {
								let at = usize::try_from(mm + i).unwrap_or(usize::MAX);
								let l = &mut self.c.list;
								if let Some(t) = l.mtab.get_mut(at) {
									*t = Mt { m: None, mark: true };
								}
								if let Some(t) = l.mgtab.get_mut(at) {
									*t = super::Mg { g: None, mark: true };
								}
							}
						}
						if stop != 0 {
							break 'end;
						}
						if self.c.list.lasttype == 0 && ml >= self.c.list.mlbeg {
							let l = &mut self.c.list;
							l.lasttype = 1;
							l.lastg = Some(gid);
							l.lastbeg = l.mlbeg;
							l.lastml = ml;
							l.lastexpl = e;
							l.lastp = 0;
							lastused = true;
						}
						ml += self.c.list.mlprinted;
						if self.dolistcl(ml) && cl >= 0 && {
							cl -= self.c.list.mlprinted;
							cl <= 1
						} {
							self.clear_eod(&mut cl);
						}
						pnl = true;
					}
					e += 1;
					if self.c.list.mnew == 0 && ml > self.c.list.mlend {
						break 'end;
					}
				}

				if onlyexpl == 0
					&& self.c.list.mlbeg < 0
					&& ylist.as_ref().is_some_and(|y| !y.is_empty())
				{
					let ylist = ylist.unwrap_or_default();
					if pnl {
						if self.dolistnl(ml) && self.compprintnl(ml)? != 0 {
							break 'end;
						}
						pnl = false;
						ml += 1;
						if cl >= 0 && {
							cl -= 1;
							cl <= 1
						} {
							self.clear_eod(&mut cl);
						}
					}
					if self.c.list.mlbeg < 0 && self.c.list.mfirstl < 0 {
						self.l().mfirstl = ml;
					}
					if gflags & cgf::LINES != 0 {
						let mut pp = 0;
						while pp < ylist.len() {
							if self.compzputs(&ylist[pp], ml)? != 0 {
								break 'end;
							}
							pp += 1;
							if pp < ylist.len() && self.compprintnl(ml)? != 0 {
								break 'end;
							}
						}
					} else {
						let mut n = lcount;
						let mut nl = glins;
						let nc = glins;
						let mut pp = 0usize;
						let rows = gflags & cgf::ROWS != 0;
						while n != 0
							&& {
								let go = nl != 0;
								nl -= 1;
								go
							}
							&& !self.e.errflag
						{
							let mut i = gcols;
							let mut mc = 0;
							let mut pq = pp;
							while n != 0
								&& {
									let go = i != 0;
									i -= 1;
									go
								}
								&& !self.e.errflag
							{
								if i32::try_from(pq).unwrap_or(i32::MAX) >= lcount || pq >= ylist.len() {
									break;
								}
								let ms = self.c.list.mscroll;
								if self.compzputs(&ylist[pq], ms)? != 0 {
									break 'end;
								}
								if i != 0 {
									let a = wid(mc) - i32::try_from(ylist[pq].len()).unwrap_or(0);
									for _ in 0..a.max(0) {
										self.e.out.push(b' ');
									}
								}
								pq += if rows {
									1
								} else {
									usize::try_from(nc).unwrap_or(0)
								};
								mc += 1;
								n -= 1;
							}
							if n != 0 {
								if self.compprintnl(ml)? != 0 {
									break 'end;
								}
								ml += 1;
								if cl >= 0 && {
									cl -= 1;
									cl <= 1
								} {
									self.clear_eod(&mut cl);
								}
							}
							pp += if rows {
								usize::try_from(gcols).unwrap_or(0)
							} else {
								1
							};
						}
					}
				} else if onlyexpl == 0 && (lcount != 0 || (showall && mcount != 0)) {
					let mut n = dcount;
					let mut nl = glins;
					let nc = glins;
					let rows = gflags & cgf::ROWS != 0;

					if gflags & cgf::HASDL != 0
						&& (lastused || self.c.list.lasttype == 0 || self.c.list.lasttype == 2)
					{
						let mut p = if !lastused && self.c.list.lasttype == 2 {
							let l = &self.c.list;
							let p = l.lastp;
							ml = l.lastml;
							n = l.lastn;
							nl = l.lastnl;
							lastused = true;
							pnl = false;
							p
						} else {
							0
						};
						while p < nmatches {
							let (disp, flags) = {
								let m = &self.c.groups.get(gid).matches[p];
								(m.disp.is_some(), m.flags)
							};
							if disp
								&& flags & cmf::DISPLINE != 0
								&& (showall || flags & (cmf::HIDE | cmf::NOLIST) == 0)
							{
								if pnl {
									if self.dolistnl(ml) && self.compprintnl(ml)? != 0 {
										break 'end;
									}
									// zsh resets `pnl` here; it is set again below.
									ml += 1;
									if self.dolistcl(ml) && cl >= 0 && {
										cl -= 1;
										cl <= 1
									} {
										self.clear_eod(&mut cl);
									}
								}
								if self.c.list.lasttype == 0 && ml >= self.c.list.mlbeg {
									let l = &mut self.c.list;
									l.lasttype = 2;
									l.lastg = Some(gid);
									l.lastbeg = l.mlbeg;
									l.lastml = ml;
									l.lastp = p;
									l.lastn = n;
									l.lastnl = nl;
									lastused = true;
								}
								if self.c.list.mfirstl < 0 {
									self.l().mfirstl = ml;
								}
								if self.dolist(ml) {
									printed += 1;
								}
								if self.clprintm(gid, Some(p), 0, ml, true, 0)? != 0 {
									break 'end;
								}
								ml += self.c.list.mlprinted;
								if self.dolistcl(ml) && {
									cl -= self.c.list.mlprinted;
									cl <= 1
								} {
									self.clear_eod(&mut cl);
								}
								pnl = true;
							}
							if self.c.list.mnew == 0 && ml > self.c.list.mlend {
								break 'end;
							}
							p += 1;
						}
					}
					if n != 0 && pnl {
						if self.dolistnl(ml) && self.compprintnl(ml)? != 0 {
							break 'end;
						}
						pnl = false;
						ml += 1;
						if self.dolistcl(ml) && cl >= 0 && {
							cl -= 1;
							cl <= 1
						} {
							self.clear_eod(&mut cl);
						}
					}
					let mut p = if !lastused && self.c.list.lasttype == 3 {
						let l = &self.c.list;
						let p = l.lastp;
						n = l.lastn;
						nl = l.lastnl;
						ml = l.lastml;
						lastused = true;
						p
					} else {
						compresult::skipnolist(self.c, gid, 0, showall)
					};
					while n != 0
						&& {
							let go = nl != 0;
							nl -= 1;
							go
						}
						&& !self.e.errflag
					{
						if self.c.list.lasttype == 0 && ml >= self.c.list.mlbeg {
							let l = &mut self.c.list;
							l.lasttype = 3;
							l.lastg = Some(gid);
							l.lastbeg = l.mlbeg;
							l.lastml = ml;
							l.lastp = p;
							l.lastn = n;
							l.lastnl = nl + 1;
							lastused = true;
						}
						let mut i = gcols;
						let mut mc = 0;
						let mut q = p;
						while n != 0
							&& {
								let go = i != 0;
								i -= 1;
								go
							}
							&& !self.e.errflag
						{
							let w = wid(mc);
							if q >= nmatches {
								if self.clprintm(gid, None, mc, ml, i == 0, w)? != 0 {
									break 'end;
								}
								break;
							}
							if self.clprintm(gid, Some(q), mc, ml, i == 0, w)? != 0 {
								break 'end;
							}
							if self.dolist(ml) {
								printed += 1;
							}
							ml += self.c.list.mlprinted;
							if self.dolistcl(ml) && {
								cl -= self.c.list.mlprinted;
								cl < 1
							} {
								self.clear_eod(&mut cl);
							}
							if self.c.list.mfirstl < 0 {
								self.l().mfirstl = ml;
							}
							n -= 1;
							if n != 0 {
								let mut j = if rows { 1 } else { nc };
								while j != 0 && q < nmatches {
									q = compresult::skipnolist(self.c, gid, q + 1, showall);
									j -= 1;
								}
							}
							mc += 1;
						}
						while i > 0 {
							i -= 1;
							if self.clprintm(gid, None, mc, ml, i == 0, wid(mc))? != 0 {
								break 'end;
							}
							mc += 1;
						}
						if n != 0 {
							if self.dolistnl(ml) && self.compprintnl(ml)? != 0 {
								break 'end;
							}
							ml += 1;
							if self.dolistcl(ml) && cl >= 0 && {
								cl -= 1;
								cl <= 1
							} {
								self.clear_eod(&mut cl);
							}
							if nl != 0 {
								let mut j = if rows { gcols } else { 1 };
								while j != 0 && p < nmatches {
									p = compresult::skipnolist(self.c, gid, p + 1, showall);
									j -= 1;
								}
							}
						}
						if self.c.list.mnew == 0 && ml > self.c.list.mlend {
							break 'end;
						}
					}
				}
				if lcount != 0 || (showall && mcount != 0) {
					pnl = true;
				}
				g = next;
			}
			asked = 0;
		}
		// end:
		self.l().mstatprinted = 0;
		self.d.lastlistlen = 0;
		if nlnct <= 1 {
			self.l().mscroll = 0;
		}
		if self.d.clearflag {
			if self.c.list.mlbeg >= 0 {
				let mut nl = nlines + nlnct;
				if nl >= lines {
					if self.c.list.mhasstat != 0 {
						self.e.out.push(b'\n');
						let mline = self.c.list.mline;
						self.compprintfmt(None, 0, 1, true, mline, None)?;
						self.l().mstatprinted = 1;
					}
					nl = lines - 1;
				} else {
					nl -= 1;
				}
				self.tcmultout(Cap::Up, Cap::MultUp, nl);
				self.d.showinglist = -1;
				self.d.lastlistlen = nlines;
			} else if nlines + nlnct - 1 < lines {
				let nl = nlines + nlnct - 1;
				self.cleareol();
				self.tcmultout(Cap::Up, Cap::MultUp, nl);
				self.d.showinglist = -1;
				self.d.lastlistlen = nlines;
			} else {
				self.d.clearflag = false;
				if asked == 0 {
					self.l().mrestlines = i32::from(ml + nlnct > lines);
					self.compprintnl(ml)?;
				}
			}
		} else if asked == 0 {
			self.l().mrestlines = i32::from(ml + nlnct > lines);
			self.compprintnl(ml)?;
		}
		self.d.listshown = if self.d.clearflag { 1 } else { -1 };
		self.l().mnew = 0;
		Ok(printed)
	}

	/// zsh `clprintm(g, mp, mc, ml, lastc, width)`: print one match of
	/// group `g` (`mp`: its index; `None` for the padding of an empty
	/// slot) at list line `ml`, column `mc`.
	pub fn clprintm(
		&mut self,
		g: GId,
		mp: Option<usize>,
		mc: i32,
		ml: i32,
		lastc: bool,
		width: i32,
	) -> R<i32> {
		let cols = self.e.columns;
		let mut subcols = false;
		let mut ret = 0;
		if Some(g) != self.c.list.last_group {
			self.e.last_cap.clear();
		}
		self.l().last_group = Some(g);
		let Some(gr) = self.c.groups.try_get(g) else {
			self.l().mlprinted = 0;
			return Ok(0);
		};
		let name = gr.name.clone();
		let name = name.as_ref().map(|n| n.as_slice());
		let gflags = gr.flags;
		let widths = gr.widths.clone();
		let gwidth = gr.width;
		let Some(i) = mp.filter(|&i| i < gr.matches.len()) else {
			if self.dolist(ml) {
				self.zcputs(name, COL_SP);
				for _ in 0..(width - 2).max(0) {
					self.e.out.push(b' ');
				}
				self.zcoff();
			}
			self.l().mlprinted = 0;
			return Ok(0);
		};
		let r = MRef { g, i };
		let all = {
			let m = &gr.matches[i];
			m.flags & cmf::ALL != 0 && m.disp.as_ref().is_none_or(|d| d.is_empty())
		};
		if all {
			compresult::bld_all_str(self.c, r, cols);
		}
		let m = self.c.groups.get(g).matches[i].clone();
		self.l().mlastm = m.gnum;
		let follow = self.e.mcolors.flags & LC_FOLLOW_SYMLINKS != 0;
		if let Some(disp) = m.disp.as_ref().filter(|_| m.flags & cmf::DISPLINE != 0) {
			let dummy = m.flags & cmf::DUMMY != 0;
			if self.c.list.mselect >= 0 {
				let mcols = self.c.list.mcols;
				let mm = mcols * ml;
				for k in (0..mcols).rev() {
					self.set_tab(mm + k, r, g, dummy);
				}
			}
			if !self.dolist(ml) {
				let cs =
					Charset { utf8: self.e.utf8, print_eight: self.e.print_eight, ..Charset::default() };
				let n = compresult::printfmt_in(disp, 0, None, false, cols, cs);
				self.l().mlprinted = n;
				return Ok(0);
			}
			if m.gnum == self.c.list.mselect {
				let mm = self.c.list.mcols * ml;
				let l = self.l();
				l.mline = ml;
				l.mcol = 0;
				l.mmtabp = usize::try_from(mm).ok();
				l.mgtabp = usize::try_from(mm).ok();
				self.zcputs(name, COL_MA);
			} else if m.flags & cmf::NOLIST != 0 && self.e.mcolors.col(COL_HI).is_some() {
				self.zcputs(name, COL_HI);
			} else if self.c.list.mselect >= 0
				&& m.flags & (cmf::MULT | cmf::FMULT) != 0
				&& self.e.mcolors.col(COL_DU).is_some()
			{
				self.zcputs(name, COL_DU);
			} else {
				subcols = self.putmatchcol(name, disp);
			}
			if subcols {
				ret = self.clprintfmt(disp, ml)?;
			} else {
				let mut stop = 0;
				self.compprintfmt(Some(disp.as_slice()), 0, 1, false, ml, Some(&mut stop))?;
				if stop != 0 {
					ret = 1;
				}
			}
			self.zcoff();
		} else {
			let mx = match &widths {
				Some(w) => w.iter().take(usize::try_from(mc).unwrap_or(0)).sum(),
				None => mc * gwidth,
			};
			let dummy = m.flags & cmf::DUMMY != 0;
			if self.c.list.mselect >= 0 {
				let mm = self.c.list.mcols * ml;
				let n = if width != 0 { width } else { self.c.list.mcols };
				for k in (0..n).rev() {
					self.set_tab(mx + mm + k, r, g, dummy);
				}
			}
			let text: &[u8] = m.disp.as_ref().map_or(m.str.as_slice(), |d| d.as_slice());
			if !self.dolist(ml) {
				let nc = nicewidth(text, self.e.utf8, self.e.print_eight);
				self.l().mlprinted = if nc != 0 { (nc - 1) / cols } else { 0 };
				return Ok(0);
			}
			if m.gnum == self.c.list.mselect {
				let mm = self.c.list.mcols * ml;
				let l = self.l();
				l.mcol = mx;
				l.mline = ml;
				l.mmtabp = usize::try_from(mx + mm).ok();
				l.mgtabp = usize::try_from(mx + mm).ok();
				self.zcputs(name, COL_MA);
			} else if m.flags & cmf::NOLIST != 0 {
				self.zcputs(name, COL_HI);
			} else if self.c.list.mselect >= 0 && m.flags & (cmf::MULT | cmf::FMULT) != 0 {
				self.zcputs(name, COL_DU);
			} else if m.mode != 0 {
				// An orphaned symlink: lstat worked, stat did not.
				let orphan = (m.mode != 0 && m.fmode == 0).then_some(COL_OR);
				let mode = if follow { m.fmode } else { m.mode };
				subcols = self.putfilecol(name, &m.str, mode, orphan);
			} else {
				subcols = self.putmatchcol(name, text);
			}
			ret = self.clnicezputs(subcols, text, ml)?;
			if ret != 0 {
				self.zcoff();
				return Ok(1);
			}
			let mut len = nicewidth(text, self.e.utf8, self.e.print_eight);
			self.l().mlprinted = if len != 0 { (len - 1) / cols } else { 0 };
			let modec = if follow { m.fmodec } else { m.modec };
			if gflags & cgf::FILES != 0 && modec != 0 {
				if m.gnum != self.c.list.mselect {
					self.zcoff();
					self.zcputs(name, COL_TC);
				}
				self.e.out.push(modec);
				len += 1;
			}
			len = width - len - 2;
			if len > 0 {
				if m.gnum != self.c.list.mselect {
					self.zcoff();
					self.zcputs(name, COL_SP);
				}
				for _ in 0..len {
					self.e.out.push(b' ');
				}
			}
			self.zcoff();
			if !lastc {
				self.zcputs(name, COL_SP);
				self.e.out.extend_from_slice(b"  ");
				self.zcoff();
			}
		}
		Ok(ret)
	}

	/// `mtab[at] = mp; mgtab[at] = g` (marked for dummies).
	fn set_tab(&mut self, at: i32, r: MRef, g: GId, mark: bool) {
		let Ok(at) = usize::try_from(at) else {
			return;
		};
		let l = &mut self.c.list;
		if let Some(t) = l.mtab.get_mut(at) {
			*t = Mt { m: Some(r), mark };
		}
		if let Some(t) = l.mgtab.get_mut(at) {
			*t = super::Mg { g: Some(g), mark };
		}
	}

	/// `mtab[i]` (a `NULL` slot outside the table).
	fn mt(&self, i: i32) -> Mt {
		usize::try_from(i)
			.ok()
			.and_then(|i| self.c.list.mtab.get(i))
			.copied()
			.unwrap_or_default()
	}

	/// zsh `singlecalc(cp, l, lcp)`: where the entry at column `*cp` of
	/// line `l` starts (into `*cp`), whether it is the last on its line
	/// (`*lcp`), and its column number.
	fn singlecalc(&self, cp: &mut i32, l: i32, lcp: &mut bool) -> i32 {
		let cols = self.e.columns;
		let mut c = *cp;
		let base = l * cols;
		let mp = self.mt(base + c);
		let mut n = 0;
		let mut op = Mt::default();
		let mut first = true;
		for j in (0..=c).rev() {
			let p = self.mt(base + j);
			if p == mp {
				c = j;
			}
			if !first && p != op {
				n += 1;
			}
			op = p;
			first = false;
		}
		*cp = c;
		*lcp = true;
		for cc in c..cols {
			let p = self.mt(base + cc);
			if p.is_set() && p != mp {
				*lcp = false;
			}
		}
		n
	}

	/// One entry for [`Self::singledraw`].
	fn singleentry(&mut self, mc: i32, ml: i32, mcc: i32, lc: bool) -> R<()> {
		let at = ml * self.e.columns + mc;
		let g = usize::try_from(at)
			.ok()
			.and_then(|i| self.c.list.mgtab.get(i))
			.and_then(|m| m.g);
		let mp = self.mt(at).m;
		let w = g
			.and_then(|g| self.c.groups.try_get(g))
			.map(|gr| match &gr.widths {
				Some(w) => w
					.get(usize::try_from(mcc).unwrap_or(0))
					.copied()
					.unwrap_or(0),
				None => gr.width,
			});
		if let (Some(g), Some(w)) = (g, w) {
			let mp = mp.filter(|r| r.g == g).map(|r| r.i);
			self.clprintm(g, mp, mcc, ml, lc, w)?;
		} else {
			self.l().mlprinted = 0;
		}
		Ok(())
	}

	/// zsh `singledraw()`: redraw only the entries of the old and the new
	/// selection.
	pub fn singledraw(&mut self) -> R<()> {
		let l = &self.c.list;
		let t1 = l.mline - l.mlbeg;
		let t2 = l.moline - l.molbeg;
		let (mut mc1, ml1, md1, mut mc2, ml2, md2) = if t2 < t1 {
			(l.mocol, l.moline, t2, l.mcol, l.mline, t1)
		} else {
			(l.mcol, l.mline, t1, l.mocol, l.moline, t2)
		};
		let (mut lc1, mut lc2) = (false, false);
		let mcc1 = self.singlecalc(&mut mc1, ml1, &mut lc1);
		let mcc2 = self.singlecalc(&mut mc2, ml2, &mut lc2);

		if md1 != 0 {
			self.tc_downcurs(md1);
		}
		if mc1 != 0 {
			self.tcmultout(Cap::Right, Cap::MultRight, mc1);
		}
		self.singleentry(mc1, ml1, mcc1, lc1)?;
		let mp = self.c.list.mlprinted;
		if mp != 0 {
			self.tcmultout(Cap::Up, Cap::MultUp, mp);
		}
		self.e.out.push(b'\r');

		if md2 != md1 {
			self.tc_downcurs(md2 - md1);
		}
		if mc2 != 0 {
			self.tcmultout(Cap::Right, Cap::MultRight, mc2);
		}
		self.singleentry(mc2, ml2, mcc2, lc2)?;
		let mp = self.c.list.mlprinted;
		if mp != 0 {
			self.tcmultout(Cap::Up, Cap::MultUp, mp);
		}
		self.e.out.push(b'\r');

		let lines = self.e.lines;
		let nlnct = self.d.nlnct;
		if self.c.list.mstatprinted != 0 {
			let i = lines - md2 - nlnct;
			self.tc_downcurs(i - 1);
			let mline = self.c.list.mline;
			self.compprintfmt(None, 0, 1, true, mline, None)?;
			self.tcmultout(Cap::Up, Cap::MultUp, lines - 1);
		} else {
			self.tcmultout(Cap::Up, Cap::MultUp, md2 + nlnct);
		}
		self.d.showinglist = -1;
		self.d.listshown = 1;
		Ok(())
	}
}
