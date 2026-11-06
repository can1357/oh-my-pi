//! zsh prompt expansion: a port of zsh 5.9 `prompt.c` (`promptexpand`,
//! `putpromptchar`, `promptpath`, `prompttrunc`, `stradd`, `tsetcap`,
//! `countprompt`, `parsecolorchar`, `match_colour`, `match_highlight`,
//! `set_colour_attribute`) and the prompt side of `init.c` `init_term`.
//!
//! The expansion buffer is zsh's: metafied, with zero-width regions
//! between [`INPAR`] and [`OUTPAR`] and a [`NULARG`] per glitch cell or
//! `%G`. [`promptexpand_ns`] returns it as it is (zsh's `ns` mode, for the
//! line editor and [`countprompt`]); [`strip_markers`] converts it to raw
//! bytes with the markers removed.
//!
//! Attributes write the capabilities of `$TERM` from the terminfo database
//! ([`TermCaps`]); colours without a capability use zsh's ANSI fallbacks.
//! The attribute state (zsh's global `txtattrmask`) is carried in
//! [`PromptEnv::txtattr`] and returned with the expansion so callers keep
//! it for the next one, as zsh does.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::BString;

use super::{strftime, zsh_quote};
use crate::bash::{
	syntax::zsh::tok::{INPAR, META, NULARG, OUTPAR, head, is_meta, metafy, tail, unmetafy},
	vm::zsh::{nameddir::Found, terminfo_db, wcwidth::wcwidth},
};

/// zsh's `zattr`: text attributes.
pub type Zattr = u64;
/// `TXTBOLDFACE`.
pub const TXTBOLDFACE: Zattr = 0x0001;
/// `TXTSTANDOUT`.
pub const TXTSTANDOUT: Zattr = 0x0002;
/// `TXTUNDERLINE`.
pub const TXTUNDERLINE: Zattr = 0x0004;
/// `TXTFGCOLOUR`.
pub const TXTFGCOLOUR: Zattr = 0x0008;
/// `TXTBGCOLOUR`.
pub const TXTBGCOLOUR: Zattr = 0x0010;
/// `TXT_ATTR_ON_MASK`.
pub const TXT_ATTR_ON_MASK: Zattr = 0x001f;
/// `TXTNOBOLDFACE`.
pub const TXTNOBOLDFACE: Zattr = 0x0020;
/// `TXTNOSTANDOUT`.
pub const TXTNOSTANDOUT: Zattr = 0x0040;
/// `TXTNOUNDERLINE`.
pub const TXTNOUNDERLINE: Zattr = 0x0080;
/// `TXTNOFGCOLOUR`.
pub const TXTNOFGCOLOUR: Zattr = 0x0100;
/// `TXTNOBGCOLOUR`.
pub const TXTNOBGCOLOUR: Zattr = 0x0200;
/// `TXT_ATTR_OFF_MASK`.
pub const TXT_ATTR_OFF_MASK: Zattr = 0x03e0;
/// `TXT_ERROR`: an invalid colour.
pub const TXT_ERROR: Zattr = 0x0800;
/// `TXT_ATTR_FG_24BIT`.
pub const TXT_ATTR_FG_24BIT: Zattr = 0x4000;
/// `TXT_ATTR_BG_24BIT`.
pub const TXT_ATTR_BG_24BIT: Zattr = 0x8000;
/// `TXT_ATTR_FG_COL_MASK`.
pub const TXT_ATTR_FG_COL_MASK: Zattr = 0x0000_00ff_ffff_0000;
/// `TXT_ATTR_FG_COL_SHIFT`.
pub const TXT_ATTR_FG_COL_SHIFT: u32 = 16;
/// `TXT_ATTR_BG_COL_MASK`.
pub const TXT_ATTR_BG_COL_MASK: Zattr = 0xffff_ff00_0000_0000;
/// `TXT_ATTR_BG_COL_SHIFT`.
pub const TXT_ATTR_BG_COL_SHIFT: u32 = 40;
/// `TXT_ATTR_FG_ON_MASK`.
pub const TXT_ATTR_FG_ON_MASK: Zattr = TXTFGCOLOUR | TXT_ATTR_FG_COL_MASK | TXT_ATTR_FG_24BIT;
/// `TXT_ATTR_BG_ON_MASK`.
pub const TXT_ATTR_BG_ON_MASK: Zattr = TXTBGCOLOUR | TXT_ATTR_BG_COL_MASK | TXT_ATTR_BG_24BIT;

/// zsh's `tcstr` indices (`zsh.h` `TC*`), in `init.c` `tccapnams` order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Cap {
	/// `TCCLEARSCREEN` (`cl`).
	ClearScreen,
	/// `TCLEFT` (`le`).
	Left,
	/// `TCMULTLEFT` (`LE`).
	MultLeft,
	/// `TCRIGHT` (`nd`).
	Right,
	/// `TCMULTRIGHT` (`RI`).
	MultRight,
	/// `TCUP` (`up`).
	Up,
	/// `TCMULTUP` (`UP`).
	MultUp,
	/// `TCDOWN` (`do`).
	Down,
	/// `TCMULTDOWN` (`DO`).
	MultDown,
	/// `TCDEL` (`dc`).
	Del,
	/// `TCMULTDEL` (`DC`).
	MultDel,
	/// `TCINS` (`ic`).
	Ins,
	/// `TCMULTINS` (`IC`).
	MultIns,
	/// `TCCLEAREOD` (`cd`).
	ClearEod,
	/// `TCCLEAREOL` (`ce`).
	ClearEol,
	/// `TCINSLINE` (`al`).
	InsLine,
	/// `TCDELLINE` (`dl`).
	DelLine,
	/// `TCNEXTTAB` (`ta`).
	NextTab,
	/// `TCBOLDFACEBEG` (`md`).
	BoldBeg,
	/// `TCSTANDOUTBEG` (`so`).
	StandoutBeg,
	/// `TCUNDERLINEBEG` (`us`).
	UnderlineBeg,
	/// `TCALLATTRSOFF` (`me`).
	AllAttrsOff,
	/// `TCSTANDOUTEND` (`se`).
	StandoutEnd,
	/// `TCUNDERLINEEND` (`ue`).
	UnderlineEnd,
	/// `TCHORIZPOS` (`ch`).
	HorizPos,
	/// `TCUPCURSOR` (`ku`).
	UpCursor,
	/// `TCDOWNCURSOR` (`kd`).
	DownCursor,
	/// `TCLEFTCURSOR` (`kl`).
	LeftCursor,
	/// `TCRIGHTCURSOR` (`kr`).
	RightCursor,
	/// `TCSAVECURSOR` (`sc`).
	SaveCursor,
	/// `TCRESTRCURSOR` (`rc`).
	RestrCursor,
	/// `TCBACKSPACE` (`bc`).
	Backspace,
	/// `TCFGCOLOUR` (`AF`).
	FgColour,
	/// `TCBGCOLOUR` (`AB`).
	BgColour,
}

/// `TC_COUNT`.
pub const TC_COUNT: usize = 34;

impl Cap {
	/// Every capability, by index.
	pub const ALL: [Self; TC_COUNT] = [
		Self::ClearScreen,
		Self::Left,
		Self::MultLeft,
		Self::Right,
		Self::MultRight,
		Self::Up,
		Self::MultUp,
		Self::Down,
		Self::MultDown,
		Self::Del,
		Self::MultDel,
		Self::Ins,
		Self::MultIns,
		Self::ClearEod,
		Self::ClearEol,
		Self::InsLine,
		Self::DelLine,
		Self::NextTab,
		Self::BoldBeg,
		Self::StandoutBeg,
		Self::UnderlineBeg,
		Self::AllAttrsOff,
		Self::StandoutEnd,
		Self::UnderlineEnd,
		Self::HorizPos,
		Self::UpCursor,
		Self::DownCursor,
		Self::LeftCursor,
		Self::RightCursor,
		Self::SaveCursor,
		Self::RestrCursor,
		Self::Backspace,
		Self::FgColour,
		Self::BgColour,
	];

