//! Decode Windows console win32-input-mode key records into the key sequences
//! the rest of the TUI already understands.
//!
//! Hosts without the kitty keyboard protocol (Windows Terminal before 1.25)
//! deliver Shift+Enter as a bare `\r` (indistinguishable from Enter) and
//! Ctrl+Enter as `\n`. Enabling `CSI ? 9001 h` makes the console host serving
//! this process report every key as `CSI Vk ; Sc ; Uc ; Kd ; Cs ; Rc _`, which
//! carries the full modifier state. Mouse reports and terminal replies keep
//! arriving as plain VT. Pasted text mostly does too, but the console host
//! re-encodes some pasted characters (line breaks) as key records inside the
//! bracketed paste; [`Win32InputModeDecoder::decode_paste`] turns those back
//! into text.
//!
//! Unmodified and legacy-expressible keys translate to the bytes a legacy
//! terminal sends; chords legacy encoding loses (modified Enter/Tab/Escape,
//! Ctrl+Shift+letter, …) translate to kitty CSI-u, which key matching already
//! parses.
//!
//! A host terminal that writes VT instead of key records (any `ConPTY` host
//! besides Windows Terminal's native path) reaches us as one `Vk = 0` text
//! record per byte: Alt+Up arrives as `ESC`, `[`, `1`, `;`, `3`, `A`. Those
//! bytes are reassembled into the escape sequence they spell; delivering them
//! one at a time turns every such key into a bare Escape plus typed garbage.

use std::{borrow::Cow, mem};

use super::{Deferred, scan::parse_saturating};
use crate::tui::types::Millis;

const RIGHT_ALT_PRESSED: u32 = 0x0001;
const LEFT_ALT_PRESSED: u32 = 0x0002;
const RIGHT_CTRL_PRESSED: u32 = 0x0004;
const LEFT_CTRL_PRESSED: u32 = 0x0008;
const SHIFT_PRESSED: u32 = 0x0010;

const VK_BACK: u32 = 0x08;
const VK_TAB: u32 = 0x09;
const VK_RETURN: u32 = 0x0d;
const VK_MENU: u32 = 0x12;
const VK_ESCAPE: u32 = 0x1b;
const VK_SPACE: u32 = 0x20;
const VK_J: u32 = 0x4a;
const VK_PACKET: u32 = 0xe7;

/// How long a split record or an incomplete record-encoded paste marker waits
/// for the rest before the held records are released unchanged.
const NORMALIZER_HOLD_MS: Millis = 75.0;
const MAX_RECORD_LENGTH: usize = 64;

/// Keys encoded as fixed bytes that can still carry text a pending dead key
/// composed.
const fn is_composable_fixed_vk(vk: u32) -> bool {
	matches!(vk, VK_BACK | VK_TAB | VK_RETURN | VK_ESCAPE | VK_SPACE)
}

/// Modifier and lock keys: their own presses produce no input.
const fn is_modifier_vk(vk: u32) -> bool {
	matches!(
		vk,
		0x10 // VK_SHIFT
			| 0x11 // VK_CONTROL
			| 0x12 // VK_MENU
			| 0x14 // VK_CAPITAL
			| 0x5b // VK_LWIN
			| 0x5c // VK_RWIN
			| 0x90 // VK_NUMLOCK
			| 0x91 // VK_SCROLL
			| 0xa0 // VK_LSHIFT
			| 0xa1 // VK_RSHIFT
			| 0xa2 // VK_LCONTROL
			| 0xa3 // VK_RCONTROL
			| 0xa4 // VK_LMENU
			| 0xa5 // VK_RMENU
	)
}

