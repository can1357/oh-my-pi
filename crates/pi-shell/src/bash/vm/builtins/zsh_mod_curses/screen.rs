//! The window model behind `zcurses`: ncurses' `WINDOW`s (cells with
//! attributes and a color pair, a cursor, per-line change marks,
//! subwindows sharing their parent's cells), the virtual screen
//! `wnoutrefresh` composes and the update that brings the terminal from
//! what it shows (`curscr`) to it, written with the terminal's terminfo
//! capabilities.
//!
//! Ported from the parts of ncurses 6 zsh 5.9's `Src/Modules/curses.c`
//! calls (`newwin`, `subwin`, `waddch`, `wborder`, `wbkgd`, `wscrl`,
//! `wnoutrefresh`, `doupdate`, `endwin`, …); the update uses absolute cursor
//! addressing rather than ncurses' cost-optimized movement, so the screen
//! (not every byte) matches.

use bstr::BString;
use serde::{Deserialize, Serialize};

use crate::bash::vm::zsh::{
	terminfo_db::{TParm, TermInfo, tparm, tputs},
	wcwidth::wcwidth,
};

/// `A_BLINK`.
pub const A_BLINK: u16 = 1;
/// `A_BOLD`.
pub const A_BOLD: u16 = 1 << 1;
/// `A_DIM`.
pub const A_DIM: u16 = 1 << 2;
/// `A_REVERSE`.
pub const A_REVERSE: u16 = 1 << 3;
/// `A_STANDOUT`.
pub const A_STANDOUT: u16 = 1 << 4;
/// `A_UNDERLINE`.
pub const A_UNDERLINE: u16 = 1 << 5;
/// `A_ALTCHARSET`: the character is a VT100 line-drawing code (`ACS_*`).
pub const A_ALTCHARSET: u16 = 1 << 6;

/// One cell: a character (0: the right half of a double-width one), its
/// attributes and color pair.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cell {
	/// The character's code point; 0 for a wide character's second column.
	pub ch:    u32,
	/// `A_*` bits.
	pub attrs: u16,
	/// Color pair.
	pub pair:  i16,
}

impl Cell {
	/// A blank without attributes.
	pub const BLANK: Self = Self { ch: ' ' as u32, attrs: 0, pair: 0 };

	/// The character, if the cell starts one.
	pub const fn char(self) -> Option<char> {
		if self.ch == 0 {
			None
		} else {
			char::from_u32(self.ch)
		}
	}
}

/// The columns `c` takes on the screen (control characters are shown
/// as `^X` by the caller; anything else unprintable takes one).
pub fn width(c: char) -> i32 {
	match wcwidth(c) {
		2 => 2,
		_ => 1,
	}
}

/// A window's cells (a window and its subwindows share one).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Buf {
	/// Its id.
	pub id:    u32,
	/// Lines.
	pub rows:  i32,
	/// Columns.
	pub cols:  i32,
	/// `rows * cols` cells, by line.
	pub cells: Vec<Cell>,
}

/// One window (ncurses `WINDOW` and zsh's `struct zc_win`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Win {
	/// The name `zcurses` knows it by.
	pub name:        BString,
	/// The [`Buf`] holding its cells.
	pub buf:         u32,
	/// Its top left corner in that buffer.
	pub off_y:       i32,
	/// See [`Self::off_y`].
	pub off_x:       i32,
	/// Its top left corner on the screen.
	pub begy:        i32,
	/// See [`Self::begy`].
	pub begx:        i32,
	/// Lines.
	pub rows:        i32,
	/// Columns.
	pub cols:        i32,
	/// The cursor.
	pub cury:        i32,
	/// See [`Self::cury`].
	pub curx:        i32,
	/// The attributes of what is written (`wattron`).
	pub attrs:       u16,
	/// The color pair of what is written (`wcolor_set`).
	pub pair:        i16,
	/// The background (`wbkgd`): what blanks are made of.
	pub bkgd:        Cell,
	/// `scrollok`.
	pub scrollok:    bool,
	/// zsh's `ZCWF_SCROLL`: `zcurses scroll on`.
	pub scroll_flag: bool,
	/// `clearok`: the next refresh clears the screen.
	pub clearok:     bool,
	/// The cursor moved since the last refresh (`_HASMOVED`).
	pub moved:       bool,
	/// `wtimeout`: -1 waits, 0 polls, else milliseconds.
	pub timeout:     i32,
	/// `keypad`.
	pub keypad:      bool,
	/// The window it is a subwindow of.
	pub parent:      Option<BString>,
	/// Its subwindows.
	pub children:    Vec<BString>,
	/// `stdscr` (zsh's `ZCWF_PERMANENT`).
	pub permanent:   bool,
	/// Per line, the first and last changed column (`-1`: unchanged).
	pub touched:     Vec<(i32, i32)>,
}