	/// The termcap code (`init.c` `tccapnams`).
	pub const fn code(self) -> &'static str {
		const NAMES: [&str; TC_COUNT] = [
			"cl", "le", "LE", "nd", "RI", "up", "UP", "do", "DO", "dc", "DC", "ic", "IC", "cd", "ce",
			"al", "dl", "ta", "md", "so", "us", "me", "se", "ue", "ch", "ku", "kd", "kl", "kr", "sc",
			"rc", "bc", "AF", "AB",
		];
		NAMES[self as usize]
	}
}

/// `TERM_BAD`: `$TERM` has no database entry.
pub const TERM_BAD: u32 = 0x01;
/// `TERM_UNKNOWN`: `$TERM` is empty (or not looked up yet).
pub const TERM_UNKNOWN: u32 = 0x02;
/// `TERM_NOUP`: no cursor-up capability (single-line editing).
pub const TERM_NOUP: u32 = 0x04;

/// zsh's terminal state for `$TERM` (`init.c` `init_term`): `tcstr`,
/// the numbers and flags it reads, and `termflags`.
#[derive(Clone, Debug)]
pub struct TermCaps {
	/// `tcstr`, by [`Cap`] index, after `init_term`'s fix-ups (`None`:
	/// `tclen` 0, not `tccan`).
	pub tcstr:     [Option<Vec<u8>>; TC_COUNT],
	/// `termflags` ([`TERM_BAD`], [`TERM_UNKNOWN`], [`TERM_NOUP`]).
	pub termflags: u32,
	/// `hasam` (`am`).
	pub hasam:     bool,
	/// `hasxn` (`xn`).
	pub hasxn:     bool,
	/// `tclines` (`li`; -1 when absent).
	pub tclines:   i32,
	/// `tccolumns` (`co`; -1 when absent).
	pub tccolumns: i32,
	/// `tccolours` (`Co`; -1 when absent, 0 with no terminal).
	pub colours:   i32,
	/// `tgetnum("sg")`: standout glitch cells.
	pub sg:        i32,
	/// `tgetnum("ug")`: underline glitch cells.
	pub ug:        i32,
}

impl Default for TermCaps {
	/// No terminal (`TERM_UNKNOWN`).
	fn default() -> Self {
		Self {
			tcstr:     std::array::from_fn(|_| None),
			termflags: TERM_UNKNOWN,
			hasam:     false,
			hasxn:     false,
			tclines:   -1,
			tccolumns: -1,
			colours:   0,
			sg:        -1,
			ug:        -1,
		}
	}
}

impl TermCaps {
	/// zsh `init_term` for `$TERM` = `term` (empty: `TERM_UNKNOWN`; no
	/// database entry: `TERM_BAD`).
	pub fn load(term: &[u8], env: &terminfo_db::TermEnv<'_>) -> Self {
		if term.is_empty() {
			return Self::default();
		}
		let Some(ti) = terminfo_db::load(term, env) else {
			return Self { termflags: TERM_BAD, ..Self::default() };
		};
		let tcstr = Cap::ALL.map(|c| ti.tc_str(c.code()).filter(|s| !s.is_empty()));
		Self::from_strs(tcstr, [ti.tc_flag("am"), ti.tc_flag("xn")], [
			ti.tc_num("li").unwrap_or(-1),
			ti.tc_num("co").unwrap_or(-1),
			ti.tc_num("Co").unwrap_or(-1),
			ti.tc_num("sg").unwrap_or(-1),
			ti.tc_num("ug").unwrap_or(-1),
		])
	}

	/// The state `init_term` derives from the `tgetstr` strings `tcstr`,
	/// the flags `am xn` and the numbers `li co Co sg ug` (tests
	/// build terminals with it).
	pub fn from_strs(
		mut tcstr: [Option<Vec<u8>>; TC_COUNT],
		flags: [bool; 2],
		nums: [i32; 5],
	) -> Self {
		let at = |c: Cap| c as usize;
		let mut termflags = 0;
		if tcstr[at(Cap::Up)].is_none() {
			termflags |= TERM_NOUP;
		}
		// Most entries have no `bc` because they use `\b`.
		if tcstr[at(Cap::Backspace)].is_none() {
			tcstr[at(Cap::Backspace)] = Some(b"\x08".to_vec());
		}
		if tcstr[at(Cap::Left)].is_none() {
			let bs = tcstr[at(Cap::Backspace)].clone();
			tcstr[at(Cap::Left)] = bs;
		}
		if tcstr[at(Cap::SaveCursor)].is_some() && tcstr[at(Cap::RestrCursor)].is_none() {
			tcstr[at(Cap::SaveCursor)] = None;
		}
		if tcstr[at(Cap::Down)]
			.as_deref()
			.is_some_and(|d| d.first() == Some(&b'\n'))
		{
			tcstr[at(Cap::Down)] = None;
		}
		if tcstr[at(Cap::ClearScreen)].is_none() {
			tcstr[at(Cap::ClearScreen)] = Some(b"\x0c".to_vec());
		}
		let [hasam, hasxn] = flags;
		let [tclines, tccolumns, colours, sg, ug] = nums;
		Self { tcstr, termflags, hasam, hasxn, tclines, tccolumns, colours, sg, ug }
	}

	/// zsh `tccan(cap)`.
	pub const fn tccan(&self, cap: Cap) -> bool {
		self.tcstr[cap as usize].is_some()
	}

	/// zsh `tclen[cap]`.
	pub fn tclen(&self, cap: Cap) -> usize {
		self.tcstr[cap as usize].as_ref().map_or(0, Vec::len)
	}

	/// Whether capabilities are written (`termflags` has none of
	/// `TERM_NOUP`, `TERM_BAD`, `TERM_UNKNOWN`).
	pub const fn usable(&self) -> bool {
		self.termflags & (TERM_NOUP | TERM_BAD | TERM_UNKNOWN) == 0
	}

	/// The capability string of `cap` as `tputs` writes it.
	pub fn tputs(&self, cap: Cap) -> Vec<u8> {
		self.tcstr[cap as usize]
			.as_deref()
			.map_or_else(Vec::new, terminfo_db::tputs)
	}

	/// The colour capability (`AF` for the foreground, `AB` for the
	/// background).
	fn colour_cap(&self, fg: bool) -> Option<&[u8]> {
		let cap = if fg { Cap::FgColour } else { Cap::BgColour };
		self.tcstr[cap as usize].as_deref()
	}
}

/// zsh's colour sequences (`fg_bg_sequences`, set from `zle_highlight`'s
/// `fg_start_code:` … `bg_end_code:` entries).
#[derive(Clone, Debug)]
pub struct ColourSeqs {
	/// Foreground start, default code, end.
	pub fg: [BString; 3],
	/// Background start, default code, end.
	pub bg: [BString; 3],
}

/// `TC_COL_FG_START`.
const COL_FG_START: &[u8] = b"\x1b[3";
/// `TC_COL_BG_START`.
const COL_BG_START: &[u8] = b"\x1b[4";
/// `TC_COL_FG_DEFAULT` and `TC_COL_BG_DEFAULT`.
const COL_DEFAULT: &[u8] = b"9";
/// `TC_COL_FG_END` and `TC_COL_BG_END`.
const COL_END: &[u8] = b"m";

impl Default for ColourSeqs {
	fn default() -> Self {
		Self {
			fg: [COL_FG_START.into(), COL_DEFAULT.into(), COL_END.into()],
			bg: [COL_BG_START.into(), COL_DEFAULT.into(), COL_END.into()],
		}
	}
}

/// The `zsh/nearcolor` hook (`GETCOLORATTR`): the palette colour plus one
/// for an RGB colour, given `tccolours`; -1 when there is none.
pub type NearColour = fn(i32, u32, u32, u32) -> i32;

