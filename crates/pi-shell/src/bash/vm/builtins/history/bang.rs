//! zsh history expansion (`hist.c` `ihgetc`, `histsubchar`, the `:`
//! modifiers) and quick substitution (`^old^new`), applied to each input
//! line of an interactive shell before it is parsed.
//!
//! zsh expands history characters as its lexer reads them, so what is
//! expanded depends on the lexer's state: nothing inside single quotes,
//! comments or here-document bodies. [`Lex`] follows that state over the
//! characters the lexer is given. Each line read for an event goes through
//! [`expand_line`], which returns the text the parser reads and extends the
//! event's history text (`chline`): there an escaped `\!` keeps its
//! backslash, while the parser sees a plain `!`.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::collections::VecDeque;

use bstr::{BString, ByteSlice};
use serde::{Deserialize, Serialize};

use super::{
	io::{HistOp, HistOut, Pending, Steps},
	model::{HIST_FOREIGN, Hist, inblank},
	words::lex_words,
};
use crate::bash::{
	diag::Diag,
	vm::zsh::{
		modify::{chabspath, convamps},
		text::{CaseMod, casemodify},
	},
};

/// `histdone`: history was expanded on this line.
pub const HISTFLAG_DONE: u8 = 1;
/// `histdone`: the line is not run (`:p`, `histverify`).
pub const HISTFLAG_NOEXEC: u8 = 2;
/// `histdone`: the line goes back to the editor (`histverify`).
pub const HISTFLAG_RECALL: u8 = 4;

/// A quoting context of the lexer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
enum Quote {
	/// `'…'` (history off).
	Single,
	/// `$'…'` (history off; backslash escapes).
	Dollar,
	/// `"…"`.
	Double,
	/// `` `…` ``.
	Tick,
	/// `'…'` inside backquotes (history off).
	TickSingle,
	/// `$(…)` with its open parenthesis depth.
	Paren(u32),
	/// `${…}` with its open brace depth.
	Brace(u32),
}

/// The lexer state history expansion depends on (zsh's `STOPHIST` and
/// `ALLOWHIST` in `lex.c`), followed across the lines of one event.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lex {
	stack:           Vec<Quote>,
	/// The next character is escaped by a backslash.
	esc:             bool,
	/// The last character began no word yet (a `#` would start a comment).
	at_word:         bool,
	/// In a comment (history off; it ends at the newline).
	comment:         bool,
	/// A comment was read (zsh `hist_keep_comment`: a comment-only event
	/// is kept).
	pub had_comment: bool,
	/// The character before the last one fed.
	prev:            u8,
	/// Here-document terminators of the command line, waiting for its
	/// newline: the word and whether leading tabs are stripped (`<<-`).
	pending:         Vec<(BString, bool)>,
	/// Here-document bodies being read, in order (history off).
	bodies:          Vec<(BString, bool)>,
	/// The word after `<<` being read: its text so far and `<<-`; `None`
	/// before its first character.
	heredoc:         Option<(BString, bool, bool)>,
	/// Characters since the last newline (to tell a here-document body's
	/// terminator line).
	line:            BString,
}

impl Lex {
	/// A fresh state at the start of an event.
	pub fn new() -> Self {
		Self { at_word: true, ..Self::default() }
	}

	/// Whether history expansion is off at this point (zsh `stophist`
	/// raised by the lexer).
	pub fn stops(&self) -> bool {
		self.comment
			|| !self.bodies.is_empty()
			|| self
				.stack
				.iter()
				.any(|q| matches!(q, Quote::Single | Quote::Dollar | Quote::TickSingle))
	}

	/// Whether the lexer is between tokens with nothing open (no quote,
	/// escape, here-document): a line read now begins a new command.
	pub const fn idle(&self) -> bool {
		self.stack.is_empty()
			&& !self.esc
			&& !self.comment
			&& self.bodies.is_empty()
			&& self.pending.is_empty()
			&& self.heredoc.is_none()
	}

	/// Whether the next character would start a comment.
	const fn comment_next(&self, comments: bool) -> bool {
		comments && self.at_word && !self.esc && self.stack.is_empty() && self.bodies.is_empty()
	}

	/// Feed one character the lexer reads.
	pub fn feed(&mut self, c: u8, comments: bool) {
		let prev = self.prev;
		self.prev = c;
		if c == b'\n' {
			self.newline();
		} else {
			self.line.push(c);
		}
		if !self.bodies.is_empty() {
			return;
		}
		if self.comment {
			if c == b'\n' {
				self.comment = false;
				self.at_word = true;
			}
			return;
		}
		if self.esc {
			self.esc = false;
			self.at_word = false;
			return;
		}
		if let Some((word, strip, started)) = &mut self.heredoc {
			// The terminator word after `<<`: blanks before it, then up
			// to a blank or an operator (quotes in it are dropped).
			let blank = matches!(c, b' ' | b'\t');
			let op = matches!(c, b'\n' | b';' | b'&' | b'|' | b'<' | b'>' | b'(' | b')');
			let quote = matches!(c, b'\'' | b'"' | b'\\');
			if !*started {
				if c == b'-' && !*strip && prev == b'<' {
					*strip = true;
					return;
				}
				if blank {
					return;
				}
				if !op {
					*started = true;
					if !quote {
						word.push(c);
					}
					return;
				}
				// `<<<` or a missing word: no here-document.
				self.heredoc = None;
			} else if blank || op {
				let done = (std::mem::take(word), *strip);
				self.heredoc = None;
				self.pending.push(done);
			} else {
				if !quote {
					word.push(c);
				}
				return;
			}
		}
		match self.stack.last().copied() {
			Some(Quote::Single) => {
				if c == b'\'' {
					self.stack.pop();
				}
				return;
			},
			Some(Quote::Dollar) => {
				match c {
					b'\\' => self.esc = true,
					b'\'' => {
						self.stack.pop();
					},
					_ => {},
				}
				return;
			},
			Some(Quote::TickSingle) => {
				if c == b'\'' {
					self.stack.pop();
				}
				return;
			},
			Some(Quote::Tick) => {
				match c {
					b'\\' => self.esc = true,
					b'\'' => self.stack.push(Quote::TickSingle),
					b'`' => {
						self.stack.pop();
					},
					_ => {},
				}
				return;
			},
			Some(Quote::Double) => {
				match c {
					b'\\' => self.esc = true,
					b'"' => {
						self.stack.pop();
					},
					b'`' => self.stack.push(Quote::Tick),
					b'(' if prev == b'$' => self.stack.push(Quote::Paren(0)),
					b'{' if prev == b'$' => self.stack.push(Quote::Brace(0)),
					_ => {},
				}
				return;
			},
			_ => {},
		}
		let top = self.stack.last_mut();
		match c {
			b'\\' => self.esc = true,
			b'\'' if prev == b'$' => self.stack.push(Quote::Dollar),
			b'\'' => self.stack.push(Quote::Single),
			b'"' => self.stack.push(Quote::Double),
			b'`' => self.stack.push(Quote::Tick),
			b'(' if prev == b'$' => self.stack.push(Quote::Paren(0)),
			b'{' if prev == b'$' => self.stack.push(Quote::Brace(0)),
			b'(' => {
				if let Some(Quote::Paren(d)) = top {
					*d += 1;
				}
			},
			b')' => match top {
				Some(Quote::Paren(0)) => {
					self.stack.pop();
				},
				Some(Quote::Paren(d)) => *d -= 1,
				_ => {},
			},
			b'{' => {
				if let Some(Quote::Brace(d)) = top {
					*d += 1;
				}
			},
			b'}' => match top {
				Some(Quote::Brace(0)) => {
					self.stack.pop();
				},
				Some(Quote::Brace(d)) => *d -= 1,
				_ => {},
			},
			b'#' if self.at_word && comments && self.stack.is_empty() => {
				self.comment = true;
				self.had_comment = true;
			},
			// `<<` starts a here-document; `<<<` is a here-string.
			b'<' if prev == b'<' && self.stack.is_empty() && !self.line.ends_with(b"<<<") => {
				self.heredoc = Some((BString::default(), false, false));
			},
			_ => {},
		}
		self.at_word =
			matches!(c, b' ' | b'\t' | b'\n' | b';' | b'&' | b'|' | b'(' | b')' | b'{' | b'}');
	}

