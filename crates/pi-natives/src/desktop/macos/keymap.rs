//! Character → virtual key lookup on the current keyboard layout, so typed
//! text reaches applications that read a key event's key code rather than
//! the Unicode text it carries.

use std::{collections::HashMap, ffi::c_void, ptr::NonNull};

use objc2_core_foundation::{CFData, CFRetained, CFString, CFType};

/// A key, with the modifiers held around it, that types one character.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Keystroke {
	pub code:   u16,
	pub shift:  bool,
	pub option: bool,
}

pub(super) struct Keymap {
	strokes: HashMap<char, Keystroke>,
}

/// Virtual key codes of Return and Tab, which are the same on every layout;
/// the layout maps them to control characters.
const RETURN: u16 = 36;
const TAB: u16 = 48;
/// Highest virtual key code a keyboard layout defines.
const MAX_KEY_CODE: u16 = 127;
/// `UCKeyTranslate` modifier bits (`EventModifiers` shifted right by 8).
const SHIFT_STATE: u32 = 0x02;
const OPTION_STATE: u32 = 0x08;
const KEY_ACTION_DOWN: u16 = 0;

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
	static kTISPropertyUnicodeKeyLayoutData: &'static CFString;
	fn TISCopyCurrentKeyboardLayoutInputSource() -> *mut CFType;
	fn TISGetInputSourceProperty(source: &CFType, key: &CFString) -> *const c_void;
	fn LMGetKbdType() -> u8;
	fn UCKeyTranslate(
		layout: *const u8,
		code: u16,
		action: u16,
		modifiers: u32,
		keyboard_type: u32,
		options: u32,
		dead_key_state: *mut u32,
		capacity: usize,
		length: *mut usize,
		characters: *mut u16,
	) -> i32;
}

impl Keymap {
	/// The map of the current keyboard layout; `None` when the layout
	/// publishes no Unicode key layout data. Text Input Sources calls must not
	/// overlap; every caller holds the desktop input lock.
	pub(super) fn current() -> Option<Self> {
		// SAFETY: The copy follows the create rule, so `CFRetained` owns it.
		let source =
			unsafe { CFRetained::from_raw(NonNull::new(TISCopyCurrentKeyboardLayoutInputSource())?) };
		// SAFETY: `source` is a live input source and the key is a framework
		// constant; the property follows the get rule and lives with `source`.
		let data = unsafe { TISGetInputSourceProperty(&source, kTISPropertyUnicodeKeyLayoutData) };
		// SAFETY: `kTISPropertyUnicodeKeyLayoutData` is documented as a CFData.
		let data = unsafe { data.cast::<CFData>().as_ref()? };
		let layout = data.byte_ptr();
		// SAFETY: A plain getter with no preconditions.
		let keyboard_type = u32::from(unsafe { LMGetKbdType() });
		Some(Self::build(|code, modifiers| {
			// Dead-key processing stays on, so a dead key yields no character and
			// never maps: posted alone it would accent the next character instead.
			let mut dead_key_state = 0;
			let mut characters = [0u16; 4];
			let mut length = 0;
			// SAFETY: `layout` points into `data`, which `source` keeps alive for
			// this call, and every out-pointer is valid for the stated capacity.
			let status = unsafe {
				UCKeyTranslate(
					layout,
					code,
					KEY_ACTION_DOWN,
					modifiers,
					keyboard_type,
					0,
					&raw mut dead_key_state,
					characters.len(),
					&raw mut length,
					characters.as_mut_ptr(),
				)
			};
			(status == 0)
				.then(|| single_char(&characters[..length.min(characters.len())]))
				.flatten()
		}))
	}