/// The shell state prompt escapes read.
#[derive(Clone, Debug, Default)]
pub struct PromptEnv {
	/// zsh's `pwd`.
	pub pwd:         BString,
	/// zsh `finddir(pwd)`: the named directory (or `$HOME`) prefix of
	/// `pwd` (`%~`, `%(~…)`).
	pub pwd_named:   Option<Found>,
	/// `$?` (`lastval`).
	pub lastval:     i32,
	/// Effective uid (`%#`, `%(#…)`, `%(!…)`).
	pub euid:        u32,
	/// Effective gid (`%(g…)`).
	pub egid:        u32,
	/// `%n` (`get_username`).
	pub user:        BString,
	/// `$HOST` (`%m`, `%M`).
	pub host:        Option<BString>,
	/// `$SHLVL` (`%L`).
	pub shlvl:       i64,
	/// `$psvar` (`%v`).
	pub psvar:       Vec<BString>,
	/// Depth of `$funcstack` (`%e`).
	pub depth:       usize,
	/// `lineno` (`%i`).
	pub lineno:      u32,
	/// The line in its file inside a function (`%I`); `None`: `%I` is `%i`.
	pub flineno:     Option<u32>,
	/// zsh's `scriptname` (`%N`).
	pub scriptname:  BString,
	/// zsh's `scriptfilename` or the defining file of the running
	/// function (`%x`).
	pub scriptfile:  BString,
	/// Current time: seconds, nanoseconds, zone offset east of UTC and
	/// zone abbreviation (`%D %T %t %* %w %W`).
	pub now:         (i64, u32, i32, BString),
	/// Seconds since the shell started (`%(S…)`).
	pub elapsed:     i64,
	/// `PROMPT_PERCENT`.
	pub percent:     bool,
	/// `PROMPT_BANG` (`!` is the history number).
	pub bang:        bool,
	/// The current history event number (`%h`, `%!`, `!`).
	pub histnum:     i64,
	/// Jobs zsh counts for `%j` (live, not hidden).
	pub jobs:        usize,
	/// zsh's `ttystrname` (`%l`, `%y`; empty: none).
	pub tty:         BString,
	/// `zterm_columns` (`%<…<` with a negative width, `%(l…)`).
	pub columns:     usize,
	/// zsh's parser context stack, outermost first (`%_`, `%^`).
	pub cmdstack:    Vec<&'static str>,
	/// `%r` (`SPROMPT`'s correction).
	pub rstring:     Option<BString>,
	/// `%R` (`SPROMPT`'s word).
	pub big_rstring: Option<BString>,
	/// The terminal (`$TERM`).
	pub term:        TermCaps,
	/// `SINGLE_LINE_ZLE` (no capabilities are written).
	pub singleline:  bool,
	/// Colour sequences (`zle_highlight`).
	pub seqs:        ColourSeqs,
	/// The `zsh/nearcolor` hook when that module is loaded.
	pub nearcolor:   Option<NearColour>,
	/// zsh's `txtattrmask` before the expansion.
	pub txtattr:     Zattr,
	/// How characters print (`MULTIBYTE` in a UTF-8 locale,
	/// `PRINT_EIGHT_BIT`).
	pub charset:     zsh_quote::Charset,
}

/// One expansion: zsh's metafied buffer with its markers, and the
/// attribute state it left (zsh's `txtattrmask`).
#[derive(Clone, Debug, Default)]
pub struct Expansion {
	/// The buffer (zsh `ns` mode).
	pub text:    Vec<u8>,
	/// `txtattrmask` after the expansion.
	pub txtattr: Zattr,
}

/// The leading decimal number at `fm[*i..]` (zsh `zstrtol(…, 10)` after a
/// digit was seen).
fn number(fm: &[u8], i: &mut usize) -> i64 {
	let mut v: i64 = 0;
	while let Some(c) = fm.get(*i).filter(|c| c.is_ascii_digit()) {
		v = v.saturating_mul(10).saturating_add(i64::from(c - b'0'));
		*i += 1;
	}
	v
}

/// zsh's prompt buffer (`struct buf_vars`) over one metafied format.
struct Bv<'a> {
	env:        &'a PromptEnv,
	/// Format (`bv->fm`): metafied.
	fm:         Vec<u8>,
	/// Read position.
	i:          usize,
	/// Output (`bv->buf`): metafied, with markers.
	buf:        Vec<u8>,
	/// Start of the current line in `buf` (`bv->bufline`).
	bufline:    usize,
	/// An active truncation's width (`bv->truncwidth`).
	truncwidth: i64,
	/// `%{` nesting (`bv->dontcount`).
	dontcount:  i32,
	/// `%{` nesting around the active truncation (`bv->trunccount`).
	trunccount: i32,
	/// `PROMPT_PERCENT`.
	percent:    bool,
	/// `PROMPT_BANG`.
	bang:       bool,
	/// `txtattrmask`.
	attrs:      Zattr,
}