	/// A newline: a finished command line starts its here-document bodies;
	/// a body line equal to its terminator ends that body.
	fn newline(&mut self) {
		let line = std::mem::take(&mut self.line);
		if let Some((term, strip)) = self.bodies.first() {
			let text: &[u8] = if *strip {
				let tabs = line.iter().take_while(|&&c| c == b'\t').count();
				&line[tabs..]
			} else {
				&line
			};
			if text == term.as_slice() {
				self.bodies.remove(0);
			}
			return;
		}
		if let Some((word, strip, started)) = self.heredoc.take()
			&& started
		{
			self.pending.push((word, strip));
		}
		if self.stack.is_empty() && !self.esc && !self.pending.is_empty() {
			self.bodies = std::mem::take(&mut self.pending);
		}
	}
}

/// The history state of the event being read (zsh's `chline` and the
/// statics of `hist.c` that live from `hbegin` to `hend`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineState {
	/// The history text so far (`chline`), with a newline after each line.
	pub chline:   BString,
	/// `!"` turned history off for the rest of the event (`stophist = 1`).
	pub stop1:    bool,
	/// History is off for this event (`stophist >= 2`: no `banghist`).
	pub disabled: bool,
	/// `histdone` flags.
	pub done:     u8,
	/// The default event (`!!`).
	pub defev:    i64,
	/// `interactivecomments` when the event began.
	pub comments: bool,
	/// History expansion failed: the event is abandoned, [`hend`] is
	/// still to run.
	///
	/// [`hend`]: super::zsh::hend
	pub failed:   bool,
	/// The lexer state.
	pub lex:      Lex,
}

impl LineState {
	/// The words of the text so far.
	pub fn words(&self) -> Vec<u32> {
		lex_words(&self.chline, self.comments)
	}
}

/// Options history expansion reads.
#[derive(Clone, Debug, Default)]
pub struct BangOpts {
	/// `cshjunkiehistory`: `!` alone is the previous event.
	pub cshjunkie:    bool,
	/// `histverify`.
	pub verify:       bool,
	/// `histsubstpattern`: `:s` takes patterns (not supported here).
	pub substpattern: bool,
	/// The shell's working directory (`:a`, `:A`, `:P`).
	pub cwd:          BString,
	/// `$PATH`'s directories, split on the platform's separator (`:c`).
	pub path:         Vec<BString>,
	/// bash's `history_expand` (`history -p`): `!#` on an empty line is
	/// empty.
	pub bash:         bool,
	/// `multibyte` in a UTF-8 locale (`:l`, `:u` case whole characters).
	pub multibyte:    bool,
}

/// A failed expansion: the message zsh prints (none for the silent
/// failures), the event is abandoned.
#[derive(Debug)]
pub struct BangError(pub Option<Diag>, pub Option<BString>);

impl BangError {
	/// bash's message for the failure (`SPEC: event not found`, …), set by
	/// [`expand_line`].
	pub const fn bash(&self) -> Option<&BString> {
		self.1.as_ref()
	}
}

/// Why expansion stopped.
pub enum Stop {
	/// A step needs an answer.
	Pending(Pending),
	/// The expansion failed.
	Error(BangError),
}

impl From<Pending> for Stop {
	fn from(p: Pending) -> Self {
		Self::Pending(p)
	}
}

/// zsh's input stack as history expansion sees it: the characters still to
/// read, each marked when it came from an expansion (`INP_HIST`).
struct Input {
	q:         VecDeque<(u8, bool)>,
	/// The last character read came from an expansion.
	from_hist: bool,
	/// The length of the line read.
	raw_len:   usize,
}

impl Input {
	/// How much of the line has been read.
	fn raw_pos(&self) -> usize {
		self.raw_len - self.q.iter().filter(|&&(_, h)| !h).count()
	}

	fn get(&mut self) -> Option<u8> {
		let (c, h) = self.q.pop_front()?;
		self.from_hist = h;
		Some(c)
	}

	/// `safeinungetc`: put back what was read (nothing at the end).
	fn unget(&mut self, c: Option<u8>) {
		if let Some(c) = c {
			self.q.push_front((c, self.from_hist));
		}
	}

	/// `inpush(…, INP_HIST)`.
	fn push_hist(&mut self, s: &[u8]) {
		for &c in s.iter().rev() {
			self.q.push_front((c, true));
		}
	}
}

