//! The terminal ZLE edits on (zsh's `SHTTY` and `shout`): its modes while
//! editing (zsh `zsetterm`, `settyinfo`), the display bytes waiting to be
//! written, its size and capabilities.
//!
//! SHTTY itself, and the shell's normal terminal modes (zsh `shttyinfo`),
//! belong to job control (`jobctl`), which opens the terminal at
//! interactive startup: ZLE borrows them.

use std::task::{Context, Poll};

use crate::bash::{
	event::WaitKey,
	fd::FdRef,
	term::{CtlChar, SetWhen, TermFlag},
	vm::{Cx, Kernel, jobctl},
};

/// The descriptor number that stands for the editing terminal: in a
/// [`WaitKey::Write`] for its pending display bytes, and in a
/// [`PendingWrite`](crate::bash::vm::proc::PendingWrite) that keeps display
/// bytes in order behind the shell's own queued output
/// (`exec::flush_out`).
pub const FD: i32 = -1;

/// The editing terminal of a vproc's editor.
pub struct Tty {
	/// SHTTY as an engine file (reads are non-blocking polls).
	pub file:    FdRef,
	/// Display bytes not written yet (zsh's buffered `shout`).
	pub out:     Vec<u8>,
	/// zsh `eofchar`: the terminal's EOF character while editing.
	pub eofchar: Option<u8>,
	/// zsh `zsetterm` is in effect (the terminal is in ZLE's modes).
	pub raw:     bool,
	/// zsh `fetchttyinfo` (`zle -I`): read the normal modes from the
	/// terminal again before the next `zsetterm`.
	pub fetch:   bool,
	/// Columns, rows (zsh `zterm_columns`, `zterm_lines`).
	pub size:    (usize, usize),
	/// zsh's terminal capabilities for `$TERM` (`init_term`), and the
	/// `$TERM` they belong to.
	pub caps:
		Option<(bstr::BString, std::sync::Arc<crate::bash::vm::builtins::zsh_prompt::TermCaps>)>,
}

impl Clone for Tty {
	/// A subshell's copy: the same terminal, nothing pending.
	fn clone(&self) -> Self {
		Self {
			file:    self.file.clone(),
			out:     Vec::new(),
			eofchar: self.eofchar,
			raw:     self.raw,
			fetch:   self.fetch,
			size:    self.size,
			caps:    self.caps.clone(),
		}
	}
}

impl Tty {
	/// The editing terminal: job control's SHTTY; `None` without one (not
	/// interactive on a terminal: no line editor).
	pub fn open(k: &Kernel) -> Option<Self> {
		let file = jobctl::shtty_file(k)?;
		Some(Self {
			file,
			out: Vec::new(),
			eofchar: None,
			raw: false,
			fetch: false,
			size: (80, 24),
			caps: None,
		})
	}

	/// zsh `zsetterm`: the shell's normal modes, sanitized (canonical
	/// input and echo on, `FLUSHO` off), become the saved modes; ZLE's
	/// modes are those without canonical input and echo, the quit,
	/// discard, suspend and literal-next characters disabled (start/stop
	/// too without `flowcontrol`), one byte at a time, CR and NL swapped
	/// on input (undone byte by byte when reading).
	pub fn zsetterm(&mut self, k: &mut Kernel, cx: &mut Cx<'_>, flowcontrol: bool) {
		let Some(h) = self.file.os_handle() else {
			return;
		};
		let Some(term) = cx.host.terminal() else {
			return;
		};
		if self.fetch {
			if let Ok(now) = term.attrs(h) {
				jobctl::set_shell_modes(k, now);
			}
			self.fetch = false;
		}
		let Some(mut sh) = jobctl::shell_modes(k).cloned() else {
			return;
		};
		sh.set(TermFlag::Icanon, true);
		sh.set(TermFlag::Echo, true);
		sh.set(TermFlag::Flusho, false);
		jobctl::set_shell_modes(k, sh.clone());
		let mut ti = sh;
		if !flowcontrol {
			ti.set(TermFlag::Ixon, false);
		}
		ti.set(TermFlag::Icanon, false);
		ti.set(TermFlag::Echo, false);
		ti.set(TermFlag::Flusho, false);
		ti.set(TermFlag::Onlcr, true);
		for c in [
			CtlChar::Quit,
			CtlChar::Discard,
			CtlChar::Susp,
			CtlChar::Dsusp,
			CtlChar::Swtc,
			CtlChar::Lnext,
		] {
			ti.set_char(c, None);
		}
		if !flowcontrol {
			ti.set_char(CtlChar::Start, None);
			ti.set_char(CtlChar::Stop, None);
		}
		self.eofchar = ti.char(CtlChar::Eof);
		ti.min = 1;
		ti.time = 0;
		ti.set(TermFlag::Inlcr, true);
		ti.set(TermFlag::Icrnl, true);
		if term.set_attrs(h, &ti, SetWhen::Drain).is_ok() {
			self.raw = true;
		}
	}