impl Bv<'_> {
	fn at(&self, i: usize) -> u8 {
		self.fm.get(i).copied().unwrap_or(0)
	}

	/// zsh `pputc`: one raw byte, metafied.
	fn pputc(&mut self, c: u8) {
		if is_meta(c) {
			self.buf.push(META);
			self.buf.push(c ^ 32);
		} else {
			self.buf.push(c);
		}
		if c == b'\n' && self.dontcount == 0 {
			self.bufline = self.buf.len();
		}
	}

	/// zsh `putstr` over raw bytes (`tputs` output).
	fn putstr(&mut self, s: &[u8]) {
		for &c in s {
			self.pputc(c);
		}
	}

	/// zsh `stradd`: raw `d` in its visible representation.
	fn stradd(&mut self, d: &[u8]) {
		let nice = zsh_quote::niceformat(d, false, self.env.charset);
		self.buf.extend_from_slice(&metafy(&nice));
	}

	/// A number.
	fn addnum(&mut self, n: impl std::fmt::Display) {
		self.buf.extend_from_slice(n.to_string().as_bytes());
	}

	/// The start of an invisible region (outside `%{…%}`).
	fn inpar(&mut self) {
		if self.dontcount == 0 {
			self.buf.push(INPAR);
		}
	}

	/// The end of an invisible region (outside `%{…%}`).
	fn outpar(&mut self) {
		if self.dontcount == 0 {
			self.buf.push(OUTPAR);
		}
	}

	/// zsh `tsetcap(cap, TSC_PROMPT | dirty)`.
	fn tsetcap(&mut self, cap: Cap, dirty: bool) {
		let env = self.env;
		let t = &env.term;
		if !t.tccan(cap) || env.singleline || !t.usable() {
			return;
		}
		self.inpar();
		let s = t.tputs(cap);
		self.putstr(&s);
		if self.dontcount == 0 {
			let glitch = match cap {
				Cap::StandoutBeg | Cap::StandoutEnd => t.sg,
				Cap::UnderlineBeg | Cap::UnderlineEnd => t.ug,
				_ => 0,
			};
			for _ in 0..glitch.max(0) {
				self.buf.push(NULARG);
			}
			self.buf.push(OUTPAR);
		}
		if dirty {
			if self.attrs & TXTBOLDFACE != 0 && cap != Cap::BoldBeg {
				self.tsetcap(Cap::BoldBeg, false);
			}
			if self.attrs & TXTSTANDOUT != 0 {
				self.tsetcap(Cap::StandoutBeg, false);
			}
			if self.attrs & TXTUNDERLINE != 0 {
				self.tsetcap(Cap::UnderlineBeg, false);
			}
			if self.attrs & TXTFGCOLOUR != 0 {
				self.colour(self.attrs, true);
			}
			if self.attrs & TXTBGCOLOUR != 0 {
				self.colour(self.attrs, false);
			}
		}
	}

	/// zsh `set_colour_attribute(atr, fg_bg, TSC_PROMPT)`.
	fn colour(&mut self, atr: Zattr, fg: bool) {
		if let Some(s) = colour_sequence(&self.env.term, &self.env.seqs, atr, fg) {
			self.inpar();
			self.putstr(&s);
			self.outpar();
		}
	}

	/// zsh `parsecolorchar(arg, is_fg)`: the colour of `%F`/`%K` at
	/// `fm[i]`, leaving `i` on its last character.
	fn parsecolorchar(&mut self, arg: i64, fg: bool) -> Zattr {
		let env = self.env;
		if self.at(self.i + 1) != b'{' {
			return match_colour(None, fg, arg, &env.term, env.nearcolor);
		}
		self.i += 2;
		if let Some(n) = tail(&self.fm, self.i).iter().position(|&c| c == b'}') {
			let ep = self.i + n;
			// The argument is expanded (`%v` works) with only
			// `PROMPT_PERCENT`.
			let inner = Bv {
				env,
				fm: self.fm[self.i..ep].to_vec(),
				i: 0,
				buf: Vec::with_capacity(n),
				bufline: 0,
				truncwidth: 0,
				dontcount: 0,
				trunccount: 0,
				percent: true,
				bang: false,
				attrs: self.attrs,
			};
			let (col, attrs) = inner.finish();
			self.attrs = attrs;
			let col = unmetafy(&strip_markers_metafied(&col));
			let mut s: &[u8] = &col;
			let atr = match_colour(Some(&mut s), fg, 0, &env.term, env.nearcolor);
			self.i = ep;
			atr
		} else {
			let rest = tail(&self.fm, self.i).to_vec();
			let mut s: &[u8] = &rest;
			let atr = match_colour(Some(&mut s), fg, 0, &env.term, env.nearcolor);
			self.i += rest.len() - s.len();
			if self.at(self.i) != b'}' {
				self.i -= 1;
			}
			atr
		}
	}

	/// Expand the whole format; the buffer and the attributes left.
	fn finish(mut self) -> (Vec<u8>, Zattr) {
		self.put(true, 0);
		if self.dontcount != 0 {
			self.buf.push(OUTPAR);
		}
		(self.buf, self.attrs)
	}

	/// zsh `promptpath(p, npath, tilde)`.
	fn promptpath(&mut self, p: &[u8], npath: i64, tilde: bool) {
		let modp: Vec<u8> = match self.env.pwd_named.as_ref().filter(|_| tilde) {
			Some(nd) => {
				let mut m = b"~".to_vec();
				m.extend_from_slice(&nd.name);
				m.extend_from_slice(tail(p, nd.dir_len));
				m
			},
			None => p.to_vec(),
		};
		match npath.cmp(&0) {
			std::cmp::Ordering::Greater => {
				let mut n = npath;
				let mut s = modp.len();
				while s > 0 {
					if modp.get(s) == Some(&b'/') {
						n -= 1;
						if n == 0 {
							s += 1;
							break;
						}
					}
					s -= 1;
				}
				if modp.get(s) == Some(&b'/') && s + 1 < modp.len() && s != 0 {
					s += 1;
				}
				self.stradd(tail(&modp, s.min(modp.len())));
			},
			std::cmp::Ordering::Less => {
				let mut n = npath;
				let mut s = 1;
				while s < modp.len() {
					if modp[s] == b'/' {
						n += 1;
						if n == 0 {
							break;
						}
					}
					s += 1;
				}
				self.stradd(head(&modp, s.min(modp.len())));
			},
			std::cmp::Ordering::Equal => self.stradd(&modp),
		}
	}

	/// `%_`/`%^`: `n` words of the parser stack, from the top (`%^`
	/// reversed).
	fn cmdwords(&mut self, arg: i64, reverse: bool) {
		let stack = &self.env.cmdstack;
		let sp = i64::try_from(stack.len()).unwrap_or(i64::MAX);
		if sp == 0 {
			return;
		}
		let words: Vec<&'static str> = if arg >= 0 {
			let n = if arg > sp || arg == 0 { sp } else { arg };
			let n = usize::try_from(n).unwrap_or(0);
			if reverse {
				stack.iter().rev().take(n).copied().collect()
			} else {
				stack[stack.len() - n..].to_vec()
			}
		} else {
			let n = usize::try_from((-arg).min(sp)).unwrap_or(0);
			if reverse {
				stack[..n].iter().rev().copied().collect()
			} else {
				stack[..n].to_vec()
			}
		};
		for (k, w) in words.iter().enumerate() {
			if k > 0 {
				self.buf.push(b' ');
			}
			self.stradd(w.as_bytes());
		}
	}

	/// The current time's broken-down field for `%(t…)` and friends.
	fn time_field(&self, conv: &[u8]) -> i64 {
		let (secs, _, off, abbr) = &self.env.now;
		let s = strftime::format(conv, *secs, *off, abbr);
		std::str::from_utf8(&s)
			.ok()
			.and_then(|s| s.trim().parse().ok())
			.unwrap_or(-1)
	}

	/// The test of `%(x.true.false)`: 1 true, 0 false, -1 unknown.
	fn cond_test(&self, tc: u8, arg: i64, minus: bool) -> i32 {
		let env = self.env;
		let t = match tc {
			b'c' | b'.' | b'~' | b'/' | b'C' => {
				let mut arg = arg;
				let mut ss: &[u8] = &env.pwd;
				if matches!(tc, b'c' | b'.' | b'~')
					&& let Some(nd) = &env.pwd_named
				{
					arg -= 1;
					ss = tail(ss, nd.dir_len);
				}
				if ss.first() == Some(&b'/') && ss.len() > 1 {
					arg -= 1;
				}
				let rest = if ss.is_empty() { ss } else { tail(ss, 1) };
				let slashes = rest.split(|&c| c == b'/').count() - 1;
				arg -= i64::try_from(slashes).unwrap_or(0);
				arg <= 0
			},
			b't' => arg == self.time_field(b"%M"),
			b'T' => arg == self.time_field(b"%H"),
			b'd' => arg == self.time_field(b"%d"),
			b'D' => arg == self.time_field(b"%m") - 1,
			b'w' => arg == self.time_field(b"%w"),
			b'?' => i64::from(env.lastval) == arg,
			b'#' => i64::from(env.euid) == arg,
			b'g' => i64::from(env.egid) == arg,
			b'j' => i64::try_from(env.jobs).unwrap_or(i64::MAX) >= arg,
			b'l' => {
				let (mut t0, _) = countprompt(tail(&self.buf, self.bufline), env.columns, 0);
				if minus {
					t0 = env.columns.saturating_sub(t0);
				}
				i64::try_from(t0).unwrap_or(i64::MAX) >= arg
			},
			b'e' => i64::try_from(env.depth).unwrap_or(i64::MAX) >= arg,
			b'L' => env.shlvl >= arg,
			b'S' => env.elapsed >= arg,
			b'v' => i64::try_from(env.psvar.len()).unwrap_or(0) >= arg,
			b'V' => {
				let k = usize::try_from(if arg == 0 { 1 } else { arg }).unwrap_or(1) - 1;
				!env.psvar.is_empty()
					&& i64::try_from(env.psvar.len()).unwrap_or(0) >= arg
					&& env.psvar.get(k).is_some_and(|v| !v.is_empty())
			},
			b'_' => i64::try_from(env.cmdstack.len()).unwrap_or(0) >= arg,
			b'!' => env.euid == 0,
			_ => return -1,
		};
		i32::from(t)
	}

	/// zsh `putpromptchar(doprint, endchar)`: expand up to `endchar` (0:
	/// the end); the character reached (0 at the end).
	fn put(&mut self, doprint: bool, endchar: u8) -> u8 {
		while self.at(self.i) != 0 && self.at(self.i) != endchar {
			if let Some(r) = self.one(doprint, endchar) {
				return r;
			}
			self.i += 1;
		}
		self.at(self.i)
	}

	/// One step of [`Self::put`] at `fm[i]`, leaving `i` on the last
	/// character used; `Some` returns from `put` with that value.
	#[expect(clippy::too_many_lines, reason = "one switch, as zsh's putpromptchar")]
	fn one(&mut self, doprint: bool, endchar: u8) -> Option<u8> {
		let env = self.env;
		let c = self.at(self.i);
		if c == b'%' && self.percent {
			let mut arg: i64 = 0;
			let mut minus = false;
			self.i += 1;
			if self.at(self.i) == b'-' {
				minus = true;
				self.i += 1;
			}
			if self.at(self.i).is_ascii_digit() {
				arg = number(&self.fm, &mut self.i);
				if minus {
					arg = -arg;
				}
			} else if minus {
				arg = -1;
			}
			if self.at(self.i) == b'(' {
				self.i += 1;
				if self.at(self.i).is_ascii_digit() {
					arg = number(&self.fm, &mut self.i);
				} else if arg < 0 {
					arg = -arg;
				}
				let test = self.cond_test(self.at(self.i), arg, minus);
				if self.at(self.i) == 0 {
					return Some(0);
				}
				self.i += 1;
				let sep = self.at(self.i);
				if sep == 0 {
					return Some(0);
				}
				self.i += 1;
				let otruncwidth = self.truncwidth;
				self.truncwidth = 0;
				let ok = self.put(test == 1 && doprint, sep) != 0
					&& {
						self.i += 1;
						self.at(self.i) != 0
					}
					&& self.put(test == 0 && doprint, b')') != 0;
				self.truncwidth = otruncwidth;
				return if ok { None } else { Some(0) };
			}
			if !doprint {
				match self.at(self.i) {
					b'[' => {
						self.i += 1;
						while self.at(self.i).is_ascii_digit() {
							self.i += 1;
						}
						while self.at(self.i) != 0 && self.at(self.i) != b']' {
							self.i += 1;
						}
					},
					d @ (b'<' | b'>') => {
						self.i += 1;
						while self.at(self.i) != 0 && self.at(self.i) != d {
							self.i += 1;
						}
					},
					b'D' if self.at(self.i + 1) == b'{' => {
						while self.at(self.i) != 0 && self.at(self.i) != b'}' {
							self.i += 1;
						}
					},
					_ => {},
				}
				return None;
			}
			match self.at(self.i) {
				b'~' => self.promptpath(&env.pwd, arg, true),
				b'd' | b'/' => self.promptpath(&env.pwd, arg, false),
				b'c' | b'.' => self.promptpath(&env.pwd, if arg == 0 { 1 } else { arg }, true),
				b'C' => self.promptpath(&env.pwd, if arg == 0 { 1 } else { arg }, false),
				b'N' => self.promptpath(&env.scriptname, arg, false),
				b'x' => self.promptpath(&env.scriptfile, arg, false),
				b'h' | b'!' => self.addnum(env.histnum),
				b'j' => self.addnum(env.jobs),
				b'M' => {
					if let Some(h) = &env.host {
						self.stradd(h);
					}
				},
				b'm' => {
					if let Some(h) = &env.host {
						let mut arg = if arg == 0 { 1 } else { arg };
						if arg < 0 {
							let mut s = h.len();
							while s > 0 {
								if h[s - 1] == b'.' {
									arg += 1;
									if arg == 0 {
										break;
									}
								}
								s -= 1;
							}
							self.stradd(tail(h, s));
						} else {
							let mut s = 0;
							while s < h.len() {
								if h[s] == b'.' {
									arg -= 1;
									if arg == 0 {
										break;
									}
								}
								s += 1;
							}
							self.stradd(head(h, s));
						}
					}
				},
				b'S' => {
					self.attrs |= TXTSTANDOUT;
					self.tsetcap(Cap::StandoutBeg, false);
				},
				b's' => {
					self.attrs &= !TXTSTANDOUT;
					self.tsetcap(Cap::StandoutEnd, true);
				},
				b'B' => {
					self.attrs |= TXTBOLDFACE;
					self.tsetcap(Cap::BoldBeg, true);
				},
				b'b' => {
					self.attrs &= !TXTBOLDFACE;
					self.tsetcap(Cap::AllAttrsOff, true);
				},
				b'U' => {
					self.attrs |= TXTUNDERLINE;
					self.tsetcap(Cap::UnderlineBeg, false);
				},
				b'u' => {
					self.attrs &= !TXTUNDERLINE;
					self.tsetcap(Cap::UnderlineEnd, true);
				},
				d @ (b'F' | b'K') => {
					let fg = d == b'F';
					let atr = self.parsecolorchar(arg, fg);
					let (none, col_mask, on_mask) = if fg {
						(TXTNOFGCOLOUR, TXT_ATTR_FG_COL_MASK, TXT_ATTR_FG_ON_MASK)
					} else {
						(TXTNOBGCOLOUR, TXT_ATTR_BG_COL_MASK, TXT_ATTR_BG_ON_MASK)
					};
					if atr & (TXT_ERROR | none) == 0 {
						self.attrs &= !col_mask;
						self.attrs |= atr & on_mask;
						self.colour(atr, fg);
					} else {
						self.attrs &= !on_mask;
						self.colour(none, fg);
					}
				},
				d @ (b'f' | b'k') => {
					let fg = d == b'f';
					let (none, on_mask) = if fg {
						(TXTNOFGCOLOUR, TXT_ATTR_FG_ON_MASK)
					} else {
						(TXTNOBGCOLOUR, TXT_ATTR_BG_ON_MASK)
					};
					self.attrs &= !on_mask;
					self.colour(none, fg);
				},
				b'[' => {
					self.i += 1;
					if self.at(self.i).is_ascii_digit() {
						arg = number(&self.fm, &mut self.i);
					}
					if !self.prompttrunc(arg, b']', doprint, endchar) {
						return Some(self.at(self.i));
					}
				},
				d @ (b'<' | b'>') => {
					// A negative width counts from the right margin.
					if minus {
						let (t0, _) = countprompt(tail(&self.buf, self.bufline), env.columns, 0);
						arg += i64::try_from(env.columns).unwrap_or(i64::MAX)
							- i64::try_from(t0).unwrap_or(0);
						if arg <= 0 {
							arg = 1;
						}
					}
					if !self.prompttrunc(arg, d, doprint, endchar) {
						return Some(self.at(self.i));
					}
				},
				b'{' => {
					if self.dontcount == 0 {
						self.buf.push(INPAR);
					}
					self.dontcount += 1;
					if arg > 0 {
						for _ in 0..arg {
							self.buf.push(NULARG);
						}
					}
				},
				b'G' => {
					for _ in 0..arg.max(1) {
						self.buf.push(NULARG);
					}
				},
				b'}' => {
					if self.trunccount != 0 && self.trunccount >= self.dontcount {
						return Some(self.at(self.i));
					}
					if self.dontcount != 0 {
						self.dontcount -= 1;
						if self.dontcount == 0 {
							self.buf.push(OUTPAR);
						}
					}
				},
				d @ (b't' | b'@' | b'T' | b'*' | b'w' | b'W' | b'D') => {
					let fmt: Vec<u8> = match d {
						b'T' => b"%K:%M".to_vec(),
						b'*' => b"%K:%M:%S".to_vec(),
						b'w' => b"%a %f".to_vec(),
						b'W' => b"%m/%d/%y".to_vec(),
						b'D' if self.at(self.i + 1) == b'{' => {
							let mut f = Vec::new();
							let mut j = self.i + 2;
							while self.at(j) != 0 && self.at(j) != b'}' {
								if self.at(j) == b'\\' && self.at(j + 1) != 0 {
									j += 1;
								}
								f.push(self.at(j));
								j += 1;
							}
							self.i = if self.at(j) == 0 { j - 1 } else { j };
							if f.is_empty() {
								return None;
							}
							unmetafy(&f)
						},
						b'D' => b"%y-%m-%d".to_vec(),
						_ => b"%l:%M%p".to_vec(),
					};
					// zsh offers `ztrftime` 8 bytes per format byte, doubled
					// twice when that is not enough.
					let (secs, nanos, off, abbr) = &env.now;
					let size = i64::try_from(fmt.len()).unwrap_or(0).saturating_mul(32);
					let s =
						super::zsh_mod_stat::ztrftime(&fmt, *secs, i64::from(*nanos), *off, abbr, size);
					self.buf.extend_from_slice(&metafy(&s));
				},
				b'n' => self.stradd(&env.user),
				b'l' => {
					if env.tty.is_empty() {
						self.stradd(b"()");
					} else {
						let t: &[u8] = &env.tty;
						let s = if t.starts_with(b"/dev/tty") {
							tail(t, 8)
						} else {
							tail(t, 5)
						};
						self.stradd(s);
					}
				},
				b'y' => {
					if env.tty.is_empty() {
						self.stradd(b"()");
					} else {
						let t: &[u8] = &env.tty;
						let s = if t.starts_with(b"/dev/") {
							tail(t, 5)
						} else {
							t
						};
						self.stradd(s);
					}
				},
				b'L' => self.addnum(env.shlvl),
				b'?' => self.addnum(env.lastval),
				d @ (b'%' | b')') => self.buf.push(d),
				b'#' => self.buf.push(if env.euid == 0 { b'#' } else { b'%' }),
				b'v' => {
					let n = i64::try_from(env.psvar.len()).unwrap_or(i64::MAX);
					let arg = match arg.cmp(&0) {
						std::cmp::Ordering::Equal => 1,
						std::cmp::Ordering::Less => arg + n + 1,
						std::cmp::Ordering::Greater => arg,
					};
					if arg > 0
						&& let Some(v) = usize::try_from(arg - 1).ok().and_then(|k| env.psvar.get(k))
					{
						self.stradd(v);
					}
				},
				b'E' => self.tsetcap(Cap::ClearEol, false),
				b'^' => self.cmdwords(arg, true),
				b'_' => self.cmdwords(arg, false),
				b'r' => {
					if let Some(r) = &env.rstring {
						self.stradd(r);
					}
				},
				b'R' => {
					if let Some(r) = &env.big_rstring {
						self.stradd(r);
					}
				},
				b'e' => self.addnum(env.depth),
				b'I' => self.addnum(env.flineno.unwrap_or(env.lineno)),
				b'i' => self.addnum(env.lineno),
				0 => return Some(0),
				META => self.i += 1,
				_ => {},
			}
		} else if c == b'!' && self.bang {
			if doprint {
				if self.at(self.i + 1) == b'!' {
					self.i += 1;
					self.pputc(b'!');
				} else {
					self.addnum(env.histnum);
				}
			}
		} else {
			let c = if c == META {
				self.i += 1;
				self.at(self.i) ^ 32
			} else {
				c
			};
			if doprint {
				self.pputc(c);
			}
		}
		None
	}

	/// zsh `prompttrunc`: `%N<str<`, `%N>str>`, `%N[str]`: what follows
	/// (to the end of this level) is cut to `arg` columns, `str` marking
	/// the cut; `false` ends the caller's level.
	fn prompttrunc(&mut self, arg: i64, truncchar: u8, doprint: bool, endchar: u8) -> bool {
		if arg <= 0 {
			if self.at(self.i) != endchar {
				self.i += 1;
			}
			while self.at(self.i) != 0 && self.at(self.i) != truncchar {
				if self.at(self.i) == b'\\' && self.at(self.i + 1) != 0 {
					self.i += 1;
				}
				self.i += 1;
			}
			return !(self.truncwidth != 0 || self.at(self.i) == 0);
		}
		let truncatleft = self.at(self.i) == b'<';
		let w = self.buf.len();
		// A truncation is active: finish it first, then start this one.
		if self.truncwidth != 0 {
			while self.i > 0 {
				self.i -= 1;
				if self.at(self.i) == b'%' {
					break;
				}
			}
			self.i = self.i.saturating_sub(1);
			return false;
		}
		self.truncwidth = arg;
		if self.at(self.i) != b']' {
			self.i += 1;
		}
		while self.at(self.i) != 0 && self.at(self.i) != truncchar {
			if self.at(self.i) == b'\\' && self.at(self.i + 1) != 0 {
				self.i += 1;
			}
			let c = self.at(self.i);
			self.buf.push(c);
			self.i += 1;
		}
		if self.at(self.i) == 0 {
			return false;
		}
		if self.buf.len() == w && truncchar == b']' {
			self.buf.push(b'<');
		}
		let truncstr = self.buf.split_off(w);
		self.i += 1;
		self.trunccount = self.dontcount;
		self.put(doprint, endchar);
		self.trunccount = 0;
		let (width, _) = countprompt(tail(&self.buf, w), self.env.columns, -1);
		let truncwidth = usize::try_from(self.truncwidth).unwrap_or(usize::MAX);
		if width > truncwidth {
			let twidth = metastrwidth(&truncstr, self.env.charset.utf8);
			let fulltext = self.buf.split_off(w);
			if twidth < truncwidth {
				let maxwidth = truncwidth - twidth;
				let utf8 = self.env.charset.utf8;
				if truncatleft {
					self.buf.extend_from_slice(&truncstr);
					let mut remw = width;
					let mut p = 0;
					while remw > maxwidth && p < fulltext.len() {
						if fulltext[p] == INPAR {
							// Invisible text is kept whole.
							while p < fulltext.len() {
								let ch = fulltext[p];
								self.buf.push(ch);
								p += 1;
								if ch == OUTPAR {
									break;
								}
								if ch == NULARG {
									remw = remw.saturating_sub(1);
								}
							}
						} else {
							let (n, cw) = next_width(&fulltext, p, utf8);
							p += n;
							remw = remw.saturating_sub(cw);
						}
					}
					self.buf.extend_from_slice(tail(&fulltext, p));
				} else {
					let mut maxw = maxwidth;
					let mut skip = 0;
					while maxw > 0 && skip < fulltext.len() {
						if fulltext[skip] == INPAR {
							while skip < fulltext.len() {
								let ch = fulltext[skip];
								skip += 1;
								if ch == OUTPAR {
									break;
								}
								if ch == NULARG {
									maxw = maxw.saturating_sub(1);
								}
							}
						} else {
							let (n, cw) = next_width(&fulltext, skip, utf8);
							skip += n;
							maxw = maxw.saturating_sub(cw);
						}
					}
					self.buf.extend_from_slice(head(&fulltext, skip));
					self.buf.extend_from_slice(&truncstr);
					// zsh writes the marker over the text after the cut
					// and then keeps the invisible groups of what is
					// there.
					let mut rest = truncstr.clone();
					rest.extend_from_slice(tail(&fulltext, skip + truncstr.len()));
					let mut q = 0;
					while q < rest.len() {
						if rest[q] == INPAR {
							while q < rest.len() {
								self.buf.push(rest[q]);
								if rest[q] == OUTPAR {
									break;
								}
								q += 1;
							}
						}
						q += 1;
					}
				}
			} else {
				self.buf.extend_from_slice(&truncstr);
			}
		}
		self.truncwidth = 0;
		if self.at(self.i) == 0 {
			return false;
		}
		if self.at(self.i) != endchar {
			self.i += 1;
			if self.put(doprint, endchar) == 0 {
				return false;
			}
		}
		// The caller's loop steps over `endchar` again.
		self.i -= 1;
		true
	}
}