/// One line's expansion: zsh `ihgetc` over the line.
struct Run<'a, 'b> {
	h:       &'a mut Hist,
	ls:      &'a mut LineState,
	inp:     Input,
	o:       &'a BangOpts,
	steps:   &'a mut Steps<'b>,
	/// `isfirstch`.
	first:   bool,
	/// `qbang` of the character just read.
	qbang:   bool,
	/// The lexer's text.
	out:     BString,
	/// Where the reference being expanded stands in the line, for bash's
	/// messages.
	marks:   Marks,
	/// ZLE's cursor while it expands its line (`excs`, `exlast`).
	cursor:  Option<(i64, i64)>,
	/// How much of the line was read when the expansion failed (before
	/// `herrflush` took the rest).
	err_pos: Option<usize>,
}

/// Offsets in the line of the history reference being expanded: its start
/// (`!` or `^`), the end of its event, its word designator, its last
/// modifier; whether it is a `^old^new`.
#[derive(Clone, Copy, Debug, Default)]
struct Marks {
	b:   usize,
	e:   usize,
	d:   usize,
	m:   usize,
	hat: bool,
}

/// zsh's error: the message, the event abandoned.
fn fail<T>(msg: impl Into<String>) -> Result<T, Stop> {
	Err(Stop::Error(BangError(Some(Diag::Usage { msg: msg.into().into() }), None)))
}

/// A silent failure (`return -1` without a message).
const fn fail_quietly<T>() -> Result<T, Stop> {
	Err(Stop::Error(BangError(None, None)))
}

/// bash's message (readline `hist_error`) for zsh's `msg` about the
/// reference `marks` locate in `line`, read up to `pos`.
fn bash_message(msg: &str, line: &[u8], marks: Marks, pos: usize) -> BString {
	let span =
		|a: usize, b: usize| BString::from(line.get(a.min(b)..b.min(line.len())).unwrap_or_default());
	let (spec, what) = if msg.starts_with("no such event") || msg.starts_with("event not found") {
		(span(marks.b, marks.e), "event not found")
	} else if msg.starts_with("illegal modifier: ") {
		(
			BString::from(&msg.as_bytes()["illegal modifier: ".len()..]),
			"unrecognized history modifier",
		)
	} else if msg == "substitution failed" {
		let spec = if marks.hat {
			let mut s = BString::from(":s");
			s.extend_from_slice(&span(marks.b, pos));
			s
		} else {
			span(marks.m, pos)
		};
		(spec, "substitution failed")
	} else if msg == "no previous substitution" {
		(span(marks.m, pos), "no previous substitution")
	} else {
		(span(marks.d, pos), "bad word specifier")
	};
	let mut out = spec;
	out.extend_from_slice(b": ");
	out.extend_from_slice(what.as_bytes());
	out
}

/// Expand the history references in `line` (one input line, with its
/// newline unless it is the last of the input), the next line of the event
/// `h.curline` is reading: the text the parser reads. The history text
/// grows by the line as zsh records it.
///
/// # Errors
/// [`Stop::Pending`] while a filesystem step (`:A`, `:P`, `:c`) has no
/// answer; [`Stop::Error`] when the expansion fails (the history text holds
/// the rest of the line then, as zsh's `herrflush` leaves it).
pub fn expand_line(
	h: &mut Hist,
	line: &[u8],
	o: &BangOpts,
	steps: &mut Steps<'_>,
) -> Result<BString, Stop> {
	let mut ls = h.curline.take().unwrap_or_default();
	let inp = Input {
		q:         line.iter().map(|&c| (c, false)).collect(),
		from_hist: false,
		raw_len:   line.len(),
	};
	let mut run = Run {
		h: &mut *h,
		ls: &mut ls,
		inp,
		o,
		steps,
		first: true,
		qbang: false,
		out: BString::default(),
		marks: Marks::default(),
		cursor: None,
		err_pos: None,
	};
	let mut res = run.line();
	if let Err(Stop::Error(BangError(Some(d), bash))) = &mut res {
		let msg = d.to_string();
		let pos = run.err_pos.unwrap_or_else(|| run.inp.raw_pos());
		*bash = Some(bash_message(&msg, line, run.marks, pos));
	}
	let out = std::mem::take(&mut run.out);
	h.curline = Some(ls);
	res.map(|()| out)
}

impl Run<'_, '_> {
	/// `stophist` now.
	fn stophist(&self) -> u8 {
		if self.ls.disabled {
			4
		} else if self.ls.lex.stops() {
			4 + u8::from(self.ls.stop1)
		} else {
			u8::from(self.ls.stop1)
		}
	}

	const fn bangchar(&self) -> u8 {
		self.h.st.chars[0]
	}

	const fn hatchar(&self) -> u8 {
		self.h.st.chars[1]
	}

	fn line(&mut self) -> Result<(), Stop> {
		loop {
			// A comment is read with `ingetc`: no expansion.
			let comment_next = self.ls.lex.comment_next(self.ls.comments) && self.peek() == Some(b'#');
			if self.ls.lex.comment || comment_next {
				let Some(c) = self.inp.get() else {
					return Ok(());
				};
				self.addtoline(c);
				self.ls.chline.push(c);
				self.out.push(c);
				self.ls.lex.feed(c, self.ls.comments);
				continue;
			}
			let Some(c) = self.ihgetc()? else {
				return Ok(());
			};
			// `ihwaddc`.
			if c == self.bangchar() && self.stophist() < 2 && self.qbang {
				if let Some((_, exlast)) = &mut self.cursor {
					*exlast -= 1;
				}
				self.addtoline(b'\\');
				self.ls.chline.push(b'\\');
				// bash leaves the backslash to quote removal.
				if self.o.bash {
					self.out.push(b'\\');
				}
			}
			self.addtoline(c);
			self.ls.chline.push(c);
			self.out.push(c);
			self.ls.lex.feed(c, self.ls.comments);
		}
	}

	/// zsh `iaddtoline` (`expanding`): move the ZLE cursor as the line
	/// grows past the input it replaces (`excs`, `exlast`).
	fn addtoline(&mut self, _c: u8) {
		let cs = self.ls.chline.len() as i64;
		let inbufct = self.inp.q.len() as i64;
		if let Some((excs, exlast)) = &mut self.cursor {
			if *excs > cs {
				*excs += 1 + inbufct - *exlast;
				if *excs < cs {
					*excs = cs;
				}
			}
			*exlast = inbufct;
		}
	}

	fn peek(&self) -> Option<u8> {
		self.inp.q.front().map(|&(c, _)| c)
	}

