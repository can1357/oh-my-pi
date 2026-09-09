//! winit → omp-tui input translation.
//!
//! Chords map through the *physical* key code so `Ctrl+P` means the same
//! keycap a terminal would report regardless of layout or Option-modified
//! characters; plain text rides the event's resolved `text`.

use omp_tui::{Chord, Key, Keymap, Mods, MouseButton};
use winit::{
	event::MouseButton as WinitButton,
	keyboard::{Key as WinitKey, KeyCode, ModifiersState, PhysicalKey},
};

/// winit modifiers → the report's modifier bits.
pub fn modifiers(state: ModifiersState) -> Mods {
	Mods {
		shift:     state.shift_key(),
		alt:       state.alt_key(),
		ctrl:      state.control_key(),
		super_key: state.super_key(),
		hyper:     false,
		meta:      false,
	}
}

/// Maps one key press through the configured terminal-vocabulary keymap.
///
/// Printable input without command modifiers keeps winit's layout-resolved
/// logical text. Chords use the physical keycap plus the complete modifier set
/// so their semantics match terminal input.
pub fn map_key(
	event: &winit::event::KeyEvent,
	mods: ModifiersState,
	keymap: &Keymap,
) -> Option<Key> {
	if mods.super_key() {
		return None;
	}
	let native = physical_key(event.physical_key).or_else(|| {
		if mods.control_key() || mods.alt_key() {
			return None;
		}
		let WinitKey::Character(text) = &event.logical_key else {
			return None;
		};
		text.chars().next().map(Key::Char)
	})?;
	let resolved = keymap.resolve(Chord::new(native, modifiers(mods)))?;
	if !mods.control_key()
		&& !mods.alt_key()
		&& resolved == identity_key(native, mods.shift_key())
		&& let WinitKey::Character(text) = &event.logical_key
	{
		let mut chars = text.chars();
		let character = chars.next()?;
		return Some(if character == ' ' && chars.next().is_none() {
			Key::Space
		} else {
			Key::Char(character)
		});
	}
	Some(resolved)
}

/// The fallback result for a plain physical key, used to recognize when
/// layout-resolved printable text should replace keycap identity.
const fn identity_key(key: Key, shifted: bool) -> Key {
	match key {
		Key::Char(' ') => Key::Space,
		Key::Char(character) if shifted => Key::Char(character.to_ascii_uppercase()),
		key => key,
	}
}

/// Resolves a physical winit key through the shared keymap.
#[cfg(test)]
fn resolve_physical(physical: PhysicalKey, mods: ModifiersState, keymap: &Keymap) -> Option<Key> {
	let key = physical_key(physical)?;
	keymap.resolve(Chord::new(key, modifiers(mods)))
}

/// Converts a physical winit keycap to the keymap's native key vocabulary.
fn physical_key(physical: PhysicalKey) -> Option<Key> {
	let PhysicalKey::Code(code) = physical else {
		return None;
	};
	Some(match code {
		KeyCode::ArrowUp => Key::Up,
		KeyCode::ArrowDown => Key::Down,
		KeyCode::ArrowLeft => Key::Left,
		KeyCode::ArrowRight => Key::Right,
		KeyCode::Tab => Key::Tab,
		KeyCode::Enter | KeyCode::NumpadEnter => Key::Enter,
		KeyCode::Escape => Key::Esc,
		KeyCode::Backspace => Key::Backspace,
		KeyCode::Delete => Key::Delete,
		KeyCode::Insert => Key::Insert,
		KeyCode::Home => Key::Home,
		KeyCode::End => Key::End,
		KeyCode::PageUp => Key::PageUp,
		KeyCode::PageDown => Key::PageDown,
		KeyCode::F1 => Key::Function(1),
		KeyCode::F2 => Key::Function(2),
		KeyCode::F3 => Key::Function(3),
		KeyCode::F4 => Key::Function(4),
		KeyCode::F5 => Key::Function(5),
		KeyCode::F6 => Key::Function(6),
		KeyCode::F7 => Key::Function(7),
		KeyCode::F8 => Key::Function(8),
		KeyCode::F9 => Key::Function(9),
		KeyCode::F10 => Key::Function(10),
		KeyCode::F11 => Key::Function(11),
		KeyCode::F12 => Key::Function(12),
		KeyCode::Space => Key::Space,
		_ => Key::Char(letter_of(physical)?),
	})
}