/// What the terminal shows, or is to show.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Screen {
	/// `lines * cols` cells, by line.
	pub cells: Vec<Cell>,
	/// Cursor line.
	pub y:     i32,
	/// Cursor column.
	pub x:     i32,
}

impl Screen {
	fn blank(lines: i32, cols: i32) -> Self {
		Self { cells: vec![Cell::BLANK; (lines.max(0) * cols.max(0)) as usize], y: 0, x: 0 }
	}
}

/// The state of curses (ncurses' `SCREEN`, its windows, and zsh's tables).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Curses {
	/// `$TERM` when curses started.
	pub term:        BString,
	/// Screen lines (`LINES`).
	pub lines:       i32,
	/// Screen columns (`COLS`).
	pub cols:        i32,
	/// The windows, in creation order (`zcurses_windows`).
	pub wins:        Vec<Win>,
	/// Cell buffers.
	pub bufs:        Vec<Buf>,
	/// The next buffer id.
	pub next_buf:    u32,
	/// `start_color` succeeded.
	pub color:       bool,
	/// `COLORS`.
	pub colors:      i32,
	/// `COLOR_PAIRS`.
	pub color_pairs: i32,
	/// zsh's `zcurses_colorpairs`: `fg/bg` names and their pairs.
	pub pair_names:  Vec<(BString, i16)>,
	/// `init_pair` definitions, by pair (pair 0: the terminal's defaults).
	pub pairs:       Vec<(i16, i16)>,
	/// zsh `next_cp`.
	pub next_cp:     i16,
	/// zsh `zc_color_phase`.
	pub color_phase: u8,
	/// What the terminal shows.
	pub cur:         Screen,
	/// What `wnoutrefresh` composed.
	pub new:         Screen,
	/// The next update clears the screen first (`curscr->_clear`).
	pub clear:       bool,
	/// `endwin` ran: the next update re-enters curses mode.
	pub ended:       bool,
	/// The attributes and pair the terminal draws with now.
	pub vid:         (u16, i16),
	/// The terminal's cursor position is unknown (after a write at the
	/// last column).
	pub lost:        bool,
	/// The keypad transmits application sequences (`smkx` sent).
	pub keypad_xmit: bool,
	/// Bytes read past a key sequence that did not match, read first.
	pub fifo:        Vec<u8>,
	/// Output not written yet (ncurses' output buffer).
	pub pending:     Vec<u8>,
	/// The terminal modes before `zcurses init` (zsh `saved_tty_state`).
	pub saved_tty:   Option<crate::bash::Termios>,
	/// The terminal modes curses set (zsh `curses_tty_state`).
	pub prog_tty:    Option<crate::bash::Termios>,
	/// The terminal reports mouse events (`mousemask` on; zsh
	/// `ZCF_MOUSE_ACTIVE`).
	pub mouse_on:    bool,
	/// The mouse mask changed since it was set (zsh
	/// `ZCF_MOUSE_MASK_CHANGED`).
	pub mouse_dirty: bool,
	/// The mask reports mouse positions (`zcurses mouse motion`).
	pub mouse_moves: bool,
}

impl Curses {
	/// curses started (`initscr`) on a `lines` × `cols` screen.
	pub fn new(term: BString, lines: i32, cols: i32) -> Self {
		let mut c = Self {
			term,
			lines,
			cols,
			wins: Vec::new(),
			bufs: Vec::new(),
			next_buf: 0,
			color: false,
			colors: 0,
			color_pairs: 0,
			pair_names: Vec::new(),
			pairs: vec![(-1, -1)],
			next_cp: 0,
			color_phase: 0,
			cur: Screen::blank(lines, cols),
			new: Screen::blank(lines, cols),
			clear: true,
			ended: false,
			vid: (0, 0),
			lost: true,
			keypad_xmit: false,
			fifo: Vec::new(),
			pending: Vec::new(),
			saved_tty: None,
			prog_tty: None,
			mouse_on: false,
			mouse_dirty: false,
			mouse_moves: false,
		};
		let mut stdscr = c.make(BString::from("stdscr"), lines, cols, 0, 0);
		stdscr.permanent = true;
		c.wins.push(stdscr);
		c
	}

	/// A new window with its own buffer (not yet listed).
	fn make(&mut self, name: BString, rows: i32, cols: i32, begy: i32, begx: i32) -> Win {
		let id = self.next_buf;
		self.next_buf += 1;
		self
			.bufs
			.push(Buf { id, rows, cols, cells: vec![Cell::BLANK; (rows * cols) as usize] });
		Win {
			name,
			buf: id,
			off_y: 0,
			off_x: 0,
			begy,
			begx,
			rows,
			cols,
			cury: 0,
			curx: 0,
			attrs: 0,
			pair: 0,
			bkgd: Cell::BLANK,
			scrollok: false,
			scroll_flag: false,
			clearok: false,
			moved: false,
			timeout: -1,
			keypad: false,
			parent: None,
			children: Vec::new(),
			permanent: false,
			// ncurses `_nc_makenew`: a new window is all changed.
			touched: vec![(0, cols - 1); rows as usize],
		}
	}

