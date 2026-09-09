//! Terminal-agnostic keyboard and mouse input primitives.

use std::{
	fmt::Write as _,
	mem, str,
	str::FromStr,
	time::{Duration, Instant},
};

use omp_core::Str;
use smallvec::{SmallVec, smallvec};
use xutf::{IntoUnicodeNormalized, Text};

use crate::{
	components::{DiffActionKind, DiffTarget},
	rich::cell_width,
};

// ---------------------------------------------------------------- events

/// Decoded keyboard input, terminal-agnostic.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum Key {
	/// Arrow up: widget-local cursor until the top edge, then focus ring.
	Up,
	/// Arrow down: widget-local cursor until the bottom edge, then ring.
	Down,
	/// Arrow left: chips/enums/number fields consume; else focus ring.
	Left,
	/// Arrow right: chips/enums/number fields consume; else focus ring.
	Right,
	/// Extend the selection one grapheme left.
	SelectLeft,
	/// Extend the selection one grapheme right.
	SelectRight,
	/// Extend the selection one visual row up.
	SelectUp,
	/// Extend the selection one visual row down.
	SelectDown,
	/// Next focusable widget (always escapes the current widget).
	Tab,
	/// Previous focusable widget.
	BackTab,
	/// Activate / choose / newline (editor) / press (button).
	Enter,
	/// Toggle (checkbox/multi) or activate; literal space in text entry.
	Space,
	/// Close popup, then clear filter, then cancel the whole dialog.
	Esc,
	/// Delete before the cursor in text entry.
	Backspace,
	/// Delete under the cursor in text entry.
	Delete,
	/// Insert at the cursor.
	Insert,
	/// Jump to line/list start.
	Home,
	/// Jump to line/list end.
	End,
	/// Extend the selection to the logical line start.
	SelectHome,
	/// Extend the selection to the logical line end.
	SelectEnd,
	/// Scroll one viewport up.
	PageUp,
	/// Scroll one viewport down.
	PageDown,
	/// Function key, numbered from F1 through F12.
	Function(u8),
	/// Ctrl-chord with a letter, normalized to lowercase. Text widgets
	/// implement the readline set (`a e k u w b f d`); others ignore.
	Ctrl(char),
	/// Alt-chord with a letter, normalized to lowercase, for chords without
	/// a canonical cross-terminal meaning (for example, `alt+y` yank-pop).
	/// Encoding variants of one physical intent normalize to their semantic
	/// keys instead and never reach this variant.
	Alt(char),
	/// Ctrl+Alt chord, normalized to lowercase. Used by the backward
	/// character-jump binding and available to embedders for other chords.
	CtrlAlt(char),
	/// Alt+Enter: follow-up to an active turn, or standard submission if idle.
	FollowUp,
	/// Shift+Enter: literal newline in multiline text entry.
	ShiftEnter,
	/// Alt/Shift+Up: restore the newest queued follow-up to the composer.
	RestoreQueue,
	/// Jump to the previous structural landmark (hunk, match, section) in
	/// the focused view. No default chord; hosts bind e.g. `Alt+Up` via
	/// [`Keymap::bind`].
	JumpPrevious,
	/// Jump to the next structural landmark (hunk, match, section) in the
	/// focused view. No default chord; hosts bind e.g. `Alt+Down` via
	/// [`Keymap::bind`].
	JumpNext,
	/// Ctrl+Shift+P: cycle backward through the host's model roster.
	CyclePrevious,
	/// Ctrl+Shift+O: toggle transcript tool-activity visibility.
	ToggleToolVisibility,
	/// Alt+Shift+C: copy the latest prompt to the clipboard.
	CopyPrompt,
	/// Alt+Shift+L: copy the current editor line to the clipboard.
	CopyLine,
	/// Ctrl+Shift+D: open the host's debug-tools overlay.
	DebugMenu,
	/// Alt+Shift+P: toggle the host's planning mode.
	PlanToggle,
	/// Ctrl/Alt+Left: previous word boundary.
	WordLeft,
	/// Ctrl/Alt+Right: next word boundary.
	WordRight,
	/// Extend the selection to the previous word boundary.
	SelectWordLeft,
	/// Extend the selection to the next word boundary.
	SelectWordRight,
	/// Select the complete editable value.
	SelectAll,
	/// Copy the active selection to the clipboard.
	Copy,
	/// Copy the active selection to the clipboard, then delete it.
	Cut,
	/// Alt+D / Alt+Delete: delete forward through the next word end.
	WordDelete,
	/// Ctrl+V: host-driven clipboard paste, preferring images (see the runtime's
	/// clipboard fallback).
	Paste,
	/// Ctrl+Shift+V: host-driven clipboard paste of text only, inserted
	/// verbatim ([`crate::Component::paste_raw`]) — no image or file-URL
	/// interpretation, no drop classification, no large-paste collapse.
	PasteRaw,
	/// Printable input: text entry, type-to-search (`/`), shortcuts.
	Char(char),
}

const INPUT_TIMEOUT: Duration = Duration::from_millis(75);
const PARTIAL_HOLD_TIMEOUT: Duration = Duration::from_millis(150);
const PASTE_INACTIVITY_TIMEOUT: Duration = Duration::from_millis(1000);
const KITTY_DEDUP_TIMEOUT: Duration = Duration::from_millis(25);
const MAX_CSI_BYTES: usize = 4096;
const MAX_STRING_SEQ_BYTES: usize = 16 * 1024 * 1024;
const STRING_DISCARD_MAX_BYTES: usize = 2 * MAX_STRING_SEQ_BYTES;
const STRING_DISCARD_INACTIVITY_TIMEOUT: Duration = Duration::from_millis(1000);
const MAX_PASTE_BYTES: usize = 64 * 1024 * 1024;
const PASTE_END: &[u8] = b"\x1b[201~";

/// A terminal-generated reply separated from user key input.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum TerminalResponse {
	/// Primary or secondary device attributes (`DA`).
	DeviceAttributes(Str),
	/// DEC private-mode report (`DECRPM`).
	ModeReport {
		/// Queried DEC mode.
		mode:   u16,
		/// Mode status reported by the terminal.
		status: u8,
	},
	/// Device-status report (`DSR`), including cursor position.
	DeviceStatus(Str),
	/// Kitty keyboard protocol flags.
	KittyKeyboardFlags(u8),
	/// Operating-system command reply, without its framing bytes.
	Osc(Str),
	/// Kitty graphics APC reply, without its framing bytes.
	KittyGraphics(Str),
	/// Device-control string reply, without its framing bytes.
	DeviceControlString(Str),
	/// OSC 11 terminal background-color report.
	OscColor {
		/// OSC color-table index (11 for the terminal background).
		index: u8,
		/// Red component normalized to 16 bits.
		r:     u16,
		/// Green component normalized to 16 bits.
		g:     u16,
		/// Blue component normalized to 16 bits.
		b:     u16,
	},
	/// DEC mode 2031 appearance notification (`1` dark, `2` light).
	AppearanceChanged(u8),
	/// DEC mode 2048 in-band resize report.
	InBandResize {
		/// Terminal rows.
		rows: u16,
		/// Terminal columns.
		cols: u16,
		/// Cell width in pixels.
		x_px: u16,
		/// Cell height in pixels.
		y_px: u16,
	},
	/// Non-kitty application-program command reply, without its framing bytes.
	ApplicationProgramCommand(Str),
}
/// Physical button encoded by an SGR mouse report.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum MouseButton {
	/// Left button.
	Left,
	/// Middle button.
	Middle,
	/// Right button.
	Right,
	/// Vertical wheel up.
	WheelUp,
	/// Vertical wheel down.
	WheelDown,
	/// Horizontal wheel left.
	WheelLeft,
	/// Horizontal wheel right.
	WheelRight,
	/// Motion without a pressed button, or an unknown button code.
	None,
}

/// Modifier bits attached to terminal input.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Mods {
	/// Shift was held.
	pub shift:     bool,
	/// Alt was held.
	pub alt:       bool,
	/// Control was held.
	pub ctrl:      bool,
	/// Super (Command/Windows) was held.
	pub super_key: bool,
	/// Hyper was held.
	pub hyper:     bool,
	/// Meta was held.
	pub meta:      bool,
}

/// Lossless SGR mouse report with its routable gesture kind.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct MouseReport {
	/// Gesture routed to widgets.
	pub kind:    Mouse,
	/// Zero-based column.
	pub col:     u16,
	/// Zero-based row.
	pub row:     u16,
	/// Physical button or wheel direction.
	pub button:  MouseButton,
	/// Keyboard modifiers encoded in the button bitfield.
	pub mods:    Mods,
	/// `true` for an `M` report and `false` for an `m` release report.
	pub pressed: bool,
}

/// One physical key edge with its keymap resolution, emitted instead of
/// [`InputEvent::Key`] once [`Keymap::set_chord_events`] is on.
///
/// `chord` is the terminal's exact report (key plus every modifier), so a
/// host can look the edge up in a `bind` table by its canonical spelling
/// ([`Chord::label`]); `key` is what the keymap would have emitted for it
/// (`None` for chords the keymap drops). Kitty release reports arrive with
/// `pressed == false`; repeats count as presses.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct KeyEvent {
	/// The exact physical chord.
	pub chord:   Chord,
	/// Keymap resolution of `chord`.
	pub key:     Option<Key>,
	/// `true` for press and repeat, `false` for a Kitty release report.
	pub pressed: bool,
}

/// One framed event from the streaming terminal input decoder.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum InputEvent {
	/// Keyboard input.
	Key(Key),
	/// A physical key edge (press or release) with its resolution; replaces
	/// [`InputEvent::Key`] while the keymap emits chord events.
	Chord(KeyEvent),
	/// Lossless SGR mouse input.
	Mouse(MouseReport),
	/// Sanitized bracketed-paste text.
	Paste(Str),
	/// Focus gained (`true`) or lost (`false`).
	Focus(bool),
	/// A terminal-generated capability or status reply.
	Response(TerminalResponse),
}

/// Stateful terminal input framer.
///
/// Incomplete escape sequences and UTF-8 scalars remain buffered until a
/// later [`feed`](Self::feed) call completes them or [`tick`](Self::tick)
/// reaches their deterministic timeout.
#[derive(Default)]
pub struct InputDecoder {
	keymap:                Keymap,
	buffer:                Vec<u8>,
	incomplete_since:      Option<Instant>,
	kitty_keyboard_active: bool,
	pending_kitty_print:   Option<(u32, Instant)>,
	paste:                 Vec<u8>,
	paste_active:          bool,
	paste_last_input:      Option<Instant>,
	paste_scan_from:       usize,
	/// Reassembly buffer for a private-CSI report whose prefix outlived the
	/// partial hold; empty when disarmed. See
	/// [`InputDecoder::reassemble_private_csi`].
	private_csi_partial:   Vec<u8>,
	string_discard:        Option<StringDiscard>,
}
#[derive(Clone, Copy, Debug)]
struct StringDiscard {
	bytes:    usize,
	esc_held: bool,
	last:     Instant,
}

impl InputDecoder {
	/// Creates an empty decoder using bounded timeout and size limits.
	pub fn new() -> Self {
		Self {
			keymap:                Keymap::default(),
			buffer:                Vec::new(),
			incomplete_since:      None,
			kitty_keyboard_active: false,
			pending_kitty_print:   None,
			paste:                 Vec::new(),
			paste_active:          false,
			paste_last_input:      None,
			paste_scan_from:       0,
			private_csi_partial:   Vec::new(),
			string_discard:        None,
		}
	}

	/// Returns the active chord-to-key map.
	pub const fn keymap(&self) -> &Keymap {
		&self.keymap
	}

	/// Returns the active chord-to-key map for rebinding.
	///
	/// Changes apply to the next chord emitted by the decoder.
	pub const fn keymap_mut(&mut self) -> &mut Keymap {
		&mut self.keymap
	}

	/// Emits one physical chord exactly as if the terminal had reported it:
	/// resolved through the live keymap and delivered as a chord edge or a
	/// semantic key by the same rule as decoded bytes. Debug key injection
	/// rides this path so a bound chord runs its bind instead of typing.
	pub fn inject(&self, chord: Chord, out: &mut Vec<InputEvent>) {
		emit_chord(&self.keymap, chord, out);
	}

	/// Tells the framer whether Kitty keyboard reporting is active.
	///
	/// Active Kitty mode extends the hold for every partial escape because a
	/// bare escape is then itself reported as CSI-u.
	pub const fn set_kitty_keyboard(&mut self, active: bool) {
		self.kitty_keyboard_active = active;
	}

	/// Feeds one arbitrary byte chunk and appends every completed event to
	/// `out`.
	pub fn feed(&mut self, bytes: &[u8], now: Instant, out: &mut Vec<InputEvent>) {
		self.expire_paste(now, out);
		self.expire_partial(now, out);
		self.expire_string_discard(now);
		let bytes = self.consume_string_discard(bytes, now);
		if bytes.is_empty() {
			return;
		}
		let bytes = self.reassemble_private_csi(bytes, out);
		if self.paste_active {
			self.paste.extend_from_slice(bytes);
			self.paste_last_input = Some(now);
			self.process_paste(now, out);
			return;
		}
		self.buffer.extend_from_slice(bytes);
		self.process_buffer(now, out);
	}

