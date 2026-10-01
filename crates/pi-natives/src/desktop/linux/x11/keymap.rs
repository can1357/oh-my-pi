//! Keysym → keycode planning shared by the `XTest`, `XSendEvent`, and MPX
//! virtual-keyboard routes, so every route picks the same keycodes and holds
//! Shift for glyphs that live on the shifted level.

use x11rb::{
	connection::Connection,
	protocol::{xinput::ConnectionExt as _, xproto::ConnectionExt as _},
	rust_connection::RustConnection,
};
use xkeysym::Keysym;

use crate::desktop::{
	backend::Modifiers,
	error::{CoreResult, DesktopError},
	keys::KeyName,
};

/// One key transition, addressed by X keycode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct KeyStep {
	pub keycode: u8,
	pub press:   bool,
}

pub(super) struct Keymap {
	min_keycode:         u8,
	keysyms_per_keycode: u8,
	keysyms:             Vec<u32>,
	/// Core modifier mask bit each modifier keycode sets while held.
	modifier_masks:      Vec<(u8, u16)>,
}

impl Keymap {
	/// The core keyboard map plus its modifier map (the `XTest` and `XSendEvent`
	/// routes both act on the core keyboard).
	pub(super) fn core(conn: &RustConnection) -> CoreResult<Self> {
		let setup = conn.setup();
		let min_keycode = setup.min_keycode;
		let count = setup
			.max_keycode
			.saturating_sub(min_keycode)
			.saturating_add(1);
		let mapping = conn
			.get_keyboard_mapping(min_keycode, count)
			.map_err(keymap_failed)?
			.reply()
			.map_err(keymap_failed)?;
		let modmap = conn
			.get_modifier_mapping()
			.map_err(keymap_failed)?
			.reply()
			.map_err(keymap_failed)?;
		let per_modifier = usize::from(modmap.keycodes_per_modifier()).max(1);
		let modifier_masks = modmap
			.keycodes
			.chunks(per_modifier)
			.take(8)
			.enumerate()
			.flat_map(|(index, keycodes)| {
				keycodes
					.iter()
					.filter(|&&keycode| keycode != 0)
					.map(move |&keycode| (keycode, 1u16 << index))
			})
			.collect();
		Ok(Self::new(min_keycode, mapping.keysyms_per_keycode, mapping.keysyms, modifier_masks))
	}

	/// The map of one `XInput` device. A hot-plugged uinput slave gets the
	/// server's configured layout, which can differ from the session layout the
	/// core keyboard carries, so the virtual keyboard plans against its own map.
	pub(super) fn device(conn: &RustConnection, device_id: u16) -> CoreResult<Self> {
		let device_id = u8::try_from(device_id).map_err(|_| {
			DesktopError::input_failed(format!("XInput device id {device_id} exceeds XI1 range"))
		})?;
		let setup = conn.setup();
		let min_keycode = setup.min_keycode;
		let count = setup
			.max_keycode
			.saturating_sub(min_keycode)
			.saturating_add(1);
		let mapping = conn
			.xinput_get_device_key_mapping(device_id, min_keycode, count)
			.map_err(keymap_failed)?
			.reply()
			.map_err(keymap_failed)?;
		Ok(Self::new(min_keycode, mapping.keysyms_per_keycode, mapping.keysyms, Vec::new()))
	}

	const fn new(
		min_keycode: u8,
		keysyms_per_keycode: u8,
		keysyms: Vec<u32>,
		modifier_masks: Vec<(u8, u16)>,
	) -> Self {
		Self { min_keycode, keysyms_per_keycode, keysyms, modifier_masks }
	}

	/// Keycode emitting `keysym` and whether Shift must be held for it. The
	/// unshifted level wins when a keysym appears on both.
	fn lookup(&self, keysym: u32) -> Option<(u8, bool)> {
		let width = usize::from(self.keysyms_per_keycode);
		if width == 0 {
			return None;
		}
		let find = |level: usize| {
			self
				.keysyms
				.chunks_exact(width)
				.position(|row| row.get(level) == Some(&keysym))
		};
		let (row, shift) = find(0)
			.map(|row| (row, false))
			.or_else(|| find(1).map(|row| (row, true)))?;
		let keycode = self.min_keycode.checked_add(u8::try_from(row).ok()?)?;
		Some((keycode, shift))
	}

	fn resolve(&self, key: KeyName) -> CoreResult<(u8, bool)> {
		let keysym = keysym_for_key(key);
		self.lookup(keysym).ok_or_else(|| {
			DesktopError::input_failed(format!("X11 keymap has no keycode for keysym {keysym:#x}"))
		})
	}

	fn shift_keycode(&self) -> CoreResult<u8> {
		self
			.lookup(Keysym::Shift_L.raw())
			.or_else(|| self.lookup(Keysym::Shift_R.raw()))
			.map(|(keycode, _)| keycode)
			.ok_or_else(|| DesktopError::input_failed("X11 keymap has no Shift key"))
	}

