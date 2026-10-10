use super::{
	backend::Modifiers,
	error::{CoreResult, DesktopError},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyName {
	Ctrl,
	Alt,
	Shift,
	Meta,
	Enter,
	Escape,
	Tab,
	Space,
	Backspace,
	Delete,
	Insert,
	Home,
	End,
	PageUp,
	PageDown,
	Up,
	Down,
	Left,
	Right,
	CapsLock,
	NumLock,
	PrintScreen,
	F1,
	F2,
	F3,
	F4,
	F5,
	F6,
	F7,
	F8,
	F9,
	F10,
	F11,
	F12,
	F13,
	F14,
	F15,
	F16,
	F17,
	F18,
	F19,
	F20,
	F21,
	F22,
	F23,
	F24,
	Char(char),
}

impl KeyName {
	#[cfg(target_os = "windows")]
	pub(crate) const fn is_modifier(self) -> bool {
		matches!(self, Self::Ctrl | Self::Alt | Self::Shift | Self::Meta)
	}

	#[cfg(target_os = "windows")]
	pub(crate) const fn to_enigo(self) -> enigo::Key {
		use enigo::Key;
		match self {
			Self::Ctrl => Key::Control,
			Self::Alt => Key::Alt,
			Self::Shift => Key::Shift,
			Self::Meta => Key::Meta,
			Self::Enter => Key::Return,
			Self::Escape => Key::Escape,
			Self::Tab => Key::Tab,
			Self::Space => Key::Space,
			Self::Backspace => Key::Backspace,
			Self::Delete => Key::Delete,
			Self::Insert => Key::Insert,
			Self::Home => Key::Home,
			Self::End => Key::End,
			Self::PageUp => Key::PageUp,
			Self::PageDown => Key::PageDown,
			Self::Up => Key::UpArrow,
			Self::Down => Key::DownArrow,
			Self::Left => Key::LeftArrow,
			Self::Right => Key::RightArrow,
			Self::CapsLock => Key::CapsLock,
			Self::NumLock => Key::Numlock,
			Self::PrintScreen => Key::PrintScr,
			Self::F1 => Key::F1,
			Self::F2 => Key::F2,
			Self::F3 => Key::F3,
			Self::F4 => Key::F4,
			Self::F5 => Key::F5,
			Self::F6 => Key::F6,
			Self::F7 => Key::F7,
			Self::F8 => Key::F8,
			Self::F9 => Key::F9,
			Self::F10 => Key::F10,
			Self::F11 => Key::F11,
			Self::F12 => Key::F12,
			Self::F13 => Key::F13,
			Self::F14 => Key::F14,
			Self::F15 => Key::F15,
			Self::F16 => Key::F16,
			Self::F17 => Key::F17,
			Self::F18 => Key::F18,
			Self::F19 => Key::F19,
			Self::F20 => Key::F20,
			Self::F21 => Key::F21,
			Self::F22 => Key::F22,
			Self::F23 => Key::F23,
			Self::F24 => Key::F24,
			Self::Char(character) => Key::Unicode(character),
		}
	}
}

pub fn parse_key(value: &str) -> CoreResult<KeyName> {
	let normalized = value.trim().to_ascii_uppercase();
	let key = match normalized.as_str() {
		"CTRL" | "CONTROL" => KeyName::Ctrl,
		"SHIFT" => KeyName::Shift,
		"ALT" | "OPTION" => KeyName::Alt,
		"META" | "CMD" | "COMMAND" | "SUPER" | "WIN" | "WINDOWS" => KeyName::Meta,
		"ENTER" | "RETURN" => KeyName::Enter,
		"ESC" | "ESCAPE" => KeyName::Escape,
		"TAB" => KeyName::Tab,
		"SPACE" => KeyName::Space,
		"BACKSPACE" => KeyName::Backspace,
		"DELETE" | "DEL" => KeyName::Delete,
		"INSERT" => KeyName::Insert,
		"HOME" => KeyName::Home,
		"END" => KeyName::End,
		"PAGEUP" => KeyName::PageUp,
		"PAGEDOWN" => KeyName::PageDown,
		"UP" | "ARROWUP" => KeyName::Up,
		"DOWN" | "ARROWDOWN" => KeyName::Down,
		"LEFT" | "ARROWLEFT" => KeyName::Left,
		"RIGHT" | "ARROWRIGHT" => KeyName::Right,
		"CAPSLOCK" => KeyName::CapsLock,
		"NUMLOCK" => KeyName::NumLock,
		"PRINTSCREEN" | "PRINTSCR" => KeyName::PrintScreen,
		"F1" => KeyName::F1,
		"F2" => KeyName::F2,
		"F3" => KeyName::F3,
		"F4" => KeyName::F4,
		"F5" => KeyName::F5,
		"F6" => KeyName::F6,
		"F7" => KeyName::F7,
		"F8" => KeyName::F8,
		"F9" => KeyName::F9,
		"F10" => KeyName::F10,
		"F11" => KeyName::F11,
		"F12" => KeyName::F12,
		"F13" => KeyName::F13,
		"F14" => KeyName::F14,
		"F15" => KeyName::F15,
		"F16" => KeyName::F16,
		"F17" => KeyName::F17,
		"F18" => KeyName::F18,
		"F19" => KeyName::F19,
		"F20" => KeyName::F20,
		"F21" => KeyName::F21,
		"F22" => KeyName::F22,
		"F23" => KeyName::F23,
		"F24" => KeyName::F24,
		_ => {
			let mut chars = value.trim().chars();
			match (chars.next(), chars.next()) {
				(Some(character), None) => {
					KeyName::Char(character.to_lowercase().next().unwrap_or(character))
				},
				_ => return Err(DesktopError::invalid_key(format!("unsupported key `{value}`"))),
			}
		},
	};
	Ok(key)
}

pub fn parse_keys(keys: &[String]) -> CoreResult<Vec<KeyName>> {
	let mut parsed = Vec::new();
	for keypress in keys {
		for component in keypress.split('+') {
			if component.trim().is_empty() {
				return Err(DesktopError::invalid_key(format!(
					"invalid empty component in keypress `{keypress}`"
				)));
			}
			parsed.push(parse_key(component)?);
		}
	}
	Ok(parsed)
}

pub fn parse_modifiers(mods: &[String]) -> CoreResult<Modifiers> {
	let mut result = Modifiers::default();
	for key in parse_keys(mods)? {
		let slot = match key {
			KeyName::Ctrl => &mut result.ctrl,
			KeyName::Alt => &mut result.alt,
			KeyName::Shift => &mut result.shift,
			KeyName::Meta => &mut result.meta,
			_ => {
				return Err(DesktopError::invalid_key(
					"mouse modifiers may contain modifier keys only",
				));
			},
		};
		if *slot {
			return Err(DesktopError::invalid_key("mouse modifiers contain a duplicate key"));
		}
		*slot = true;
	}
	Ok(result)
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyDirection {
	Press,
	Release,
}

/// Presses `keys` in order, runs `operation` while they are held, then
/// releases them in reverse order, even when a press or `operation` fails.
///
/// A failed press releases only the keys already down, never the failed one.
/// `merge(primary, cleanup)` folds each release result into the cleanup
/// result and that into the primary result, so each backend keeps its own
/// policy for reporting cleanup failures next to the delivery failure.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn hold_keys<C, E>(
	ctx: &mut C,
	keys: impl IntoIterator<Item = KeyName>,
	mut emit: impl FnMut(&mut C, KeyName, KeyDirection) -> Result<(), E>,
	operation: impl FnOnce(&mut C) -> Result<(), E>,
	mut merge: impl FnMut(Result<(), E>, Result<(), E>) -> Result<(), E>,
) -> Result<(), E> {
	let keys = keys.into_iter();
	let mut pressed = Vec::with_capacity(keys.size_hint().0);
	let mut result = Ok(());
	for key in keys {
		if let Err(error) = emit(ctx, key, KeyDirection::Press) {
			result = Err(error);
			break;
		}
		pressed.push(key);
	}
	if result.is_ok() {
		result = operation(ctx);
	}
	let mut cleanup = Ok(());
	for &key in pressed.iter().rev() {
		let release = emit(ctx, key, KeyDirection::Release);
		cleanup = merge(cleanup, release);
	}
	merge(result, cleanup)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_full_alias_table() {
		let cases = [
			(&["cmd", "META", "super", "win", "windows", "command"][..], KeyName::Meta),
			(&["option", "alt"][..], KeyName::Alt),
			(&["control", "ctrl"][..], KeyName::Ctrl),
			(&["enter", "return"][..], KeyName::Enter),
			(&["esc", "escape"][..], KeyName::Escape),
			(&["delete", "del"][..], KeyName::Delete),
			(&["up", "arrowup"][..], KeyName::Up),
			(&["down", "arrowdown"][..], KeyName::Down),
			(&["left", "arrowleft"][..], KeyName::Left),
			(&["right", "arrowright"][..], KeyName::Right),
			(&["printscreen", "printscr"][..], KeyName::PrintScreen),
		];
		for (aliases, expected) in cases {
			for alias in aliases {
				assert_eq!(parse_key(alias).unwrap(), expected);
			}
		}
		assert_eq!(parse_keys(&["cmd+shift+p".into()]).unwrap(), [
			KeyName::Meta,
			KeyName::Shift,
			KeyName::Char('p')
		]);
		assert_eq!(
			parse_key("garbage").unwrap_err().code,
			super::super::error::ErrorCode::InvalidKey
		);
	}

	#[test]
	fn presses_in_order_and_releases_in_reverse_even_after_errors() {
		let keys = [KeyName::Ctrl, KeyName::Shift, KeyName::Char('p')];
		let record = |events: &mut Vec<(KeyName, KeyDirection)>, key, direction| {
			events.push((key, direction));
			Ok::<_, &str>(())
		};
		let mut events = Vec::new();
		hold_keys(
			&mut events,
			keys,
			record,
			|events| {
				events.push((KeyName::Space, KeyDirection::Press));
				Ok(())
			},
			Result::and,
		)
		.unwrap();
		assert_eq!(events, [
			(KeyName::Ctrl, KeyDirection::Press),
			(KeyName::Shift, KeyDirection::Press),
			(KeyName::Char('p'), KeyDirection::Press),
			(KeyName::Space, KeyDirection::Press),
			(KeyName::Char('p'), KeyDirection::Release),
			(KeyName::Shift, KeyDirection::Release),
			(KeyName::Ctrl, KeyDirection::Release)
		]);

		let mut events = Vec::new();
		let result = hold_keys(
			&mut events,
			keys,
			|events, key, direction| {
				events.push((key, direction));
				match (key, direction) {
					(KeyName::Char('p'), KeyDirection::Press) => Err("press"),
					(KeyName::Ctrl, KeyDirection::Release) => Err("release"),
					_ => Ok(()),
				}
			},
			|_| unreachable!("operation must not run after a failed press"),
			Result::and,
		);
		assert_eq!(result, Err("press"));
		assert_eq!(events[3..], [
			(KeyName::Shift, KeyDirection::Release),
			(KeyName::Ctrl, KeyDirection::Release)
		]);

		let mut events = Vec::new();
		let result = hold_keys(&mut events, keys, record, |_| Err("operation"), Result::and);
		assert_eq!(result, Err("operation"));
		assert_eq!(events.len(), 6);
	}
}