	/// Continues a private-CSI report whose prefix outlived the partial
	/// hold, returning the suffix of `bytes` that remains ordinary input.
	///
	/// A private CSI (`ESC [ ?` / `ESC [ >`) is a terminal->host report,
	/// never a keystroke, so reassembly stays armed for the whole session:
	/// a Device-Attributes reply split by a slow SSH/PTY link must not leak
	/// its tail into the composer as literal text.
	fn reassemble_private_csi<'a>(
		&mut self,
		bytes: &'a [u8],
		out: &mut Vec<InputEvent>,
	) -> &'a [u8] {
		if self.private_csi_partial.is_empty() {
			return bytes;
		}
		for (index, &byte) in bytes.iter().enumerate() {
			match byte {
				// Parameter and intermediate bytes extend the report; a
				// runaway sequence resets instead of growing without bound.
				0x20..=0x3f => {
					self.private_csi_partial.push(byte);
					if self.private_csi_partial.len() > MAX_CSI_BYTES {
						self.private_csi_partial.clear();
						return &bytes[index + 1..];
					}
				},
				// Final byte: the report is complete. Recognized replies
				// surface as structured responses; anything else is dropped
				// — a late or unowned report is never typed input.
				0x40..=0x7e => {
					self.private_csi_partial.push(byte);
					let sequence = mem::take(&mut self.private_csi_partial);
					if let Decoded::Event(event) = decode_frame(&sequence) {
						out.push(event);
					}
					return &bytes[index + 1..];
				},
				// An escape or control byte can never continue a report:
				// abandon the stale partial (terminal noise, not keystrokes)
				// and process the new bytes normally.
				_ => {
					self.private_csi_partial.clear();
					return &bytes[index..];
				},
			}
		}
		&[]
	}

	/// Advances timeout-driven recovery without reading input.
	pub fn tick(&mut self, now: Instant, out: &mut Vec<InputEvent>) {
		self.expire_paste(now, out);
		self.expire_partial(now, out);
	}

	/// Earliest instant at which [`tick`](Self::tick) could release buffered
	/// input, or `None` when nothing is pending. May be conservative; `tick`
	/// re-checks the active deadline.
	pub fn deadline(&self) -> Option<Instant> {
		[
			self.incomplete_since.map(|at| at + INPUT_TIMEOUT),
			self
				.paste_last_input
				.map(|at| at + PASTE_INACTIVITY_TIMEOUT),
			self
				.string_discard
				.map(|discard| discard.last + STRING_DISCARD_INACTIVITY_TIMEOUT),
		]
		.into_iter()
		.flatten()
		.min()
	}

	fn process_buffer(&mut self, now: Instant, out: &mut Vec<InputEvent>) {
		loop {
			if self.buffer.is_empty() {
				self.incomplete_since = None;
				return;
			}
			if self.buffer.starts_with(b"\x1b\x1b[<") {
				self.emit(Decoded::Chord(Chord::plain(Key::Esc)), now, out);
				self.buffer.drain(..1);
				continue;
			}
			let resolution = resolve_frame(&self.buffer);
			match resolution {
				FrameResolution::Incomplete => {
					self.incomplete_since.get_or_insert(now);
					return;
				},
				FrameResolution::Overflow(length) => {
					if is_string_sequence(&self.buffer) {
						self.buffer.clear();
						self.enter_string_discard(now);
						continue;
					}
					if !emit_unterminated_response(&self.buffer[..length], out) {
						emit_raw(&self.buffer[..length], &self.keymap, out);
					}
					self.pending_kitty_print = None;
					self.buffer.drain(..length);
					self.incomplete_since = None;
				},
				FrameResolution::Complete(length) => {
					let decoded = decode_frame(&self.buffer[..length]);
					self.buffer.drain(..length);
					self.incomplete_since = None;
					if matches!(decoded, Decoded::PasteStart) {
						self.paste_active = true;
						self.paste_last_input = Some(now);
						self.paste_scan_from = 0;
						self.paste.clear();
						self.paste.append(&mut self.buffer);
						self.process_paste(now, out);
						if self.paste_active {
							return;
						}
					} else {
						self.emit(decoded, now, out);
					}
				},
			}
		}
	}

	fn process_paste(&mut self, now: Instant, out: &mut Vec<InputEvent>) {
		let start = self.paste_scan_from.saturating_sub(PASTE_END.len() - 1);
		let end = self.paste[start..]
			.windows(PASTE_END.len())
			.position(|window| window == PASTE_END)
			.map(|offset| start + offset);
		if let Some(end) = end {
			let remaining = self.paste.split_off(end + PASTE_END.len());
			self.paste.truncate(end);
			self.finish_paste(out);
			self.buffer = remaining;
			self.process_buffer(now, out);
			return;
		}
		self.paste_scan_from = self.paste.len();
		if self.paste.len() > MAX_PASTE_BYTES {
			self.finish_paste(out);
		}
	}

	fn finish_paste(&mut self, out: &mut Vec<InputEvent>) {
		let bytes = mem::take(&mut self.paste);
		let decoded = decode_reencoded_paste_controls(&bytes);
		out.push(InputEvent::Paste(Str::from(sanitize_paste(&decoded))));
		self.paste_active = false;
		self.paste_last_input = None;
		self.paste_scan_from = 0;
		self.pending_kitty_print = None;
	}

	fn expire_paste(&mut self, now: Instant, out: &mut Vec<InputEvent>) {
		if self.paste_active
			&& self
				.paste_last_input
				.is_some_and(|last| now.saturating_duration_since(last) >= PASTE_INACTIVITY_TIMEOUT)
		{
			self.finish_paste(out);
		}
	}

	fn expire_partial(&mut self, now: Instant, out: &mut Vec<InputEvent>) {
		let Some(since) = self.incomplete_since else {
			return;
		};
		let extended = self.kitty_keyboard_active || is_sgr_mouse_partial(&self.buffer);
		let timeout = if extended {
			INPUT_TIMEOUT + PARTIAL_HOLD_TIMEOUT
		} else {
			INPUT_TIMEOUT
		};
		if now.saturating_duration_since(since) < timeout {
			return;
		}
		let buffered = mem::take(&mut self.buffer);
		self.incomplete_since = None;
		self.pending_kitty_print = None;
		if is_private_csi_report_partial(&buffered) {
			// A `CSI ?…` / `CSI >…` prefix flushed mid-sequence is the start
			// of a terminal report split by a slow link. Swallowing it here
			// and reassembling with later bytes keeps the reply out of the
			// composer for the whole session.
			self.private_csi_partial = buffered;
			return;
		}
		if is_string_sequence(&buffered) {
			self.enter_string_discard(now);
			return;
		}
		if !emit_unterminated_response(&buffered, out) {
			if buffered == b"\x1b\x1b" {
				emit_chord(&self.keymap, Chord::plain(Key::Esc), out);
				emit_chord(&self.keymap, Chord::plain(Key::Esc), out);
			} else {
				emit_raw(&buffered, &self.keymap, out);
			}
		}
	}

	fn emit(&mut self, decoded: Decoded, now: Instant, out: &mut Vec<InputEvent>) {
		let (event, chords, kitty_dedup, bare) = match decoded {
			Decoded::Event(event) => (Some(event), SmallVec::new(), None, false),
			Decoded::Chord(chord) => (None, smallvec![chord], None, false),
			Decoded::Release(chord) => {
				// Releases never take part in the press dedup window and only
				// hosts that asked for edges see them.
				if self.keymap.chords {
					out.push(InputEvent::Chord(KeyEvent {
						chord,
						key: self.keymap.resolve(chord),
						pressed: false,
					}));
				}
				return;
			},
			Decoded::BareChord(chord) => (None, smallvec![chord], None, true),
			Decoded::KittyChord(chord) => {
				let dedup = chord_printable_codepoint(chord);
				(None, smallvec![chord], dedup, false)
			},
			Decoded::KittyText { chords, dedup } => (None, chords, dedup, false),
			Decoded::PasteStart | Decoded::None => return,
		};
		let bare_printable = (bare && chords.len() == 1)
			.then(|| chord_printable_codepoint(chords[0]))
			.flatten();
		if bare_printable.is_some_and(|printable| {
			self.pending_kitty_print.is_some_and(|(codepoint, at)| {
				printable == codepoint && now.saturating_duration_since(at) <= KITTY_DEDUP_TIMEOUT
			})
		}) {
			self.pending_kitty_print = None;
			return;
		}
		self.pending_kitty_print = kitty_dedup.map(|codepoint| (codepoint, now));
		if let Some(InputEvent::Response(TerminalResponse::KittyKeyboardFlags(flags))) = event {
			self.kitty_keyboard_active = flags != 0;
			out.push(InputEvent::Response(TerminalResponse::KittyKeyboardFlags(flags)));
		} else if let Some(event) = event {
			out.push(event);
		} else {
			for chord in chords {
				emit_chord(&self.keymap, chord, out);
			}
		}
	}

	const fn enter_string_discard(&mut self, now: Instant) {
		self.string_discard = Some(StringDiscard { bytes: 0, esc_held: false, last: now });
	}

	fn expire_string_discard(&mut self, now: Instant) {
		if self.string_discard.is_some_and(|discard| {
			now.saturating_duration_since(discard.last) >= STRING_DISCARD_INACTIVITY_TIMEOUT
		}) {
			self.string_discard = None;
		}
	}

	fn consume_string_discard<'a>(&mut self, bytes: &'a [u8], now: Instant) -> &'a [u8] {
		let Some(discard) = self.string_discard.as_mut() else {
			return bytes;
		};
		if discard.esc_held {
			discard.esc_held = false;
			if bytes.first() == Some(&b'\\') {
				self.string_discard = None;
				return &bytes[1..];
			}
		}
		for (index, byte) in bytes.iter().copied().enumerate() {
			if byte == 0x07 {
				self.string_discard = None;
				return &bytes[index + 1..];
			}
			if byte == 0x1b {
				if bytes.get(index + 1) == Some(&b'\\') {
					self.string_discard = None;
					return &bytes[index + 2..];
				}
				if index + 1 == bytes.len() {
					discard.esc_held = true;
				}
			}
		}
		discard.bytes = discard.bytes.saturating_add(bytes.len());
		discard.last = now;
		if discard.bytes > STRING_DISCARD_MAX_BYTES {
			self.string_discard = None;
		}
		&[]
	}
}
const fn is_string_sequence(bytes: &[u8]) -> bool {
	matches!(bytes, [0x1b, b']' | b'P' | b'_', ..])
}

#[derive(Clone, Debug)]
enum Decoded {
	Event(InputEvent),
	Chord(Chord),
	/// A Kitty key-release report.
	Release(Chord),
	BareChord(Chord),
	KittyChord(Chord),
	KittyText {
		chords: SmallVec<Chord, 4>,
		dedup:  Option<u32>,
	},
	PasteStart,
	None,
}

enum FrameResolution {
	Complete(usize),
	Incomplete,
	Overflow(usize),
}

fn resolve_frame(bytes: &[u8]) -> FrameResolution {
	if bytes[0] != 0x1b {
		let width = utf8_width(bytes[0]);
		return if width > bytes.len() {
			FrameResolution::Incomplete
		} else {
			FrameResolution::Complete(width.max(1))
		};
	}
	if bytes.len() == 1 {
		return FrameResolution::Incomplete;
	}
	if bytes[1] == 0x1b {
		if bytes.len() == 2 {
			return FrameResolution::Incomplete;
		}
		if matches!(bytes[2], b'[' | b'O') {
			return match resolve_escape(&bytes[1..]) {
				FrameResolution::Complete(length) => FrameResolution::Complete(length + 1),
				FrameResolution::Overflow(length) => FrameResolution::Overflow(length + 1),
				FrameResolution::Incomplete => FrameResolution::Incomplete,
			};
		}
		return FrameResolution::Complete(1);
	}
	resolve_escape(bytes)
}

fn resolve_escape(bytes: &[u8]) -> FrameResolution {
	match bytes[1] {
		b'[' => {
			if bytes.len() < 3 {
				return FrameResolution::Incomplete;
			}
			if bytes[2] == b'M' {
				return if bytes.len() >= 6 {
					FrameResolution::Complete(6)
				} else {
					FrameResolution::Incomplete
				};
			}
			let limit = bytes.len().min(MAX_CSI_BYTES);
			let sgr = bytes[2] == b'<';
			for index in 2..limit {
				if (0x40..=0x7e).contains(&bytes[index]) {
					if !sgr {
						return FrameResolution::Complete(index + 1);
					}
					if matches!(bytes[index], b'M' | b'm') && valid_sgr_body(&bytes[2..=index]) {
						return FrameResolution::Complete(index + 1);
					}
				}
			}
			if bytes.len() >= MAX_CSI_BYTES {
				FrameResolution::Overflow(MAX_CSI_BYTES)
			} else {
				FrameResolution::Incomplete
			}
		},
		b']' | b'P' | b'_' => {
			let limit = bytes.len().min(MAX_STRING_SEQ_BYTES);
			for index in 2..limit {
				if bytes[1] == b']' && bytes[index] == 0x07 {
					return FrameResolution::Complete(index + 1);
				}
				if bytes[index] == 0x1b && index + 1 < limit && bytes[index + 1] == b'\\' {
					return FrameResolution::Complete(index + 2);
				}
			}
			if bytes.len() >= MAX_STRING_SEQ_BYTES {
				FrameResolution::Overflow(MAX_STRING_SEQ_BYTES)
			} else {
				FrameResolution::Incomplete
			}
		},
		b'O' => {
			if bytes.len() >= 3 {
				FrameResolution::Complete(3)
			} else {
				FrameResolution::Incomplete
			}
		},
		_ => {
			let width = utf8_width(bytes[1]);
			if bytes.len() > width {
				FrameResolution::Complete(width + 1)
			} else {
				FrameResolution::Incomplete
			}
		},
	}
}

