//! A small VT100/xterm screen model: enough of the control sequences zsh,
//! ZLE and common prompts emit (cursor motion, erase, insert/delete,
//! scrolling regions, the alternate screen, autowrap) to compare what two
//! shells leave on a terminal. Colours and attributes are parsed and
//! dropped. A cursor position request (`CSI 6 n`) is answered through
//! [`Screen::take_replies`].

/// The terminal's character grid.
#[derive(Clone, Debug)]
pub struct Screen {
	rows:    usize,
	cols:    usize,
	grid:    Vec<Vec<String>>,
	/// The main screen while the alternate one is shown.
	saved:   Option<Vec<Vec<String>>>,
	row:     usize,
	col:     usize,
	/// The last column was written: the next printable wraps first.
	wrap:    bool,
	top:     usize,
	bottom:  usize,
	cursor:  Option<(usize, usize)>,
	parser:  State,
	utf8:    Vec<u8>,
	replies: Vec<u8>,
}

#[derive(Clone, Debug)]
enum State {
	Ground,
	Escape,
	/// `ESC (` and friends: one charset byte follows.
	Charset,
	Csi {
		private:      Option<u8>,
		params:       Vec<u8>,
		intermediate: Vec<u8>,
	},
	/// OSC, DCS, APC, PM, SOS: skipped up to BEL or ST.
	Text {
		esc: bool,
	},
}

impl Screen {
	/// A blank `rows` × `cols` screen, cursor at the top left.
	#[must_use]
	pub fn new(rows: u16, cols: u16) -> Self {
		let (rows, cols) = (usize::from(rows.max(1)), usize::from(cols.max(1)));
		Self {
			rows,
			cols,
			grid: blank(rows, cols),
			saved: None,
			row: 0,
			col: 0,
			wrap: false,
			top: 0,
			bottom: rows - 1,
			cursor: None,
			parser: State::Ground,
			utf8: Vec::new(),
			replies: Vec::new(),
		}
	}

	/// Resize as a terminal emulator does: rows are dropped or added at the
	/// bottom, lines truncated or padded; the scrolling region resets.
	pub fn resize(&mut self, rows: u16, cols: u16) {
		let (rows, cols) = (usize::from(rows.max(1)), usize::from(cols.max(1)));
		for grid in std::iter::once(&mut self.grid).chain(self.saved.as_mut()) {
			grid.resize_with(rows, || vec![String::from(" "); cols]);
			for line in grid.iter_mut() {
				line.resize(cols, String::from(" "));
			}
		}
		self.rows = rows;
		self.cols = cols;
		self.top = 0;
		self.bottom = rows - 1;
		self.row = self.row.min(rows - 1);
		self.col = self.col.min(cols - 1);
		self.wrap = false;
	}

	/// The cursor as (row, column), zero-based.
	#[must_use]
	pub const fn cursor(&self) -> (usize, usize) {
		(self.row, self.col)
	}

	/// Row `i` without trailing blanks.
	#[must_use]
	pub fn row(&self, i: usize) -> String {
		self
			.grid
			.get(i)
			.map(|line| line.concat().trim_end().to_owned())
			.unwrap_or_default()
	}

	/// Every row without trailing blanks, joined by newlines, without
	/// trailing empty rows.
	#[must_use]
	pub fn contents(&self) -> String {
		let mut rows: Vec<String> = (0..self.rows).map(|i| self.row(i)).collect();
		while rows.last().is_some_and(String::is_empty) {
			rows.pop();
		}
		rows.join("\n")
	}

	/// Bytes the terminal must send back (cursor position reports),
	/// taken.
	pub fn take_replies(&mut self) -> Vec<u8> {
		std::mem::take(&mut self.replies)
	}

	/// Feed output bytes.
	pub fn feed(&mut self, bytes: &[u8]) {
		for &b in bytes {
			self.byte(b);
		}
	}

	fn byte(&mut self, b: u8) {
		match std::mem::replace(&mut self.parser, State::Ground) {
			State::Ground => self.ground(b),
			State::Escape => self.escape(b),
			State::Charset => {},
			State::Csi { private, mut params, mut intermediate } => match b {
				0x1b => self.parser = State::Escape,
				0x18 | 0x1a => {},
				0x00..=0x1f => {
					self.control(b);
					self.parser = State::Csi { private, params, intermediate };
				},
				b'<' | b'=' | b'>' | b'?' if params.is_empty() && private.is_none() => {
					self.parser = State::Csi { private: Some(b), params, intermediate };
				},
				b'0'..=b'9' | b';' | b':' => {
					params.push(b);
					self.parser = State::Csi { private, params, intermediate };
				},
				0x20..=0x2f => {
					intermediate.push(b);
					self.parser = State::Csi { private, params, intermediate };
				},
				0x40..=0x7e => self.csi(private, &params, &intermediate, b),
				_ => {},
			},
			State::Text { esc } => match b {
				0x07 => {},
				b'\\' if esc => {},
				0x1b => self.parser = State::Text { esc: true },
				_ => self.parser = State::Text { esc: false },
			},
		}
	}