	/// The window named `name`.
	pub fn find(&self, name: &[u8]) -> Option<usize> {
		self.wins.iter().position(|w| w.name.as_slice() == name)
	}

	/// ncurses `newwin`: `None` for impossible dimensions.
	pub fn newwin(&mut self, name: BString, nl: i32, nc: i32, by: i32, bx: i32) -> Option<()> {
		if by < 0 || bx < 0 || nl < 0 || nc < 0 {
			return None;
		}
		let nl = if nl == 0 { self.lines - by } else { nl };
		let nc = if nc == 0 { self.cols - bx } else { nc };
		if nl <= 0 || nc <= 0 {
			return None;
		}
		let w = self.make(name, nl, nc, by, bx);
		self.wins.push(w);
		Some(())
	}

	/// ncurses `subwin` (screen coordinates) of window `p`: `None` when it
	/// does not fit in it.
	pub fn subwin(
		&mut self,
		name: BString,
		p: usize,
		nl: i32,
		nc: i32,
		by: i32,
		bx: i32,
	) -> Option<()> {
		let par = &self.wins[p];
		let (y, x) = (by - par.begy, bx - par.begx);
		if y < 0 || x < 0 || nl < 0 || nc < 0 || y + nl > par.rows || x + nc > par.cols {
			return None;
		}
		let nl = if nl == 0 { par.rows - y } else { nl };
		let nc = if nc == 0 { par.cols - x } else { nc };
		if nl <= 0 || nc <= 0 {
			return None;
		}
		let w = Win {
			name:        name.clone(),
			buf:         par.buf,
			off_y:       par.off_y + y,
			off_x:       par.off_x + x,
			begy:        by,
			begx:        bx,
			rows:        nl,
			cols:        nc,
			cury:        0,
			curx:        0,
			attrs:       par.attrs,
			pair:        par.pair,
			bkgd:        par.bkgd,
			scrollok:    false,
			scroll_flag: false,
			clearok:     false,
			moved:       false,
			timeout:     -1,
			keypad:      false,
			parent:      Some(par.name.clone()),
			children:    Vec::new(),
			permanent:   false,
			touched:     vec![(0, nc - 1); nl as usize],
		};
		self.wins[p].children.push(name);
		self.wins.push(w);
		Some(())
	}

	/// ncurses `delwin` of window `i` (its parent, or `stdscr`, is touched).
	pub fn delwin(&mut self, i: usize) {
		let w = self.wins.remove(i);
		let shared = self.wins.iter().any(|o| o.buf == w.buf);
		if !shared {
			self.bufs.retain(|b| b.id != w.buf);
		}
		let touch = match &w.parent {
			Some(p) => {
				if let Some(pi) = self.find(p) {
					self.wins[pi].children.retain(|c| *c != w.name);
					Some(pi)
				} else {
					None
				}
			},
			None => self.find(b"stdscr"),
		};
		if let Some(t) = touch {
			self.touchwin(t);
		}
	}

	fn buf_index(&self, w: usize) -> usize {
		let id = self.wins[w].buf;
		self.bufs.iter().position(|b| b.id == id).unwrap_or(0)
	}

	/// The cell at `(y, x)` of window `w`.
	pub fn cell(&self, w: usize, y: i32, x: i32) -> Cell {
		let win = &self.wins[w];
		let b = &self.bufs[self.buf_index(w)];
		let (by, bx) = (win.off_y + y, win.off_x + x);
		if by < 0 || bx < 0 || by >= b.rows || bx >= b.cols {
			return Cell::BLANK;
		}
		b.cells[(by * b.cols + bx) as usize]
	}

	fn put(&mut self, w: usize, y: i32, x: i32, cell: Cell) {
		let bi = self.buf_index(w);
		let win = &mut self.wins[w];
		if y < 0 || x < 0 || y >= win.rows || x >= win.cols {
			return;
		}
		let b = &mut self.bufs[bi];
		let (by, bx) = (win.off_y + y, win.off_x + x);
		if by >= b.rows || bx >= b.cols {
			return;
		}
		b.cells[(by * b.cols + bx) as usize] = cell;
		let t = &mut win.touched[y as usize];
		if t.0 < 0 || x < t.0 {
			t.0 = x;
		}
		if x > t.1 {
			t.1 = x;
		}
	}

