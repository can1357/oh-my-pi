//! Screen updates compared with what `/bin/zsh -f -i` (5.9) wrote to a
//! pty with `TERM=xterm-256color`, one key per refresh (the pty's `ONLCR`
//! turned zsh's `\n` into `\r\n`; the expectations here are zsh's bytes).

use bstr::BString;

use super::{
	Display, RefreshIn, RegionHighlight, ZRH_PREDISPLAY, get_region_highlight, output_highlight,
	set_region_highlight, trashzle, zrefresh,
};
use crate::bash::vm::{
	builtins::zsh_prompt::{
		Cap, TC_COUNT, TXT_ATTR_FG_COL_SHIFT, TXTBOLDFACE, TXTFGCOLOUR, TXTSTANDOUT, TXTUNDERLINE,
		TermCaps,
	},
	zle::{Context, Editor},
};

/// `xterm-256color` as ncurses' `tgetstr` gives it on the oracle's
/// system.
fn xterm() -> TermCaps {
	let mut s: [Option<Vec<u8>>; TC_COUNT] = std::array::from_fn(|_| None);
	let caps: [(Cap, &[u8]); 32] = [
		(Cap::ClearScreen, b"\x1b[H\x1b[2J"),
		(Cap::Left, b"\x08"),
		(Cap::MultLeft, b"\x1b[%p1%dD"),
		(Cap::Right, b"\x1b[C"),
		(Cap::MultRight, b"\x1b[%p1%dC"),
		(Cap::Up, b"\x1b[A"),
		(Cap::MultUp, b"\x1b[%p1%dA"),
		(Cap::Down, b"\n"),
		(Cap::MultDown, b"\x1b[%p1%dB"),
		(Cap::Del, b"\x1b[P"),
		(Cap::MultDel, b"\x1b[%p1%dP"),
		(Cap::MultIns, b"\x1b[%p1%d@"),
		(Cap::ClearEod, b"\x1b[J"),
		(Cap::ClearEol, b"\x1b[K"),
		(Cap::InsLine, b"\x1b[L"),
		(Cap::DelLine, b"\x1b[M"),
		(Cap::NextTab, b"\t"),
		(Cap::BoldBeg, b"\x1b[1m"),
		(Cap::StandoutBeg, b"\x1b[7m"),
		(Cap::UnderlineBeg, b"\x1b[4m"),
		(Cap::AllAttrsOff, b"\x1b[0m"),
		(Cap::StandoutEnd, b"\x1b[27m"),
		(Cap::UnderlineEnd, b"\x1b[24m"),
		(Cap::HorizPos, b"\x1b[%i%p1%dG"),
		(Cap::UpCursor, b"\x1bOA"),
		(Cap::DownCursor, b"\x1bOB"),
		(Cap::LeftCursor, b"\x1bOD"),
		(Cap::RightCursor, b"\x1bOC"),
		(Cap::SaveCursor, b"\x1b7"),
		(Cap::RestrCursor, b"\x1b8"),
		(Cap::FgColour, b"\x1b[%?%p1%{8}%<%t3%p1%d%e%p1%{16}%<%t9%p1%{8}%-%d%e38;5;%p1%d%;m"),
		(Cap::BgColour, b"\x1b[%?%p1%{8}%<%t4%p1%d%e%p1%{16}%<%t10%p1%{8}%-%d%e48;5;%p1%d%;m"),
	];
	for (c, v) in caps {
		s[c as usize] = Some(v.to_vec());
	}
	TermCaps::from_strs(s, [true, true], [24, 80, 256, -1, -1])
}

/// A display, an editor and the terminal they draw on.
struct Screen {
	d:      Display,
	ed:     Editor,
	term:   TermCaps,
	cols:   i32,
	single: bool,
}

impl Screen {
	/// A fresh line (zsh `zleread`) with left prompt `lp`, right prompt
	/// `rp`.
	fn new(lp: &[u8], rp: &[u8], cols: i32) -> Self {
		let mut ed = Editor::new(Context::LineStart, 0);
		ed.lprompt = lp.to_vec();
		ed.rprompt = rp.to_vec();
		let d = Display { resetneeded: true, ..Display::default() };
		Self { d, ed, term: xterm(), cols, single: false }
	}

	/// The refresh input.
	fn input<'a>(ed: &'a Editor, term: &'a TermCaps, cols: i32, single: bool) -> RefreshIn<'a> {
		RefreshIn {
			ed,
			term,
			columns: cols,
			lines: 24,
			singlelinezle: single,
			combiningchars: false,
			transientrprompt: false,
			rprompt_indent: 1,
			zle_highlight: None,
			nearcolor: None,
			pmpt_attr: 0,
			rpmpt_attr: 0,
			vicmd: false,
			isearch: None,
			suffixlen: 0,
			postedit: None,
		}
	}