	fn ground(&mut self, b: u8) {
		if !self.utf8.is_empty() || b >= 0x80 {
			self.utf8.push(b);
			match std::str::from_utf8(&self.utf8) {
				Ok(s) => {
					let c = s.chars().next().unwrap_or('\u{fffd}');
					self.utf8.clear();
					self.print(c);
				},
				Err(e) if e.error_len().is_some() || self.utf8.len() >= 4 => {
					self.utf8.clear();
					self.print('\u{fffd}');
				},
				Err(_) => {},
			}
			return;
		}
		match b {
			0x1b => self.parser = State::Escape,
			0x00..=0x1f => self.control(b),
			0x7f => {},
			_ => self.print(char::from(b)),
		}
	}

	fn control(&mut self, b: u8) {
		match b {
			b'\r' => {
				self.col = 0;
				self.wrap = false;
			},
			b'\n' | 0x0b | 0x0c => self.linefeed(),
			0x08 => {
				self.col = self.col.saturating_sub(1);
				self.wrap = false;
			},
			b'\t' => {
				self.col = ((self.col / 8 + 1) * 8).min(self.cols - 1);
				self.wrap = false;
			},
			_ => {},
		}
	}

	fn escape(&mut self, b: u8) {
		match b {
			b'[' => {
				self.parser = State::Csi {
					private:      None,
					params:       Vec::new(),
					intermediate: Vec::new(),
				};
			},
			b']' | b'P' | b'_' | b'^' | b'X' => self.parser = State::Text { esc: false },
			b'(' | b')' | b'*' | b'+' | b'#' | b'%' => self.parser = State::Charset,
			b'7' => self.cursor = Some((self.row, self.col)),
			b'8' => self.restore_cursor(),
			b'D' => self.linefeed(),
			b'E' => {
				self.col = 0;
				self.linefeed();
			},
			b'M' => self.reverse_index(),
			b'c' => *self = Self::new(self.rows as u16, self.cols as u16),
			_ => {},
		}
	}

	fn csi(&mut self, private: Option<u8>, params: &[u8], intermediate: &[u8], fin: u8) {
		let args: Vec<usize> = params
			.split(|&c| c == b';')
			.map(|p| {
				let p = p.split(|&c| c == b':').next().unwrap_or(p);
				std::str::from_utf8(p)
					.ok()
					.and_then(|s| s.parse().ok())
					.unwrap_or(0)
			})
			.collect();
		let arg = |i: usize, default: usize| match args.get(i) {
			Some(&0) | None => default,
			Some(&n) => n,
		};
		if !intermediate.is_empty() {
			return;
		}
		if let Some(p) = private {
			if p == b'?' && matches!(fin, b'h' | b'l') {
				for &mode in &args {
					if matches!(mode, 47 | 1047 | 1049) {
						self.alternate(fin == b'h', mode == 1049);
					}
				}
			}
			return;
		}
		self.wrap = false;
		match fin {
			b'A' => {
				self.row = self
					.row
					.saturating_sub(arg(0, 1))
					.max(self.top.min(self.row))
			},
			b'B' => self.row = (self.row + arg(0, 1)).min(self.bottom.max(self.row)),
			b'C' => self.col = (self.col + arg(0, 1)).min(self.cols - 1),
			b'D' => self.col = self.col.saturating_sub(arg(0, 1)),
			b'E' => {
				self.row = (self.row + arg(0, 1)).min(self.rows - 1);
				self.col = 0;
			},
			b'F' => {
				self.row = self.row.saturating_sub(arg(0, 1));
				self.col = 0;
			},
			b'G' | b'`' => self.col = (arg(0, 1) - 1).min(self.cols - 1),
			b'd' => self.row = (arg(0, 1) - 1).min(self.rows - 1),
			b'H' | b'f' => {
				self.row = (arg(0, 1) - 1).min(self.rows - 1);
				self.col = (arg(1, 1) - 1).min(self.cols - 1);
			},
			b'J' => match args.first().copied().unwrap_or(0) {
				0 => {
					self.clear_line(self.row, self.col, self.cols);
					for r in self.row + 1..self.rows {
						self.clear_line(r, 0, self.cols);
					}
				},
				1 => {
					for r in 0..self.row {
						self.clear_line(r, 0, self.cols);
					}
					self.clear_line(self.row, 0, self.col + 1);
				},
				_ => {
					for r in 0..self.rows {
						self.clear_line(r, 0, self.cols);
					}
				},
			},
			b'K' => match args.first().copied().unwrap_or(0) {
				0 => self.clear_line(self.row, self.col, self.cols),
				1 => self.clear_line(self.row, 0, self.col + 1),
				_ => self.clear_line(self.row, 0, self.cols),
			},
			b'X' => {
				let end = (self.col + arg(0, 1)).min(self.cols);
				self.clear_line(self.row, self.col, end);
			},
			b'P' => {
				let n = arg(0, 1).min(self.cols - self.col);
				let line = &mut self.grid[self.row];
				line.drain(self.col..self.col + n);
				line.resize(self.cols, String::from(" "));
			},
			b'@' => {
				let n = arg(0, 1).min(self.cols - self.col);
				let line = &mut self.grid[self.row];
				for _ in 0..n {
					line.insert(self.col, String::from(" "));
				}
				line.truncate(self.cols);
			},
			b'L' if (self.top..=self.bottom).contains(&self.row) => {
				for _ in 0..arg(0, 1) {
					self.grid.remove(self.bottom);
					self
						.grid
						.insert(self.row, vec![String::from(" "); self.cols]);
				}
				self.col = 0;
			},
			b'M' if (self.top..=self.bottom).contains(&self.row) => {
				for _ in 0..arg(0, 1) {
					self.grid.remove(self.row);
					self
						.grid
						.insert(self.bottom, vec![String::from(" "); self.cols]);
				}
				self.col = 0;
			},
			b'S' => {
				for _ in 0..arg(0, 1) {
					self.scroll_up();
				}
			},
			b'T' => {
				for _ in 0..arg(0, 1) {
					self.scroll_down();
				}
			},
			b'r' => {
				let top = arg(0, 1) - 1;
				let bottom = arg(1, self.rows).min(self.rows) - 1;
				if top < bottom {
					self.top = top;
					self.bottom = bottom;
					self.row = 0;
					self.col = 0;
				}
			},
			b's' => self.cursor = Some((self.row, self.col)),
			b'u' => self.restore_cursor(),
			b'n' if args.first() == Some(&6) => {
				let reply = format!("\x1b[{};{}R", self.row + 1, self.col + 1);
				self.replies.extend_from_slice(reply.as_bytes());
			},
			_ => {},
		}
	}