	/// Put `cell` at `(y, x)`, keeping wide characters whole: a character
	/// whose half is overwritten becomes blanks.
	fn put_char(&mut self, w: usize, y: i32, x: i32, cell: Cell, wide: bool) {
		let cols = self.wins[w].cols;
		let blank = self.blank(w);
		// Overwriting the right half of a wide character blanks its left.
		if x > 0 && self.cell(w, y, x).ch == 0 {
			self.put(w, y, x - 1, blank);
		}
		let end = if wide { x + 1 } else { x };
		// Overwriting the left half blanks the right one.
		if end + 1 < cols && self.cell(w, y, end + 1).ch == 0 {
			self.put(w, y, end + 1, blank);
		}
		self.put(w, y, x, cell);
		if wide {
			self.put(w, y, x + 1, Cell { ch: 0, ..cell });
		}
	}

	/// What blanks of window `w` are (its background).
	fn blank(&self, w: usize) -> Cell {
		self.wins[w].bkgd
	}

	/// ncurses `render_char`: `ch` written with the window's attributes,
	/// pair and background.
	fn render(&self, w: usize, ch: u32, attrs: u16) -> Cell {
		let win = &self.wins[w];
		let a = win.attrs | attrs;
		let pair = if win.pair != 0 {
			win.pair
		} else {
			win.bkgd.pair
		};
		let ch = if ch == u32::from(b' ') && attrs == 0 {
			win.bkgd.ch
		} else {
			ch
		};
		Cell { ch, attrs: a | win.bkgd.attrs, pair }
	}

	/// Mark every line of window `w` changed (`touchwin`).
	pub fn touchwin(&mut self, w: usize) {
		let win = &mut self.wins[w];
		let last = win.cols - 1;
		win.touched.fill((0, last));
	}

	/// ncurses `wmove`.
	pub fn wmove(&mut self, w: usize, y: i32, x: i32) -> bool {
		let win = &mut self.wins[w];
		if y < 0 || x < 0 || y >= win.rows || x >= win.cols {
			return false;
		}
		win.cury = y;
		win.curx = x;
		win.moved = true;
		true
	}

	/// The next line for the cursor of window `w` (ncurses `newline`):
	/// scrolls at the bottom when allowed; `false` when it may not.
	fn newline(&mut self, w: usize) -> bool {
		let (y, rows, scroll) = {
			let win = &self.wins[w];
			(win.cury, win.rows, win.scrollok)
		};
		if y + 1 >= rows {
			if !scroll {
				return false;
			}
			self.scroll_lines(w, 1);
		} else {
			self.wins[w].cury = y + 1;
		}
		true
	}

	/// Write one character cell at the cursor and advance it (ncurses
	/// `waddch_literal`): at the end of a line the cursor wraps; at the
	/// bottom right of a window that may not scroll it stays and the add
	/// fails.
	fn add_literal(&mut self, w: usize, cell: Cell, wide: bool) -> bool {
		let (y, mut x, cols) = {
			let win = &self.wins[w];
			(win.cury, win.curx, win.cols)
		};
		if wide && cols < 2 {
			return false;
		}
		if wide && x + 1 >= cols {
			// It does not fit: blanks to the end of the line, then wrap.
			let blank = self.blank(w);
			while x < cols {
				self.put_char(w, y, x, blank, false);
				x += 1;
			}
			self.wins[w].curx = cols - 1;
			if !self.wrap(w) {
				return false;
			}
			return self.add_literal(w, cell, wide);
		}
		self.put_char(w, y, x, cell, wide);
		x += if wide { 2 } else { 1 };
		if x >= cols {
			self.wins[w].curx = cols - 1;
			return self.wrap(w);
		}
		self.wins[w].curx = x;
		true
	}

	/// ncurses `wrap_to_next_line`.
	fn wrap(&mut self, w: usize) -> bool {
		let (y, rows, scroll) = {
			let win = &self.wins[w];
			(win.cury, win.rows, win.scrollok)
		};
		if y + 1 >= rows {
			if !scroll {
				let win = &mut self.wins[w];
				win.curx = win.cols - 1;
				return false;
			}
			self.scroll_lines(w, 1);
		} else {
			self.wins[w].cury = y + 1;
		}
		self.wins[w].curx = 0;
		true
	}