	/// zsh `ihgetc`; `None` at the end of the line.
	fn ihgetc(&mut self) -> Result<Option<u8>, Stop> {
		let Some(mut c) = self.inp.get() else {
			return Ok(None);
		};
		self.qbang = false;
		let stop = self.stophist();
		if stop == 0 && !self.inp.from_hist {
			match self.histsubchar(c)? {
				Some(ch) => c = ch,
				None => return Ok(None),
			}
		}
		let stop = self.stophist();
		if self.inp.from_hist && stop == 0 {
			self.qbang = false;
			if c == b'\\' {
				let next = self.inp.get();
				if next == Some(self.bangchar()) {
					self.qbang = true;
					c = self.bangchar();
				} else {
					self.inp.unget(next);
					self.inp.from_hist = true;
					c = b'\\';
				}
			}
		} else if stop != 0 || self.inp.from_hist {
			self.qbang = c == self.bangchar() && stop < 2;
		}
		Ok(Some(c))
	}

	/// zsh `herrflush`: drop pending expansion text, add the rest of the
	/// line to the history text.
	fn herrflush(&mut self) {
		if self.err_pos.is_none() {
			self.err_pos = Some(self.inp.raw_pos());
		}
		while self.inp.q.front().is_some_and(|&(_, h)| h) {
			self.inp.q.pop_front();
		}
		while let Some((c, _)) = self.inp.q.pop_front() {
			self.ls.chline.push(c);
		}
	}

	/// The event at `ev` (zsh `gethist`), else `no such event`.
	fn gethist(&mut self, ev: i64) -> Result<usize, Stop> {
		if let Some(i) = self.h.gethistent(ev, 0) {
			Ok(i)
		} else {
			self.herrflush();
			fail(format!("no such event: {ev}"))
		}
	}

	/// The text of ring position `i` (the line being read: the history
	/// text so far, zsh `checkcurline`).
	fn event_text(&self, i: usize) -> BString {
		if i < self.h.entries.len() {
			self.h.entries[i].text.clone()
		} else {
			self.ls.chline.clone()
		}
	}

	/// The words of ring position `i`.
	fn event_words(&self, i: usize) -> Vec<u32> {
		if i < self.h.entries.len() {
			self.h.entries[i].words().into_owned()
		} else {
			self.ls.words()
		}
	}

	/// zsh `getargc`.
	fn getargc(&self, i: usize) -> i64 {
		let n = self.event_words(i).len() / 2;
		n.saturating_sub(1) as i64
	}

	/// zsh `getargs`: words `a1..=a2` of event `i`.
	fn getargs(&mut self, i: usize, a1: i64, a2: i64) -> Result<BString, Stop> {
		let words = self.event_words(i);
		let nwords = (words.len() / 2) as i64;
		if self.o.bash && nwords == 0 && a1 == 0 {
			return Ok(BString::default());
		}
		if a2 < a1 || a1 >= nwords || a2 >= nwords || a1 < 0 {
			self.herrflush();
			return fail("no such word in event");
		}
		let text = self.event_text(i);
		if a1 == 0 && a2 == nwords - 1 {
			return Ok(text);
		}
		let p1 = words[2 * a1 as usize] as usize;
		let p2 = words[2 * a2 as usize + 1] as usize;
		Ok(BString::from(text.get(p1..p2.min(text.len())).unwrap_or_default()))
	}

	/// zsh `hdynread2`: up to `stop` or a newline (put back), `\` quoting
	/// the next character.
	fn hdynread2(&mut self, stop: Option<u8>) -> BString {
		let mut buf = BString::default();
		loop {
			let c = self.inp.get();
			match c {
				None => break,
				Some(c) if Some(c) == stop => break,
				Some(b'\n') => {
					self.inp.unget(Some(b'\n'));
					break;
				},
				Some(b'\\') => {
					if let Some(n) = self.inp.get() {
						buf.push(n);
					}
				},
				Some(c) => buf.push(c),
			}
		}
		buf
	}

	/// zsh `getsubsargs`: `/l/r/` (delimiter first) into `hsubl`/`hsubr`;
	/// `gbal` set by a following `:G`, `cflag` by a `:` before another
	/// modifier.
	fn getsubsargs(&mut self, gbal: &mut bool, cflag: &mut bool) {
		let del = self.inp.get();
		let l = self.hdynread2(del);
		let r = self.hdynread2(del);
		if !l.is_empty() {
			self.h.st.hsubl = Some(l);
		} else if self.h.st.hsubl.is_none() {
			return;
		}
		self.h.st.hsubr = Some(r);
		let follow = self.inp.get();
		if follow == Some(b':') {
			let next = self.inp.get();
			if next == Some(b'G') {
				*gbal = true;
			} else {
				self.inp.unget(next);
				*cflag = true;
			}
		} else {
			self.inp.unget(follow);
		}
	}

	/// zsh `subst`: replace `hsubl` by `hsubr` (all with `gbal`); `false`
	/// when it does not occur.
	fn subst(&self, s: &mut BString, gbal: bool) -> Result<bool, Stop> {
		if self.o.substpattern {
			let d = Diag::Unsupported { what: "histsubstpattern in history substitution".into() };
			return Err(Stop::Error(BangError(Some(d), None)));
		}
		let (Some(l), Some(r)) = (self.h.st.hsubl.clone(), self.h.st.hsubr.clone()) else {
			return Ok(false);
		};
		let (inp, gbal) = if l.is_empty() {
			(s.clone(), false)
		} else {
			(l, gbal)
		};
		let Some(first) = s.find(&inp) else {
			return Ok(false);
		};
		let rep = convamps(&r, &inp);
		let mut out = BString::from(&s[..first]);
		out.extend_from_slice(&rep);
		let mut i = first + inp.len();
		if gbal && !inp.is_empty() {
			while let Some(p) = s[i..].find(&inp) {
				out.extend_from_slice(&s[i..i + p]);
				out.extend_from_slice(&rep);
				i += p + inp.len();
			}
		}
		out.extend_from_slice(&s[i..]);
		*s = out;
		Ok(true)
	}

	/// zsh `substfailed`.
	fn substfailed<T>(&mut self) -> Result<T, Stop> {
		self.herrflush();
		fail("substitution failed")
	}