fn decode_frame(bytes: &[u8]) -> Decoded {
	if bytes[0] != 0x1b {
		return decode_plain(bytes, false).map_or(Decoded::None, Decoded::BareChord);
	}
	if bytes == b"\x1b" {
		return Decoded::Chord(Chord::plain(Key::Esc));
	}
	let (sequence, meta) = if bytes.starts_with(b"\x1b\x1b") {
		(&bytes[1..], true)
	} else {
		(bytes, false)
	};
	match sequence.get(1) {
		Some(b'[') => {
			decode_csi(&sequence[2..sequence.len() - 1], sequence[sequence.len() - 1], meta)
		},
		Some(b'O') => {
			let key = match sequence[2] {
				b'A' => Some(Key::Up),
				b'B' => Some(Key::Down),
				b'C' => Some(Key::Right),
				b'D' => Some(Key::Left),
				b'H' => Some(Key::Home),
				b'F' => Some(Key::End),
				b'P'..=b'S' => Some(Key::Function(sequence[2] - b'P' + 1)),
				_ => None,
			};
			key.map_or(Decoded::None, |key| {
				Decoded::Chord(Chord::with_modifiers(key, u32::from(meta) * 2))
			})
		},
		Some(b']') => {
			let end = if sequence.ends_with(b"\x1b\\") {
				sequence.len() - 2
			} else {
				sequence.len() - 1
			};
			let payload = &sequence[2..end];
			if let Some((index, r, g, b)) = parse_osc_color(payload) {
				Decoded::Event(InputEvent::Response(TerminalResponse::OscColor { index, r, g, b }))
			} else {
				Decoded::Event(InputEvent::Response(TerminalResponse::Osc(decode_text(payload))))
			}
		},
		Some(b'P') => {
			let end = sequence.len().saturating_sub(2);
			Decoded::Event(InputEvent::Response(TerminalResponse::DeviceControlString(decode_text(
				&sequence[2..end],
			))))
		},
		Some(b'_') => {
			let end = sequence.len().saturating_sub(2);
			let payload = &sequence[2..end];
			if let Some(payload) = payload.strip_prefix(b"G") {
				Decoded::Event(InputEvent::Response(TerminalResponse::KittyGraphics(decode_text(
					payload,
				))))
			} else {
				Decoded::Event(InputEvent::Response(TerminalResponse::ApplicationProgramCommand(
					decode_text(payload),
				)))
			}
		},
		_ => decode_plain(&sequence[1..], true).map_or(Decoded::None, Decoded::Chord),
	}
}

fn decode_csi(body: &[u8], final_byte: u8, meta: bool) -> Decoded {
	if final_byte == b'c' && matches!(body.first(), Some(b'?' | b'>')) {
		return Decoded::Event(InputEvent::Response(TerminalResponse::DeviceAttributes(
			decode_text(body),
		)));
	}
	if final_byte == b'y'
		&& let Some(fields) = body
			.strip_prefix(b"?")
			.and_then(|body| body.strip_suffix(b"$"))
	{
		let mut fields = fields.split(|byte| *byte == b';');
		if let (Some(mode), Some(status)) =
			(fields.next().and_then(parse_decimal_u16), fields.next().and_then(parse_decimal_u8))
		{
			return Decoded::Event(InputEvent::Response(TerminalResponse::ModeReport {
				mode,
				status,
			}));
		}
	}
	if final_byte == b'u'
		&& let Some(flags) = body.strip_prefix(b"?").and_then(parse_decimal_u8)
	{
		return Decoded::Event(InputEvent::Response(TerminalResponse::KittyKeyboardFlags(flags)));
	}
	if final_byte == b'n'
		&& let Some(appearance) = parse_appearance_response(body)
	{
		return Decoded::Event(InputEvent::Response(TerminalResponse::AppearanceChanged(appearance)));
	}
	if final_byte == b't'
		&& let Some((rows, cols, x_px, y_px)) = parse_in_band_resize(body)
	{
		return Decoded::Event(InputEvent::Response(TerminalResponse::InBandResize {
			rows,
			cols,
			x_px,
			y_px,
		}));
	}
	if matches!(final_byte, b'n' | b'R') {
		return Decoded::Event(InputEvent::Response(TerminalResponse::DeviceStatus(decode_text(
			body,
		))));
	}
	if body.is_empty() && matches!(final_byte, b'I' | b'O') {
		return Decoded::Event(InputEvent::Focus(final_byte == b'I'));
	}
	if final_byte == b'~' && body == b"200" {
		return Decoded::PasteStart;
	}
	if body.starts_with(b"<") && matches!(final_byte, b'M' | b'm') {
		return decode_sgr_mouse(body, final_byte);
	}
	if final_byte == b'u' {
		return decode_kitty_key(body, meta);
	}
	if final_byte == b'~' {
		return decode_tilde_key(body, meta);
	}
	let mut fields = body.split(|byte| *byte == b';');
	let first = fields.next().unwrap_or_default();
	let modifiers = if first == b"1" {
		fields.next().and_then(parse_modifier).unwrap_or(0)
	} else {
		0
	} | if meta { 2 } else { 0 };
	let key = match final_byte {
		b'A' => Some(Key::Up),
		b'B' => Some(Key::Down),
		b'C' => Some(Key::Right),
		b'D' => Some(Key::Left),
		b'H' => Some(Key::Home),
		b'F' => Some(Key::End),
		b'Z' => Some(Key::Tab),
		_ => None,
	};
	let modifiers = modifiers | u32::from(final_byte == b'Z');
	key.map_or(Decoded::None, |key| Decoded::Chord(Chord::with_modifiers(key, modifiers)))
}

fn decode_kitty_key(body: &[u8], meta: bool) -> Decoded {
	let mut fields = body.split(|byte| *byte == b';');
	let mut codepoints = fields
		.next()
		.unwrap_or_default()
		.split(|byte| *byte == b':');
	let primary = codepoints.next().and_then(parse_decimal).unwrap_or(0);
	let shifted = codepoints.next().and_then(parse_decimal);
	let base_layout = codepoints.next().and_then(parse_decimal);
	let modifier_field = fields.next().unwrap_or(b"1");
	let associated_text = fields.next();
	let mut modifier_parts = modifier_field.split(|byte| *byte == b':');
	let mut modifiers = modifier_parts.next().and_then(parse_modifier).unwrap_or(0);
	if meta {
		modifiers |= 0b0000_0010;
	}
	let event_type = modifier_parts
		.next()
		.and_then(parse_decimal_u8)
		.unwrap_or(1);
	// Caps/Num Lock describe terminal state, not application modifiers.
	modifiers &= !(0b0100_0000 | 0b1000_0000);
	if event_type == 3 {
		// A release report names the same physical chord as its press; the
		// associated text never applies to a release.
		let codepoint = if modifiers & 0b0000_1110 != 0 {
			base_layout.unwrap_or(primary)
		} else if modifiers & 0b0000_0001 != 0 {
			shifted.unwrap_or(primary)
		} else {
			primary
		};
		return chord_from_codepoint(codepoint, modifiers).map_or(Decoded::None, Decoded::Release);
	}
	if modifiers & 0b0000_1110 == 0
		&& let Some(text) = associated_text
	{
		let chords: SmallVec<_, 4> = text
			.split(|byte| *byte == b':')
			.filter_map(parse_decimal)
			.filter_map(char::from_u32)
			.filter_map(character_to_key)
			.map(Chord::plain)
			.collect();
		if !chords.is_empty() {
			let dedup = (chords.len() == 1)
				.then(|| chord_printable_codepoint(chords[0]))
				.flatten();
			return Decoded::KittyText { chords, dedup };
		}
	}
	let codepoint = if modifiers & 0b0000_1110 != 0 {
		base_layout.unwrap_or(primary)
	} else if modifiers & 0b0000_0001 != 0 {
		shifted.unwrap_or(primary)
	} else {
		primary
	};
	let Some(chord) = chord_from_codepoint(codepoint, modifiers) else {
		return Decoded::None;
	};
	let printable = modifiers & 0b0000_1110 == 0 && chord_printable_codepoint(chord).is_some();
	if printable {
		Decoded::KittyChord(chord)
	} else {
		Decoded::Chord(chord)
	}
}

fn chord_printable_codepoint(chord: Chord) -> Option<u32> {
	match chord.key {
		Key::Char(character) => Some(u32::from(character)),
		Key::Space => Some(32),
		_ => None,
	}
}

fn decode_tilde_key(body: &[u8], meta: bool) -> Decoded {
	let mut fields = body.split(|byte| *byte == b';');
	let first = fields.next().unwrap_or_default();
	let second = fields.next();
	let third = fields.next();
	if first == b"27"
		&& let (Some(modifiers), Some(codepoint), None) = (second, third, fields.next())
	{
		let modifiers = parse_modifier(modifiers).unwrap_or(0) | if meta { 2 } else { 0 };
		let codepoint = parse_decimal(codepoint).unwrap_or(0);
		return chord_from_codepoint(codepoint, modifiers).map_or(Decoded::None, Decoded::Chord);
	}
	let number = parse_decimal_u8(first).unwrap_or(0);
	let modifiers = second.and_then(parse_modifier).unwrap_or(0) | if meta { 2 } else { 0 };
	let key = match number {
		1 | 7 => Some(Key::Home),
		2 => Some(Key::Insert),
		3 => Some(Key::Delete),
		4 | 8 => Some(Key::End),
		5 => Some(Key::PageUp),
		6 => Some(Key::PageDown),
		11..=15 => Some(Key::Function(number - 10)),
		17..=21 => Some(Key::Function(number - 11)),
		23 | 24 => Some(Key::Function(number - 12)),
		_ => None,
	};
	key.map(|key| Chord::with_modifiers(key, modifiers))
		.map_or(Decoded::None, Decoded::Chord)
}

fn decode_sgr_mouse(body: &[u8], final_byte: u8) -> Decoded {
	let mut fields = body[1..].split(|byte| *byte == b';');
	let Some(bits) = fields.next().and_then(parse_decimal_u16) else {
		return Decoded::None;
	};
	let Some(column) = fields.next().and_then(parse_decimal_u16) else {
		return Decoded::None;
	};
	let Some(row) = fields.next().and_then(parse_decimal_u16) else {
		return Decoded::None;
	};
	let button = if bits & 0b0100_0000 != 0 {
		match bits & 0b0000_0011 {
			0 => MouseButton::WheelUp,
			1 => MouseButton::WheelDown,
			2 => MouseButton::WheelLeft,
			_ => MouseButton::WheelRight,
		}
	} else {
		match bits & 0b0000_0011 {
			0 => MouseButton::Left,
			1 => MouseButton::Middle,
			2 => MouseButton::Right,
			_ => MouseButton::None,
		}
	};
	let kind = match button {
		MouseButton::WheelUp => Mouse::WheelUp,
		MouseButton::WheelDown => Mouse::WheelDown,
		MouseButton::WheelLeft => Mouse::WheelLeft,
		MouseButton::WheelRight => Mouse::WheelRight,
		_ if final_byte == b'm' => Mouse::Release,
		MouseButton::None if bits & 0b0010_0000 != 0 => Mouse::Move,
		_ if bits & 0b0010_0000 != 0 => Mouse::Drag,
		MouseButton::Left => Mouse::Click,
		MouseButton::Middle => Mouse::MiddleClick,
		MouseButton::Right => Mouse::RightClick,
		MouseButton::None => Mouse::Move,
	};
	Decoded::Event(InputEvent::Mouse(MouseReport {
		kind,
		col: column.saturating_sub(1),
		row: row.saturating_sub(1),
		button,
		mods: Mods {
			shift: bits & 0b0000_0100 != 0,
			alt: bits & 0b0000_1000 != 0,
			ctrl: bits & 0b0001_0000 != 0,
			..Mods::default()
		},
		pressed: final_byte == b'M',
	}))
}

fn chord_from_codepoint(codepoint: u32, modifiers: u32) -> Option<Chord> {
	let key = match codepoint {
		57344 | 27 => Some(Key::Esc),
		57345 | 10 | 13 | 57414 => Some(Key::Enter),
		57346 | 9 => Some(Key::Tab),
		57347 | 127 => Some(Key::Backspace),
		57348 => Some(Key::Insert),
		57349 => Some(Key::Delete),
		57350 => Some(Key::Left),
		57351 => Some(Key::Right),
		57352 => Some(Key::Up),
		57353 => Some(Key::Down),
		57354 => Some(Key::PageUp),
		57355 => Some(Key::PageDown),
		57356 => Some(Key::Home),
		57357 => Some(Key::End),
		57364..=57375 => Some(Key::Function(u8::try_from(codepoint - 57363).ok()?)),
		57399..=57408 => char::from_digit(codepoint - 57399, 10).map(Key::Char),
		57409 => Some(Key::Char('.')),
		57410 => Some(Key::Char('/')),
		57411 => Some(Key::Char('*')),
		57412 => Some(Key::Char('-')),
		57413 => Some(Key::Char('+')),
		57415 => Some(Key::Char('=')),
		_ => character_to_key(char::from_u32(codepoint)?),
	}?;
	Some(Chord::with_modifiers(key, modifiers))
}