	/// Keeps, per character, the first key that types it, trying no
	/// modifiers, then Shift, Option and Shift-Option, and main keys before
	/// the keypad, whose digits and operators repeat the main row.
	fn build(translate: impl Fn(u16, u32) -> Option<char>) -> Self {
		let codes = (0..=MAX_KEY_CODE)
			.filter(|&code| !is_keypad(code))
			.chain((0..=MAX_KEY_CODE).filter(|&code| is_keypad(code)));
		let mut strokes = HashMap::new();
		for (shift, option) in [(false, false), (true, false), (false, true), (true, true)] {
			let state = if shift { SHIFT_STATE } else { 0 } | if option { OPTION_STATE } else { 0 };
			for code in codes.clone() {
				if let Some(character) = translate(code, state) {
					strokes
						.entry(character)
						.or_insert(Keystroke { code, shift, option });
				}
			}
		}
		for (character, code) in [('\r', RETURN), ('\n', RETURN), ('\t', TAB)] {
			strokes.insert(character, Keystroke { code, shift: false, option: false });
		}
		Self { strokes }
	}

	pub(super) fn stroke(&self, character: char) -> Option<Keystroke> {
		self.strokes.get(&character).copied()
	}
}

const fn is_keypad(code: u16) -> bool {
	matches!(code, 65 | 67 | 69 | 71 | 75 | 76 | 78 | 81..=89 | 91 | 92)
}

/// The one printable character `units` spell, if they spell exactly one.
fn single_char(units: &[u16]) -> Option<char> {
	let mut characters = char::decode_utf16(units.iter().copied());
	match (characters.next(), characters.next()) {
		(Some(Ok(character)), None) if !character.is_control() => Some(character),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Key 0 types `q`/`Q`/`@`, key 1 types `é` only with Shift-Option, keypad
	/// 83 and main 18 both type `1`, and Return yields a control character.
	fn translate(code: u16, state: u32) -> Option<char> {
		match (code, state) {
			(0, 0) => Some('q'),
			(0, SHIFT_STATE) => Some('Q'),
			(0, OPTION_STATE) => Some('@'),
			(1, 0) => Some('e'),
			(1, 0x0a) => Some('é'),
			(18 | 83, 0) => Some('1'),
			(83, SHIFT_STATE) => Some('+'),
			(RETURN, _) => single_char(&[0x0d]),
			_ => None,
		}
	}

	#[test]
	fn characters_map_to_the_layouts_keys_with_their_modifiers() {
		let keymap = Keymap::build(translate);
		let stroke = |code, shift, option| Some(Keystroke { code, shift, option });
		assert_eq!(keymap.stroke('q'), stroke(0, false, false));
		assert_eq!(keymap.stroke('Q'), stroke(0, true, false));
		assert_eq!(keymap.stroke('@'), stroke(0, false, true));
		assert_eq!(keymap.stroke('é'), stroke(1, true, true));
		// The main row wins over the keypad; a keypad-only character still maps.
		assert_eq!(keymap.stroke('1'), stroke(18, false, false));
		assert_eq!(keymap.stroke('+'), stroke(83, true, false));
		// Return and Tab come from fixed codes, not the layout's control
		// characters.
		assert_eq!(keymap.stroke('\n'), stroke(RETURN, false, false));
		assert_eq!(keymap.stroke('\r'), stroke(RETURN, false, false));
		assert_eq!(keymap.stroke('\t'), stroke(TAB, false, false));
		assert_eq!(keymap.stroke('😀'), None);
	}

	#[test]
	fn only_one_printable_character_counts_as_typed() {
		// A dead key yields nothing, a control key a control character, and a
		// ligature key several characters: none of them types one character.
		assert_eq!(single_char(&[]), None);
		assert_eq!(single_char(&[0x0d]), None);
		assert_eq!(single_char(&[0x61, 0x62]), None);
		assert_eq!(single_char(&[0xd800]), None);
		assert_eq!(single_char(&[0x61]), Some('a'));
		assert_eq!(single_char(&[0xd83d, 0xde00]), Some('😀'));
	}

	#[test]
	fn current_layout_types_space_on_the_space_bar() {
		// Every layout types a space with the space bar, whatever its letters.
		let keymap = Keymap::current().expect("current keyboard layout data");
		assert_eq!(keymap.stroke(' '), Some(Keystroke { code: 49, shift: false, option: false }));
	}
}