/// Cursor keys: legacy `CSI <final>`, modified `CSI 1 ; <mod> <final>`.
const fn cursor_final(vk: u32) -> Option<char> {
	Some(match vk {
		0x23 => 'F', // VK_END
		0x24 => 'H', // VK_HOME
		0x25 => 'D', // VK_LEFT
		0x26 => 'A', // VK_UP
		0x27 => 'C', // VK_RIGHT
		0x28 => 'B', // VK_DOWN
		0x70 => 'P', // VK_F1 (legacy SS3)
		0x71 => 'Q', // VK_F2
		0x72 => 'R', // VK_F3
		0x73 => 'S', // VK_F4
		_ => return None,
	})
}

/// F1-F4 use SS3 when unmodified.
const fn is_ss3_vk(vk: u32) -> bool {
	matches!(vk, 0x70..=0x73)
}

/// Tilde keys: `CSI <n> ~`, modified `CSI <n> ; <mod> ~`.
const fn tilde_code(vk: u32) -> Option<u32> {
	Some(match vk {
		0x21 => 5,  // VK_PRIOR
		0x22 => 6,  // VK_NEXT
		0x2d => 2,  // VK_INSERT
		0x2e => 3,  // VK_DELETE
		0x74 => 15, // VK_F5
		0x75 => 17, // VK_F6
		0x76 => 18, // VK_F7
		0x77 => 19, // VK_F8
		0x78 => 20, // VK_F9
		0x79 => 21, // VK_F10
		0x7a => 23, // VK_F11
		0x7b => 24, // VK_F12
		_ => return None,
	})
}

/// One `CSI Vk ; Sc ; Uc ; Kd ; Cs ; Rc _` key record.
#[derive(Clone, Copy, Debug)]
struct KeyRecord {
	vk:     u32,
	/// UTF-16 code unit the key produced (0 = none).
	uc:     u32,
	down:   bool,
	state:  u32,
	repeat: u32,
}

const fn is_record_param(byte: u8) -> bool {
	byte.is_ascii_digit() || byte == b';'
}

fn parse_record(data: &str) -> Option<KeyRecord> {
	let body = data.strip_prefix("\x1b[")?.strip_suffix('_')?;
	if !body.bytes().all(is_record_param) {
		return None;
	}
	let mut params = [None; 6];
	for (index, raw) in body.split(';').enumerate() {
		*params.get_mut(index)? = (!raw.is_empty()).then(|| parse_saturating(raw));
	}
	let at = |index: usize, fallback: u32| params[index].unwrap_or(fallback);
	Some(KeyRecord {
		vk:     at(0, 0),
		uc:     at(2, 0),
		down:   at(3, 0) == 1,
		state:  at(4, 0),
		// `wRepeatCount` is a WORD; the bound keeps a forged record from
		// demanding gigabytes of repeated text.
		repeat: at(5, 1).clamp(1, u32::from(u16::MAX)),
	})
}

/// Lowercase codepoint a letter/digit virtual key stands for, or 0.
const fn base_codepoint_for_vk(vk: u32) -> u32 {
	match vk {
		0x41..=0x5a => vk + 0x20,
		0x30..=0x39 => vk,
		_ => 0,
	}
}

/// Text of one BMP code unit (empty for 0 and for a lone surrogate).
fn unit_text(code_unit: u32) -> String {
	if code_unit == 0 {
		return String::new();
	}
	char::from_u32(code_unit & 0xffff).map_or_default(String::from)
}

/// Classification of relayed VT text that starts with ESC.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VtState {
	Partial,
	Complete,
	Invalid,
	/// The leading ESC is a standalone Escape and the rest starts a new
	/// sequence.
	Split,
}