fn decode_plain(bytes: &[u8], alt: bool) -> Option<Chord> {
	let mut chord = if bytes[0] < 0x20 || bytes[0] == 0x7f {
		decode_control(bytes[0])?
	} else {
		let character = str::from_utf8(bytes).ok()?.chars().next()?;
		Chord::plain(character_to_key(character)?)
	};
	chord.mods.alt |= alt;
	Some(chord)
}

fn decode_control(byte: u8) -> Option<Chord> {
	let chord = match byte {
		b'\t' => Chord::plain(Key::Tab),
		b'\r' => Chord::plain(Key::Enter),
		// A bare LF is the iTerm2-style Shift+Enter mapping (Claude Code's
		// /terminal-setup and similar bindings); raw-mode Enter always
		// arrives as CR, so LF decodes as the Shift+Enter chord and the
		// keymap's `(Enter, shift)` row owns the newline semantics for the
		// composer and /tree selector.
		b'\n' => Chord::new(Key::Enter, Mods { shift: true, ..Mods::default() }),
		0x7f | 0x08 => Chord::plain(Key::Backspace),
		0x01..=0x1a => {
			Chord::new(Key::Char(char::from(b'a' + byte - 1)), Mods { ctrl: true, ..Mods::default() })
		},
		0x1b => Chord::plain(Key::Esc),
		_ => return None,
	};
	Some(chord)
}

const fn character_to_key(character: char) -> Option<Key> {
	match character {
		' ' => Some(Key::Space),
		'\r' | '\n' => Some(Key::Enter),
		_ if !character.is_control() => Some(Key::Char(character)),
		_ => None,
	}
}

const fn utf8_width(byte: u8) -> usize {
	match byte {
		0x00..=0x7f => 1,
		0xc2..=0xdf => 2,
		0xe0..=0xef => 3,
		0xf0..=0xf4 => 4,
		_ => 1,
	}
}

fn valid_sgr_body(body: &[u8]) -> bool {
	let Some(body) = body.strip_prefix(b"<") else {
		return false;
	};
	let Some(body) = body.strip_suffix(b"M").or_else(|| body.strip_suffix(b"m")) else {
		return false;
	};
	let mut fields = body.split(|byte| *byte == b';');
	(0..3).all(|_| fields.next().and_then(parse_decimal).is_some()) && fields.next().is_none()
}

fn is_sgr_mouse_partial(bytes: &[u8]) -> bool {
	bytes.starts_with(b"\x1b[<")
		&& bytes[3..]
			.iter()
			.all(|byte| byte.is_ascii_digit() || *byte == b';')
}

/// Whether an expired partial is unambiguously the prefix of a private-CSI
/// terminal report: `ESC [ ?` or `ESC [ >` followed only by parameter bytes.
fn is_private_csi_report_partial(bytes: &[u8]) -> bool {
	let Some(body) = bytes.strip_prefix(b"\x1b[") else {
		return false;
	};
	let Some((&marker, parameters)) = body.split_first() else {
		return false;
	};
	matches!(marker, b'?' | b'>')
		&& parameters
			.iter()
			.all(|byte| byte.is_ascii_digit() || *byte == b';')
}

fn parse_modifier(bytes: &[u8]) -> Option<u32> {
	parse_decimal(bytes).map(|modifier| modifier.saturating_sub(1))
}

fn parse_decimal(bytes: &[u8]) -> Option<u32> {
	(!bytes.is_empty() && bytes.iter().all(u8::is_ascii_digit))
		.then(|| str::from_utf8(bytes).ok()?.parse().ok())
		.flatten()
}

fn parse_decimal_u16(bytes: &[u8]) -> Option<u16> {
	parse_decimal(bytes).and_then(|number| u16::try_from(number).ok())
}

fn parse_decimal_u8(bytes: &[u8]) -> Option<u8> {
	parse_decimal(bytes).and_then(|number| u8::try_from(number).ok())
}

fn decode_text(bytes: &[u8]) -> Str {
	Str::from_utf8_lossy(bytes)
}
fn parse_appearance_response(body: &[u8]) -> Option<u8> {
	let mut fields = body.strip_prefix(b"?997;")?.split(|byte| *byte == b';');
	let appearance = fields.next().and_then(parse_decimal_u8)?;
	(matches!(appearance, 1 | 2) && fields.next().is_none()).then_some(appearance)
}

fn parse_in_band_resize(body: &[u8]) -> Option<(u16, u16, u16, u16)> {
	let body = body.strip_suffix(b" ")?;
	let mut fields = body.split(|byte| *byte == b';');
	if fields.next()? != b"48" {
		return None;
	}
	let mut number = || {
		fields
			.next()
			.and_then(|field| field.split(|byte| *byte == b':').next())
			.and_then(parse_decimal_u16)
	};
	let rows = number()?;
	let cols = number()?;
	let y_px = number()?;
	let x_px = number()?;
	(fields.next().is_none()).then_some((rows, cols, x_px, y_px))
}

fn parse_osc_color(payload: &[u8]) -> Option<(u8, u16, u16, u16)> {
	let separator = payload.iter().position(|byte| *byte == b';')?;
	let (index, color) = (&payload[..separator], &payload[separator + 1..]);
	let index = parse_decimal_u8(index)?;
	let color = color
		.strip_prefix(b"rgb:")
		.or_else(|| color.strip_prefix(b"rgba:"))?;
	let mut components = color.split(|byte| *byte == b'/');
	let r = components.next().and_then(parse_hex_component)?;
	let g = components.next().and_then(parse_hex_component)?;
	let b = components.next().and_then(parse_hex_component)?;
	components.next().is_none().then_some((index, r, g, b))
}

fn parse_hex_component(bytes: &[u8]) -> Option<u16> {
	if !matches!(bytes.len(), 2 | 4) || !bytes.iter().all(u8::is_ascii_hexdigit) {
		return None;
	}
	let value = u16::from_str_radix(str::from_utf8(bytes).ok()?, 16).ok()?;
	Some(if bytes.len() == 2 {
		value * 0x101
	} else {
		value
	})
}

fn emit_unterminated_response(bytes: &[u8], out: &mut Vec<InputEvent>) -> bool {
	let response = if let Some(payload) = bytes.strip_prefix(b"\x1b]") {
		TerminalResponse::Osc(decode_text(payload))
	} else if let Some(payload) = bytes.strip_prefix(b"\x1b_G") {
		TerminalResponse::KittyGraphics(decode_text(payload))
	} else if let Some(payload) = bytes.strip_prefix(b"\x1b_") {
		TerminalResponse::ApplicationProgramCommand(decode_text(payload))
	} else if let Some(payload) = bytes.strip_prefix(b"\x1bP") {
		TerminalResponse::DeviceControlString(decode_text(payload))
	} else {
		return false;
	};
	out.push(InputEvent::Response(response));
	true
}

fn emit_raw(bytes: &[u8], keymap: &Keymap, out: &mut Vec<InputEvent>) {
	let mut cursor = 0;
	while cursor < bytes.len() {
		let width = utf8_width(bytes[cursor]).min(bytes.len() - cursor).max(1);
		if let Some(chord) = decode_plain(&bytes[cursor..cursor + width], false) {
			emit_chord(keymap, chord, out);
		}
		cursor += width;
	}
}

fn emit_chord(keymap: &Keymap, chord: Chord, out: &mut Vec<InputEvent>) {
	let key = keymap.resolve(chord);
	if keymap.chords {
		out.push(InputEvent::Chord(KeyEvent { chord, key, pressed: true }));
	} else if let Some(key) = key {
		out.push(InputEvent::Key(key));
	}
}

fn decode_reencoded_paste_controls(bytes: &[u8]) -> String {
	let mut decoded = Vec::with_capacity(bytes.len());
	let mut cursor = 0;
	while cursor < bytes.len() {
		if bytes[cursor..].starts_with(b"\x1b[") {
			let tail = &bytes[cursor + 2..];
			if let Some(end) = tail.iter().position(|byte| matches!(byte, b'u' | b'~')) {
				let body = &tail[..end];
				let final_byte = tail[end];
				let mut fields = body.split(|byte| *byte == b';');
				let codepoint = if final_byte == b'u' {
					match (fields.next(), fields.next(), fields.next()) {
						(Some(codepoint), Some(b"5"), None) => parse_decimal(codepoint),
						_ => None,
					}
				} else {
					match (fields.next(), fields.next(), fields.next(), fields.next()) {
						(Some(b"27"), Some(b"5"), Some(codepoint), None) => parse_decimal(codepoint),
						_ => None,
					}
				};
				if let Some(codepoint @ (65..=90 | 97..=122)) = codepoint {
					let control = if codepoint >= 97 {
						codepoint - 96
					} else {
						codepoint - 64
					};
					decoded.push(u8::try_from(control).expect("control byte fits"));
					cursor += 2 + end + 1;
					continue;
				}
			}
		}
		decoded.push(bytes[cursor]);
		cursor += 1;
	}
	String::from_utf8_lossy(&decoded).into_owned()
}

/// Decodes a complete byte slice without retaining partial framing state.
///
/// Prefer [`InputDecoder`] for PTY, SSH, or multiplexer streams where an
/// escape sequence may be split between reads.
pub fn decode_keys(bytes: &[u8], output: &mut Vec<Key>) {
	let mut decoder = InputDecoder::new();
	let now = Instant::now();
	let mut events = Vec::new();
	decoder.feed(bytes, now, &mut events);
	decoder.tick(now + INPUT_TIMEOUT + PARTIAL_HOLD_TIMEOUT, &mut events);
	output.extend(events.into_iter().filter_map(|event| match event {
		InputEvent::Key(key) => Some(key),
		_ => None,
	}));
}

/// A terminal chord exactly as decoded: native key plus full modifiers.
///
/// Nothing is folded here — lookup canonicalization happens inside
/// [`Keymap::resolve`], where an exact binding always wins over the
/// shift-folded spelling.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Chord {
	/// The decoded native key.
	pub key:  Key,
	/// Full modifier set.
	pub mods: Mods,
}

impl Chord {
	/// Creates a chord from a native key and its terminal modifiers.
	pub const fn new(key: Key, mods: Mods) -> Self {
		Self { key, mods }
	}

	/// Parses a configurable chord. Modifier aliases are ASCII-insensitive:
	/// `ctrl`/`control`, `alt`/`option`, `cmd`/`command`/`super`/`win`,
	/// `shift`, `meta`, and `hyper`.
	pub fn parse(source: &str) -> Result<Self, ChordParseError> {
		source.parse()
	}

	/// Writes the canonical portable chord spelling: modifiers in
	/// `ctrl+alt+shift+super` order, canonical key names (`escape`, `pageup`),
	/// and a letter lowercased under Ctrl/Alt/Super so `bind ctrl+shift+p`
	/// matches both the Kitty (`p`+shift) and the modifyOtherKeys (`P`)
	/// report of the same chord.
	pub fn label(self) -> Str {
		let mut label = String::new();
		for (active, name) in [
			(self.mods.ctrl, "ctrl"),
			(self.mods.alt, "alt"),
			(self.mods.shift, "shift"),
			(self.mods.super_key, "super"),
			(self.mods.meta, "meta"),
			(self.mods.hyper, "hyper"),
		] {
			if active {
				if !label.is_empty() {
					label.push('+');
				}
				label.push_str(name);
			}
		}
		if !label.is_empty() {
			label.push('+');
		}
		let key = match self.key {
			Key::Char(ch) if self.mods.ctrl || self.mods.alt || self.mods.super_key => {
				Key::Char(ch.to_ascii_lowercase())
			},
			key => key,
		};
		write_key_label(&mut label, key);
		Str::from(label)
	}

	/// Creates an unmodified chord.
	pub const fn plain(key: Key) -> Self {
		Self::new(key, Mods {
			shift:     false,
			alt:       false,
			ctrl:      false,
			super_key: false,
			hyper:     false,
			meta:      false,
		})
	}

	const fn with_modifiers(key: Key, modifiers: u32) -> Self {
		Self::new(key, Mods {
			shift:     modifiers & 0b0000_0001 != 0,
			alt:       modifiers & 0b0000_0010 != 0,
			ctrl:      modifiers & 0b0000_0100 != 0,
			super_key: modifiers & 0b0000_1000 != 0,
			hyper:     modifiers & 0b0001_0000 != 0,
			meta:      modifiers & 0b0010_0000 != 0,
		})
	}