/// The QWERTY keycap character of a physical key, matching terminal chord
/// reports: letters, digits, and the `- = [ ] , .` symbol keys.
pub const fn letter_of(physical: PhysicalKey) -> Option<char> {
	let PhysicalKey::Code(code) = physical else {
		return None;
	};
	Some(match code {
		KeyCode::KeyA => 'a',
		KeyCode::KeyB => 'b',
		KeyCode::KeyC => 'c',
		KeyCode::KeyD => 'd',
		KeyCode::KeyE => 'e',
		KeyCode::KeyF => 'f',
		KeyCode::KeyG => 'g',
		KeyCode::KeyH => 'h',
		KeyCode::KeyI => 'i',
		KeyCode::KeyJ => 'j',
		KeyCode::KeyK => 'k',
		KeyCode::KeyL => 'l',
		KeyCode::KeyM => 'm',
		KeyCode::KeyN => 'n',
		KeyCode::KeyO => 'o',
		KeyCode::KeyP => 'p',
		KeyCode::KeyQ => 'q',
		KeyCode::KeyR => 'r',
		KeyCode::KeyS => 's',
		KeyCode::KeyT => 't',
		KeyCode::KeyU => 'u',
		KeyCode::KeyV => 'v',
		KeyCode::KeyW => 'w',
		KeyCode::KeyX => 'x',
		KeyCode::KeyY => 'y',
		KeyCode::KeyZ => 'z',
		KeyCode::Digit0 => '0',
		KeyCode::Digit1 => '1',
		KeyCode::Digit2 => '2',
		KeyCode::Digit3 => '3',
		KeyCode::Digit4 => '4',
		KeyCode::Digit5 => '5',
		KeyCode::Digit6 => '6',
		KeyCode::Digit7 => '7',
		KeyCode::Digit8 => '8',
		KeyCode::Digit9 => '9',
		KeyCode::Minus => '-',
		KeyCode::Equal => '=',
		KeyCode::BracketLeft => '[',
		KeyCode::BracketRight => ']',
		KeyCode::Semicolon => ';',
		KeyCode::Quote => '\'',
		KeyCode::Backquote => '`',
		KeyCode::Backslash => '\\',
		KeyCode::Comma => ',',
		KeyCode::Period => '.',
		KeyCode::Slash => '/',
		_ => return None,
	})
}

/// winit button → the report's physical button vocabulary.
pub const fn map_button(button: WinitButton) -> Option<MouseButton> {
	Some(match button {
		WinitButton::Left => MouseButton::Left,
		WinitButton::Right => MouseButton::Right,
		WinitButton::Middle => MouseButton::Middle,
		_ => return None,
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn default_keymap_resolves_gui_chords_like_terminal_chords() {
		let keymap = Keymap::default();
		assert_eq!(
			resolve_physical(PhysicalKey::Code(KeyCode::Enter), ModifiersState::ALT, &keymap,),
			Some(Key::FollowUp),
		);
		assert_eq!(
			resolve_physical(
				PhysicalKey::Code(KeyCode::KeyD),
				ModifiersState::CONTROL | ModifiersState::SHIFT,
				&keymap,
			),
			Some(Key::DebugMenu),
		);
	}

	#[test]
	fn supplied_keymap_changes_gui_dispatch() {
		let mut keymap = Keymap::default();
		let mods = ModifiersState::ALT | ModifiersState::SHIFT;
		keymap.bind(Chord::new(Key::Char('k'), modifiers(mods)), Key::ToggleToolVisibility);

		assert_eq!(
			resolve_physical(PhysicalKey::Code(KeyCode::KeyK), mods, &keymap),
			Some(Key::ToggleToolVisibility),
		);
	}

	#[test]
	fn chord_conversion_preserves_every_modifier() {
		let state = ModifiersState::SHIFT
			| ModifiersState::ALT
			| ModifiersState::CONTROL
			| ModifiersState::SUPER;
		assert_eq!(modifiers(state), Mods {
			shift:     true,
			alt:       true,
			ctrl:      true,
			super_key: true,
			hyper:     false,
			meta:      false,
		},);
	}

	#[test]
	fn letter_of_covers_digits_and_symbol_row() {
		let cases = [
			(KeyCode::Digit7, '7'),
			(KeyCode::BracketRight, ']'),
			(KeyCode::Equal, '='),
			(KeyCode::Minus, '-'),
			(KeyCode::Comma, ','),
			(KeyCode::Period, '.'),
		];
		for (code, expected) in cases {
			assert_eq!(letter_of(PhysicalKey::Code(code)), Some(expected));
		}
	}
}