/// Classify relayed VT text that starts with ESC.
fn vt_state(text: &str) -> VtState {
	let bytes = text.as_bytes();
	let Some(&introducer) = bytes.get(1) else {
		return VtState::Partial;
	};
	match introducer {
		0x1b => match bytes.get(2) {
			None => VtState::Partial,
			// Only meta-CSI/SS3 (legacy Alt+Up is `ESC ESC [ A`) stays grouped;
			// `ESC ESC d` is Escape followed by Alt+d, matching the splitter.
			Some(b'[' | b'O') => vt_state(&text[1..]),
			Some(_) => VtState::Split,
		},
		b'[' => {
			// `CSI` parameter bytes `0-?`, intermediates ` -/`, one final `@-~`.
			let body = &bytes[2..];
			let params = body
				.iter()
				.take_while(|byte| (0x30..=0x3f).contains(*byte))
				.count();
			let intermediates = body[params..]
				.iter()
				.take_while(|byte| (0x20..=0x2f).contains(*byte))
				.count();
			match &body[params + intermediates..] {
				[] => VtState::Partial,
				[last] if (0x40..=0x7e).contains(last) => VtState::Complete,
				_ => VtState::Invalid,
			}
		},
		b'O' => match text.chars().count() {
			2 => VtState::Partial,
			3 => VtState::Complete,
			_ => VtState::Invalid,
		},
		b']' | b'P' | b'_' => {
			if text.ends_with('\x07') || (text.len() > 3 && text.ends_with("\x1b\\")) {
				VtState::Complete
			} else {
				VtState::Partial
			}
		},
		// ESC + one character: Alt+character.
		_ if text.chars().count() == 2 => VtState::Complete,
		_ => VtState::Invalid,
	}
}

fn encode_key(record: &KeyRecord) -> Option<String> {
	let KeyRecord { vk, uc, state, .. } = *record;
	let shift = state & SHIFT_PRESSED != 0;
	let alt = state & (LEFT_ALT_PRESSED | RIGHT_ALT_PRESSED) != 0;
	let ctrl = state & (LEFT_CTRL_PRESSED | RIGHT_CTRL_PRESSED) != 0;
	let modifier = 1 + u32::from(shift) + 2 * u32::from(alt) + 4 * u32::from(ctrl);
	let text = unit_text(uc);

	// A pending dead key composes onto the next key: on US-International, `'`
	// then Space arrives as a Space record carrying `'`, and `'` then Enter as
	// an Enter record carrying `'` followed by one carrying `\r`. The carried
	// text is the input.
	if !ctrl && !alt && uc > 0x20 && uc != 0x7f && is_composable_fixed_vk(vk) {
		return Some(text);
	}

	match vk {
		VK_RETURN => {
			return Some(if modifier == 1 {
				"\r".to_owned()
			} else {
				format!("\x1b[13;{modifier}u")
			});
		},
		VK_TAB => {
			return Some(match modifier {
				1 => "\t".to_owned(),
				2 => "\x1b[Z".to_owned(),
				_ => format!("\x1b[9;{modifier}u"),
			});
		},
		VK_BACK => {
			return Some(match modifier {
				1 => "\x7f".to_owned(),
				3 => "\x1b\x7f".to_owned(),
				_ => format!("\x1b[127;{modifier}u"),
			});
		},
		VK_ESCAPE => {
			return Some(if modifier == 1 {
				"\x1b".to_owned()
			} else {
				format!("\x1b[27;{modifier}u")
			});
		},
		VK_SPACE => {
			return Some(if !ctrl && !alt {
				" ".to_owned()
			} else {
				format!("\x1b[32;{modifier}u")
			});
		},
		_ => {},
	}

	if let Some(letter) = cursor_final(vk) {
		return Some(if modifier != 1 {
			format!("\x1b[1;{modifier}{letter}")
		} else if is_ss3_vk(vk) {
			format!("\x1bO{letter}")
		} else {
			format!("\x1b[{letter}")
		});
	}
	if let Some(code) = tilde_code(vk) {
		return Some(if modifier == 1 {
			format!("\x1b[{code}~")
		} else {
			format!("\x1b[{code};{modifier}~")
		});
	}

	// AltGr arrives as Right Alt + Left Ctrl; when it composed printable text,
	// that text is the input.
	let alt_gr = state & RIGHT_ALT_PRESSED != 0 && state & LEFT_CTRL_PRESSED != 0;
	if alt_gr && uc >= 0x20 && uc != 0x7f {
		return Some(text);
	}

	let base = base_codepoint_for_vk(vk);
	if ctrl {
		// Windows Terminal / ConPTY report Ctrl+J as VK_J with Uc=LF. Returning
		// the raw LF would make the editor treat it as Enter, so keep the key
		// identity. Only J is special-cased: `ctrl+j` is a default
		// `tui.input.newLine` binding, while Ctrl+M/I (CR/Tab) already decode to
		// the keys their C0 bytes represent.
		let ctrl_j = !alt && vk == VK_J && uc == 0x0a;
		// Ctrl+Shift+letter collapses onto Ctrl+letter in legacy bytes; keep it
		// distinct.
		if (shift || uc == 0 || ctrl_j) && base != 0 {
			return Some(format!("\x1b[{base};{modifier}u"));
		}
		if uc == 0 {
			return None;
		}
		return Some(if alt { format!("\x1b{text}") } else { text });
	}
	if alt {
		if uc != 0 {
			return Some(format!("\x1b{text}"));
		}
		return char::from_u32(base)
			.filter(|_| base != 0)
			.map(|letter| format!("\x1b{letter}"));
	}
	// Plain or shifted key; Uc 0 is a dead key whose composed text arrives with
	// the next key.
	(uc != 0).then_some(text)
}