	/// The shift-folded spelling used as a lookup fallback: letters under
	/// Ctrl/Alt/Super lowercase and drop Shift, so `Alt+Shift+Y` also finds
	/// an `Alt+y` binding. `None` when already canonical.
	fn folded(self) -> Option<Self> {
		if !(self.mods.ctrl || self.mods.alt || self.mods.super_key) {
			return None;
		}
		let Key::Char(ch) = self.key else {
			return None;
		};
		let lowered = ch.to_ascii_lowercase();
		let mut mods = self.mods;
		mods.shift = false;
		(lowered != ch || mods != self.mods).then_some(Self { key: Key::Char(lowered), mods })
	}
}

/// A malformed configurable chord.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ChordParseError {
	/// The chord was empty.
	#[error("key chord is empty")]
	Empty,
	/// A modifier name was not recognized.
	#[error("key chord contains an unknown modifier")]
	UnknownModifier,
	/// The chord contains no key or more than one key.
	#[error("key chord must contain exactly one key")]
	InvalidKeyCount,
	/// The key name was not recognized.
	#[error("key chord contains an unknown key")]
	UnknownKey,
	/// The same modifier occurred more than once.
	#[error("key chord contains a duplicate modifier")]
	DuplicateModifier,
}

impl FromStr for Chord {
	type Err = ChordParseError;

	fn from_str(source: &str) -> Result<Self, Self::Err> {
		let source = source.trim();
		if source.is_empty() {
			return Err(ChordParseError::Empty);
		}
		let mut parts = source.split('+').map(str::trim).peekable();
		let mut mods = Mods::default();
		let mut key = None;
		while let Some(part) = parts.next() {
			if part.is_empty() {
				return Err(ChordParseError::UnknownKey);
			}
			let last = parts.peek().is_none();
			if last {
				key = Some(parse_key_name(part)?);
				continue;
			}
			let slot = match part.to_ascii_lowercase().as_str() {
				"ctrl" | "control" | "ctl" => &mut mods.ctrl,
				"alt" | "option" | "opt" => &mut mods.alt,
				"shift" => &mut mods.shift,
				"super" | "cmd" | "command" | "win" | "windows" => &mut mods.super_key,
				"meta" => &mut mods.meta,
				"hyper" => &mut mods.hyper,
				_ => return Err(ChordParseError::UnknownModifier),
			};
			if *slot {
				return Err(ChordParseError::DuplicateModifier);
			}
			*slot = true;
		}
		Ok(Self::new(key.ok_or(ChordParseError::InvalidKeyCount)?, mods))
	}
}

fn parse_key_name(source: &str) -> Result<Key, ChordParseError> {
	if source.chars().count() == 1 {
		return Ok(Key::Char(source.chars().next().expect("one scalar")));
	}
	let folded = source.to_ascii_lowercase();
	let key = match folded.as_str() {
		"up" => Key::Up,
		"down" => Key::Down,
		"left" => Key::Left,
		"right" => Key::Right,
		"tab" => Key::Tab,
		"enter" | "return" => Key::Enter,
		"space" => Key::Space,
		"esc" | "escape" => Key::Esc,
		"backspace" | "bs" => Key::Backspace,
		"delete" | "del" => Key::Delete,
		"insert" | "ins" => Key::Insert,
		"home" => Key::Home,
		"end" => Key::End,
		"pageup" | "pgup" => Key::PageUp,
		"pagedown" | "pgdown" => Key::PageDown,
		_ if folded.starts_with('f') => folded[1..]
			.parse::<u8>()
			.ok()
			.filter(|number| (1..=12).contains(number))
			.map(Key::Function)
			.ok_or(ChordParseError::UnknownKey)?,
		_ => return Err(ChordParseError::UnknownKey),
	};
	Ok(key)
}

fn write_key_label(target: &mut String, key: Key) {
	match key {
		Key::Up => target.push_str("up"),
		Key::Down => target.push_str("down"),
		Key::Left => target.push_str("left"),
		Key::Right => target.push_str("right"),
		Key::Tab => target.push_str("tab"),
		Key::Enter => target.push_str("enter"),
		Key::Space => target.push_str("space"),
		Key::Esc => target.push_str("escape"),
		Key::Backspace => target.push_str("backspace"),
		Key::Delete => target.push_str("delete"),
		Key::Insert => target.push_str("insert"),
		Key::Home => target.push_str("home"),
		Key::End => target.push_str("end"),
		Key::PageUp => target.push_str("pageup"),
		Key::PageDown => target.push_str("pagedown"),
		Key::Function(number) => {
			let _ = write!(target, "f{number}");
		},
		Key::Char(' ') => target.push_str("space"),
		Key::Char(character) => target.push(character),
		_ => target.push_str("semantic"),
	}
}

/// Chord-to-action table consulted before the identity fallbacks.
///
/// All semantic defaults (word motion, word deletes, newline spellings, the
/// legacy `Shift+F3` alias) live here, so embedders can rebind, [`disable`],
/// or [`unbind`] any of them.
///
/// [`disable`]: Keymap::disable
/// [`unbind`]: Keymap::unbind
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Keymap {
	bindings: Vec<(Chord, Option<Key>)>,
	/// Emit [`InputEvent::Chord`] edges (with releases) instead of
	/// [`InputEvent::Key`].
	chords:   bool,
}

/// Default chord table: word motion/delete spellings (including macOS
/// `super+alt+…`), the readline rubouts, Shift/Ctrl-Enter
/// newline spellings plus Alt follow-up, and smart/raw clipboard paste.
///
/// Modifier bits are `1 = Shift`, `2 = Alt`, `4 = Ctrl`, and `8 = Super`.
const DEFAULT_BINDINGS: &[(Key, u8, Key)] = &[
	(Key::Tab, 1, Key::BackTab),
	(Key::Left, 2, Key::WordLeft),
	(Key::Right, 2, Key::WordRight),
	(Key::Left, 4, Key::WordLeft),
	(Key::Right, 4, Key::WordRight),
	(Key::Left, 1, Key::SelectLeft),
	(Key::Right, 1, Key::SelectRight),
	(Key::Up, 1, Key::RestoreQueue),
	(Key::Down, 1, Key::SelectDown),
	(Key::Home, 1, Key::SelectHome),
	(Key::End, 1, Key::SelectEnd),
	(Key::Left, 3, Key::SelectWordLeft),
	(Key::Right, 3, Key::SelectWordRight),
	(Key::Left, 5, Key::SelectWordLeft),
	(Key::Right, 5, Key::SelectWordRight),
	(Key::Left, 7, Key::SelectWordLeft),
	(Key::Right, 7, Key::SelectWordRight),
	(Key::Char('c'), 5, Key::Copy),
	(Key::Char('C'), 5, Key::Copy),
	(Key::Char('x'), 5, Key::Cut),
	(Key::Char('X'), 5, Key::Cut),
	(Key::Char('f'), 2, Key::WordRight),
	(Key::Char('b'), 2, Key::WordLeft),
	(Key::Char('d'), 2, Key::WordDelete),
	(Key::Delete, 2, Key::WordDelete),
	(Key::Char('d'), 10, Key::WordDelete),
	(Key::Delete, 10, Key::WordDelete),
	(Key::Backspace, 4, Key::Ctrl('w')),
	(Key::Backspace, 2, Key::Ctrl('w')),
	(Key::Backspace, 10, Key::Ctrl('w')),
	(Key::Char('v'), 4, Key::Paste),
	(Key::Char('v'), 8, Key::Paste),
	(Key::Char('v'), 2, Key::Paste),
	(Key::Char('v'), 5, Key::PasteRaw),
	(Key::Char('v'), 3, Key::PasteRaw),
	// xterm modifyOtherKeys emits the shifted codepoint, so this exact row must win
	// before shift-folding `Ctrl+Shift+V` into the smart-paste `Ctrl+v` row.
	(Key::Up, 2, Key::RestoreQueue),
	(Key::Up, 3, Key::RestoreQueue),
	(Key::Char('V'), 5, Key::PasteRaw),
	(Key::Char('V'), 3, Key::PasteRaw),
	(Key::Char('d'), 5, Key::DebugMenu),
	(Key::Char('D'), 5, Key::DebugMenu),
	(Key::Char('o'), 5, Key::ToggleToolVisibility),
	(Key::Char('O'), 5, Key::ToggleToolVisibility),
	(Key::Char('c'), 3, Key::CopyPrompt),
	(Key::Char('C'), 3, Key::CopyPrompt),
	(Key::Char('l'), 3, Key::CopyLine),
	(Key::Char('L'), 3, Key::CopyLine),
	// kitty CSI-u reports the unshifted codepoint with the shift bit set
	// (`112;6u`), so the lowercase rows must exist or shift folds away and
	// Ctrl+Shift+P collapses into Ctrl+P.
	(Key::Char('p'), 5, Key::CyclePrevious),
	(Key::Char('P'), 5, Key::CyclePrevious),
	(Key::Char('p'), 3, Key::PlanToggle),
	(Key::Char('P'), 3, Key::PlanToggle),
	// Shift+Enter / Ctrl+J insert a newline. Ctrl+Enter is deliberately
	// absent so it remains a
	// distinct chord for hosts (and is FollowUp here, like Alt+Enter, for
	// hosts without a bind table).
	(Key::Char('j'), 4, Key::ShiftEnter),
	(Key::Enter, 1, Key::ShiftEnter),
	(Key::Enter, 2, Key::FollowUp),
	(Key::Enter, 3, Key::ShiftEnter),
	(Key::Enter, 4, Key::FollowUp),
	// Legacy `CSI 13;2~` is byte-identical for Shift+Enter and Shift+F3, so
	// resolve the ambiguity to a newline.
	(Key::Function(3), 1, Key::ShiftEnter),
];

const fn mods_from_bits(bits: u8) -> Mods {
	Mods {
		shift:     bits & 0b0000_0001 != 0,
		alt:       bits & 0b0000_0010 != 0,
		ctrl:      bits & 0b0000_0100 != 0,
		super_key: bits & 0b0000_1000 != 0,
		hyper:     false,
		meta:      false,
	}
}

impl Default for Keymap {
	fn default() -> Self {
		Self {
			bindings: DEFAULT_BINDINGS
				.iter()
				.map(|&(key, bits, mapped)| (Chord::new(key, mods_from_bits(bits)), Some(mapped)))
				.collect(),
			chords:   false,
		}
	}
}

impl Keymap {
	/// Switches the decoder to physical edges: every key press arrives as
	/// [`InputEvent::Chord`] carrying the exact chord plus this map's
	/// resolution, and Kitty key releases are delivered instead of dropped.
	/// Hosts with a `bind` table use this so the table sees the chord the
	/// user pressed, not the semantic key it folded into.
	pub const fn set_chord_events(&mut self, chords: bool) {
		self.chords = chords;
	}

	/// Whether physical chord edges are emitted.
	#[must_use]
	pub const fn chord_events(&self) -> bool {
		self.chords
	}

	/// Adds or replaces the binding for `chord`.
	pub fn bind(&mut self, chord: Chord, key: Key) {
		self.set(chord, Some(key));
	}

	/// Masks `chord` entirely: [`Keymap::resolve`] returns `None` even when
	/// an identity fallback (`Ctrl+letter`, plain typing) would apply.
	pub fn disable(&mut self, chord: Chord) {
		self.set(chord, None);
	}

	/// Removes any entry for `chord`, restoring identity-fallback handling.
	pub fn unbind(&mut self, chord: Chord) {
		self.bindings.retain(|(bound, _)| *bound != chord);
	}

	fn set(&mut self, chord: Chord, key: Option<Key>) {
		match self.bindings.iter_mut().find(|(bound, _)| *bound == chord) {
			Some(slot) => slot.1 = key,
			None => self.bindings.push((chord, key)),
		}
	}

	fn entry(&self, chord: Chord) -> Option<&(Chord, Option<Key>)> {
		self.bindings.iter().find(|(bound, _)| *bound == chord)
	}

	/// Resolves a native chord. Precedence: the exact chord's table entry,
	/// the shift-folded spelling's entry, then identity fallbacks.
	///
	/// OS shortcut modifiers are discarded unless explicitly bound. A
	/// [`Keymap::disable`]d chord resolves to `None` before any fallback.
	pub fn resolve(&self, exact: Chord) -> Option<Key> {
		let folded = exact.folded();
		if let Some((_, entry)) = self
			.entry(exact)
			.or_else(|| folded.and_then(|chord| self.entry(chord)))
		{
			return *entry;
		}
		let chord = folded.unwrap_or(exact);
		if chord.mods.super_key || chord.mods.hyper || chord.mods.meta {
			return None;
		}
		if chord.mods.ctrl && chord.mods.alt {
			return match chord.key {
				Key::Char(ch) => Some(Key::CtrlAlt(ch.to_ascii_lowercase())),
				_ => None,
			};
		}
		if chord.mods.ctrl {
			return match chord.key {
				Key::Char(ch) => Some(Key::Ctrl(ch.to_ascii_lowercase())),
				_ => None,
			};
		}
		if chord.mods.alt {
			return match chord.key {
				Key::Char(ch) if ch.is_alphanumeric() => Some(Key::Alt(ch.to_ascii_lowercase())),
				_ => None,
			};
		}
		if chord.mods.shift && matches!(chord.key, Key::Function(_)) {
			return None;
		}
		Some(match chord.key {
			Key::Char(' ') => Key::Space,
			Key::Char(ch) if chord.mods.shift => Key::Char(ch.to_ascii_uppercase()),
			key => key,
		})
	}
}