	/// zsh `getargspec`: a word number (`-1`: none given, `-2`: error).
	fn getargspec(&mut self, argc: i64, marg: i64, evset: i64) -> Result<i64, Stop> {
		let c = self.inp.get();
		Ok(match c {
			Some(b'0') => 0,
			Some(d) if d.is_ascii_digit() => {
				let mut ret: i64 = 0;
				let mut c = Some(d);
				while let Some(d) = c.filter(u8::is_ascii_digit) {
					ret = ret.saturating_mul(10).saturating_add(i64::from(d - b'0'));
					c = self.inp.get();
				}
				self.inp.unget(c);
				ret
			},
			Some(b'^') => 1,
			Some(b'$') => argc,
			Some(b'%') => {
				if evset != 0 {
					self.herrflush();
					return fail("Ambiguous history reference");
				}
				if marg == -1 {
					self.herrflush();
					return fail("% with no previous word matched");
				}
				marg
			},
			c => {
				self.inp.unget(c);
				-1
			},
		})
	}

	/// zsh `digitcount`.
	fn digitcount(&mut self) -> usize {
		let mut c = self.inp.get();
		let mut count = 0usize;
		while let Some(d) = c.filter(u8::is_ascii_digit) {
			count = count
				.saturating_mul(10)
				.saturating_add(usize::from(d - b'0'));
			c = self.inp.get();
		}
		self.inp.unget(c);
		count
	}

	/// zsh `hconsearch`: the newest older event containing `s`, and the
	/// word it starts in.
	fn hconsearch(&self, s: &[u8]) -> Option<(i64, i64)> {
		let n = self.h.ring_len();
		for i in (0..n.saturating_sub(1)).rev() {
			if self.h.flags_at(i) & HIST_FOREIGN != 0 {
				continue;
			}
			let text = self.h.text_at(i);
			if let Some(pos) = text.find(s) {
				let words = self.h.words_at(i);
				let nw = words.len() / 2;
				let mut t1 = 0;
				while t1 < nw && (words[2 * t1] as usize) <= pos {
					t1 += 1;
				}
				return Some((self.h.num_at(i), t1 as i64 - 1));
			}
		}
		None
	}

	/// zsh `histsubchar`: `c` was read with history on; the character the
	/// lexer gets instead (the first of an expansion), `None` at the end.
	#[allow(clippy::too_many_lines, reason = "a faithful port of one C function")]
	fn histsubchar(&mut self, c: u8) -> Result<Option<u8>, Stop> {
		let bang = self.bangchar();
		let mut cflag = false;
		let mut bflag = false;
		let mut sline: BString;
		if self.first && c == self.hatchar() && c != 0 {
			// `^foo^bar`.
			self.first = false;
			self.inp.unget(Some(c));
			self.marks = Marks { b: self.inp.raw_pos(), hat: true, ..Marks::default() };
			let defev = self.ls.defev;
			let i = self.gethist(defev)?;
			let argc = self.getargc(i);
			sline = self.getargs(i, 0, argc)?;
			let mut gbal = false;
			self.getsubsargs(&mut gbal, &mut cflag);
			if self.h.st.hsubl.is_none() {
				return fail_quietly();
			}
			if !self.subst(&mut sline, gbal)? {
				return self.substfailed();
			}
		} else {
			if c != b' ' {
				self.first = false;
			}
			if c == b'\\' {
				let g = self.inp.get();
				if g == Some(bang) && bang != 0 {
					self.qbang = true;
					return Ok(Some(bang));
				}
				self.inp.unget(g);
			}
			if c != bang || bang == 0 {
				return Ok(Some(c));
			}
			let at = self.inp.raw_pos().saturating_sub(1);
			self.marks = Marks { b: at, e: at, d: at, m: at, hat: false };
			let mut c = self.inp.get();
			if c == Some(b'{') {
				bflag = true;
				cflag = true;
				c = self.inp.get();
			}
			if c == Some(b'"') {
				self.ls.stop1 = true;
				return Ok(self.inp.get());
			}
			let blank = c.is_some_and(inblank);
			if (!cflag && blank) || matches!(c, Some(b'=' | b'(') | None) {
				self.inp.unget(c);
				return Ok(Some(bang));
			}
			cflag = false;
			let mut buf = BString::default();
			let mut evset: i64 = -1;
			let ev: i64;
			let (mut marg, mut mev) = (self.h.st.marg, self.h.st.mev);
			if c == Some(b'?') {
				loop {
					c = self.inp.get();
					match c {
						Some(b'?' | b'\n') | None => break,
						Some(ch) => buf.push(ch),
					}
				}
				self.marks.e = self.inp.raw_pos();
				if c != Some(b'\n') && c.is_some() {
					c = self.inp.get();
				}
				self.h.st.hsubl = Some(buf.clone());
				if let Some((found, m)) = self.hconsearch(&buf) {
					ev = found;
					mev = found;
					marg = m;
				} else {
					mev = -1;
					self.h.st.mev = mev;
					self.herrflush();
					return fail(format!("no such event: {}", buf.as_bstr()));
				}
				evset = 0;
				self.h.st.marg = marg;
				self.h.st.mev = mev;
			} else {
				while let Some(ch) = c {
					let stops = matches!(
						ch,
						b';' | b':' | b'^' | b'$' | b'*' | b'%' | b'}' | b'\'' | b'"' | b'`'
					);
					if inblank(ch) || stops {
						break;
					}
					if !buf.is_empty() {
						if ch == b'-' {
							break;
						}
						if (buf[0].is_ascii_digit() || buf[0] == b'-') && !ch.is_ascii_digit() {
							break;
						}
					}
					buf.push(ch);
					if ch == b'#' || ch == bang {
						c = self.inp.get();
						break;
					}
					c = self.inp.get();
				}
				self.marks.e = self.inp.raw_pos() - usize::from(c.is_some());
				if buf.is_empty() && matches!(c, Some(b'}' | b';' | b'\'' | b'"' | b'`')) {
					// Neither event nor word designator: no expansion.
					self.inp.unget(c);
					return Ok(Some(bang));
				}
				let t0 = zstrtol(&buf);
				if buf.is_empty() {
					if c == Some(b'%') {
						ev = if marg == -1 { self.ls.defev } else { mev };
						evset = 0;
					} else {
						ev = if self.o.cshjunkie {
							self.h.addhistnum(self.h.st.curhist, -1, HIST_FOREIGN)
						} else {
							self.ls.defev
						};
						evset = i64::from(!(c == Some(b':') && evset == -1));
					}
				} else if t0 != 0 {
					ev = if t0 < 0 {
						self.h.addhistnum(self.h.st.curhist, t0, HIST_FOREIGN)
					} else {
						t0
					};
					evset = 1;
				} else if buf[0] == bang {
					ev = self.h.addhistnum(self.h.st.curhist, -1, HIST_FOREIGN);
					evset = 1;
				} else if buf[0] == b'#' {
					ev = self.h.st.curhist;
					evset = 1;
				} else if let Some(i) = self.h.search_up(|t| t.starts_with(buf.as_slice())) {
					ev = self.h.num_at(i);
					evset = 1;
				} else {
					self.herrflush();
					return fail(format!("event not found: {}", buf.as_bstr()));
				}
			}
			// The event.
			self.marks.d = self.marks.e;
			self.ls.defev = ev;
			let mut ehist = self.gethist(ev)?;
			let mut argc = self.getargc(ehist);
			if c == Some(b':') {
				self.marks.d = self.inp.raw_pos().saturating_sub(1);
				cflag = true;
				c = self.inp.get();
				if c == Some(b'%') && marg != -1 {
					if evset == 0 {
						self.ls.defev = mev;
						ehist = self.gethist(mev)?;
						argc = self.getargc(ehist);
					} else {
						self.herrflush();
						return fail("ambiguous history reference");
					}
				}
			}
			let farg: i64;
			let mut larg: i64;
			if c == Some(b'*') {
				farg = 1;
				larg = argc;
				cflag = false;
			} else {
				self.inp.unget(c);
				let f = self.getargspec(argc, marg, evset)?;
				larg = f;
				if f != -1 {
					cflag = false;
				}
				let c2 = self.inp.get();
				if c2 == Some(b'*') {
					cflag = false;
					larg = argc;
				} else if c2 == Some(b'-') {
					cflag = false;
					larg = self.getargspec(argc, marg, evset)?;
					if larg == -1 {
						larg = argc - 1;
					}
				} else {
					self.inp.unget(c2);
				}
				farg = if f == -1 { 0 } else { f };
			}
			if larg == -1 {
				larg = argc;
			}
			sline = self.getargs(ehist, farg, larg)?;
		}
		self.modifiers(&mut sline, cflag, bflag)?;
		// Push the expansion as input and read its first character.
		self.inp.push_hist(&sline);
		self.ls.done |= HISTFLAG_DONE;
		if self.o.verify {
			self.ls.done |= HISTFLAG_NOEXEC | HISTFLAG_RECALL;
		}
		Ok(self.inp.get())
	}