/// Stateful decoder: joins UTF-16 surrogate halves that arrive as separate
/// records, and reassembles VT escape sequences relayed as text records.
#[derive(Default)]
pub(super) struct Win32InputModeDecoder {
	pending_high_surrogate: u16,
	/// Relayed VT text that starts with ESC and has not completed a sequence
	/// yet.
	pending_vt:             String,
}

impl Win32InputModeDecoder {
	/// Whether relayed VT text is held waiting for the rest of its sequence.
	pub(super) const fn has_pending_sequence(&self) -> bool {
		!self.pending_vt.is_empty()
	}

	/// Whether the held relayed text is an OSC/DCS/APC string still waiting for
	/// its terminator (a TSP event, a clipboard or colour reply). Unlike a lone
	/// ESC or a short CSI, releasing it early cannot be mistaken for a key: the
	/// head would be handed on as a fragment and the tail typed as text. A bare
	/// two-byte introducer is not a string yet: it may be an Alt chord (Alt+]).
	pub(super) const fn has_pending_string(&self) -> bool {
		let bytes = self.pending_vt.as_bytes();
		bytes.len() >= 3 && matches!(bytes[1], b']' | b'P' | b'_')
	}

	/// Release held VT text as-is. The caller invokes this once no further
	/// bytes arrived in time, so a lone relayed ESC still acts as the Escape
	/// key.
	pub(super) fn flush_pending_sequence(&mut self) -> Option<String> {
		(!self.pending_vt.is_empty()).then(|| mem::take(&mut self.pending_vt))
	}

	/// Translate one stdin sequence. Returns `false` when `data` is not a
	/// win32-input-mode record (pass it through unchanged), otherwise pushes
	/// the key events it produces — none for key releases and bare modifier
	/// presses.
	pub(super) fn decode(&mut self, data: &str, keys: &mut Vec<String>) -> bool {
		let Some(record) = parse_record(data) else {
			return false;
		};

		if !record.down {
			// Alt+Numpad composition delivers its character on the Alt release.
			if record.vk == VK_MENU && record.uc != 0 {
				self.relay_text(record.uc, 1, keys);
			}
			return true;
		}
		if is_modifier_vk(record.vk) {
			return true;
		}
		if record.vk == 0 || record.vk == VK_PACKET {
			self.relay_text(record.uc, record.repeat, keys);
			return true;
		}
		if (0xd800..=0xdfff).contains(&record.uc) {
			self.relay_text(record.uc, 1, keys);
			return true;
		}

		self.pending_high_surrogate = 0;
		let encoded = encode_key(&record);
		// A real key ends whatever relayed text was still incomplete.
		keys.extend(self.flush_pending_sequence());
		if let Some(encoded) = encoded {
			keys.extend(std::iter::repeat_n(encoded, record.repeat as usize));
		}
		true
	}

