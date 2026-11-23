//! Indicatif progress bars drawn on a utility's stderr (`cp -g`, `mv -g`).
//!
//! indicatif's own targets write to the host process's stderr, which belongs
//! to the TUI; these bars draw on the command's fd 2 instead.

use std::{
	fmt,
	io::{self, Write},
};

use crate::openfile::OpenFile;
use indicatif::{ProgressDrawTarget, TermLike};
use parking_lot::Mutex;

use crate::host::Host;

/// A terminal-like indicatif sink backed by the command's stderr.
struct ProgressTerminal {
	writer: Mutex<OpenFile>,
}

impl fmt::Debug for ProgressTerminal {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("ProgressTerminal").finish_non_exhaustive()
	}
}

impl ProgressTerminal {
	fn write_control(&self, value: impl fmt::Display) -> io::Result<()> {
		write!(self.writer.lock(), "{value}")
	}

	fn move_cursor(&self, n: usize, direction: char) -> io::Result<()> {
		if n == 0 {
			Ok(())
		} else {
			self.write_control(format_args!("\x1b[{n}{direction}"))
		}
	}
}

impl TermLike for ProgressTerminal {
	fn width(&self) -> u16 {
		self.writer
			.lock()
			.window_size()
			.map(|(columns, _)| columns)
			.filter(|&columns| columns > 0)
			.unwrap_or(80)
	}

	fn move_cursor_up(&self, n: usize) -> io::Result<()> {
		self.move_cursor(n, 'A')
	}

	fn move_cursor_down(&self, n: usize) -> io::Result<()> {
		self.move_cursor(n, 'B')
	}

	fn move_cursor_right(&self, n: usize) -> io::Result<()> {
		self.move_cursor(n, 'C')
	}

	fn move_cursor_left(&self, n: usize) -> io::Result<()> {
		self.move_cursor(n, 'D')
	}

	fn write_line(&self, s: &str) -> io::Result<()> {
		writeln!(self.writer.lock(), "{s}")
	}

	fn write_str(&self, s: &str) -> io::Result<()> {
		self.writer.lock().write_all(s.as_bytes())
	}

	fn clear_line(&self) -> io::Result<()> {
		self.write_control("\r\x1b[2K")
	}

	fn flush(&self) -> io::Result<()> {
		self.writer.lock().flush()
	}
}

/// A draw target on the command's stderr, or `None` when stderr is not a
/// terminal (where indicatif would draw nothing either).
pub(crate) fn stderr_draw_target(host: &Host) -> Option<ProgressDrawTarget> {
	host.stderr.is_terminal().then(|| {
		let terminal = ProgressTerminal { writer: Mutex::new(host.stderr_clone()) };
		ProgressDrawTarget::term_like(Box::new(terminal))
	})
}