	/// Press/release steps typing `text`; shifted glyphs are wrapped in Shift.
	/// Fails before planning anything when a character has no keycode.
	pub(super) fn plan_text(&self, text: &str) -> CoreResult<Vec<KeyStep>> {
		let mut steps = Vec::with_capacity(text.len() * 2);
		for ch in text.chars() {
			let (keycode, needs_shift) = self.resolve(KeyName::Char(ch))?;
			let shift = if needs_shift {
				Some(self.shift_keycode()?)
			} else {
				None
			};
			if let Some(shift) = shift {
				steps.push(KeyStep { keycode: shift, press: true });
			}
			steps.push(KeyStep { keycode, press: true });
			steps.push(KeyStep { keycode, press: false });
			if let Some(shift) = shift {
				steps.push(KeyStep { keycode: shift, press: false });
			}
		}
		Ok(steps)
	}

	/// Keys pressed in order and released in reverse, with Shift added once
	/// ahead of the first shifted glyph unless the chord already holds it.
	pub(super) fn plan_chord(&self, keys: &[KeyName]) -> CoreResult<Vec<KeyStep>> {
		let shift_requested = keys.contains(&KeyName::Shift);
		let mut held: Vec<u8> = Vec::with_capacity(keys.len() + 1);
		for &key in keys {
			let (keycode, needs_shift) = self.resolve(key)?;
			if needs_shift && !shift_requested {
				let shift = self.shift_keycode()?;
				if !held.contains(&shift) {
					held.push(shift);
				}
			}
			if !held.contains(&keycode) {
				held.push(keycode);
			}
		}
		Ok(held
			.iter()
			.map(|&keycode| KeyStep { keycode, press: true })
			.chain(
				held
					.iter()
					.rev()
					.map(|&keycode| KeyStep { keycode, press: false }),
			)
			.collect())
	}

	/// Keycodes to hold for a modifier-qualified pointer gesture.
	pub(super) fn modifier_keycodes(&self, modifiers: Modifiers) -> CoreResult<Vec<u8>> {
		[
			(modifiers.ctrl, KeyName::Ctrl),
			(modifiers.alt, KeyName::Alt),
			(modifiers.shift, KeyName::Shift),
			(modifiers.meta, KeyName::Meta),
		]
		.into_iter()
		.filter(|&(enabled, _)| enabled)
		.map(|(_, key)| self.resolve(key).map(|(keycode, _)| keycode))
		.collect()
	}

	/// Core state bits `keycode` contributes while held (0 for non-modifiers).
	pub(super) fn modifier_mask(&self, keycode: u8) -> u16 {
		self
			.modifier_masks
			.iter()
			.filter(|&&(candidate, _)| candidate == keycode)
			.fold(0, |mask, &(_, bit)| mask | bit)
	}
}

/// Emits `steps` in order. When one fails, the keys this run still holds are
/// released in reverse so no modifier is left chording later input.
pub(super) fn run_steps(
	steps: &[KeyStep],
	mut emit: impl FnMut(KeyStep) -> CoreResult<()>,
) -> CoreResult<()> {
	let mut held: Vec<u8> = Vec::new();
	for &step in steps {
		// An emitter can fail after the press was queued (e.g. SYN_REPORT
		// failed after EV_KEY). Include the attempted press in cleanup.
		if step.press && !held.contains(&step.keycode) {
			held.push(step.keycode);
		}
		if let Err(error) = emit(step) {
			for &keycode in held.iter().rev() {
				let _ = emit(KeyStep { keycode, press: false });
			}
			return Err(error);
		}
		if !step.press {
			held.retain(|&keycode| keycode != step.keycode);
		}
	}
	Ok(())
}

fn keymap_failed(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::input_failed(format!("X11 keymap request failed: {error}"))
}