	/// Text a record carries, grouped into whole escape sequences; other text
	/// passes through per character.
	fn relay_text(&mut self, code_unit: u32, repeat: u32, keys: &mut Vec<String>) {
		let Some(text) = self.emit_text(code_unit) else {
			return;
		};
		for _ in 0..repeat {
			if self.pending_vt.is_empty() && text != "\x1b" {
				keys.push(text.clone());
				continue;
			}
			self.pending_vt.push_str(&text);
			let mut state = vt_state(&self.pending_vt);
			while state == VtState::Split {
				keys.push("\x1b".to_owned());
				self.pending_vt.remove(0);
				state = vt_state(&self.pending_vt);
			}
			if state == VtState::Partial {
				continue;
			}
			keys.push(mem::take(&mut self.pending_vt));
		}
	}

	/// Replace the key records embedded in bracketed paste `content` with the
	/// text they type, so a pasted line break stays a line break instead of
	/// acting as Enter. Key-downs yield their character (`\r` for Enter);
	/// releases and keys without text yield nothing. Text that merely looks
	/// like a record without ESC is left alone.
	pub(super) fn decode_paste(&mut self, content: String) -> String {
		if !content.contains("\x1b[") {
			return content;
		}
		self.pending_high_surrogate = 0;
		let mut decoded = String::with_capacity(content.len());
		let mut rest = content.as_str();
		while let Some(start) = rest.find("\x1b[") {
			let body = &rest[start + 2..];
			let params = body
				.bytes()
				.take_while(|&byte| is_record_param(byte))
				.count();
			if body.as_bytes().get(params) != Some(&b'_') {
				decoded.push_str(&rest[..start + 2]);
				rest = body;
				continue;
			}
			decoded.push_str(&rest[..start]);
			let (record, after) = rest[start..].split_at(2 + params + 1);
			match parse_record(record) {
				None => decoded.push_str(record),
				Some(key) if !key.down => {},
				Some(key) => {
					if let Some(text) = self.emit_text(key.uc) {
						for _ in 0..key.repeat {
							decoded.push_str(&text);
						}
					}
				},
			}
			rest = after;
		}
		decoded.push_str(rest);
		self.pending_high_surrogate = 0;
		decoded
	}

	/// Text of one UTF-16 code unit, joining a low surrogate with the high
	/// half a previous record delivered.
	fn emit_text(&mut self, code_unit: u32) -> Option<String> {
		if code_unit == 0 {
			return None;
		}
		if let Ok(high @ 0xd800..=0xdbff) = u16::try_from(code_unit) {
			self.pending_high_surrogate = high;
			return None;
		}
		let text = match u16::try_from(code_unit) {
			Ok(low @ 0xdc00..=0xdfff) => {
				if self.pending_high_surrogate == 0 {
					return None;
				}
				char::decode_utf16([self.pending_high_surrogate, low])
					.next()
					.and_then(Result::ok)
					.map(String::from)
			},
			_ => Some(unit_text(code_unit)).filter(|text| !text.is_empty()),
		};
		self.pending_high_surrogate = 0;
		text
	}
}

/// Restores paste delimiters that a Windows console host emitted as individual
/// win32-input-mode key records before the splitter searches for the
/// delimiters. Non-matching records remain untouched for normal key and paste
/// decoding.
#[derive(Default)]
pub(super) struct Win32PasteMarkerNormalizer {
	pending:   String,
	candidate: String,
	index:     usize,
	marker:    char,
	/// Releases held records whose wait timed out. A stalled loop can have the
	/// rest of a record waiting in stdin's queue; the deferral releases only
	/// after it has had a chance to arrive.
	timer:     Deferred,
}