	fn alternate(&mut self, on: bool, save_cursor: bool) {
		if on && self.saved.is_none() {
			if save_cursor {
				self.cursor = Some((self.row, self.col));
			}
			let main = std::mem::replace(&mut self.grid, blank(self.rows, self.cols));
			self.saved = Some(main);
		} else if !on && let Some(main) = self.saved.take() {
			self.grid = main;
			if save_cursor {
				self.restore_cursor();
			}
		}
	}

	fn restore_cursor(&mut self) {
		if let Some((r, c)) = self.cursor {
			self.row = r.min(self.rows - 1);
			self.col = c.min(self.cols - 1);
		}
		self.wrap = false;
	}

	fn clear_line(&mut self, row: usize, from: usize, to: usize) {
		if let Some(line) = self.grid.get_mut(row) {
			for cell in line.iter_mut().take(to.min(self.cols)).skip(from) {
				*cell = String::from(" ");
			}
		}
	}

	fn linefeed(&mut self) {
		self.wrap = false;
		if self.row == self.bottom {
			self.scroll_up();
		} else if self.row + 1 < self.rows {
			self.row += 1;
		}
	}

	fn reverse_index(&mut self) {
		self.wrap = false;
		if self.row == self.top {
			self.scroll_down();
		} else {
			self.row = self.row.saturating_sub(1);
		}
	}

	fn scroll_up(&mut self) {
		self.grid.remove(self.top);
		self
			.grid
			.insert(self.bottom, vec![String::from(" "); self.cols]);
	}

	fn scroll_down(&mut self) {
		self.grid.remove(self.bottom);
		self
			.grid
			.insert(self.top, vec![String::from(" "); self.cols]);
	}

	fn print(&mut self, c: char) {
		let width = char_width(c);
		if width == 0 {
			// A combining mark joins the cell before the cursor.
			let col = if self.wrap {
				self.col
			} else {
				self.col.saturating_sub(1)
			};
			self.grid[self.row][col].push(c);
			return;
		}
		if self.wrap || self.col + width > self.cols {
			self.col = 0;
			self.linefeed();
		}
		let line = &mut self.grid[self.row];
		line[self.col] = c.to_string();
		if width == 2 && self.col + 1 < self.cols {
			line[self.col + 1] = String::new();
		}
		if self.col + width >= self.cols {
			self.col = self.cols - 1;
			self.wrap = true;
		} else {
			self.col += width;
		}
	}
}

fn blank(rows: usize, cols: usize) -> Vec<Vec<String>> {
	vec![vec![String::from(" "); cols]; rows]
}

/// Display width of `c`: 0 for combining marks and zero-width characters,
/// 2 for East Asian wide characters and emoji, else 1.
fn char_width(c: char) -> usize {
	let u = u32::from(c);
	match u {
		0x0300..=0x036f | 0x200b..=0x200f | 0xfe00..=0xfe0f | 0x20d0..=0x20ff => 0,
		0x1100..=0x115f
		| 0x2e80..=0xa4cf
		| 0xac00..=0xd7a3
		| 0xf900..=0xfaff
		| 0xfe30..=0xfe4f
		| 0xff00..=0xff60
		| 0xffe0..=0xffe6
		| 0x1f300..=0x1f64f
		| 0x1f900..=0x1f9ff
		| 0x20000..=0x3fffd => 2,
		_ => 1,
	}
}