	/// The `:` modifiers of `histsubchar` (and the `}` of `!{…}`).
	fn modifiers(&mut self, sline: &mut BString, mut cflag: bool, bflag: bool) -> Result<(), Stop> {
		loop {
			let c = if cflag { Some(b':') } else { self.inp.get() };
			if c == Some(b':') {
				self.marks.m = self.inp.raw_pos().saturating_sub(usize::from(!cflag));
			}
			cflag = false;
			if c != Some(b':') {
				if c != Some(b'}') || !bflag {
					self.inp.unget(c);
				}
				if c != Some(b'}') && bflag {
					return fail("'}' expected");
				}
				return Ok(());
			}
			let mut gbal = false;
			let mut c = self.inp.get();
			if c == Some(b'g') {
				gbal = true;
				c = self.inp.get();
				if !matches!(c, Some(b's' | b'&')) {
					return fail("'s' or '&' modifier expected after 'g'");
				}
			}
			if self.o.bash && matches!(c, Some(b'a' | b'A' | b'c' | b'P' | b'l' | b'u' | b'Q')) {
				self.herrflush();
				let shown = c.map_or_else(String::new, |c| char::from(c).to_string());
				return fail(format!("illegal modifier: {shown}"));
			}
			match c {
				Some(b'p') => self.ls.done = HISTFLAG_DONE | HISTFLAG_NOEXEC,
				Some(b'a') => *sline = BString::from(chabspath(sline, &self.o.cwd)),
				Some(b'A') => {
					let abs = chabspath(sline, &self.o.cwd);
					*sline = BString::from(self.realpath_prefix(abs)?);
				},
				Some(b'c') => {
					if let Some(p) = self.which(sline)? {
						*sline = p;
					} else {
						self.herrflush();
						return fail("modifier failed: c");
					}
				},
				Some(b'h') => {
					let n = self.digitcount();
					if !remtpath(sline, n) {
						self.herrflush();
						return fail("modifier failed: h");
					}
				},
				Some(b'e') => {
					if !rembutext(sline) {
						self.herrflush();
						return fail("modifier failed: e");
					}
				},
				Some(b'r') => {
					if !remtext(sline) {
						self.herrflush();
						return fail("modifier failed: r");
					}
				},
				Some(b't') => {
					let n = self.digitcount();
					if !remlpaths(sline, n) {
						self.herrflush();
						return fail("modifier failed: t");
					}
				},
				Some(b's' | b'&') => {
					if c == Some(b's') {
						self.getsubsargs(&mut gbal, &mut cflag);
					}
					if self.h.st.hsubl.is_some() && self.h.st.hsubr.is_some() {
						if !self.subst(sline, gbal)? {
							return self.substfailed();
						}
					} else {
						self.herrflush();
						return fail("no previous substitution");
					}
				},
				Some(b'q') => *sline = quote(sline),
				Some(b'Q') => *sline = unquote(sline),
				Some(b'x') => *sline = quotebreak(sline),
				Some(b'l') => {
					*sline = BString::from(casemodify(sline, CaseMod::Lower, self.o.multibyte));
				},
				Some(b'u') => {
					*sline = BString::from(casemodify(sline, CaseMod::Upper, self.o.multibyte));
				},
				Some(b'P') => {
					let abs = if sline.first() == Some(&b'/') {
						sline.to_vec()
					} else {
						let mut p = self.o.cwd.to_vec();
						if !p.ends_with(b"/") {
							p.push(b'/');
						}
						p.extend_from_slice(sline);
						p
					};
					*sline = BString::from(self.realpath_prefix(abs)?);
				},
				other => {
					self.herrflush();
					let shown = other.map_or_else(String::new, |c| char::from(c).to_string());
					return fail(format!("illegal modifier: {shown}"));
				},
			}
		}
	}

	/// zsh `chrealpath`: the longest prefix of the absolute `s` ending at a
	/// `/` that resolves, resolved, with the rest appended.
	fn realpath_prefix(&mut self, s: Vec<u8>) -> Result<Vec<u8>, Stop> {
		if s.first() != Some(&b'/') {
			return Ok(s);
		}
		let mut cut = s.len();
		loop {
			if cut > 0 {
				let head = BString::from(&s[..cut]);
				if let Ok(HistOut::Bytes(real)) = self.steps.ask(HistOp::RealPath { path: head })? {
					let mut out = real.to_vec();
					out.extend_from_slice(&s[cut..]);
					return Ok(out);
				}
			}
			if cut == 0 {
				return Ok(s);
			}
			cut = s[..cut].iter().rposition(|&c| c == b'/').unwrap_or(0);
		}
	}