/// The bytes and width of the character of metafied `s` at `p`
/// (`mbrtowc` and `WCWIDTH`; an invalid byte is one column).
fn next_width(s: &[u8], p: usize, utf8: bool) -> (usize, usize) {
	let mut raw = Vec::with_capacity(4);
	let mut q = p;
	let take = |q: &mut usize| -> Option<u8> {
		let c = *s.get(*q)?;
		if c == META {
			*q += 2;
			Some(s.get(*q - 1).copied().unwrap_or(0) ^ 32)
		} else {
			*q += 1;
			Some(c)
		}
	};
	let Some(first) = take(&mut q) else {
		return (1, 0);
	};
	raw.push(first);
	if !utf8 || first < 0x80 {
		return (q - p, 1);
	}
	let want = utf8_len(first);
	if want == 0 {
		return (q - p, 1);
	}
	while raw.len() < want {
		let save = q;
		match take(&mut q) {
			Some(c) if c & 0xc0 == 0x80 => raw.push(c),
			_ => {
				q = save;
				return (q - p, 1);
			},
		}
	}
	let cw = std::str::from_utf8(&raw)
		.ok()
		.and_then(|t| t.chars().next())
		.map_or(1, |ch| usize::try_from(wcwidth(ch)).unwrap_or(1));
	(q - p, cw)
}