	/// ncurses `waddch` / `wadd_wch` of `c`: `\n`, `\r`, `\b` and `\t`
	/// move the cursor; other control characters show as `^X`.
	pub fn addch(&mut self, w: usize, c: char, attrs: u16) -> bool {
		match c {
			'\n' => {
				self.clrtoeol(w);
				self.wins[w].curx = 0;
				self.newline(w)
			},
			'\r' => {
				self.wins[w].curx = 0;
				true
			},
			'\u{8}' => {
				let win = &mut self.wins[w];
				if win.curx > 0 {
					win.curx -= 1;
				}
				true
			},
			'\t' => {
				let blank = self.render(w, u32::from(b' '), attrs);
				loop {
					if !self.add_literal(w, blank, false) {
						return false;
					}
					if self.wins[w].curx % 8 == 0 {
						return true;
					}
				}
			},
			c if (c as u32) < 0x20 || c as u32 == 0x7f => {
				let shown = if c as u32 == 0x7f {
					'?'
				} else {
					char::from(c as u8 + 0x40)
				};
				let caret = self.render(w, u32::from(b'^'), attrs);
				let ch = self.render(w, u32::from(shown), attrs);
				self.add_literal(w, caret, false) && self.add_literal(w, ch, false)
			},
			c => {
				let cell = self.render(w, u32::from(c), attrs);
				self.add_literal(w, cell, width(c) == 2)
			},
		}
	}

	/// ncurses `waddstr`: each character, stopping at the first failure.
	pub fn addstr(&mut self, w: usize, s: &str) -> bool {
		s.chars().all(|c| self.addch(w, c, 0))
	}

	/// ncurses `werase`.
	pub fn werase(&mut self, w: usize) {
		let blank = self.blank(w);
		let (rows, cols) = (self.wins[w].rows, self.wins[w].cols);
		for y in 0..rows {
			for x in 0..cols {
				self.put(w, y, x, blank);
			}
		}
		let win = &mut self.wins[w];
		win.cury = 0;
		win.curx = 0;
		self.touchwin(w);
	}

	/// ncurses `wclrtoeol`.
	pub fn clrtoeol(&mut self, w: usize) {
		let blank = self.blank(w);
		let (y, x, cols) = (self.wins[w].cury, self.wins[w].curx, self.wins[w].cols);
		if x > 0 && self.cell(w, y, x).ch == 0 {
			self.put(w, y, x - 1, blank);
		}
		for i in x..cols {
			self.put(w, y, i, blank);
		}
	}

	/// ncurses `wclrtobot`.
	pub fn clrtobot(&mut self, w: usize) {
		self.clrtoeol(w);
		let blank = self.blank(w);
		let (y, rows, cols) = (self.wins[w].cury, self.wins[w].rows, self.wins[w].cols);
		for line in y + 1..rows {
			for i in 0..cols {
				self.put(w, line, i, blank);
			}
		}
	}

	/// ncurses `wborder(win, 0, …, 0)`: the default line-drawing border.
	pub fn border(&mut self, w: usize) {
		let (rows, cols) = (self.wins[w].rows, self.wins[w].cols);
		let acs = |s: &Self, c: u8| s.render(w, u32::from(c), A_ALTCHARSET);
		let (hl, vl) = (acs(self, b'q'), acs(self, b'x'));
		let (ul, ur, ll, lr) = (acs(self, b'l'), acs(self, b'k'), acs(self, b'm'), acs(self, b'j'));
		for x in 1..cols - 1 {
			self.put_char(w, 0, x, hl, false);
			self.put_char(w, rows - 1, x, hl, false);
		}
		for y in 1..rows - 1 {
			self.put_char(w, y, 0, vl, false);
			self.put_char(w, y, cols - 1, vl, false);
		}
		self.put_char(w, 0, 0, ul, false);
		self.put_char(w, 0, cols - 1, ur, false);
		self.put_char(w, rows - 1, 0, ll, false);
		self.put_char(w, rows - 1, cols - 1, lr, false);
	}

	/// ncurses `wbkgd`: the new background replaces the old one in every
	/// cell (a cell of the old background character becomes the new one;
	/// attributes of the old background give way to the new).
	pub fn bkgd(&mut self, w: usize, ch: u32, attrs: u16, pair: i16) {
		let old = self.wins[w].bkgd;
		let new = Cell { ch: if ch == 0 { u32::from(b' ') } else { ch }, attrs, pair };
		{
			let win = &mut self.wins[w];
			win.attrs = (win.attrs & !old.attrs) | attrs;
			win.bkgd = new;
		}
		let (rows, cols) = (self.wins[w].rows, self.wins[w].cols);
		for y in 0..rows {
			for x in 0..cols {
				let c = self.cell(w, y, x);
				let cell = if c.ch == old.ch {
					new
				} else {
					Cell {
						ch:    c.ch,
						attrs: (c.attrs & !old.attrs) | attrs,
						pair:  if c.pair == old.pair { pair } else { c.pair },
					}
				};
				self.put(w, y, x, cell);
			}
		}
		self.touchwin(w);
	}

