//! Command-stream keybinding projection for the chat actor.

use std::collections::BTreeMap;

use omp_chat::input::{ChordError, normalize_chord};
use omp_core::Str;

/// Command-stream bindings keyed by normalized terminal chord.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ConsoleKeybindings {
	/// Normalized chord to console command.
	pub bindings: BTreeMap<Str, Str>,
}

impl ConsoleKeybindings {
	/// Builds the terminal binding table from the process control context.
	pub fn from_ctx(ctx: &omp_con::Ctx) -> Result<Self, ChordError> {
		let mut bindings = BTreeMap::new();
		for (chord, command) in ctx.binds() {
			bindings.insert(normalize_chord(chord.as_str())?, command);
		}
		Ok(Self { bindings })
	}

	/// Returns the command bound to a normalized chord.
	#[must_use]
	pub fn command_for(&self, chord: &str) -> Option<&str> {
		let chord = normalize_chord(chord).ok()?;
		self.bindings.get(chord.as_str()).map(Str::as_str)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn projects_console_binds() {
		let ctx = omp_con::Ctx::new();
		ctx.run(r#"bind ctrl+t "toggle cl_showthinking""#)
			.expect("bind");
		ctx.run(r#"bind Shift+Ctrl+P "cl_model_cycle back""#)
			.expect("bind");
		let bindings = ConsoleKeybindings::from_ctx(&ctx).expect("bindings");
		assert_eq!(bindings.command_for("CTRL+T"), Some("toggle cl_showthinking"));
		assert_eq!(bindings.command_for("ctrl+shift+p"), Some("cl_model_cycle back"));
	}
}