/// Mouse gestures in document cell coordinates.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum Mouse {
	/// Left-button press: focuses and activates the hit target.
	Click,
	/// Right-button press.
	RightClick,
	/// Middle-button press.
	MiddleClick,
	/// Pointer motion without a pressed button: drives hover highlights.
	Move,
	/// Pointer motion with a pressed button.
	Drag,
	/// Button release.
	Release,
	/// Wheel up: scroll viewports first, then list cursors.
	WheelUp,
	/// Wheel down: scroll viewports first, then list cursors.
	WheelDown,
	/// Horizontal wheel left.
	WheelLeft,
	/// Horizontal wheel right.
	WheelRight,
}

/// Outcome of one input event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UiEvent {
	/// Nothing to report; the frame may still have changed.
	None,
	/// A `submit` button fired (or a confirm completed on one).
	Submit,
	/// Esc at the top level or a `cancel` button fired.
	Cancel,
	/// A plain `id`-carrying button fired.
	Pressed(Str),
	/// An `id`-carrying select's cursor rested on a new option.
	Highlighted {
		/// The select's `id`.
		id:    Str,
		/// Value of the option under the cursor.
		value: Str,
	},
	/// An `id`-carrying select committed the option under its cursor.
	Changed {
		/// The select's `id`.
		id:    Str,
		/// Value of the committed option.
		value: Str,
	},
	/// A tree node was activated with Enter, Right on a leaf, or a row click.
	TreeActivated {
		/// The tree's `id`, or the empty string when unnamed.
		id:  Str,
		/// Stable node key.
		key: Str,
	},
	/// A tree node was toggled with Space or by expanding/collapsing it.
	TreeToggled {
		/// The tree's `id`, or the empty string when unnamed.
		id:       Str,
		/// Stable node key.
		key:      Str,
		/// New expansion state for a branch; `None` for a leaf-level
		/// application toggle.
		expanded: Option<bool>,
	},
	/// A tree node's trailing action chip was activated.
	TreeAction {
		/// The tree's `id`, or the empty string when unnamed.
		id:     Str,
		/// Stable node key.
		key:    Str,
		/// Action value authored on the node.
		action: Str,
	},
	/// An `id`-carrying filterable select's query changed.
	Filtered {
		/// The select's `id`.
		id:    Str,
		/// The new filter query.
		query: Str,
		/// Value of the option under the cursor after re-filtering;
		/// `None` when nothing matches.
		value: Option<Str>,
	},
	/// An editing widget copied or cut text; the HOST owns the clipboard
	/// write (OSC 52 on terminals, a native detached write on the GPU
	/// host) — widgets never touch the clipboard themselves.
	Copied(Str),
	/// An interactive diff pane requested a host-owned mutation.
	DiffAction {
		/// The pane's component `id`, or the empty string when unnamed.
		id:     Str,
		/// Mutation selected by the host or a hunk button.
		action: DiffActionKind,
		/// Source scope resolved by selection/hunk/file precedence.
		target: DiffTarget,
	},
}