	/// Scroll window `w`'s lines up by `n` (down for negative `n`),
	/// blanking what comes in; the cursor stays.
	fn scroll_lines(&mut self, w: usize, n: i32) {
		let blank = self.blank(w);
		let (rows, cols) = (self.wins[w].rows, self.wins[w].cols);
		let n = n.clamp(-rows, rows);
		let src = |y: i32| y + n;
		let lines: Vec<Vec<Cell>> = (0..rows)
			.map(|y| {
				let s = src(y);
				(0..cols)
					.map(|x| {
						if s >= 0 && s < rows {
							self.cell(w, s, x)
						} else {
							blank
						}
					})
					.collect()
			})
			.collect();
		for (y, line) in lines.into_iter().enumerate() {
			for (x, c) in line.into_iter().enumerate() {
				self.put(w, y as i32, x as i32, c);
			}
		}
		self.touchwin(w);
	}

	/// ncurses `wscrl`: fails unless the window may scroll.
	pub fn wscrl(&mut self, w: usize, n: i32) -> bool {
		if !self.wins[w].scrollok {
			return false;
		}
		if n != 0 {
			self.scroll_lines(w, n);
		}
		true
	}

	/// ncurses `wnoutrefresh`: the window's changed parts into the virtual
	/// screen, its cursor the screen's.
	pub fn noutrefresh(&mut self, w: usize) {
		let (begy, begx, rows, cols) = {
			let win = &self.wins[w];
			(win.begy, win.begx, win.rows, win.cols)
		};
		if self.wins[w].clearok {
			self.clear = true;
			self.wins[w].clearok = false;
		}
		for y in 0..rows {
			let (first, last) = self.wins[w].touched[y as usize];
			if first < 0 {
				continue;
			}
			let sy = begy + y;
			if sy < 0 || sy >= self.lines {
				continue;
			}
			for x in first..=last.min(cols - 1) {
				let sx = begx + x;
				if sx < 0 || sx >= self.cols {
					continue;
				}
				let c = self.cell(w, y, x);
				self.new.cells[(sy * self.cols + sx) as usize] = c;
			}
			self.wins[w].touched[y as usize] = (-1, -1);
		}
		let win = &mut self.wins[w];
		win.moved = false;
		self.new.y = (begy + win.cury).clamp(0, self.lines - 1);
		self.new.x = (begx + win.curx).clamp(0, self.cols - 1);
	}

	/// Whether window `w` changed or its cursor moved since its last
	/// refresh (`is_wintouched`, `_HASMOVED`).
	pub fn needs_refresh(&self, w: usize) -> bool {
		let win = &self.wins[w];
		win.moved || win.touched.iter().any(|t| t.0 >= 0)
	}
}

/// The terminal capabilities the update writes with.
pub struct Caps<'t> {
	ti:  &'t TermInfo,
	/// `acsc`: VT100 line-drawing code → the terminal's character.
	acs: Vec<(u8, u8)>,
}

impl<'t> Caps<'t> {
	/// The capabilities of `ti`.
	pub fn new(ti: &'t TermInfo) -> Self {
		let acs = ti
			.str("acsc")
			.map_or_default(|s| s.as_chunks::<2>().0.iter().map(|p| (p[0], p[1])).collect());
		Self { ti, acs }
	}

	/// String capability `name`, padding removed.
	pub fn s(&self, name: &str) -> Option<Vec<u8>> {
		self.ti.str(name).map(tputs)
	}

	/// What turns xterm mouse reporting on or off (ncurses
	/// `enable_xterm_mouse`: the extended `XM` capability, else mode 1000);
	/// `None` for a terminal without mouse events (`kmous`).
	pub fn mouse(&self, on: bool) -> Option<Vec<u8>> {
		self.ti.str("kmous")?;
		Some(match self.p("XM", &[i32::from(on)]) {
			Some(s) => s,
			None if on => b"\x1b[?1000h".to_vec(),
			None => b"\x1b[?1000l".to_vec(),
		})
	}

	/// String capability `name` with parameters.
	fn p(&self, name: &str, params: &[i32]) -> Option<Vec<u8>> {
		let cap = self.ti.str(name)?;
		let args: Vec<TParm<'_>> = params.iter().map(|&n| TParm::Num(n)).collect();
		Some(tputs(&tparm(cap, &args)))
	}

	/// The terminal's character for line-drawing code `c` and whether it
	/// needs the alternate character set; ncurses' ASCII fallback without
	/// `acsc`.
	fn acs_char(&self, c: u8) -> (u8, bool) {
		if let Some(&(_, t)) = self.acs.iter().find(|(v, _)| *v == c) {
			return (t, true);
		}
		let ascii = match c {
			b'q' => b'-',
			b'x' => b'|',
			_ => b'+',
		};
		(ascii, false)
	}
}

/// Write `bytes` (a capability may be absent: nothing).
fn emit(out: &mut Vec<u8>, bytes: Option<Vec<u8>>) {
	if let Some(b) = bytes {
		out.extend_from_slice(&b);
	}
}

