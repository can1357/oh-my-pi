//! Canonical key-chord spelling for `bind`.
//!
//! A chord uses canonical spelling (`ctrl+shift+p`, `alt+up`, `f5`).
//! [`normalize_chord`] folds case, modifier aliases, and modifier order so
//! every spelling of one physical chord lands on one bind-table key; the
//! terminal decoder lowers a received key to the same canonical spelling.

use omp_core::{Str, StrMut};
use thiserror::Error;

/// Invalid `bind` key chord.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ChordError {
	/// The chord had no key component.
	#[error("key chord is empty")]
	Empty,
	/// The chord contains whitespace, an empty segment, an unknown modifier,
	/// or a repeated modifier.
	#[error("invalid key chord `{chord}`")]
	Invalid {
		/// Rejected chord.
		chord: Str,
	},
}

/// Canonical modifier order for chord spellings.
const MODIFIERS: [&str; 4] = ["ctrl", "alt", "shift", "super"];

/// Symbols whose printable form already implies Shift. Terminals disagree
/// about whether the Shift modifier remains set beside the shifted codepoint,
/// so both reports must name one physical chord.
const SHIFTED_SYMBOLS: &str = "!@#$%^&*()_+{}|:<>?~";

/// Folds a `bind` chord to its canonical spelling: lowercase, modifiers in
/// `ctrl+alt+shift+super` order, canonical key names (`escape`, `pageup`,
/// `shift+tab`, `f5`).
pub fn normalize_chord(chord: &str) -> Result<Str, ChordError> {
	let chord = chord.trim();
	if chord.is_empty() {
		return Err(ChordError::Empty);
	}
	let invalid = || ChordError::Invalid { chord: Str::new(chord) };
	if chord.chars().any(char::is_whitespace) {
		return Err(invalid());
	}
	let lower = chord.to_ascii_lowercase();
	let mut parts = lower.split('+').collect::<Vec<_>>();
	// A trailing `+` key (`ctrl++`) splits into two empties: fold them back.
	if parts.len() >= 2 && parts[parts.len() - 1].is_empty() && parts[parts.len() - 2].is_empty() {
		parts.truncate(parts.len() - 2);
		parts.push("+");
	}
	let Some((key, mods)) = parts.split_last() else {
		return Err(invalid());
	};
	if key.is_empty() {
		return Err(invalid());
	}
	let mut present = [false; MODIFIERS.len()];
	for modifier in mods {
		let name = match *modifier {
			"control" | "ctl" => "ctrl",
			"option" | "opt" | "meta" => "alt",
			"cmd" | "command" | "win" => "super",
			other => other,
		};
		let Some(index) = MODIFIERS.iter().position(|known| *known == name) else {
			return Err(invalid());
		};
		if present[index] {
			return Err(invalid());
		}
		present[index] = true;
	}
	let key = match *key {
		"esc" => "escape",
		"return" | "cr" => "enter",
		"pgup" => "pageup",
		"pgdn" | "pgdown" => "pagedown",
		"del" => "delete",
		"bs" => "backspace",
		"backtab" => {
			present[2] = true;
			"tab"
		},
		other => other,
	};
	if key.len() == 1 && SHIFTED_SYMBOLS.contains(key) {
		present[2] = false;
	}
	let mut out = StrMut::with_capacity(chord.len() + 8);
	for (index, name) in MODIFIERS.iter().enumerate() {
		if present[index] {
			out.push_str(name);
			out.push('+');
		}
	}
	out.push_str(key);
	Ok(out.freeze())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn modifier_order_and_aliases_fold_to_one_spelling() {
		for spelling in ["shift+ctrl+p", "Ctrl+Shift+P", "control+shift+p", "CTRL+SHIFT+p"] {
			assert_eq!(normalize_chord(spelling).unwrap().as_str(), "ctrl+shift+p", "{spelling}");
		}
		assert_eq!(normalize_chord("opt+m").unwrap().as_str(), "alt+m");
		assert_eq!(normalize_chord("cmd+v").unwrap().as_str(), "super+v");
		assert_eq!(normalize_chord("backtab").unwrap().as_str(), "shift+tab");
		assert_eq!(normalize_chord("esc").unwrap().as_str(), "escape");
		assert_eq!(normalize_chord("ctrl++").unwrap().as_str(), "ctrl++");
		assert_eq!(normalize_chord("shift+!").unwrap().as_str(), "!");
		assert_eq!(normalize_chord("ctrl+shift+_").unwrap().as_str(), "ctrl+_");
	}

	#[test]
	fn malformed_chords_are_rejected() {
		assert_eq!(normalize_chord(""), Err(ChordError::Empty));
		assert!(matches!(normalize_chord("ctrl+"), Err(ChordError::Invalid { .. })));
		assert!(matches!(normalize_chord("ctrl+ctrl+p"), Err(ChordError::Invalid { .. })));
		assert!(matches!(normalize_chord("hyper+p"), Err(ChordError::Invalid { .. })));
		assert!(matches!(normalize_chord("ctrl p"), Err(ChordError::Invalid { .. })));
	}
}