/// Grapheme-safe byte offset for a cell-column cursor within `text`.
pub fn byte_at_column(text: &str, column: u16) -> usize {
	let mut cells = 0u16;
	for (offset, grapheme) in text.grapheme_indices() {
		if cells >= column {
			return offset;
		}
		cells += cell_width(grapheme);
	}
	text.len()
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum WordClass {
	Word,
	Whitespace,
	Cjk,
	Delimiter,
}

const fn is_cjk(character: char) -> bool {
	matches!(
		character as u32,
		0x2E80..=0x2FFF
			| 0x3040..=0x30FF
			| 0x3100..=0x312F
			| 0x3130..=0x318F
			| 0x31A0..=0x31BF
			| 0x31F0..=0x31FF
			| 0x3400..=0x4DBF
			| 0x4E00..=0x9FFF
			| 0xA960..=0xA97F
			| 0xAC00..=0xD7AF
			| 0xF900..=0xFAFF
			| 0x20000..=0x2FA1F
	)
}

fn word_class(grapheme: &str) -> WordClass {
	let Some(character) = grapheme.chars().next() else {
		return WordClass::Delimiter;
	};
	if character.is_whitespace() {
		WordClass::Whitespace
	} else if is_cjk(character) {
		WordClass::Cjk
	} else if character.is_alphanumeric() || character == '_' {
		WordClass::Word
	} else {
		WordClass::Delimiter
	}
}

fn is_word_joiner(grapheme: &str) -> bool {
	matches!(grapheme, "'" | "’" | "-" | "‐" | "‑")
}

fn word_left_byte(text: &str, at: usize) -> usize {
	let mut graphemes = text[..at].grapheme_indices().rev().peekable();
	while graphemes
		.peek()
		.is_some_and(|(_, grapheme)| word_class(grapheme) == WordClass::Whitespace)
	{
		graphemes.next();
	}
	let Some((start, first)) = graphemes.next() else {
		return 0;
	};
	let class = word_class(first);
	if class == WordClass::Cjk {
		return start;
	}
	if class != WordClass::Word {
		let mut target = start;
		while let Some(&(offset, grapheme)) = graphemes.peek() {
			if word_class(grapheme) != class {
				break;
			}
			target = offset;
			graphemes.next();
		}
		return target;
	}
	let mut target = start;
	while let Some((offset, grapheme)) = graphemes.next() {
		if word_class(grapheme) == WordClass::Word {
			target = offset;
		} else if is_word_joiner(grapheme)
			&& graphemes
				.peek()
				.is_some_and(|(_, left)| word_class(left) == WordClass::Word)
		{
			let (left_offset, _) = graphemes.next().expect("peeked left word");
			target = left_offset;
		} else {
			break;
		}
	}
	target
}

fn word_right_byte(text: &str, at: usize) -> usize {
	let mut graphemes = text[at..].grapheme_indices().peekable();
	while graphemes
		.peek()
		.is_some_and(|(_, grapheme)| word_class(grapheme) == WordClass::Whitespace)
	{
		graphemes.next();
	}
	let Some((first_offset, first)) = graphemes.next() else {
		return text.len();
	};
	let class = word_class(first);
	let mut end = at + first_offset + first.len();
	if class == WordClass::Cjk {
		return end;
	}
	if class != WordClass::Word {
		while let Some(&(_, grapheme)) = graphemes.peek() {
			if word_class(grapheme) != class {
				break;
			}
			let (offset, grapheme) = graphemes.next().expect("peeked delimiter");
			end = at + offset + grapheme.len();
		}
		return end;
	}
	while let Some((offset, grapheme)) = graphemes.next() {
		if word_class(grapheme) == WordClass::Word
			|| (is_word_joiner(grapheme)
				&& graphemes
					.peek()
					.is_some_and(|(_, right)| word_class(right) == WordClass::Word))
		{
			end = at + offset + grapheme.len();
		} else {
			break;
		}
	}
	end
}

/// Cell column of the previous coarse word start before `column`.
pub fn word_left_column(text: &str, column: u16) -> u16 {
	cell_width(&text[..word_left_byte(text, byte_at_column(text, column))])
}

/// Cell column just past the next coarse word after `column`.
pub fn word_right_column(text: &str, column: u16) -> u16 {
	cell_width(&text[..word_right_byte(text, byte_at_column(text, column))])
}

/// Byte start of the coarse word before `at`.
pub fn word_rubout_start(text: &str, at: usize) -> usize {
	word_left_byte(text, at)
}

/// Normalizes terminal paste input before inserting it into a widget.
pub fn sanitize_paste(text: &str) -> String {
	let normalized_newlines = text.replace("\r\n", "\n").replace('\r', "\n");
	let mut sanitized = String::with_capacity(normalized_newlines.len());
	for character in normalized_newlines.chars() {
		if character == '\t' {
			sanitized.push_str("   ");
		} else if !character.is_control() || character == '\n' {
			sanitized.push(character);
		}
	}
	sanitized.into_nfc()
}

#[cfg(test)]
mod tests {
	use std::{
		slice,
		time::{Duration, Instant},
	};

	use super::{
		Chord, ChordParseError, InputDecoder, InputEvent, Key, Keymap, Mods, Mouse, MouseButton,
		MouseReport, STRING_DISCARD_MAX_BYTES, TerminalResponse, decode_keys, mods_from_bits,
	};

	#[test]
	fn paste_sanitization_expands_tabs_to_visible_cells() {
		assert_eq!(super::sanitize_paste("a\tb\r\nc\u{7}"), "a   b\nc");
	}

	#[test]
	fn configurable_chords_accept_modifier_aliases_and_canonicalize() {
		let control = Chord::parse("Control+Shift+K").expect("control alias");
		assert!(control.mods.ctrl && control.mods.shift);
		assert_eq!(control.key, Key::Char('K'));
		assert_eq!(control.label(), "ctrl+shift+k");

		let command = Chord::parse("cmd+option+left").expect("mac aliases");
		assert!(command.mods.super_key && command.mods.alt);
		assert_eq!(command.key, Key::Left);
		assert_eq!(command.label(), "alt+super+left");

		assert_eq!(Chord::parse("ctrl+ctrl+x"), Err(ChordParseError::DuplicateModifier));
		assert_eq!(Chord::parse("mystery+x"), Err(ChordParseError::UnknownModifier));
		assert_eq!(Chord::parse("ctrl+no-such-key"), Err(ChordParseError::UnknownKey));
	}

	fn drip(bytes: &[u8]) -> Vec<InputEvent> {
		let start = Instant::now();
		let mut decoder = InputDecoder::new();
		let mut events = Vec::new();
		for (offset, byte) in bytes.iter().enumerate() {
			decoder.feed(
				slice::from_ref(byte),
				start + Duration::from_millis(u64::try_from(offset).unwrap()),
				&mut events,
			);
		}
		events
	}

	#[test]
	fn native_keymap_covers_chords_and_motion() {
		let cases: &[(Key, u8, Key)] = &[
			(Key::Char('a'), 4, Key::Ctrl('a')),
			(Key::Char('W'), 5, Key::Ctrl('w')),
			(Key::Char('k'), 5, Key::Ctrl('k')),
			(Key::Left, 2, Key::WordLeft),
			(Key::Right, 4, Key::WordRight),
			(Key::Enter, 1, Key::ShiftEnter),
			(Key::Enter, 0, Key::Enter),
			(Key::Char(' '), 0, Key::Space),
			(Key::Char('Z'), 1, Key::Char('Z')),
			(Key::BackTab, 1, Key::BackTab),
			(Key::PageDown, 0, Key::PageDown),
			(Key::Enter, 2, Key::FollowUp),
			(Key::Enter, 4, Key::FollowUp),
			(Key::Char('j'), 4, Key::ShiftEnter),
			(Key::Function(3), 1, Key::ShiftEnter),
			(Key::Char('d'), 2, Key::WordDelete),
			(Key::Delete, 2, Key::WordDelete),
			(Key::Backspace, 4, Key::Ctrl('w')),
			(Key::Backspace, 10, Key::Ctrl('w')),
			(Key::Char('d'), 10, Key::WordDelete),
			(Key::Char('f'), 2, Key::WordRight),
			(Key::Char('b'), 2, Key::WordLeft),
			(Key::Char('d'), 4, Key::Ctrl('d')),
			(Key::Char('y'), 2, Key::Alt('y')),
			(Key::Char('Y'), 3, Key::Alt('y')),
			(Key::Char(']'), 6, Key::CtrlAlt(']')),
			(Key::Char('d'), 5, Key::DebugMenu),
			(Key::Char('D'), 5, Key::DebugMenu),
		];
		let keymap = Keymap::default();
		for &(key, bits, expected) in cases {
			let chord = Chord::new(key, mods_from_bits(bits));
			assert_eq!(keymap.resolve(chord), Some(expected), "{chord:?}");
		}
	}

	#[test]
	fn keymap_resolves_smart_and_raw_paste_chords() {
		let mut keymap = Keymap::default();
		assert_eq!(
			keymap.resolve(Chord::parse("ctrl+shift+o").expect("tool visibility chord")),
			Some(Key::ToggleToolVisibility)
		);
		assert_eq!(
			keymap.resolve(Chord::parse("alt+shift+c").expect("copy prompt chord")),
			Some(Key::CopyPrompt)
		);
		assert_eq!(
			keymap.resolve(Chord::parse("alt+shift+l").expect("copy line chord")),
			Some(Key::CopyLine)
		);
		assert_eq!(
			keymap.resolve(Chord::parse("super+v").expect("super paste chord")),
			Some(Key::Paste)
		);
		assert_eq!(
			keymap.resolve(Chord::parse("alt+shift+v").expect("raw paste chord")),
			Some(Key::PasteRaw)
		);
		assert_eq!(
			keymap.resolve(Chord::parse("ctrl+shift+d").expect("debug chord")),
			Some(Key::DebugMenu)
		);
		let smart = Chord::new(Key::Char('v'), mods_from_bits(4));
		assert_eq!(keymap.resolve(smart), Some(Key::Paste));
		assert_eq!(
			keymap.resolve(Chord::new(Key::Char('v'), mods_from_bits(5))),
			Some(Key::PasteRaw)
		);
		assert_eq!(
			keymap.resolve(Chord::new(Key::Char('V'), mods_from_bits(5))),
			Some(Key::PasteRaw)
		);

		keymap.unbind(smart);
		assert_eq!(keymap.resolve(smart), Some(Key::Ctrl('v')));
	}

	#[test]
	fn decoder_routes_kitty_and_modify_other_keys_debug_chords() {
		let start = Instant::now();
		for bytes in [b"\x1b[100;6u".as_slice(), b"\x1b[27;6;68~".as_slice()] {
			let mut decoder = InputDecoder::new();
			let mut events = Vec::new();
			decoder.feed(bytes, start, &mut events);
			assert_eq!(events, [InputEvent::Key(Key::DebugMenu)], "{bytes:?}");
		}
	}

	#[test]
	fn decoder_normalizes_kitty_shifted_letters() {
		let cases: &[(&[u8], Key)] = &[
			(b"\x1b[97;2u", Key::Char('A')),
			(b"\x1b[65;2u", Key::Char('A')),
			(b"\x1b[49;2u", Key::Char('1')),
			(b"\x1b[97;5u", Key::Ctrl('a')),
			(b"A", Key::Char('A')),
		];
		for &(bytes, expected) in cases {
			let mut keys = Vec::new();
			decode_keys(bytes, &mut keys);
			assert_eq!(keys, [expected], "{bytes:?}");
		}
	}

	#[test]
	fn kitty_printable_dedup_only_suppresses_the_bare_companion() {
		let start = Instant::now();
		let mut decoder = InputDecoder::new();
		let mut events = Vec::new();

		decoder.feed(b"\x1b[97u", start, &mut events);
		assert_eq!(decoder.deadline(), None, "dedup state never schedules actor work");
		decoder.feed(b"\x1b[97u", start + Duration::from_millis(1), &mut events);
		decoder.feed(b"\x1b[97;1:2u", start + Duration::from_millis(2), &mut events);
		decoder.feed(b"a", start + Duration::from_millis(3), &mut events);
		assert_eq!(
			events,
			[
				InputEvent::Key(Key::Char('a')),
				InputEvent::Key(Key::Char('a')),
				InputEvent::Key(Key::Char('a')),
			],
			"presses and repeats survive; only the raw companion is removed"
		);

		let mut decoder = InputDecoder::new();
		let mut encoded = Vec::new();
		decoder.feed(b"\x1b[97u", start, &mut encoded);
		decoder.feed(b"\x1b[27;1;97~", start + Duration::from_millis(1), &mut encoded);
		assert_eq!(
			encoded,
			[InputEvent::Key(Key::Char('a')), InputEvent::Key(Key::Char('a'))],
			"an encoded printable is not the buggy one-scalar companion"
		);
	}

	#[test]
	fn kitty_csi_u_uses_layout_text_and_keypad_fields() {
		let cases: &[(&[u8], &[Key])] = &[
			(b"\x1b[1089::99;5u", &[Key::Ctrl('c')]),
			(b"\x1b[97;1;120:121u", &[Key::Char('x'), Key::Char('y')]),
			(b"\x1b[57399u", &[Key::Char('0')]),
			(b"\x1b[57408u", &[Key::Char('9')]),
			(b"\x1b[57410u", &[Key::Char('/')]),
			(b"\x1b[57414u", &[Key::Enter]),
			(b"\x1b[57415u", &[Key::Char('=')]),
		];
		for &(bytes, expected) in cases {
			let mut keys = Vec::new();
			decode_keys(bytes, &mut keys);
			assert_eq!(keys, expected, "{bytes:?}");
		}
	}

	#[test]
	fn decoder_emits_selection_chords_across_legacy_and_kitty_protocols() {
		let cases: &[(&[u8], Key)] = &[
			(b"\x1b[1;2D", Key::SelectLeft),
			(b"\x1b[57351;2u", Key::SelectRight),
			(b"\x1b[1;6D", Key::SelectWordLeft),
			(b"\x1b[99:67;6u", Key::Copy),
			(b"\x1b[120:88;6u", Key::Cut),
		];
		for &(bytes, expected) in cases {
			let mut keys = Vec::new();
			decode_keys(bytes, &mut keys);
			assert_eq!(keys, [expected], "{bytes:?}");
		}
	}

	#[test]
	fn decoder_filters_releases_and_keymap_filters_os_chords() {
		let mut keys = Vec::new();
		decode_keys(b"\x1b[97;1:3u", &mut keys);
		assert!(keys.is_empty(), "kitty release must not become input");

		let keymap = Keymap::default();
		let os_mods = [
			Mods { super_key: true, ..Mods::default() },
			Mods { hyper: true, ..Mods::default() },
			Mods { meta: true, ..Mods::default() },
		];
		for mods in os_mods {
			assert_eq!(
				keymap.resolve(Chord::new(Key::Char('c'), mods)),
				None,
				"OS shortcuts must never type ({mods:?})"
			);
		}
		let hyper = Chord::new(Key::Char('c'), Mods { hyper: true, ..Mods::default() });
		let mut keymap = Keymap::default();
		keymap.bind(hyper, Key::Esc);
		assert_eq!(keymap.resolve(hyper), Some(Key::Esc));
	}

	#[test]
	fn keymap_bindings_are_customizable() {
		let mut keymap = Keymap::default();
		let legacy = Chord::new(Key::Function(3), mods_from_bits(1));
		assert_eq!(keymap.resolve(legacy), Some(Key::ShiftEnter));
		keymap.unbind(legacy);
		assert_eq!(keymap.resolve(legacy), None);

		let function = Chord::new(Key::Function(5), Mods::default());
		keymap.bind(function, Key::Ctrl('r'));
		assert_eq!(keymap.resolve(function), Some(Key::Ctrl('r')));
		keymap.bind(function, Key::Esc);
		assert_eq!(keymap.resolve(function), Some(Key::Esc));

		let word = Chord::new(Key::Right, mods_from_bits(2));
		keymap.unbind(word);
		assert_eq!(keymap.resolve(word), None);

		let quit = Chord::new(Key::Char('q'), Mods::default());
		keymap.disable(quit);
		assert_eq!(keymap.resolve(quit), None);
		keymap.unbind(quit);
		assert_eq!(keymap.resolve(quit), Some(Key::Char('q')));

		let exact = Chord::new(Key::Char('Y'), mods_from_bits(3));
		keymap.bind(exact, Key::PageUp);
		assert_eq!(keymap.resolve(exact), Some(Key::PageUp));
		assert_eq!(
			keymap.resolve(Chord::new(Key::Char('y'), mods_from_bits(2))),
			Some(Key::Alt('y')),
			"lowercase spelling still uses the identity fallback"
		);
	}

	#[test]
	fn decoder_applies_live_keymap_changes_once() {
		let start = Instant::now();
		let chord = Chord::new(Key::Char('f'), Mods { alt: true, ..Mods::default() });
		let mut decoder = InputDecoder::new();
		let mut events = Vec::new();

		decoder.feed(b"\x1bf", start, &mut events);
		assert_eq!(events, [InputEvent::Key(Key::WordRight)]);

		events.clear();
		decoder.keymap_mut().disable(chord);
		decoder.feed(b"\x1bf", start, &mut events);
		assert!(events.is_empty());

		decoder.keymap_mut().bind(chord, Key::PageDown);
		decoder.feed(b"\x1bf", start, &mut events);
		assert_eq!(events, [InputEvent::Key(Key::PageDown)]);

		events.clear();
		decoder.feed(b"x", start, &mut events);
		assert_eq!(events, [InputEvent::Key(Key::Char('x'))]);
	}

	#[test]
	fn raw_key_decoder_covers_terminal_sequence_families_and_utf8() {
		let mut keys = Vec::new();
		decode_keys(
			b"\x1b[A\x1bOB\x1b[5~\x1b[6~\x1b[H\x1b[F\x1b[3~\x1b[13;2u\x01\x1bx\xc3\xa9\x1b",
			&mut keys,
		);
		assert_eq!(keys, [
			Key::Up,
			Key::Down,
			Key::PageUp,
			Key::PageDown,
			Key::Home,
			Key::End,
			Key::Delete,
			Key::ShiftEnter,
			Key::Ctrl('a'),
			Key::Alt('x'),
			Key::Char('é'),
			Key::Esc,
		]);
	}

	#[test]
	fn alt_chords_decode_from_legacy_meta_and_kitty_encodings() {
		// alt+p / alt+m (model pickers), alt+l, alt+r, shift+tab (thinking
		// cycle), ctrl+shift+p and alt+shift+p as every terminal spells them:
		// legacy `ESC x`, kitty CSI-u with the alt bit (3 = 1+2), shifted
		// kitty spellings, and `CSI Z` for Shift+Tab.
		let cases: &[(&[u8], Key)] = &[
			(b"\x1bp", Key::Alt('p')),
			(b"\x1bm", Key::Alt('m')),
			(b"\x1bl", Key::Alt('l')),
			(b"\x1br", Key::Alt('r')),
			(b"\x1b[112;3u", Key::Alt('p')),
			(b"\x1b[109;3u", Key::Alt('m')),
			(b"\x1b[Z", Key::BackTab),
			(b"\x1b[9;2u", Key::BackTab),
			(b"\x1b[112;6u", Key::CyclePrevious),
			(b"\x1b[112;4u", Key::PlanToggle),
			(b"\x1b[1;3A", Key::RestoreQueue),
			(b"\x1b[15~", Key::Function(5)),
		];
		for (bytes, expected) in cases {
			let mut keys = Vec::new();
			decode_keys(bytes, &mut keys);
			assert_eq!(keys, [*expected], "{bytes:?}");
		}
		// A split `ESC` + `p` within the escape hold is still one alt chord.
		let start = Instant::now();
		let mut decoder = InputDecoder::new();
		let mut events = Vec::new();
		decoder.feed(b"\x1b", start, &mut events);
		decoder.feed(b"p", start + Duration::from_millis(20), &mut events);
		assert_eq!(events, [InputEvent::Key(Key::Alt('p'))]);
	}

	#[test]
	fn streaming_decoder_holds_split_escapes_until_timeout() {
		let start = Instant::now();
		let mut decoder = InputDecoder::new();
		let mut events = Vec::new();
		decoder.feed(b"\x1b", start, &mut events);
		decoder.feed(b"[A", start + Duration::from_millis(74), &mut events);
		assert_eq!(events, [InputEvent::Key(Key::Up)]);

		events.clear();
		let mut decoder = InputDecoder::new();
		decoder.feed(b"\x1b", start, &mut events);
		decoder.feed(b"[A", start + Duration::from_millis(76), &mut events);
		assert_eq!(events, [
			InputEvent::Key(Key::Esc),
			InputEvent::Key(Key::Char('[')),
			InputEvent::Key(Key::Char('A')),
		]);

		events.clear();
		let mut decoder = InputDecoder::new();
		decoder.set_kitty_keyboard(true);
		decoder.feed(b"\x1b", start, &mut events);
		decoder.tick(start + Duration::from_millis(224), &mut events);
		assert!(events.is_empty());
		decoder.tick(start + Duration::from_millis(225), &mut events);
		assert_eq!(events, [InputEvent::Key(Key::Esc)]);
	}
	#[test]
	fn decoder_deadline_tracks_pending_partial_input() {
		let start = Instant::now();
		let mut decoder = InputDecoder::new();
		let mut events = Vec::new();
		assert_eq!(decoder.deadline(), None);

		decoder.feed(b"\x1b[", start, &mut events);
		assert!(events.is_empty());
		assert_eq!(decoder.deadline(), Some(start + Duration::from_millis(75)));

		decoder.tick(start + Duration::from_millis(75), &mut events);
		assert_eq!(events, [InputEvent::Key(Key::Esc), InputEvent::Key(Key::Char('['))]);
		assert_eq!(decoder.deadline(), None);
	}

	#[test]
	fn torn_string_payload_is_discarded_and_recovers_after_split_st() {
		let start = Instant::now();
		let mut decoder = InputDecoder::new();
		let mut events = Vec::new();
		decoder.feed(b"\x1b]5522;partial", start, &mut events);
		decoder.tick(start + Duration::from_millis(75), &mut events);
		assert!(events.is_empty());
		decoder.feed(b"base64\x1b", start + Duration::from_millis(76), &mut events);
		decoder.feed(b"\\ok", start + Duration::from_millis(77), &mut events);
		assert_eq!(events, [InputEvent::Key(Key::Char('o')), InputEvent::Key(Key::Char('k')),]);
	}

	#[test]
	fn torn_string_discard_has_inactivity_and_byte_bounds() {
		let start = Instant::now();
		let mut decoder = InputDecoder::new();
		let mut events = Vec::new();
		decoder.feed(b"\x1bPpartial", start, &mut events);
		decoder.tick(start + Duration::from_millis(75), &mut events);
		decoder.tick(start + Duration::from_millis(1075), &mut events);
		decoder.feed(b"x", start + Duration::from_millis(1076), &mut events);
		assert_eq!(events, [InputEvent::Key(Key::Char('x'))]);

		events.clear();
		decoder.feed(b"\x1b_partial", start + Duration::from_millis(1080), &mut events);
		decoder.tick(start + Duration::from_millis(1155), &mut events);
		let oversized = vec![b'a'; STRING_DISCARD_MAX_BYTES + 1];
		decoder.feed(&oversized, start + Duration::from_millis(1156), &mut events);
		assert!(events.is_empty());
		decoder.feed(b"z", start + Duration::from_millis(1157), &mut events);
		assert_eq!(events, [InputEvent::Key(Key::Char('z'))]);
	}

	#[test]
	fn streaming_decoder_disambiguates_alt_and_meta_escape_prefixes() {
		let start = Instant::now();
		let mut decoder = InputDecoder::new();
		let mut events = Vec::new();
		decoder.feed(b"\x1b\x1bd\x1b\x1b[D\x1b\x1b", start, &mut events);
		decoder.tick(start + Duration::from_millis(75), &mut events);
		assert_eq!(events, [
			InputEvent::Key(Key::Esc),
			InputEvent::Key(Key::WordDelete),
			InputEvent::Key(Key::WordLeft),
			InputEvent::Key(Key::Esc),
			InputEvent::Key(Key::Esc),
		]);
	}

	#[test]
	fn decoder_maps_alt_enter_variants_to_followup() {
		let start = Instant::now();
		let mut events = Vec::new();
		let mut decoder = InputDecoder::new();
		decoder.feed(b"\x1b[13;3u", start, &mut events);
		assert_eq!(events, [InputEvent::Key(Key::FollowUp)]);
		events.clear();
		decoder.feed(b"\x1b\r", start, &mut events);
		assert_eq!(events, [InputEvent::Key(Key::FollowUp)]);
	}

	#[test]
	fn streaming_decoder_filters_late_replies_and_decodes_key_families() {
		let start = Instant::now();
		let mut decoder = InputDecoder::new();
		let mut events = Vec::new();
		decoder.feed(b"x\x1b[?1;2c\x1b[15~\x1b[24~\x1b[1;5D\x1b[I\x1b[O", start, &mut events);
		assert_eq!(events, [
			InputEvent::Key(Key::Char('x')),
			InputEvent::Response(TerminalResponse::DeviceAttributes("?1;2".into())),
			InputEvent::Key(Key::Function(5)),
			InputEvent::Key(Key::Function(12)),
			InputEvent::Key(Key::WordLeft),
			InputEvent::Focus(true),
			InputEvent::Focus(false),
		]);
	}

	#[test]
	fn bare_lf_decodes_as_shift_enter_while_cr_stays_enter() {
		// The composer and /tree selector accept three Shift+Enter encodings —
		// kitty CSI-u (covered by the keymap rows), the legacy
		// `CSI 13;2~` form, and a bare LF from the iTerm2 mapping. Raw-mode
		// Enter always arrives as CR.
		let start = Instant::now();
		let mut decoder = InputDecoder::new();
		let mut events = Vec::new();
		decoder.feed(b"\r\n\x1b[13;2~", start, &mut events);
		assert_eq!(events, [
			InputEvent::Key(Key::Enter),
			InputEvent::Key(Key::ShiftEnter),
			InputEvent::Key(Key::ShiftEnter),
		]);
	}

	#[test]
	fn submit_remap_on_ctrl_enter_wins_over_follow_up_default() {
		// A chord the user explicitly binds to submit must win over the hardcoded
		// Ctrl+Enter -> follow-up default. OMP's
		// chord spellings are table-owned rows, so rebinding the exact chord
		// replaces the default `(Enter, ctrl) -> FollowUp` row — including under kitty
		// caps/num lock bits, which the decoder drops before lookup. Bare LF
		// (the iTerm2 Shift+Enter mapping) stays exempt: it decodes as the
		// Shift+Enter chord, so a Ctrl+Enter remap never captures it.
		let start = Instant::now();
		let mut decoder = InputDecoder::new();
		decoder
			.keymap_mut()
			.bind(Chord::new(Key::Enter, mods_from_bits(4)), Key::Enter);
		let mut events = Vec::new();
		// Ctrl+Enter as kitty CSI-u: plain, +caps lock (64), +num lock (128),
		// then a bare LF.
		decoder.feed(b"\x1b[13;5u\x1b[13;69u\x1b[13;133u\n", start, &mut events);
		assert_eq!(events, [
			InputEvent::Key(Key::Enter),
			InputEvent::Key(Key::Enter),
			InputEvent::Key(Key::Enter),
			InputEvent::Key(Key::ShiftEnter),
		]);

		// Under the default table the same spelling is still the follow-up chord.
		let mut keys = Vec::new();
		decode_keys(b"\x1b[13;5u", &mut keys);
		assert_eq!(keys, [Key::FollowUp]);
	}

	#[test]
	fn split_private_csi_report_reassembles_after_partial_expiry() {
		// A Device-Attributes reply split by a slow SSH/PTY link.
		// The prefix outlives the partial hold, the tail arrives as ordinary
		// bytes; neither half may leak into the composer as literal text.
		let start = Instant::now();
		let mut decoder = InputDecoder::new();
		let mut events = Vec::new();
		decoder.feed(b"\x1b[?1;22;23", start, &mut events);
		decoder.tick(start + Duration::from_millis(200), &mut events);
		assert!(events.is_empty());
		decoder.feed(b";24;28;32;42;52c", start + Duration::from_millis(300), &mut events);
		assert_eq!(events, [InputEvent::Response(TerminalResponse::DeviceAttributes(
			"?1;22;23;24;28;32;42;52".into(),
		))]);
	}

	#[test]
	fn abandoned_private_csi_partial_yields_to_new_escape_input() {
		let start = Instant::now();
		let mut decoder = InputDecoder::new();
		let mut events = Vec::new();
		decoder.feed(b"\x1b[?1;2", start, &mut events);
		decoder.tick(start + Duration::from_millis(200), &mut events);
		assert!(events.is_empty());
		// A new escape can never continue a report: the stale partial is
		// dropped as terminal noise and the arrow decodes normally.
		decoder.feed(b"\x1b[A", start + Duration::from_millis(300), &mut events);
		assert_eq!(events, [InputEvent::Key(Key::Up)]);
	}

	#[test]
	fn kitty_csi_u_suppresses_release_delivers_repeat_and_deduplicates_printable() {
		let start = Instant::now();
		let mut decoder = InputDecoder::new();
		let mut events = Vec::new();
		decoder.feed(b"\x1b[97;1:3u\x1b[98;1:2u\x1b[97u", start, &mut events);
		decoder.feed(b"a", start + Duration::from_millis(25), &mut events);
		decoder.feed(b"a", start + Duration::from_millis(26), &mut events);
		decoder.feed(b"\x1b[32u ", start + Duration::from_millis(27), &mut events);
		assert_eq!(events, [
			InputEvent::Key(Key::Char('b')),
			InputEvent::Key(Key::Char('a')),
			InputEvent::Key(Key::Char('a')),
			InputEvent::Key(Key::Space),
		]);
	}

	#[test]
	fn bracketed_paste_reassembles_recovers_and_decodes_tmux_controls() {
		let start = Instant::now();
		let mut decoder = InputDecoder::new();
		let mut events = Vec::new();
		decoder.feed(b"\x1b[20", start, &mut events);
		decoder.feed(b"0~one\r", start + Duration::from_millis(10), &mut events);
		decoder.feed(b"\ntwo\x1b[201~", start + Duration::from_millis(20), &mut events);
		assert_eq!(events, [InputEvent::Paste("one\ntwo".into())]);

		events.clear();
		decoder.feed(
			b"\x1b[200~a\x1b[106;5ub\x1b[27;5;105~c\x1b[201~",
			start + Duration::from_millis(30),
			&mut events,
		);
		assert_eq!(events, [InputEvent::Paste("a\nb   c".into())]);

		events.clear();
		decoder.feed(b"\x1b[200~unterminated", start + Duration::from_millis(40), &mut events);
		decoder.tick(start + Duration::from_millis(1040), &mut events);
		assert_eq!(events, [InputEvent::Paste("unterminated".into())]);
	}

	#[test]
	fn sgr_mouse_reports_hold_splits_and_preserve_raw_details() {
		let start = Instant::now();
		let mut decoder = InputDecoder::new();
		let mut events = Vec::new();
		decoder.feed(b"\x1b[<60;1", start, &mut events);
		decoder.feed(b"0;4M", start + Duration::from_millis(150), &mut events);
		decoder.feed(b"\x1b[<65;3;2M\x1b[<32;7;8M", start + Duration::from_millis(151), &mut events);
		assert_eq!(events, [
			InputEvent::Mouse(MouseReport {
				kind:    Mouse::Drag,
				col:     9,
				row:     3,
				button:  MouseButton::Left,
				mods:    Mods { shift: true, alt: true, ctrl: true, ..Mods::default() },
				pressed: true,
			}),
			InputEvent::Mouse(MouseReport {
				kind:    Mouse::WheelDown,
				col:     2,
				row:     1,
				button:  MouseButton::WheelDown,
				mods:    Mods::default(),
				pressed: true,
			}),
			InputEvent::Mouse(MouseReport {
				kind:    Mouse::Drag,
				col:     6,
				row:     7,
				button:  MouseButton::Left,
				mods:    Mods::default(),
				pressed: true,
			}),
		]);
	}

	#[test]
	fn sgr_mouse_maps_buttons_wheels_drag_and_release() {
		let cases = [
			(b"\x1b[<2;4;5M".as_slice(), Mouse::RightClick),
			(b"\x1b[<1;4;5M".as_slice(), Mouse::MiddleClick),
			(b"\x1b[<66;4;5M".as_slice(), Mouse::WheelLeft),
			(b"\x1b[<67;4;5M".as_slice(), Mouse::WheelRight),
			(b"\x1b[<32;4;5M".as_slice(), Mouse::Drag),
			(b"\x1b[<0;4;5m".as_slice(), Mouse::Release),
		];
		for (bytes, kind) in cases {
			let start = Instant::now();
			let mut decoder = InputDecoder::new();
			let mut events = Vec::new();
			decoder.feed(bytes, start, &mut events);
			assert_eq!(events.len(), 1);
			let InputEvent::Mouse(report) = events[0] else {
				panic!("expected mouse report");
			};
			assert_eq!(report.kind, kind);
			assert_eq!((report.col, report.row), (3, 4));
		}
	}

	#[test]
	fn capability_responses_parse_whole_and_byte_dripped() {
		let cases = [
			(
				b"\x1b]11;rgb:ffff/0000/8080\x07".as_slice(),
				InputEvent::Response(TerminalResponse::OscColor {
					index: 11,
					r:     0xffff,
					g:     0,
					b:     0x8080,
				}),
			),
			(
				b"\x1b]11;rgba:ff/00/80\x1b\\".as_slice(),
				InputEvent::Response(TerminalResponse::OscColor {
					index: 11,
					r:     0xffff,
					g:     0,
					b:     0x8080,
				}),
			),
			(b"\x1b[?997;1n".as_slice(), InputEvent::Response(TerminalResponse::AppearanceChanged(1))),
			(
				b"\x1b[48;24;80;1600;800 t".as_slice(),
				InputEvent::Response(TerminalResponse::InBandResize {
					rows: 24,
					cols: 80,
					x_px: 800,
					y_px: 1600,
				}),
			),
		];
		for (bytes, expected) in cases {
			let start = Instant::now();
			let mut decoder = InputDecoder::new();
			let mut events = Vec::new();
			decoder.feed(bytes, start, &mut events);
			assert_eq!(events.as_slice(), slice::from_ref(&expected));
			assert_eq!(drip(bytes), [expected]);
		}
	}

	#[test]
	fn decoder_maps_mouse_gestures_with_position() {
		let cases = [
			(b"\x1b[<0;4;8M".as_slice(), Mouse::Click),
			(b"\x1b[<64;4;8M".as_slice(), Mouse::WheelUp),
			(b"\x1b[<35;4;8M".as_slice(), Mouse::Move),
			(b"\x1b[<2;4;8M".as_slice(), Mouse::RightClick),
			(b"\x1b[<1;4;8M".as_slice(), Mouse::MiddleClick),
			(b"\x1b[<32;4;8M".as_slice(), Mouse::Drag),
			(b"\x1b[<0;4;8m".as_slice(), Mouse::Release),
			(b"\x1b[<66;4;8M".as_slice(), Mouse::WheelLeft),
			(b"\x1b[<67;4;8M".as_slice(), Mouse::WheelRight),
		];
		for (bytes, expected) in cases {
			let events = drip(bytes);
			let [InputEvent::Mouse(report)] = events.as_slice() else {
				panic!("expected one mouse event");
			};
			assert_eq!(report.kind, expected);
			assert_eq!((report.col, report.row), (3, 7));
		}
	}

	#[test]
	fn word_helpers_follow_pi_coarse_semantics() {
		use super::{word_left_column, word_right_column, word_rubout_start};
		let text = "foo-bar baz";
		assert_eq!(word_left_column(text, 11), 8);
		assert_eq!(word_left_column(text, 8), 0);
		assert_eq!(word_right_column(text, 0), 7);
		assert_eq!(word_right_column(text, 7), 11);
		assert_eq!(word_rubout_start(text, 7), 0);
		assert_eq!(word_left_column("中文", 4), 2);
		assert_eq!(word_right_column("中文", 0), 2);
	}
}