/// Bytes of the UTF-8 sequence led by `c` (0: not a lead byte).
const fn utf8_len(c: u8) -> usize {
	match c {
		0xc2..=0xdf => 2,
		0xe0..=0xef => 3,
		0xf0..=0xf4 => 4,
		_ => 0,
	}
}

/// zsh `MB_METASTRWIDTH`: the columns of metafied `s` (characters that do
/// not print count 0, bytes that do not decode 1).
fn metastrwidth(s: &[u8], utf8: bool) -> usize {
	if !utf8 {
		return unmetafy(s).len();
	}
	let raw = unmetafy(s);
	let mut w = 0;
	let mut i = 0;
	while i < raw.len() {
		let (ch, n) = bstr::decode_utf8(tail(&raw, i));
		match ch {
			Some(ch) if ch.is_ascii() => w += 1,
			Some(ch) => w += usize::try_from(wcwidth(ch)).unwrap_or(0),
			None => w += 1,
		}
		i += n.max(1);
	}
	w
}

/// zsh `match_named_colour`: the ANSI colour `s` abbreviates (8:
/// `default`), consuming its letters.
fn match_named_colour(s: &mut &[u8]) -> i32 {
	const COLOURS: [&[u8]; 9] =
		[b"black", b"red", b"green", b"yellow", b"blue", b"magenta", b"cyan", b"white", b"default"];
	let cur: &[u8] = s;
	let len = cur.iter().take_while(|c| c.is_ascii_alphabetic()).count();
	let word = &cur[..len];
	*s = &cur[len..];
	COLOURS
		.iter()
		.position(|c| c.len() >= len && &c[..len] == word)
		.map_or(-1, |i| i32::try_from(i).unwrap_or(-1))
}

