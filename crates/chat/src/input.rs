//! Terminal-input normalization for app-supplied console bindings.
//!
//! A `bind` chord uses lowercase names (`ctrl+shift+p`, `alt+up`, `f5`);
//! [`normalize_chord`] folds case and modifier order so every spelling of a
//! physical chord lands on one table key, and [`Bindings::command`] lowers
//! a decoded [`Key`] to that same canonical spelling.

use std::collections::BTreeMap;

pub use omp_con::{ChordError, normalize_chord};
use omp_core::Str;
use omp_tui::Key;

/// Normalized physical chord to console command.
#[derive(Clone, Debug, Default)]
pub struct Bindings {
	commands: BTreeMap<Str, Str>,
}

impl Bindings {
	/// Builds bindings already normalized by the application keybinding table.
	#[must_use]
	pub fn new(commands: impl IntoIterator<Item = (Str, Str)>) -> Self {
		Self { commands: commands.into_iter().collect() }
	}

	/// Finds the command bound to a decoded terminal key.
	#[must_use]
	pub fn command(&self, key: Key) -> Option<&str> {
		let chord = chord(key)?;
		self.commands.get(chord.as_str()).map(Str::as_str)
	}

	/// Whether any chord is bound to `command`.
	#[must_use]
	pub fn binds(&self, command: &str) -> bool {
		self.commands.values().any(|bound| bound == command)
	}

	/// The chord to show in a hint for `command`: the shortest one bound to
	/// it (`f5` over `alt+r`, as the primary key is listed first), ties by
	/// chord order. Bind lines carry no declaration order into the table.
	#[must_use]
	pub fn chord_for(&self, command: &str) -> Option<&str> {
		self
			.commands
			.iter()
			.filter(|(_, bound)| bound.as_str() == command)
			.map(|(chord, _)| chord.as_str())
			.min_by_key(|chord| chord.len())
	}
}

/// Canonical chord spelling for a decoded key, or `None` for keys that are
/// never bindable (plain text, selection chords, host-only intents).
#[must_use]
pub fn chord(key: Key) -> Option<Str> {
	let fixed = match key {
		Key::Ctrl(ch) => return Some(Str::new(format!("ctrl+{ch}"))),
		Key::Alt(ch) => return Some(Str::new(format!("alt+{ch}"))),
		Key::CtrlAlt(ch) => return Some(Str::new(format!("ctrl+alt+{ch}"))),
		Key::Function(number) => return Some(Str::new(format!("f{number}"))),
		Key::Enter => "enter",
		Key::Esc => "escape",
		Key::Tab => "tab",
		Key::BackTab => "shift+tab",
		Key::Space => "space",
		Key::Backspace => "backspace",
		Key::Delete => "delete",
		Key::Insert => "insert",
		Key::Up => "up",
		Key::Down => "down",
		Key::Left => "left",
		Key::Right => "right",
		Key::Home => "home",
		Key::End => "end",
		Key::PageUp => "pageup",
		Key::PageDown => "pagedown",
		// The keymap folds Ctrl+Enter and Alt+Enter into one intent; the
		// The bind table uses the primary follow-up chord.
		// (`config/keybindings.ts` `ctrl+enter`), which the default cfg binds.
		Key::FollowUp => "ctrl+enter",
		Key::ShiftEnter => "shift+enter",
		Key::RestoreQueue => "alt+up",
		Key::CyclePrevious => "ctrl+shift+p",
		Key::ToggleToolVisibility => "ctrl+shift+o",
		Key::CopyPrompt => "alt+shift+c",
		Key::CopyLine => "alt+shift+l",
		Key::DebugMenu => "ctrl+shift+d",
		Key::PlanToggle => "alt+shift+p",
		Key::WordLeft => "ctrl+left",
		Key::WordRight => "ctrl+right",
		Key::WordDelete => "alt+delete",
		Key::Paste => "ctrl+v",
		Key::PasteRaw => "ctrl+shift+v",
		Key::SelectLeft
		| Key::SelectRight
		| Key::SelectUp
		| Key::SelectDown
		| Key::SelectHome
		| Key::SelectEnd
		| Key::SelectWordLeft
		| Key::SelectWordRight
		| Key::SelectAll
		| Key::Copy
		| Key::Cut
		| Key::JumpPrevious
		| Key::JumpNext
		| Key::Char(_) => return None,
	};
	Some(Str::new_static(fixed))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn normalize_chord_folds_case_aliases_and_modifier_order() {
		let cases = [
			("CTRL+T", "ctrl+t"),
			("shift+ctrl+p", "ctrl+shift+p"),
			("Alt+Shift+P", "alt+shift+p"),
			("esc", "escape"),
			("Escape", "escape"),
			("pgup", "pageup"),
			("backtab", "shift+tab"),
			("option+p", "alt+p"),
			("meta+up", "alt+up"),
			("cmd+v", "super+v"),
			("ctrl++", "ctrl++"),
			("shift+!", "!"),
			("ctrl+shift+_", "ctrl+_"),
			("f5", "f5"),
		];
		for (input, expected) in cases {
			assert_eq!(normalize_chord(input).expect(input), expected, "{input}");
		}
	}

	#[test]
	fn normalize_chord_rejects_malformed_spellings() {
		assert_eq!(normalize_chord("  "), Err(ChordError::Empty));
		for bad in ["ctrl+", "ctrl+ctrl+p", "hyper+p", "ctrl p", "+p"] {
			assert!(normalize_chord(bad).is_err(), "{bad}");
		}
	}

	#[test]
	fn decoded_keys_lower_to_the_same_spelling_as_bind_lines() {
		let cases = [
			(Key::Alt('p'), "alt+p"),
			(Key::Alt('m'), "alt+m"),
			(Key::Ctrl('p'), "ctrl+p"),
			(Key::CyclePrevious, "shift+ctrl+p"),
			(Key::BackTab, "shift+tab"),
			(Key::Function(5), "F5"),
			(Key::RestoreQueue, "alt+up"),
			(Key::PlanToggle, "alt+shift+p"),
			(Key::FollowUp, "ctrl+enter"),
			(Key::Esc, "escape"),
			(Key::CtrlAlt(']'), "ctrl+alt+]"),
		];
		for (key, spelled) in cases {
			assert_eq!(chord(key).expect("bindable"), normalize_chord(spelled).expect(spelled));
		}
		assert_eq!(chord(Key::Char('p')), None, "plain typing is never a bind target");
		let bindings = Bindings::new([
			(Str::new_static("alt+p"), Str::new_static("cl_model_select session")),
			(Str::new_static("shift+tab"), Str::new_static("cl_thinking_cycle")),
		]);
		assert_eq!(bindings.command(Key::Alt('p')), Some("cl_model_select session"));
		assert_eq!(bindings.command(Key::BackTab), Some("cl_thinking_cycle"));
		assert!(bindings.binds("cl_thinking_cycle"));
	}
}