impl Curses {
	/// The terminal set up for curses (ncurses `initscr`'s output: the
	/// alternate screen, the scroll region, normal attributes, insert mode
	/// off, automatic margins, default colors).
	pub fn start(&mut self, caps: &Caps<'_>) {
		let mut out = std::mem::take(&mut self.pending);
		emit(&mut out, caps.s("smcup"));
		emit(&mut out, caps.p("csr", &[0, self.lines - 1]));
		emit(&mut out, caps.s("sgr0"));
		emit(&mut out, caps.s("rmir"));
		emit(&mut out, caps.s("smam"));
		if self.color {
			emit(&mut out, caps.s("op"));
		}
		emit(&mut out, caps.s("rmkx"));
		self.keypad_xmit = false;
		self.pending = out;
		self.vid = (0, 0);
		self.lost = true;
	}

	/// The attributes and pair the terminal draws with, changed to
	/// `(attrs, pair)` (ncurses `vidputs`).
	fn vid(&mut self, caps: &Caps<'_>, out: &mut Vec<u8>, attrs: u16, pair: i16) {
		if self.vid == (attrs, pair) {
			return;
		}
		if self.vid.1 != 0 && pair == 0 && self.color {
			emit(out, caps.s("op"));
		}
		let on = |a: u16| i32::from(attrs & a != 0);
		if caps.ti.str("sgr").is_some() {
			emit(
				out,
				caps.p("sgr", &[
					on(A_STANDOUT),
					on(A_UNDERLINE),
					on(A_REVERSE),
					on(A_BLINK),
					on(A_DIM),
					on(A_BOLD),
					0,
					0,
					on(A_ALTCHARSET),
				]),
			);
		} else {
			emit(out, caps.s("sgr0"));
			for (bit, cap) in [
				(A_STANDOUT, "smso"),
				(A_UNDERLINE, "smul"),
				(A_REVERSE, "rev"),
				(A_BLINK, "blink"),
				(A_DIM, "dim"),
				(A_BOLD, "bold"),
				(A_ALTCHARSET, "smacs"),
			] {
				if attrs & bit != 0 {
					emit(out, caps.s(cap));
				}
			}
			if attrs & A_ALTCHARSET == 0 && self.vid.0 & A_ALTCHARSET != 0 {
				emit(out, caps.s("rmacs"));
			}
		}
		if pair != 0 && self.color {
			let (fg, bg) = self.pairs.get(pair as usize).copied().unwrap_or((-1, -1));
			if fg >= 0 {
				emit(
					out,
					caps
						.p("setaf", &[i32::from(fg)])
						.or_else(|| caps.p("setf", &[i32::from(fg)])),
				);
			}
			if bg >= 0 {
				emit(
					out,
					caps
						.p("setab", &[i32::from(bg)])
						.or_else(|| caps.p("setb", &[i32::from(bg)])),
				);
			}
		}
		self.vid = (attrs, pair);
	}

	/// Move the terminal's cursor to `(y, x)`.
	fn goto(&mut self, caps: &Caps<'_>, out: &mut Vec<u8>, y: i32, x: i32) {
		if !self.lost && self.cur.y == y && self.cur.x == x {
			return;
		}
		if !self.lost && self.cur.y == y && x == 0 {
			out.push(b'\r');
		} else {
			emit(out, caps.p("cup", &[y, x]));
		}
		self.cur.y = y;
		self.cur.x = x;
		self.lost = false;
	}

	/// Draw cell `c` at the terminal's cursor.
	fn draw(&mut self, caps: &Caps<'_>, out: &mut Vec<u8>, c: Cell) {
		let (mut attrs, ch) = (c.attrs, c.ch);
		let mut bytes = [0u8; 4];
		let text: &[u8] = if attrs & A_ALTCHARSET != 0 {
			let (t, alt) = caps.acs_char(ch as u8);
			if !alt {
				attrs &= !A_ALTCHARSET;
			}
			bytes[0] = t;
			&bytes[..1]
		} else {
			let ch = char::from_u32(ch).unwrap_or(' ');
			ch.encode_utf8(&mut bytes).as_bytes()
		};
		let text = text.to_vec();
		self.vid(caps, out, attrs, c.pair);
		out.extend_from_slice(&text);
		let w = char::from_u32(c.ch).map_or(1, width);
		self.cur.x += w;
		if self.cur.x >= self.cols {
			// Where the cursor is after the last column depends on the
			// terminal's margins: address it next time.
			self.lost = true;
		}
	}