	/// zsh `settyinfo(&shttyinfo)`: back to the shell's normal modes.
	pub fn settyinfo(&mut self, k: &Kernel, cx: &mut Cx<'_>) {
		let Some(h) = self.file.os_handle() else {
			return;
		};
		let (Some(term), Some(sh)) = (cx.host.terminal(), jobctl::shell_modes(k)) else {
			return;
		};
		let _ = term.set_attrs(h, sh, SetWhen::Drain);
		self.raw = false;
	}

	/// The terminal's size, read again (zsh `adjustwinsize`); `None`
	/// when it cannot be read.
	pub fn read_size(&self, cx: &mut Cx<'_>) -> Option<(usize, usize)> {
		let h = self.file.os_handle()?;
		let info = cx.host.terminal()?.size(h).ok()?;
		Some((usize::from(info.cols), usize::from(info.rows)))
	}

	/// Queue display bytes.
	pub fn put(&mut self, bytes: &[u8]) {
		self.out.extend_from_slice(bytes);
	}

	/// Write what is queued; the wait key while the terminal will not
	/// take more. A write error drops the bytes (zsh ignores them too).
	pub fn flush(&mut self, k: &Kernel) -> Option<WaitKey> {
		let mut tcx = Context::from_waker(&k.waker);
		let mut off = 0;
		while off < self.out.len() {
			match self.file.poll_write(&mut tcx, &self.out[off..]) {
				Poll::Ready(Ok(n)) if n > 0 => off += n,
				Poll::Ready(_) => {
					off = self.out.len();
				},
				Poll::Pending => {
					self.out.drain(..off);
					return Some(WaitKey::Write { fd: FD });
				},
			}
		}
		self.out.clear();
		None
	}

	/// One byte typed, if one is there (`Ok(None)`: nothing yet, the
	/// engine's waker is registered); `Err` at end of file
	/// (`UnexpectedEof`) or on a read error.
	pub fn read_byte(&self, k: &Kernel) -> std::io::Result<Option<u8>> {
		let mut tcx = Context::from_waker(&k.waker);
		let mut b = [0u8; 1];
		match self.file.poll_read(&mut tcx, &mut b) {
			Poll::Ready(Ok(1)) => Ok(Some(b[0])),
			Poll::Ready(Ok(_)) => Err(std::io::ErrorKind::UnexpectedEof.into()),
			Poll::Ready(Err(e)) => Err(e),
			Poll::Pending => Ok(None),
		}
	}

	/// zsh `noquery(0)` for `$PENDING`: input waiting on the terminal.
	/// The engine can tell only whether some is there, not how much: 1
	/// when there is, else 0.
	pub fn pending_input(&self) -> usize {
		let waker = std::task::Waker::noop();
		let mut tcx = Context::from_waker(waker);
		usize::from(self.file.poll_read(&mut tcx, &mut []).is_ready())
	}
}