pub(super) fn keysym_for_key(key: KeyName) -> u32 {
	let keysym = match key {
		KeyName::Ctrl => Keysym::Control_L,
		KeyName::Alt => Keysym::Alt_L,
		KeyName::Shift => Keysym::Shift_L,
		KeyName::Meta => Keysym::Super_L,
		KeyName::Enter => Keysym::Return,
		KeyName::Escape => Keysym::Escape,
		KeyName::Tab => Keysym::Tab,
		KeyName::Space => Keysym::space,
		KeyName::Backspace => Keysym::BackSpace,
		KeyName::Delete => Keysym::Delete,
		KeyName::Insert => Keysym::Insert,
		KeyName::Home => Keysym::Home,
		KeyName::End => Keysym::End,
		KeyName::PageUp => Keysym::Prior,
		KeyName::PageDown => Keysym::Next,
		KeyName::Up => Keysym::Up,
		KeyName::Down => Keysym::Down,
		KeyName::Left => Keysym::Left,
		KeyName::Right => Keysym::Right,
		KeyName::CapsLock => Keysym::Caps_Lock,
		KeyName::NumLock => Keysym::Num_Lock,
		KeyName::PrintScreen => Keysym::Print,
		KeyName::F1 => Keysym::F1,
		KeyName::F2 => Keysym::F2,
		KeyName::F3 => Keysym::F3,
		KeyName::F4 => Keysym::F4,
		KeyName::F5 => Keysym::F5,
		KeyName::F6 => Keysym::F6,
		KeyName::F7 => Keysym::F7,
		KeyName::F8 => Keysym::F8,
		KeyName::F9 => Keysym::F9,
		KeyName::F10 => Keysym::F10,
		KeyName::F11 => Keysym::F11,
		KeyName::F12 => Keysym::F12,
		KeyName::F13 => Keysym::F13,
		KeyName::F14 => Keysym::F14,
		KeyName::F15 => Keysym::F15,
		KeyName::F16 => Keysym::F16,
		KeyName::F17 => Keysym::F17,
		KeyName::F18 => Keysym::F18,
		KeyName::F19 => Keysym::F19,
		KeyName::F20 => Keysym::F20,
		KeyName::F21 => Keysym::F21,
		KeyName::F22 => Keysym::F22,
		KeyName::F23 => Keysym::F23,
		KeyName::F24 => Keysym::F24,
		KeyName::Char(ch) => {
			return match ch {
				'\n' | '\r' => Keysym::Return.raw(),
				'\t' => Keysym::Tab.raw(),
				_ => Keysym::from_char(ch).raw(),
			};
		},
	};
	keysym.raw()
}

#[cfg(test)]
mod tests {
	use super::*;

	const A: u8 = 38;
	const ONE: u8 = 10;
	const RETURN: u8 = 36;
	const SHIFT: u8 = 50;
	const CTRL: u8 = 37;

	/// US-like two-level map: a/A, 1/!, Return, `Shift_L`, `Control_L`.
	fn keymap() -> Keymap {
		let mut keysyms = vec![0u32; (255 - 8 + 1) * 2];
		let mut set = |keycode: u8, syms: [u32; 2]| {
			let index = usize::from(keycode - 8) * 2;
			keysyms[index..index + 2].copy_from_slice(&syms);
		};
		set(A, [0x61, 0x41]);
		set(ONE, [0x31, 0x21]);
		set(RETURN, [0xff0d, 0xff0d]);
		set(SHIFT, [0xffe1, 0xffe1]);
		set(CTRL, [0xffe3, 0xffe3]);
		Keymap::new(8, 2, keysyms, vec![(SHIFT, 1), (CTRL, 4)])
	}

	fn press(keycode: u8) -> KeyStep {
		KeyStep { keycode, press: true }
	}

	fn release(keycode: u8) -> KeyStep {
		KeyStep { keycode, press: false }
	}

	#[test]
	fn text_wraps_shifted_glyphs_in_shift() {
		let steps = keymap().plan_text("aA!\n").unwrap();
		assert_eq!(steps, vec![
			press(A),
			release(A),
			press(SHIFT),
			press(A),
			release(A),
			release(SHIFT),
			press(SHIFT),
			press(ONE),
			release(ONE),
			release(SHIFT),
			press(RETURN),
			release(RETURN),
		]);
	}

	#[test]
	fn chord_adds_shift_once_unless_requested() {
		let map = keymap();
		assert_eq!(
			map.plan_chord(&[KeyName::Ctrl, KeyName::Char('A')])
				.unwrap(),
			vec![press(CTRL), press(SHIFT), press(A), release(A), release(SHIFT), release(CTRL),]
		);
		assert_eq!(
			map.plan_chord(&[KeyName::Ctrl, KeyName::Shift, KeyName::Char('A')])
				.unwrap(),
			vec![press(CTRL), press(SHIFT), press(A), release(A), release(SHIFT), release(CTRL)]
		);
	}

	#[test]
	fn unshifted_level_wins_over_an_earlier_shifted_match() {
		let mut map = keymap();
		let index = usize::from(ONE - 8) * 2;
		map.keysyms[index + 1] = 0x61;
		assert_eq!(map.lookup(0x61), Some((A, false)));
	}

	#[test]
	fn partially_failed_press_is_released_before_earlier_modifiers() {
		let mut emitted = Vec::new();
		let result = run_steps(&[press(CTRL), press(A)], |step| {
			emitted.push(step);
			if step == press(A) {
				Err(DesktopError::input_failed("failed after enqueue"))
			} else {
				Ok(())
			}
		});
		assert!(result.is_err());
		assert_eq!(emitted, vec![press(CTRL), press(A), release(A), release(CTRL)]);
	}

	#[test]
	fn text_with_an_unmapped_glyph_is_refused_whole() {
		assert!(keymap().plan_text("a€").is_err());
	}
}