	/// zsh `equalsubstr` for `:c`: the path of command `name` on `$PATH`.
	fn which(&mut self, name: &[u8]) -> Result<Option<BString>, Stop> {
		if name.contains(&b'/') {
			return Ok(None);
		}
		for dir in self.o.path.clone() {
			let mut p = if dir.is_empty() {
				self.o.cwd.clone()
			} else {
				dir
			};
			if !p.ends_with(b"/") {
				p.push(b'/');
			}
			p.extend_from_slice(name);
			if let Ok(HistOut::Stat(st)) = self
				.steps
				.ask(HistOp::Stat { path: p.clone(), follow: true })?
				&& st.kind == crate::bash::fs::StatKind::File
				&& st.mode & 0o111 != 0
			{
				return Ok(Some(p));
			}
		}
		Ok(None)
	}
}

/// C `zstrtol(s, NULL, 10)`: an optional sign and leading digits.
fn zstrtol(s: &[u8]) -> i64 {
	let (neg, digits) = match s.first() {
		Some(b'-') => (true, &s[1..]),
		Some(b'+') => (false, &s[1..]),
		_ => (false, s),
	};
	let n = digits
		.iter()
		.take_while(|c| c.is_ascii_digit())
		.fold(0_i64, |n, &c| n.wrapping_mul(10).wrapping_add(i64::from(c - b'0')));
	if neg { -n } else { n }
}

/// zsh `remtpath` (`:h`, `:hN`); `false` when nothing is left (the text
/// becomes `/` or `.`).
pub fn remtpath(s: &mut BString, count: usize) -> bool {
	let n = s.len();
	// `str`: index of the last character examined, `None` before the start.
	let mut end = n;
	while end > 0 && s[end - 1] == b'/' {
		end -= 1;
	}
	if count == 0 {
		while end > 0 && s[end - 1] != b'/' {
			end -= 1;
		}
	}
	if end == 0 {
		*s = BString::from(if s.first() == Some(&b'/') { "/" } else { "." });
		return false;
	}
	if count > 0 {
		let mut left = count;
		let mut p = 0;
		// zsh: `while (strp < str)`, `str` the last character kept.
		while p < end - 1 {
			if s[p] == b'/' {
				left -= 1;
				if left == 0 {
					let cut = if p == 0 { 1 } else { p };
					s.truncate(cut);
					return true;
				}
				while s.get(p + 1) == Some(&b'/') {
					p += 1;
				}
			}
			p += 1;
		}
		return true;
	}
	// `end` is just past the separator before the last component.
	let mut cut = end - 1;
	while cut > 0 && s[cut - 1] == b'/' {
		cut -= 1;
	}
	if cut == 0 {
		cut = 1;
		if s.get(1) == Some(&b'/') && s.get(2) != Some(&b'/') {
			cut = 2;
		}
	}
	s.truncate(cut);
	true
}

/// zsh `remtext` (`:r`).
pub fn remtext(s: &mut BString) -> bool {
	for i in (0..s.len()).rev() {
		match s[i] {
			b'/' => return false,
			b'.' => {
				s.truncate(i);
				return true;
			},
			_ => {},
		}
	}
	false
}

/// zsh `rembutext` (`:e`).
pub fn rembutext(s: &mut BString) -> bool {
	for i in (0..s.len()).rev() {
		match s[i] {
			b'/' => break,
			b'.' => {
				*s = BString::from(&s[i + 1..]);
				return true;
			},
			_ => {},
		}
	}
	s.clear();
	false
}

/// zsh `remlpaths` (`:t`, `:tN`).
pub fn remlpaths(s: &mut BString, count: usize) -> bool {
	if s.is_empty() {
		return false;
	}
	let mut count = count as i64;
	// `str`: index of the character examined (may go to -1).
	let mut i = s.len() as i64 - 1;
	if s[i as usize] == b'/' {
		while i >= 0 && s[i as usize] == b'/' {
			i -= 1;
		}
		s.truncate((i + 1) as usize);
	}
	loop {
		while i >= 0 {
			if s[i as usize] == b'/' {
				count -= 1;
				if count > 0 {
					if i > 0 {
						i -= 1;
						break;
					}
					return true;
				}
				*s = BString::from(&s[i as usize + 1..]);
				return true;
			}
			i -= 1;
		}
		while i >= 0 && s[i as usize] == b'/' {
			i -= 1;
		}
		if i <= 0 {
			break;
		}
	}
	false
}

/// zsh `doexpandhist` (ZLE `expand-history`, `magic-space`): the history
/// references of the edited line `line` (no newline) expanded as a fresh
/// event of `h` would be, with the cursor `cs` moved along; `None` when
/// nothing changed. Only the expansion's globals (`:s` strings, the last
/// `!?str?` match) stay in `h`; the caller commits them.
///
/// # Errors
/// As [`expand_line`].
pub fn expand_for_zle(
	h: &mut Hist,
	line: &[u8],
	cs: usize,
	o: &BangOpts,
	steps: &mut Steps<'_>,
) -> Result<Option<(BString, usize)>, Stop> {
	let defev = h
		.curline
		.as_ref()
		.map_or_else(|| h.addhistnum(h.st.curhist, -1, HIST_FOREIGN), |l| l.defev);
	let comments = h.curline.as_ref().is_some_and(|l| l.comments);
	let mut ls = LineState { defev, comments, lex: Lex::new(), ..LineState::default() };
	let inp = Input {
		q:         line.iter().map(|&c| (c, false)).collect(),
		from_hist: false,
		raw_len:   line.len(),
	};
	let mut run = Run {
		h: &mut *h,
		ls: &mut ls,
		inp,
		o,
		steps,
		first: true,
		qbang: false,
		out: BString::default(),
		marks: Marks::default(),
		cursor: Some((cs as i64, line.len() as i64)),
		err_pos: None,
	};
	run.line()?;
	let excs = run.cursor.map_or(0, |c| c.0);
	if ls.chline.as_slice() == line {
		return Ok(None);
	}
	let cs = usize::try_from(excs).unwrap_or(0).min(ls.chline.len());
	Ok(Some((ls.chline, cs)))
}