impl Win32PasteMarkerNormalizer {
	/// Normalize one stdin read; returns the text to hand to the splitter
	/// (empty while everything is held).
	pub(super) fn process<'a>(&mut self, now: Millis, data: &'a str) -> Cow<'a, str> {
		if self.pending.is_empty() && self.candidate.is_empty() && !data.contains('\x1b') {
			return Cow::Borrowed(data);
		}
		self.timer.clear();
		let mut pending = mem::take(&mut self.pending);
		pending.push_str(data);
		let mut output = String::new();
		let mut pos = 0;

		while pos < pending.len() {
			match pending[pos..].find('\x1b') {
				None => {
					self.release_candidate(&mut output);
					output.push_str(&pending[pos..]);
					pos = pending.len();
					break;
				},
				Some(0) => {},
				Some(escape) => {
					self.release_candidate(&mut output);
					output.push_str(&pending[pos..pos + escape]);
					pos += escape;
				},
			}

			let rest = &pending[pos..];
			if rest.len() == 1 {
				break;
			}
			if rest.as_bytes()[1] != b'[' {
				self.release_candidate(&mut output);
				output.push('\x1b');
				pos += 1;
				continue;
			}
			let params = rest[2..]
				.bytes()
				.take_while(|&byte| is_record_param(byte))
				.count();
			let terminator = rest.as_bytes().get(2 + params);
			if terminator != Some(&b'_') {
				// A record prefix that ends the read may still complete.
				if rest.len() <= MAX_RECORD_LENGTH && terminator.is_none() {
					break;
				}
				self.release_candidate(&mut output);
				output.push('\x1b');
				pos += 1;
				continue;
			}

			let record = &rest[..=2 + params];
			pos += record.len();
			let key = parse_record(record);
			if !self.candidate.is_empty() && key.is_some_and(|key| !key.down) {
				self.candidate.push_str(record);
				continue;
			}
			let plain_down = key.filter(|key| key.down && key.state == 0 && key.repeat == 1);
			if let Some(key) = plain_down {
				let expected = if self.index == 0 {
					0x1b
				} else {
					u32::from(b"[200~"[self.index - 1])
				};
				if key.uc == expected || (self.index == 4 && key.uc == u32::from(b'1')) {
					if self.index == 4 {
						self.marker = if key.uc == u32::from(b'1') { '1' } else { '0' };
					}
					self.candidate.push_str(record);
					self.index += 1;
					if self.index == 6 {
						output.push_str("\x1b[20");
						output.push(self.marker);
						output.push('~');
						self.candidate.clear();
						self.index = 0;
					}
					continue;
				}
			}
			self.release_candidate(&mut output);
			if plain_down.is_some_and(|key| key.uc == 0x1b) {
				self.candidate.push_str(record);
				self.index = 1;
			} else {
				output.push_str(record);
			}
		}

		pending.drain(..pos);
		self.pending = pending;
		if !self.candidate.is_empty() || !self.pending.is_empty() {
			self.timer.arm(now + NORMALIZER_HOLD_MS);
		}
		Cow::Owned(output)
	}

	/// Advance the hold timer one stage; `Some` carries the released records
	/// once the wait has expired (the caller then treats a downstream hold on
	/// the same wait as already elapsed).
	pub(super) fn tick(&mut self, now: Millis) -> Option<String> {
		self.timer.poll(now).then(|| self.flush())
	}

	/// When [`Self::tick`] next has work to do.
	pub(super) const fn deadline(&self) -> Option<Millis> {
		self.timer.deadline()
	}

	/// Release an incomplete marker as its original key records.
	pub(super) fn flush(&mut self) -> String {
		self.timer.clear();
		self.index = 0;
		let mut raw = mem::take(&mut self.candidate);
		raw.push_str(&self.pending);
		self.pending.clear();
		raw
	}

	/// A candidate marker prefix turned out to be ordinary records.
	fn release_candidate(&mut self, output: &mut String) {
		output.push_str(&self.candidate);
		self.candidate.clear();
		self.index = 0;
	}
}

#[cfg(test)]
mod tests;