	/// zsh `zrefresh`: the bytes written.
	fn refresh(&mut self) -> String {
		let mut out = Vec::new();
		let input = Self::input(&self.ed, &self.term, self.cols, self.single);
		zrefresh(&mut self.d, &input, &mut out);
		String::from_utf8(out).expect("refresh output is UTF-8 here")
	}

	/// Set the line and cursor, then refresh.
	fn show(&mut self, line: &str, cs: usize) -> String {
		self.ed.line = line.chars().collect();
		self.ed.cs = cs;
		self.refresh()
	}

	/// zsh `trashzle`: the bytes written.
	fn trash(&mut self) -> String {
		let mut out = Vec::new();
		let input = Self::input(&self.ed, &self.term, self.cols, self.single);
		trashzle(&mut self.d, &input, &mut out);
		String::from_utf8(out).expect("refresh output is UTF-8 here")
	}
}

#[test]
fn typing_deleting_and_moving() {
	let mut s = Screen::new(b"/private/tmp/rr % ", b"", 80);
	assert_eq!(s.refresh(), "\x1b[0m\x1b[27m\x1b[24m\x1b[J/private/tmp/rr % \x1b[K");
	// zleread refreshes again after zle-line-init.
	assert_eq!(s.refresh(), "");
	assert_eq!(s.show("a", 1), "a");
	assert_eq!(s.show("ab", 2), "\x08ab");
	assert_eq!(s.show("a", 1), "\x08\x08a \x08");
	assert_eq!(s.show("a", 0), "\x08");
}

#[test]
fn long_line_wraps_at_80_columns() {
	let text = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnop";
	let mut s = Screen::new(b"% ", b"", 80);
	assert_eq!(s.refresh(), "\x1b[0m\x1b[27m\x1b[24m\x1b[J% \x1b[K");
	for k in 1..=text.len() {
		let out = s.show(&text[..k], k);
		let want = match k {
			2 => "\x08ab".to_owned(),
			// The line is full: the cursor goes to the next one.
			78 => "p \r\x1b[K".to_owned(),
			_ => text[k - 1..k].to_owned(),
		};
		assert_eq!(out, want, "after {k} characters");
	}
	let q = format!("{text}q");
	assert_eq!(s.show(&q, 79), "q");
	assert_eq!(s.show(text, 78), "\r\x1b[K");
	assert_eq!(s.show(&text[..77], 77), "\x1b[A\x1b[79C\x1b[K\x1b[1B\r\x1b[K\x1b[A\x1b[79C");
	assert_eq!(s.show(&text[..77], 0), "\x1b[77D");
	assert_eq!(s.show(&text[1..77], 0), "\x1b[P\x1b[76C \x1b[77D");
	assert_eq!(s.show(&text[1..77], 76), "\x1b[76C");
}

#[test]
fn rprompt_and_region() {
	let mut s = Screen::new(b"% ", b"R%", 80);
	assert_eq!(s.refresh(), "\x1b[0m\x1b[27m\x1b[24m\x1b[J% \x1b[K\x1b[75CR%\x1b[77D");
	assert_eq!(s.show("a", 1), "a");
	assert_eq!(s.show("ab", 2), "\x08ab");
	assert_eq!(s.show("abc", 3), "c");
	// set-mark-command: an empty region.
	s.ed.region_active = 1;
	s.ed.mark = 3;
	assert_eq!(s.refresh(), "");
	assert_eq!(s.show("abc", 2), "\x08\x1b[7mc\x1b[27m\x08");
	assert_eq!(s.show("abc", 1), "\x08\x08a\x1b[7mb\x08");
	assert_eq!(s.show("abc", 2), "\x08\x1b[27ma\x1b[27mb");
}

#[test]
fn rprompt_removed_when_the_line_reaches_it() {
	let mut s = Screen::new(b"% ", b"R", 10);
	assert_eq!(
		s.refresh(),
		"\x1b[0m\x1b[27m\x1b[24m\x1b[J% \x1b[K\x1b[6CR\x08\x08\x08\x08\x08\x08\x08"
	);
	assert_eq!(s.show("a", 1), "a");
	assert_eq!(s.show("ab", 2), "\x08ab");
	assert_eq!(s.show("abc", 3), "c");
	assert_eq!(s.show("abcd", 4), "d");
	assert_eq!(s.show("abcde", 5), "e");
	assert_eq!(s.show("abcdef", 6), "f\x1b[K");
	assert_eq!(s.show("abcdefg", 7), "g");
	assert_eq!(s.show("abcdef", 6), "\x08 \x08");
	assert_eq!(s.show("abcde", 5), "\x08\x1b[K\x1b[1CR\x08\x08");
	assert_eq!(s.show("abcd", 4), "\x08 \x08");
}