/// zsh `zstrtol(s, &end, base)`: blanks, a sign, digits; the value and the
/// rest.
fn zstrtol(s: &[u8], base: u32) -> (i64, &[u8]) {
	let mut i = s.iter().take_while(|&&c| c == b' ' || c == b'\t').count();
	let neg = match s.get(i) {
		Some(b'-') => {
			i += 1;
			true
		},
		Some(b'+') => {
			i += 1;
			false
		},
		_ => false,
	};
	let mut v: i64 = 0;
	while let Some(d) = s.get(i).and_then(|&c| char::from(c).to_digit(base)) {
		v = v.wrapping_mul(i64::from(base)).wrapping_add(i64::from(d));
		i += 1;
	}
	(if neg { v.wrapping_neg() } else { v }, tail(s, i))
}

/// zsh `match_colour`: the attribute of the colour named at `*s` (its
/// text consumed; `None`: the numeric `colour`) for the foreground or
/// background; [`TXT_ERROR`] when invalid or out of the terminal's range.
pub fn match_colour(
	s: Option<&mut &[u8]>,
	fg: bool,
	colour: i64,
	term: &TermCaps,
	nearcolor: Option<NearColour>,
) -> Zattr {
	let (shft, on) = if fg {
		(TXT_ATTR_FG_COL_SHIFT, TXTFGCOLOUR)
	} else {
		(TXT_ATTR_BG_COL_SHIFT, TXTBGCOLOUR)
	};
	let mut colour = colour;
	if let Some(s) = s {
		if s.first() == Some(&b'#') && s.get(1).is_some_and(u8::is_ascii_hexdigit) {
			let cur: &[u8] = s;
			let (col, rest) = zstrtol(tail(cur, 1), 16);
			let used = cur.len() - rest.len();
			let (r, g, b) = match used {
				4 => {
					let x = |v: i64| u32::try_from(v & 0xf).unwrap_or(0) * 0x11;
					(x(col >> 8), x(col >> 4), x(col))
				},
				7 => {
					let x = |v: i64| u32::try_from(v & 0xff).unwrap_or(0);
					(x(col >> 16), x(col >> 8), x(col))
				},
				_ => return TXT_ERROR,
			};
			*s = rest;
			let hook = nearcolor.map_or(0, |f| f(term.colours, r, g, b));
			colour = i64::from(hook) - 1;
			if colour == -1 {
				let rgb = (u64::from(r) << 16) | (u64::from(g) << 8) | u64::from(b);
				let flag = if fg {
					TXT_ATTR_FG_24BIT
				} else {
					TXT_ATTR_BG_24BIT
				};
				return on | flag | (rgb << shft);
			}
			if colour <= -2 {
				return TXT_ERROR;
			}
		} else if s.first().is_some_and(u8::is_ascii_alphabetic) {
			colour = i64::from(match_named_colour(s));
			if colour == 8 {
				return if fg { TXTNOFGCOLOUR } else { TXTNOBGCOLOUR };
			}
			if colour < 0 {
				return TXT_ERROR;
			}
		} else {
			let cur: &[u8] = s;
			let (v, rest) = zstrtol(cur, 10);
			*s = rest;
			colour = v;
			if !(0..256).contains(&colour) {
				return TXT_ERROR;
			}
		}
	}
	// Out of range of the terminal's colours and the basic ANSI set.
	if term.colour_cap(fg).is_some() && colour > 7 && colour >= i64::from(term.colours) {
		return TXT_ERROR;
	}
	on | (u64::try_from(colour).unwrap_or(0) << shft)
}

/// zsh `match_highlight`: the attributes of a highlight specification
/// (`bold,fg=red,…`); the attributes and the bytes used.
pub fn match_highlight(s: &[u8], term: &TermCaps, nearcolor: Option<NearColour>) -> (Zattr, usize) {
	const HIGHLIGHTS: [(&[u8], Zattr, Zattr); 4] = [
		(b"none", 0, TXT_ATTR_ON_MASK),
		(b"bold", TXTBOLDFACE, 0),
		(b"standout", TXTSTANDOUT, 0),
		(b"underline", TXTUNDERLINE, 0),
	];
	let mut on: Zattr = 0;
	let mut t: &[u8] = s;
	let mut found = true;
	while found && !t.is_empty() {
		found = false;
		if t.starts_with(b"fg=") || t.starts_with(b"bg=") {
			let fg = t[0] == b'f';
			t = tail(t, 3);
			let atr = match_colour(Some(&mut t), fg, 0, term, nearcolor);
			match t.first() {
				Some(b',') => t = tail(t, 1),
				Some(b' ') | None => {},
				Some(_) => break,
			}
			found = true;
			if atr != TXT_ERROR {
				on |= atr;
			}
		} else {
			for (name, mask_on, mask_off) in HIGHLIGHTS {
				if t.starts_with(name) {
					let mut val = tail(t, name.len());
					match val.first() {
						Some(b',') => val = tail(val, 1),
						Some(b' ') | None => {},
						Some(_) => break,
					}
					on |= mask_on;
					on &= !mask_off;
					t = val;
					found = true;
				}
			}
		}
	}
	(on, s.len() - t.len())
}

/// zsh `set_colour_attribute`'s output for colour attribute `atr` of the
/// foreground (`fg`) or background: the terminal's colour capability when
/// it covers the colour, else the ANSI sequence; `None` when nothing is
/// written.
pub fn colour_sequence(
	term: &TermCaps,
	seqs: &ColourSeqs,
	atr: Zattr,
	fg: bool,
) -> Option<Vec<u8>> {
	let (colour, def, truecol, set) = if fg {
		(
			(atr & TXT_ATTR_FG_COL_MASK) >> TXT_ATTR_FG_COL_SHIFT,
			atr & TXTNOFGCOLOUR != 0,
			atr & TXT_ATTR_FG_24BIT != 0,
			&seqs.fg,
		)
	} else {
		(
			(atr & TXT_ATTR_BG_COL_MASK) >> TXT_ATTR_BG_COL_SHIFT,
			atr & TXTNOBGCOLOUR != 0,
			atr & TXT_ATTR_BG_24BIT != 0,
			&seqs.bg,
		)
	};
	let default_start = if fg { COL_FG_START } else { COL_BG_START };
	let is_default = set[0].as_slice() == default_start
		&& set[1].as_slice() == COL_DEFAULT
		&& set[2].as_slice() == COL_END;
	if !def && !truecol && is_default {
		if let Some(cap) = term.colour_cap(fg)
			&& (term.colours < 0 || colour < u64::try_from(term.colours).unwrap_or(0))
		{
			let n = i32::try_from(colour).unwrap_or(0);
			return Some(terminfo_db::tputs(&terminfo_db::tgoto(cap, n, n)));
		}
		if colour > 255 {
			return None;
		}
	}
	let mut out: Vec<u8> = if truecol {
		default_start.to_vec()
	} else {
		set[0].to_vec()
	};
	if def {
		out.extend_from_slice(if truecol {
			COL_DEFAULT
		} else {
			set[1].as_slice()
		});
	} else if truecol {
		out.extend_from_slice(
			format!("8;2;{};{};{}", colour >> 16, (colour >> 8) & 0xff, colour & 0xff).as_bytes(),
		);
	} else if (8..=255).contains(&colour) {
		out.extend_from_slice(colour.to_string().as_bytes());
	} else {
		out.push(b'0'.wrapping_add(u8::try_from(colour & 0xff).unwrap_or(0)));
	}
	out.extend_from_slice(if truecol { COL_END } else { set[2].as_slice() });
	Some(out)
}