/// zsh `quote` (`:q`): single-quote the text, quoted blanks kept apart.
pub fn quote(s: &[u8]) -> BString {
	let mut out = BString::from("'");
	let mut inquotes = false;
	for (i, &c) in s.iter().enumerate() {
		if c == b'\'' {
			inquotes = !inquotes;
			out.extend_from_slice(b"'\\''");
		} else if inblank(c) && !inquotes && (i == 0 || s[i - 1] != b'\\') {
			out.push(b'\'');
			out.push(c);
			out.push(b'\'');
		} else {
			out.push(c);
		}
	}
	out.push(b'\'');
	out
}

/// zsh `quotebreak` (`:x`): single-quote each blank-separated word.
pub fn quotebreak(s: &[u8]) -> BString {
	let mut out = BString::from("'");
	for &c in s {
		if c == b'\'' {
			out.extend_from_slice(b"'\\''");
		} else if inblank(c) {
			out.push(b'\'');
			out.push(c);
			out.push(b'\'');
		} else {
			out.push(c);
		}
	}
	out.push(b'\'');
	out
}

/// `:Q`: one level of quoting removed (`\x`, `'…'`, `"…"`, `$'…'`).
pub fn unquote(s: &[u8]) -> BString {
	let mut out = BString::default();
	let mut i = 0;
	while i < s.len() {
		match s[i] {
			b'\\' => {
				if let Some(&c) = s.get(i + 1) {
					out.push(c);
				}
				i += 2;
			},
			b'\'' => {
				i += 1;
				while i < s.len() && s[i] != b'\'' {
					out.push(s[i]);
					i += 1;
				}
				i += 1;
			},
			b'"' => {
				i += 1;
				while i < s.len() && s[i] != b'"' {
					if s[i] == b'\\' && matches!(s.get(i + 1), Some(b'$' | b'`' | b'"' | b'\\' | b'\n'))
					{
						i += 1;
					}
					if let Some(&c) = s.get(i) {
						out.push(c);
					}
					i += 1;
				}
				i += 1;
			},
			c => {
				out.push(c);
				i += 1;
			},
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::vm::builtins::history::model::Entry;

	fn hist(events: &[&str]) -> Hist {
		let mut h = Hist::default();
		h.st.histsiz = 100;
		for e in events {
			let i = h.prepnext(false);
			h.events_mut()[i].text = BString::from(*e);
			h.events_mut()[i].words = lex_words(e.as_bytes(), false);
			h.addhistnode(i);
		}
		h
	}

	/// One event of `lines` read by `h` (zsh `hbegin` … `hend`): the parser's
	/// text and the history text, or the error message.
	fn event(h: &mut Hist, lines: &[&str]) -> Result<(String, String), String> {
		h.st.curhist += 1;
		h.st.histactive = super::super::model::HA_ACTIVE;
		h.st.linked = true;
		let defev = h.addhistnum(h.st.curhist, -1, HIST_FOREIGN);
		h.curline = Some(LineState { defev, lex: Lex::new(), ..LineState::default() });
		let mut out = String::new();
		let o = BangOpts::default();
		let none = |_: &crate::bash::vm::proc::Probe| None;
		let mut steps = Steps::new(&none, 0);
		for l in lines {
			match expand_line(h, l.as_bytes(), &o, &mut steps) {
				Ok(t) => out.push_str(&t.to_str_lossy()),
				Err(Stop::Error(BangError(d, _))) => {
					h.st.curhist -= 1;
					h.st.linked = false;
					return Err(d.map_or_else(String::new, |d| d.to_string()));
				},
				Err(Stop::Pending(_)) => panic!("no I/O expected"),
			}
		}
		let ls = h.curline.take().unwrap();
		h.st.curhist -= 1;
		h.st.linked = false;
		let text = ls.chline.to_str_lossy().trim_end_matches('\n').to_owned();
		let i = h.prepnext(false);
		h.events_mut()[i] = Entry {
			text: text.clone().into(),
			num: h.st.curhist,
			words: lex_words(text.as_bytes(), false),
			..Entry::default()
		};
		Ok((out, text))
	}

	/// Goldens: zsh 5.9 `-i` reading the lines from a pipe.
	#[test]
	fn designators_and_modifiers() {
		let mut h = hist(&["echo a b c"]);
		assert_eq!(event(&mut h, &["!!\n"]).unwrap().0, "echo a b c\n");
		assert_eq!(event(&mut h, &["echo !$ !^\n"]).unwrap().0, "echo c a\n");
		assert_eq!(event(&mut h, &["!-2:s/a/X/\n"]).unwrap().0, "echo X b c\n");
		assert_eq!(event(&mut h, &["echo !#\n"]).unwrap().0, "echo echo \n");
		assert_eq!(event(&mut h, &["^b^Q\n"]), Err("substitution failed".into()));
	}

	#[test]
	fn quoting_rules() {
		let mut h = hist(&["echo 'a!!'"]);
		let (out, text) = event(&mut h, &["echo \"b!!\" \\!! c!\n"]).unwrap();
		assert_eq!(out, "echo \"becho 'a!!'\" !! c!\n");
		assert_eq!(text, "echo \"becho 'a!!'\" \\!! c!");
		let (out, _) = event(&mut h, &["echo '!!' $'!!' !\"!!\n"]).unwrap();
		assert_eq!(out, "echo '!!' $'!!' !!\n");
	}

	#[test]
	fn errors() {
		let mut h = hist(&["echo a b"]);
		assert_eq!(event(&mut h, &["!foo\n"]), Err("event not found: foo".into()));
		assert_eq!(event(&mut h, &["!!:3\n"]), Err("no such word in event".into()));
		assert_eq!(event(&mut h, &["!!:z\n"]), Err("illegal modifier: z".into()));
		assert_eq!(event(&mut h, &["!?zz?\n"]), Err("no such event: zz".into()));
	}

	#[test]
	fn path_modifiers() {
		let mut s = BString::from("/a/b/c.tar.gz");
		assert!(remtpath(&mut s, 0));
		assert_eq!(s, "/a/b");
		let mut s = BString::from("c.tar.gz");
		assert!(remtext(&mut s));
		assert_eq!(s, "c.tar");
		let mut s = BString::from("x");
		assert!(!remtpath(&mut s, 0));
		assert_eq!(s, ".");
		let mut s = BString::from("/a/b/c");
		assert!(remlpaths(&mut s, 0));
		assert_eq!(s, "c");
		assert_eq!(quote(b"a b'c"), "'a' 'b'\\''c'");
	}
}