#[test]
fn rprompt_cleared_by_backward_kill_word() {
	let mut s = Screen::new(b"% ", b"R", 10);
	s.refresh();
	assert_eq!(s.show("a", 1), "a");
	assert_eq!(s.show("ab", 2), "\x08ab");
	assert_eq!(s.show("", 0), "\x08\x08  \x08\x08");
}

#[test]
fn region_highlight_entries_and_trashed_display() {
	let mut s = Screen::new(b"% ", b"", 80);
	s.refresh();
	s.show("a", 1);
	s.show("ab", 2);
	s.show("abc", 3);
	// `region_highlight=('0 2 fg=red,bold' 'P1 3 underline memo=x')`, the
	// second entry stretched by the `d` inserted at its end.
	s.ed.region_highlights = vec![
		RegionHighlight {
			start: 0,
			end:   2,
			atr:   TXTFGCOLOUR | (1 << TXT_ATTR_FG_COL_SHIFT) | TXTBOLDFACE,
			flags: 0,
			memo:  None,
		},
		RegionHighlight {
			start: 1,
			end:   4,
			atr:   TXTUNDERLINE,
			flags: ZRH_PREDISPLAY,
			memo:  Some(BString::from("x")),
		},
	];
	assert_eq!(
		s.show("abcd", 4),
		"\x08\x08\x08\x1b[1m\x1b[31ma\x1b[1m\x1b[4m\x1b[31mb\x1b[0m\x1b[39m\x1b[4mc\x1b[4md\x1b[24m"
	);
	// `zle -M`: the display is given up below the line …
	assert_eq!(s.trash(), "\r\n");
	assert_eq!(s.trash(), "");
	// … and with ALWAYS_LAST_PROMPT redrawn over the prompt.
	s.d.clearflag = true;
	assert_eq!(
		s.refresh(),
		concat!(
			"\x1b[0m\x1b[27m\x1b[24m\r\x1b[2C\x1b[1m\x1b[31ma\x1b[1m",
			"\x1b[4m\x1b[31mb\x1b[0m\x1b[39m\x1b[4mcd\x1b[24m\x1b[K",
		)
	);
	s.ed.region_highlights[1].end = 5;
	assert_eq!(s.show("abcde", 5), "\x08\x1b[4md\x1b[4me\x1b[24m");
}

#[test]
fn invalidated_display_is_redrawn() {
	let mut s = Screen::new(b"% ", b"", 80);
	s.refresh();
	s.show("a", 1);
	s.show("ab", 2);
	assert_eq!(s.show("ab", 1), "\x08");
	// `zle -I`.
	assert_eq!(s.trash(), "\r\n");
	assert_eq!(s.refresh(), "\x1b[0m\x1b[27m\x1b[24m\x1b[J% ab\x1b[K\x08");
	assert_eq!(s.show("acb", 2), "\x08acb\x08");
}

#[test]
fn single_line_zle_scrolls_horizontally() {
	let text = "abcdefghijklmnopqrstuvw";
	let mut s = Screen::new(b"% ", b"", 20);
	s.single = true;
	assert_eq!(s.refresh(), "\x1b[J% ");
	for k in 1..=text.len() {
		let want = if k == 17 {
			"\r<jklmnopq\x1b[K"
		} else {
			&text[k - 1..k]
		};
		assert_eq!(s.show(&text[..k], k), want, "after {k} characters");
	}
	assert_eq!(s.show(text, 0), "\r% abcdefghijklmnop>\x1b[17D");
	assert_eq!(s.show(&text[1..], 0), "bcdefghijklmnopq\x1b[16D");
}

#[test]
fn region_highlight_values_round_trip() {
	let term = xterm();
	let vals: Vec<BString> = [
		"P1 3 fg=red,underline memo=x,y",
		"0 20 bold",
		"2 4 fg=#ff0000",
		" 5 6 fg=200,bg=default",
		"x",
		"P -3 +4 none,standout bg=blue memo=",
		"7 8 fg=300,bold",
		"1 2 fg=#abc",
		"3 4 underline,none,bold",
	]
	.into_iter()
	.map(BString::from)
	.collect();
	let rh = set_region_highlight(Some(&vals), &term, None);
	let got: Vec<String> = get_region_highlight(&rh)
		.iter()
		.map(ToString::to_string)
		.collect();
	assert_eq!(got, [
		"P1 3 fg=red,underline memo=x",
		"0 20 bold",
		"2 4 fg=#ff0000",
		"5 6 fg=200",
		"-1 -1 none",
		"P-3 4 standout",
		"7 8 bold",
		"1 2 fg=#aabbcc",
		"3 4 bold",
	]);
	assert!(set_region_highlight(None, &term, None).is_empty());
	assert_eq!(output_highlight(TXTSTANDOUT | TXTBOLDFACE), b"bold,standout");
	assert_eq!(output_highlight(0), b"none");
}