/// zsh `tsetcap(cap, 0)` outside prompts: `cap` as written to the
/// terminal (empty when the terminal lacks it or is unusable).
pub fn tsetcap(term: &TermCaps, cap: Cap, singleline: bool) -> Vec<u8> {
	if !term.tccan(cap) || singleline || !term.usable() {
		return Vec::new();
	}
	term.tputs(cap)
}

/// zsh `promptexpand(s, 1, rs, Rs, NULL)` over raw `s`: zsh's metafied
/// buffer with [`INPAR`]/[`OUTPAR`] around invisible text and a
/// [`NULARG`] per glitch cell, and the attribute state left.
pub fn promptexpand_ns(s: &[u8], env: &PromptEnv) -> Expansion {
	let bv = Bv {
		env,
		fm: metafy(s),
		i: 0,
		buf: Vec::with_capacity(s.len() + 16),
		bufline: 0,
		truncwidth: 0,
		dontcount: 0,
		trunccount: 0,
		percent: env.percent,
		bang: env.bang,
		attrs: env.txtattr,
	};
	let (text, txtattr) = bv.finish();
	Expansion { text, txtattr }
}

/// The markers of a [`promptexpand_ns`] buffer removed, still metafied.
fn strip_markers_metafied(s: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(s.len());
	let mut i = 0;
	while i < s.len() {
		match s[i] {
			META => {
				out.extend_from_slice(&s[i..(i + 2).min(s.len())]);
				i += 2;
				continue;
			},
			INPAR | OUTPAR | NULARG => {},
			c => out.push(c),
		}
		i += 1;
	}
	out
}

/// A [`promptexpand_ns`] buffer as the raw bytes zsh's `ns = 0` mode
/// gives: markers removed, unmetafied.
pub fn strip_markers(s: &[u8]) -> Vec<u8> {
	unmetafy(&strip_markers_metafied(s))
}

/// zsh `countprompt(str, &w, &h, overf)` over a [`promptexpand_ns`]
/// buffer: the column after it and the lines it takes on a terminal of
/// `columns` columns (`overf` -1: no wrapping, the absolute width; 0: a
/// full last line counts as wrapped).
pub fn countprompt(s: &[u8], columns: usize, overf: i32) -> (usize, usize) {
	let cols = i64::try_from(columns.max(1)).unwrap_or(i64::MAX);
	let (mut w, mut h): (i64, i64) = (0, 1);
	let mut multi = false;
	let mut wcw: i64 = 0;
	let mut visible = true;
	let mut pending: Vec<u8> = Vec::with_capacity(4);
	let mut i = 0;
	while i < s.len() {
		while w > cols && overf >= 0 && !multi {
			h += 1;
			if wcw != 0 {
				w = wcw;
				break;
			}
			w -= cols;
		}
		wcw = 0;
		let c = s[i];
		if c == INPAR {
			visible = false;
		} else if c == OUTPAR {
			visible = true;
		} else if c == NULARG {
			w += 1;
		} else if visible {
			let inchar = if c == META {
				i += 1;
				s.get(i).copied().unwrap_or(0) ^ 32
			} else {
				if !multi {
					if c == b'\t' {
						w = (w | 7) + 1;
						i += 1;
						continue;
					}
					if c == b'\n' {
						w = 0;
						h += 1;
						i += 1;
						continue;
					}
				}
				c
			};
			pending.push(inchar);
			match decode_pending(&pending) {
				Decoded::Incomplete => multi = true,
				Decoded::Invalid => {
					pending.clear();
					multi = false;
					w += 1;
				},
				Decoded::Char(ch) => {
					pending.clear();
					multi = false;
					if ch != '\0' {
						wcw = i64::from(wcwidth(ch));
						if wcw >= 0 {
							w += wcw;
						} else {
							w += 1;
						}
					}
				},
			}
		}
		i += 1;
	}
	while w > cols && overf >= 0 {
		h += 1;
		if wcw != 0 {
			w = wcw;
			break;
		}
		w -= cols;
	}
	if w == cols && overf == 0 {
		w = 0;
		h += 1;
	}
	(usize::try_from(w).unwrap_or(0), usize::try_from(h).unwrap_or(1))
}

/// `mbrtowc` over the bytes of one character so far.
enum Decoded {
	/// More bytes are needed.
	Incomplete,
	/// Not a character.
	Invalid,
	/// A whole character.
	Char(char),
}

/// UTF-8 decoding of `b`, the bytes collected for one character.
fn decode_pending(b: &[u8]) -> Decoded {
	let first = b[0];
	if first < 0x80 {
		return Decoded::Char(char::from(first));
	}
	let want = utf8_len(first);
	if want == 0 || b[1..].iter().any(|&c| c & 0xc0 != 0x80) {
		return Decoded::Invalid;
	}
	if b.len() < want {
		return Decoded::Incomplete;
	}
	std::str::from_utf8(b)
		.ok()
		.and_then(|t| t.chars().next())
		.map_or(Decoded::Invalid, Decoded::Char)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn env() -> PromptEnv {
		PromptEnv {
			pwd: "/home/u/src/proj".into(),
			pwd_named: Some(Found { name: BString::default(), dir_len: 7 }),
			lastval: 3,
			user: "u".into(),
			host: Some("box.example.org".into()),
			shlvl: 2,
			euid: 1000,
			percent: true,
			columns: 80,
			..PromptEnv::default()
		}
	}

	fn p(s: &str) -> String {
		String::from_utf8(strip_markers(&promptexpand_ns(s.as_bytes(), &env()).text)).unwrap()
	}

	#[test]
	fn paths_and_home_abbreviation() {
		assert_eq!(p("%~"), "~/src/proj");
		assert_eq!(p("%/"), "/home/u/src/proj");
		assert_eq!(p("%c"), "proj");
		assert_eq!(p("%2~"), "src/proj");
		assert_eq!(p("%-1/"), "/home");
	}

	#[test]
	fn simple_escapes_and_conditionals() {
		assert_eq!(p("%n@%m %? %L %% %#"), "u@box 3 2 % %");
		assert_eq!(p("%(?.ok.fail %?)"), "fail 3");
		assert_eq!(p("%(3?.three.other)"), "three");
		assert_eq!(p("%M"), "box.example.org");
	}

	#[test]
	fn truncation() {
		assert_eq!(p("%5<..<abcdefgh"), "..fgh");
		assert_eq!(p("%5>..>abcdefgh"), "abc..");
		assert_eq!(p("%10<..<short"), "short");
	}

	#[test]
	fn colours_without_a_terminal_use_ansi_sequences() {
		assert_eq!(p("%F{red}r%f"), "\x1b[31mr\x1b[39m");
		assert_eq!(p("%K{123}x%k"), "\x1b[4123mx\x1b[49m");
		assert_eq!(p("%F{#ff0000}t"), "\x1b[38;2;255;0;0mt");
		assert_eq!(p("%Bb%b"), "b");
	}

	#[test]
	fn invisible_regions_and_width() {
		let e = promptexpand_ns(b"%{\x1b[1m%}ab%G", &env());
		let want: Vec<u8> =
			[&[INPAR][..], &b"\x1b[1m"[..], &[OUTPAR][..], &b"ab"[..], &[NULARG][..]].concat();
		assert_eq!(e.text, want);
		assert_eq!(countprompt(&e.text, 80, -1).0, 3);
		assert_eq!(countprompt(b"abc\tx", 80, -1), (9, 1));
		assert_eq!(countprompt(b"ab\ncd", 80, -1), (2, 2));
	}
}