	/// ncurses `doupdate`: bring the terminal to the virtual screen.
	pub fn doupdate(&mut self, caps: &Caps<'_>) {
		let mut out = std::mem::take(&mut self.pending);
		if self.ended {
			self.ended = false;
			emit(&mut out, caps.s("smcup"));
			emit(&mut out, caps.p("csr", &[0, self.lines - 1]));
			if self.mouse_on {
				emit(&mut out, caps.mouse(true));
			}
			self.clear = true;
			self.vid = (u16::MAX, -1);
		}
		if self.clear {
			self.vid(caps, &mut out, 0, 0);
			emit(&mut out, caps.s("clear"));
			self.cur = Screen::blank(self.lines, self.cols);
			self.lost = false;
			self.clear = false;
		}
		let cols = self.cols;
		for y in 0..self.lines {
			let row = (y * cols) as usize;
			let mut x = 0;
			while x < cols {
				let i = row + x as usize;
				let want = self.new.cells[i];
				if want == self.cur.cells[i] {
					x += 1;
					continue;
				}
				// The right half of a wide character is drawn with its left.
				let (sx, si) = if want.ch == 0 {
					if x > 0 && self.new.cells[i - 1].ch != 0 {
						(x - 1, i - 1)
					} else {
						self.cur.cells[i] = want;
						x += 1;
						continue;
					}
				} else {
					(x, i)
				};
				let cell = self.new.cells[si];
				self.goto(caps, &mut out, y, sx);
				self.draw(caps, &mut out, cell);
				self.cur.cells[si] = cell;
				let wide = char::from_u32(cell.ch).is_some_and(|c| width(c) == 2);
				let next = if wide && sx + 1 < cols {
					self.cur.cells[si + 1] = self.new.cells[si + 1];
					sx + 2
				} else {
					sx + 1
				};
				if next <= x {
					// A stray right half (its left is no wide character).
					self.cur.cells[i] = want;
					x += 1;
				} else {
					x = next;
				}
			}
		}
		if self.vid != (0, 0) {
			self.vid(caps, &mut out, 0, 0);
		}
		let (ny, nx) = (self.new.y, self.new.x);
		self.goto(caps, &mut out, ny, nx);
		self.pending = out;
	}

	/// ncurses `endwin`: normal attributes, the cursor to the bottom left,
	/// the normal screen back, the keypad local.
	pub fn endwin(&mut self, caps: &Caps<'_>) {
		let mut out = std::mem::take(&mut self.pending);
		if self.mouse_on {
			emit(&mut out, caps.mouse(false));
		}
		if self.vid != (0, 0) {
			self.vid(caps, &mut out, 0, 0);
		}
		self.lost = true;
		let last = self.lines - 1;
		self.goto(caps, &mut out, last, 0);
		emit(&mut out, caps.s("rmcup"));
		out.push(b'\r');
		emit(&mut out, caps.s("rmkx"));
		self.keypad_xmit = false;
		self.ended = true;
		self.lost = true;
		self.pending = out;
	}

	/// ncurses `resize_term`: the screen, `stdscr` and every window that
	/// sticks out of it take the new size.
	pub fn resize(&mut self, lines: i32, cols: i32) {
		self.lines = lines;
		self.cols = cols;
		self.cur = Screen::blank(lines, cols);
		self.new = Screen::blank(lines, cols);
		self.clear = true;
		for w in 0..self.wins.len() {
			let (begy, begx, rows, wcols, permanent) = {
				let win = &self.wins[w];
				(win.begy, win.begx, win.rows, win.cols, win.permanent)
			};
			let nrows = if permanent {
				lines
			} else {
				rows.min((lines - begy).max(1))
			};
			let ncols = if permanent {
				cols
			} else {
				wcols.min((cols - begx).max(1))
			};
			if (nrows, ncols) != (rows, wcols) {
				self.resize_win(w, nrows, ncols);
			}
		}
	}

	/// Window `w` (owning its buffer) with `rows` × `cols` cells, keeping
	/// what fits.
	fn resize_win(&mut self, w: usize, rows: i32, cols: i32) {
		let bi = self.buf_index(w);
		let blank = self.blank(w);
		let owner = self.wins[w].parent.is_none();
		if owner {
			let (orows, ocols) = (self.bufs[bi].rows, self.bufs[bi].cols);
			let old = std::mem::take(&mut self.bufs[bi].cells);
			let mut cells = vec![blank; (rows * cols) as usize];
			for y in 0..rows.min(orows) {
				for x in 0..cols.min(ocols) {
					cells[(y * cols + x) as usize] = old[(y * ocols + x) as usize];
				}
			}
			let b = &mut self.bufs[bi];
			b.rows = rows;
			b.cols = cols;
			b.cells = cells;
		}
		let win = &mut self.wins[w];
		win.rows = rows;
		win.cols = cols;
		win.cury = win.cury.min(rows - 1);
		win.curx = win.curx.min(cols - 1);
		win.touched = vec![(0, cols - 1); rows as usize];
	}
}
