//! Terminal input utilities

use std::{collections::HashMap, sync::LazyLock};

use terminfo::capability as cap;

use crate::{error, interfaces};

macro_rules! key {
	($terminfo:expr, $our_key:expr, $terminfo_key:ty) => {{
		(
			$our_key,
			$terminfo
				.get::<$terminfo_key>()
				.map(|k| k.expand().to_vec()),
		)
	}};
}

fn build_terminfo_key_map() -> HashMap<Vec<u8>, interfaces::Key> {
	let mut map: HashMap<Vec<u8>, interfaces::Key> = HashMap::new();

	if let Ok(ti) = terminfo::Database::from_env() {
		// Iterate over key capabilities and populate the map
		let key_capabilities = [
			key!(ti, interfaces::Key::F(1), cap::KeyF1<'_>),
			key!(ti, interfaces::Key::F(2), cap::KeyF2<'_>),
			key!(ti, interfaces::Key::F(3), cap::KeyF3<'_>),
			key!(ti, interfaces::Key::F(4), cap::KeyF4<'_>),
			key!(ti, interfaces::Key::F(5), cap::KeyF5<'_>),
			key!(ti, interfaces::Key::F(6), cap::KeyF6<'_>),
			key!(ti, interfaces::Key::F(7), cap::KeyF7<'_>),
			key!(ti, interfaces::Key::F(8), cap::KeyF8<'_>),
			key!(ti, interfaces::Key::F(9), cap::KeyF9<'_>),
			key!(ti, interfaces::Key::F(10), cap::KeyF10<'_>),
			key!(ti, interfaces::Key::F(11), cap::KeyF11<'_>),
			key!(ti, interfaces::Key::F(12), cap::KeyF12<'_>),
			key!(ti, interfaces::Key::Backspace, cap::KeyBackspace<'_>),
			key!(ti, interfaces::Key::Enter, cap::KeyEnter<'_>),
			key!(ti, interfaces::Key::Left, cap::KeyLeft<'_>),
			key!(ti, interfaces::Key::Right, cap::KeyRight<'_>),
			key!(ti, interfaces::Key::Up, cap::KeyUp<'_>),
			key!(ti, interfaces::Key::Down, cap::KeyDown<'_>),
			key!(ti, interfaces::Key::Home, cap::KeyHome<'_>),
			key!(ti, interfaces::Key::End, cap::KeyEnd<'_>),
			key!(ti, interfaces::Key::PageUp, cap::KeyPPage<'_>),
			key!(ti, interfaces::Key::PageDown, cap::KeyNPage<'_>),
			key!(ti, interfaces::Key::BackTab, cap::BackTab<'_>),
			// It's not clear if these belong here, because they're not
			// strictly "key" capabilities.
			key!(ti, interfaces::Key::Up, cap::CursorUp<'_>),
			key!(ti, interfaces::Key::Down, cap::CursorDown<'_>),
			key!(ti, interfaces::Key::Left, cap::CursorLeft<'_>),
			key!(ti, interfaces::Key::Right, cap::CursorRight<'_>),
		];

		for (key, v) in key_capabilities {
			if let Some(Ok(v)) = v {
				map.insert(v.clone(), key.clone());
			}
		}
	}

	map
}

pub(crate) static TERMINFO_KEY_MAP: LazyLock<HashMap<Vec<u8>, interfaces::Key>> =
	LazyLock::new(build_terminfo_key_map);

/// Translates a key code (byte sequence) into a `Key` enum value. Returns
/// `None` if the key code is not recognized.
///
/// # Arguments
///
/// * `key_code`: The byte sequence representing the key code.
pub fn try_get_key_from_key_code(key_code: &[u8]) -> Option<interfaces::Key> {
	if let Some(key) = TERMINFO_KEY_MAP.get(key_code) {
		Some(key.clone())
	} else if key_code.len() == 1 && !key_code[0].is_ascii_control() {
		Some(interfaces::Key::Character(key_code[0] as char))
	} else {
		None
	}
}
