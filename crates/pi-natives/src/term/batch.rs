//! The typed op emitter: one method per terminal op, encoding its escape
//! sequence into the device's output buffer and recording what it changed.

use std::fmt::NumBuffer;

use super::{
	mode,
	state::{Frame, State},
};

// tmux expires synchronized output after one second. Renew during large
// replays as the output queue drains, at complete sequence/row boundaries.
const SYNC_RENEW_BYTES: usize = 16 * 1024;

const KEYBOARD_POP: &[u8] = b"\x1b[<u";
/// OSC 9;4 with state 0; the trailing `;` is part of the sequence.
const PROGRESS_CLEAR: &[u8] = b"\x1b]9;4;0;\x07";

/// One ordered batch of terminal output, open for the duration of a
/// [`Device::emit`](super::Device::emit) call.
///
/// Every method appends one op and returns `self` for chaining. Counts are
/// always written with an explicit parameter (`CSI 1 B`, never `CSI B`); a
/// zero count writes nothing.
///
/// # Examples
/// ```ignore
/// device.emit(|batch| {
/// 	batch
/// 		.frame_begin(true, false)
/// 		.move_to(3, 1)
/// 		.text(row)
/// 		.erase_line_to_end()
/// 		.frame_end();
/// });
/// ```
pub(crate) struct Batch<'a> {
	state:    &'a mut State,
	/// The sink's UTF-8 buffer; this batch owns everything from `start` on.
	out:      &'a mut Vec<u8>,
	/// End offset of every op, for a sink that may only be cut between ops.
	marks:    Option<&'a mut Vec<usize>>,
	/// Length of `out` after the previous op.
	op_start: usize,
}

impl<'a> Batch<'a> {
	pub(super) const fn new(
		state: &'a mut State,
		out: &'a mut Vec<u8>,
		marks: Option<&'a mut Vec<usize>>,
	) -> Self {
		let op_start = out.len();
		Self { state, out, marks, op_start }
	}
}

impl Batch<'_> {
	/// Opaque output written verbatim: row content, image payloads. Escape
	/// sequences inside it are not tracked.
	pub(crate) fn text(&mut self, text: &str) -> &mut Self {
		self.out.extend_from_slice(text.as_bytes());
		self.end_op()
	}

	/// CUP to a 1-based row and column (`CSI row ; col H`).
	pub(crate) fn move_to(&mut self, row: u32, col: u32) -> &mut Self {
		self.out.extend_from_slice(b"\x1b[");
		self.number(row);
		self.out.push(b';');
		self.number(col);
		self.out.push(b'H');
		self.end_op()
	}

	/// CUP with no parameters (`CSI H`).
	pub(crate) fn home(&mut self) -> &mut Self {
		self.sequence(b"\x1b[H")
	}

	/// CUU (`CSI n A`).
	pub(crate) fn up(&mut self, rows: u32) -> &mut Self {
		self.counted(rows, b"A")
	}

	/// CUD (`CSI n B`).
	pub(crate) fn down(&mut self, rows: u32) -> &mut Self {
		self.counted(rows, b"B")
	}

	/// CUF (`CSI n C`).
	pub(crate) fn forward(&mut self, columns: u32) -> &mut Self {
		self.counted(columns, b"C")
	}

	/// CHA to a 1-based column (`CSI col G`).
	pub(crate) fn column(&mut self, col: u32) -> &mut Self {
		self.param(b"\x1b[", col, b"G")
	}

	/// `\r`.
	pub(crate) fn cr(&mut self) -> &mut Self {
		self.sequence(b"\r")
	}

	/// `\n`, `count` times.
	pub(crate) fn lf(&mut self, count: u32) -> &mut Self {
		self.out.resize(self.out.len() + count as usize, b'\n');
		self.end_op()
	}

	/// EL0 (`CSI K`).
	pub(crate) fn erase_line_to_end(&mut self) -> &mut Self {
		self.sequence(b"\x1b[K")
	}

	/// EL2 (`CSI 2 K`).
	pub(crate) fn erase_line(&mut self) -> &mut Self {
		self.sequence(b"\x1b[2K")
	}

	/// ED0 (`CSI J`).
	pub(crate) fn erase_below(&mut self) -> &mut Self {
		self.sequence(b"\x1b[J")
	}

	/// ED2 (`CSI 2 J`).
	pub(crate) fn erase_screen(&mut self) -> &mut Self {
		self.sequence(b"\x1b[2J")
	}

	/// ED3 (`CSI 3 J`).
	pub(crate) fn erase_scrollback(&mut self) -> &mut Self {
		self.sequence(b"\x1b[3J")
	}

	/// IL (`CSI n L`).
	pub(crate) fn insert_lines(&mut self, count: u32) -> &mut Self {
		self.counted(count, b"L")
	}

	/// DL (`CSI n M`).
	pub(crate) fn delete_lines(&mut self, count: u32) -> &mut Self {
		self.counted(count, b"M")
	}

	/// DECSC (`ESC 7`).
	pub(crate) fn save_cursor(&mut self) -> &mut Self {
		self.sequence(b"\x1b7")
	}

	/// DECRC (`ESC 8`).
	pub(crate) fn restore_cursor(&mut self) -> &mut Self {
		self.sequence(b"\x1b8")
	}

	/// One SGR parameter (`CSI param m`): 0 reset, 8 conceal, 28 reveal.
	pub(crate) fn sgr(&mut self, param: u32) -> &mut Self {
		self.param(b"\x1b[", param, b"m")
	}

	/// DECSET (`CSI ? mode h`). With `dedupe`, nothing is written when the
	/// device last wrote this mode as set; an unknown mode is always written.
	/// See [`mode::ALT_SCREEN`] for what entering the alternate screen adds.
	pub(crate) fn set_mode(&mut self, mode: u32, dedupe: bool) -> &mut Self {
		self.dec_mode(mode, true, dedupe)
	}

	/// DECRST (`CSI ? mode l`). With `dedupe`, nothing is written when the
	/// device last wrote this mode as reset; an unknown mode is always
	/// written.
	pub(crate) fn reset_mode(&mut self, mode: u32, dedupe: bool) -> &mut Self {
		self.dec_mode(mode, false, dedupe)
	}

	/// DECKPNM (`ESC >`).
	pub(crate) fn keypad_numeric(&mut self) -> &mut Self {
		self.sequence(b"\x1b>")
	}

	/// DECSCUSR (`CSI code SP q`): 0 default, 2 block, 4 underline, 6 bar.
	/// Nothing is written when `code` is the last shape written.
	pub(crate) fn cursor_shape(&mut self, code: u32) -> &mut Self {
		if self.state.cursor_shape == Some(code) {
			return self;
		}
		self.state.cursor_shape = Some(code);
		self.param(b"\x1b[", code, b" q")
	}

	/// Push a kitty keyboard frame (`CSI > flags u`).
	pub(crate) fn keyboard_push(&mut self, flags: u32) -> &mut Self {
		self.state.kitty = Some(flags);
		self.param(b"\x1b[>", flags, b"u")
	}

	/// Pop a kitty keyboard frame (`CSI < u`).
	pub(crate) fn keyboard_pop(&mut self) -> &mut Self {
		self.state.kitty = None;
		self.sequence(KEYBOARD_POP)
	}

	/// xterm modifyOtherKeys level (`CSI > 4 ; level m`); 0 disables.
	pub(crate) fn modify_other_keys(&mut self, level: u32) -> &mut Self {
		self.state.modify_other_keys = level != 0;
		self.param(b"\x1b[>4;", level, b"m")
	}

	/// Window title (`OSC 0 ; title BEL`).
	pub(crate) fn title(&mut self, title: &str) -> &mut Self {
		self.out.extend_from_slice(b"\x1b]0;");
		self.out.extend_from_slice(title.as_bytes());
		self.out.push(0x07);
		self.end_op()
	}

	/// OSC 9;4 progress indicator: 0 clears it, 3 is indeterminate.
	pub(crate) fn progress(&mut self, state: u32) -> &mut Self {
		self.state.progress = state != 0;
		if state == 0 {
			self.sequence(PROGRESS_CLEAR)
		} else {
			self.param(b"\x1b]9;4;", state, b"\x07")
		}
	}

	/// DA1 (`CSI c`): the probe sentinel.
	pub(crate) fn query_device_attributes(&mut self) -> &mut Self {
		self.sequence(b"\x1b[c")
	}

	/// DSR 6 (`CSI 6 n`): cursor position report.
	pub(crate) fn query_cursor_position(&mut self) -> &mut Self {
		self.sequence(b"\x1b[6n")
	}

	/// DECRQM (`CSI ? mode $ p`).
	pub(crate) fn query_private_mode(&mut self, mode: u32) -> &mut Self {
		self.param(b"\x1b[?", mode, b"$p")
	}

	/// kitty keyboard flags query (`CSI ? u`).
	pub(crate) fn query_keyboard(&mut self) -> &mut Self {
		self.sequence(b"\x1b[?u")
	}

	/// Open a paint bracket: hide the cursor, open DEC 2026 when `sync`,
	/// disable autowrap. With `sync` and `renew`, DEC 2026 is re-opened
	/// between ops every 16 KiB until [`frame_end`](Self::frame_end).
	///
	/// The hardware cursor is hidden before each paint: Ghostty-style bar
	/// cursors can otherwise leave visual afterimages while the row under a
	/// visible cursor is repainted. Autowrap is disabled because several
	/// terminals keep a "pending wrap" flag after an exact-width row, so a
	/// following cursor move can first wrap to the next row and produce
	/// staircase trails; paints emit explicit `\r\n` instead. Synchronized
	/// output is optional because some terminals have broken DEC 2026
	/// implementations; autowrap discipline stays on either way.
	pub(crate) fn frame_begin(&mut self, sync: bool, renew: bool) -> &mut Self {
		self.out.extend_from_slice(b"\x1b[?25l");
		self.state.record(mode::CURSOR_VISIBLE, false);
		if sync {
			self.out.extend_from_slice(b"\x1b[?2026h");
			self.state.record(mode::SYNCHRONIZED_OUTPUT, true);
		}
		self.out.extend_from_slice(b"\x1b[?7l");
		self.state.record(mode::AUTOWRAP, false);
		self.state.frame = Some(Frame { sync, renew: sync && renew, emitted: 0 });
		self.end_op()
	}

	/// Close the bracket opened by [`frame_begin`](Self::frame_begin):
	/// autowrap on, DEC 2026 closed if the frame opened it.
	pub(crate) fn frame_end(&mut self) -> &mut Self {
		self.out.extend_from_slice(b"\x1b[?7h");
		self.state.record(mode::AUTOWRAP, true);
		if self.state.frame.take().is_some_and(|frame| frame.sync) {
			self.out.extend_from_slice(b"\x1b[?2026l");
			self.state.record(mode::SYNCHRONIZED_OUTPUT, false);
		}
		self.end_op()
	}

	/// Mark cursor visibility unknown (resize, reattach) without writing
	/// anything.
	pub(crate) fn forget_cursor(&mut self) -> &mut Self {
		self.state.forget(mode::CURSOR_VISIBLE);
		self
	}

	/// Undo, in a fixed order, everything the device knows it changed and
	/// every mode the terminal layer may have left on.
	pub(super) fn restore(&mut self) {
		if self.state.progress {
			self.out.extend_from_slice(PROGRESS_CLEAR);
			self.state.progress = false;
		}

		// Keyboard enhancement state is screen-local: pop the alt-screen frame
		// before leaving it; the main-screen frame is popped below. DECRST 1049
		// must never be written blindly, because Windows' shared VT dispatcher
		// (conhost and Windows Terminal both use AdaptDispatch) executes an
		// unconditional cursor restore on it — with no prior DECSC save the
		// cursor jumps to the viewport home, dropping the parent shell prompt on
		// top of the dead frame after exit.
		if self.state.alt_screen() {
			if self.state.kitty.is_some() {
				self.out.extend_from_slice(KEYBOARD_POP);
			}
			self.put_mode(mode::ALT_SCREEN, false);
		}

		// Leave paint-time terminal modes even if the process exits between the
		// begin/end halves of a frame. Safe no-ops on terminals that ignored
		// them.
		self.put_mode(mode::SYNCHRONIZED_OUTPUT, false);
		self.put_mode(mode::AUTOWRAP, true);
		self.state.frame = None;

		// Restore normal cursor-key (DECCKM) and numeric-keypad mode (terminfo
		// `rmkx`). Symmetric with the normalize at startup: a TTY-sharing child
		// can leave the terminal in application-cursor-keys mode, and without
		// this reset the parent shell inherits SS3 arrows so Up/Down history
		// navigation stays broken after omp exits (#6374).
		self.put_mode(mode::CURSOR_KEYS, false);
		self.out.extend_from_slice(b"\x1b>");

		self.put_mode(mode::BRACKETED_PASTE, false);
		self.put_mode(mode::PASTE_EVENTS, false);

		// Hand the cursor shape back to the user's terminal configuration; a Vim
		// Normal-mode block must not outlive the session in their shell.
		if self.state.cursor_shape.is_some_and(|code| code != 0) {
			self.out.extend_from_slice(b"\x1b[0 q");
			self.state.cursor_shape = Some(0);
		}

		// Disable mouse tracking (enabled only by fullscreen overlays; safe
		// no-ops otherwise). Covers crash paths that reach the restore without
		// the overlay's own teardown running.
		self.put_mode(mode::MOUSE_SGR, false);
		self.put_mode(mode::MOUSE_MOTION, false);
		self.put_mode(mode::MOUSE_CLICKS, false);

		self.put_mode(mode::APPEARANCE_REPORTS, false);

		// Xterm ?1010/?1011 are disabled while omp owns the TTY so typing does
		// not force a reader scrolled into native history back to the tail; set
		// again only the ones this session reset.
		for scroll in [mode::SCROLL_ON_OUTPUT, mode::SCROLL_ON_KEY] {
			if self.state.mode(scroll) == Some(false) {
				self.put_mode(scroll, true);
			}
		}

		if self.state.mode(mode::IN_BAND_RESIZE) == Some(true) {
			self.put_mode(mode::IN_BAND_RESIZE, false);
		}

		if self.state.kitty.take().is_some() {
			self.out.extend_from_slice(KEYBOARD_POP);
		}
		if self.state.modify_other_keys {
			self.out.extend_from_slice(b"\x1b[>4;0m");
			self.state.modify_other_keys = false;
		}
		if self.state.mode(mode::WIN32_INPUT) == Some(true) {
			self.put_mode(mode::WIN32_INPUT, false);
		}

		self.put_mode(mode::CURSOR_VISIBLE, true);
		self.end_op();
	}

	fn dec_mode(&mut self, mode: u32, set: bool, dedupe: bool) -> &mut Self {
		if dedupe && self.state.mode(mode) == Some(set) {
			return self;
		}
		if mode == mode::ALT_SCREEN {
			self.switch_screen(set);
		} else {
			self.put_mode(mode, set);
		}
		self.end_op()
	}

	/// Enter or leave the alternate screen, carrying the keyboard enhancement
	/// across the switch.
	fn switch_screen(&mut self, enter: bool) {
		let kitty = self.state.kitty;
		if enter {
			self.put_mode(mode::ALT_SCREEN, true);
			// kitty keyboard flags are a per-screen stack, so the alternate screen
			// starts without omp's frame: push it again. xterm modifyOtherKeys is
			// one global flag, re-asserted for hosts that reset it on the switch.
			if let Some(flags) = kitty {
				self.put(b"\x1b[>", flags, b"u");
			} else if self.state.modify_other_keys {
				self.out.extend_from_slice(b"\x1b[>4;2m");
			}
		} else {
			// The matching pop balances the push made on entry. xterm
			// modifyOtherKeys is a single global flag with no per-screen stack —
			// emitting `>4;0m` here would clear it on the normal screen too,
			// breaking the composer between overlays. The exit restore still
			// disables it globally.
			if kitty.is_some() {
				self.out.extend_from_slice(KEYBOARD_POP);
			}
			self.put_mode(mode::ALT_SCREEN, false);
			// `CSI = flags ; 1 u` replaces the main-screen stack top, which is
			// omp's own frame, so it is a no-op wherever per-screen stacks work.
			// Windows Terminal 1.25–1.27 restore the pre-push flags on `?1049l`
			// (microsoft/terminal#20763), dropping to legacy keys: Shift+Enter
			// arrives as `\r`, Ctrl+Enter as `\n`.
			if let Some(flags) = kitty {
				self.put(b"\x1b[=", flags, b";1u");
			}
		}
		// Some hosts keep DECTCEM per screen buffer: after a switch the
		// cursor's visibility is unknown until written again.
		self.state.forget(mode::CURSOR_VISIBLE);
	}

	/// Write `CSI ? mode h|l` and record it.
	fn put_mode(&mut self, mode: u32, set: bool) {
		self.put(b"\x1b[?", mode, if set { b"h" } else { b"l" });
		self.state.record(mode, set);
	}

	/// Write `intro n fin` as part of the current op.
	fn put(&mut self, intro: &[u8], n: u32, fin: &[u8]) {
		self.out.extend_from_slice(intro);
		self.number(n);
		self.out.extend_from_slice(fin);
	}

	/// Write `n` in decimal as part of the current op.
	fn number(&mut self, n: u32) {
		self
			.out
			.extend_from_slice(n.format_into(&mut NumBuffer::new()).as_bytes());
	}

	/// A fixed sequence as one op.
	fn sequence(&mut self, bytes: &[u8]) -> &mut Self {
		self.out.extend_from_slice(bytes);
		self.end_op()
	}

	/// `intro n fin` as one op.
	fn param(&mut self, intro: &[u8], n: u32, fin: &[u8]) -> &mut Self {
		self.put(intro, n, fin);
		self.end_op()
	}

	/// `CSI count fin` as one op; nothing for a zero count.
	fn counted(&mut self, count: u32, fin: &[u8]) -> &mut Self {
		if count == 0 {
			return self;
		}
		self.param(b"\x1b[", count, fin)
	}

	/// Close the current op, then renew DEC 2026 if the open frame asked for
	/// it and has grown past the renewal size. Renewals only happen here,
	/// between ops, so they never land inside an escape sequence or a row.
	fn end_op(&mut self) -> &mut Self {
		let mut end = self.out.len();
		mark(&mut self.marks, end);
		if let Some(frame) = &mut self.state.frame
			&& frame.renew
		{
			frame.emitted += end - self.op_start;
			if frame.emitted >= SYNC_RENEW_BYTES {
				self.out.extend_from_slice(b"\x1b[?2026h");
				frame.emitted = 0;
				end = self.out.len();
				mark(&mut self.marks, end);
			}
		}
		self.op_start = end;
		self
	}
}

/// Record an op boundary at offset `end`, unless the op wrote nothing.
fn mark(marks: &mut Option<&mut Vec<usize>>, end: usize) {
	if let Some(marks) = marks
		&& marks.last().copied().unwrap_or(0) != end
	{
		marks.push(end);
	}
}
