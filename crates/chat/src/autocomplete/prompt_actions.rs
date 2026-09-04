//! `#` prompt actions: editor commands
//! offered from a `#query` token at the cursor. Accepting a row removes the
//! token and records the action for the composer to apply.

use std::{cell::Cell, rc::Rc};

use omp_core::Str;
use omp_tui::{EditorCompletion, Icon, Suggestion, Suggestions};
use smallvec::SmallVec;

use super::fuzzy_score;

/// Editor action selected from the `#` menu.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PromptAction {
	/// Copy the caret's line to the clipboard.
	CopyLine,
	/// Copy the whole draft to the clipboard.
	CopyPrompt,
	/// Undo the last edit made before the trigger token was typed.
	Undo {
		/// The removed `#…` token, so undo skips its own typing.
		transient: Str,
	},
	/// Move the caret to the end of the draft.
	MessageEnd,
	/// Move the caret to the start of the draft.
	MessageStart,
	/// Move the caret to the start of the current line.
	LineStart,
	/// Move the caret to the end of the current line.
	LineEnd,
}

struct Definition {
	/// Builds the action from the removed `#…` token.
	build:       fn(Str) -> PromptAction,
	label:       &'static str,
	/// Bound editor chord.
	description: &'static str,
	keywords:    &'static str,
	icon:        Icon,
}

/// Action table, in display order.
const DEFINITIONS: [Definition; 7] = [
	Definition {
		build:       |_| PromptAction::CopyLine,
		label:       "Copy current line",
		description: "Alt+Shift+L",
		keywords:    "copy line clipboard current",
		icon:        Icon::Copy,
	},
	Definition {
		build:       |_| PromptAction::CopyPrompt,
		label:       "Copy whole prompt",
		description: "Alt+Shift+C",
		keywords:    "copy prompt clipboard message",
		icon:        Icon::Clipboard,
	},
	Definition {
		build:       |transient| PromptAction::Undo { transient },
		label:       "Undo",
		description: "Ctrl+_",
		keywords:    "undo revert edit history",
		icon:        Icon::Undo,
	},
	Definition {
		build:       |_| PromptAction::MessageEnd,
		label:       "Move cursor to message end",
		description: "Current message",
		keywords:    "move cursor message end prompt last bottom",
		icon:        Icon::Cursor,
	},
	Definition {
		build:       |_| PromptAction::MessageStart,
		label:       "Move cursor to message start",
		description: "Current message",
		keywords:    "move cursor message start beginning prompt first top",
		icon:        Icon::Cursor,
	},
	Definition {
		build:       |_| PromptAction::LineStart,
		label:       "Move cursor to line start",
		description: "Home / Ctrl+A",
		keywords:    "move cursor line start beginning home",
		icon:        Icon::Cursor,
	},
	Definition {
		build:       |_| PromptAction::LineEnd,
		label:       "Move cursor to line end",
		description: "End / Ctrl+E",
		keywords:    "move cursor line end",
		icon:        Icon::Cursor,
	},
];

/// The `#query` token ending at `cursor`: the
/// last `#` before the cursor with no whitespace after it.
fn prefix_start(text: &str, cursor: usize) -> Option<usize> {
	let before = text.get(..cursor)?;
	let hash = before.rfind('#')?;
	(!before[hash + 1..].contains(char::is_whitespace)).then_some(hash)
}

/// Prompt-action completion. Acceptance is reported through the shared
/// [`PromptActions::take`] slot, polled by the composer after every key.
pub struct PromptActions {
	pending:  Rc<Cell<Option<PromptAction>>>,
	/// Submitted slash commands whose argument text keeps `#word` literal.
	commands: Box<[Str]>,
}

impl PromptActions {
	/// Creates a provider and its acceptance slot.
	#[must_use]
	pub fn new() -> Self {
		Self { pending: Rc::new(Cell::new(None)), commands: Box::default() }
	}

	/// Records the submitted slash-command roster. The provider suppresses
	/// prompt actions inside a recognized command's arguments while still
	/// allowing numeric GitHub refs and internal URLs there.
	pub fn suppress_in_command_args<'a>(&mut self, commands: impl IntoIterator<Item = &'a str>) {
		self.commands = commands.into_iter().map(Str::new).collect();
	}

	fn inside_command_args(&self, text: &str, cursor: usize) -> bool {
		let before = &text[..cursor];
		let line_start = before.rfind('\n').map_or(0, |at| at + 1);
		if !before[..line_start].trim().is_empty() {
			return false;
		}
		let Some(body) = before[line_start..]
			.trim_start_matches([' ', '\t'])
			.strip_prefix('/')
		else {
			return false;
		};
		let Some(delimiter) = body.find(char::is_whitespace) else {
			return false;
		};
		let name = &body[..delimiter];
		self.commands.iter().any(|command| command.as_str() == name)
	}

	/// Shared acceptance slot; clone it into the composer.
	#[must_use]
	pub fn slot(&self) -> Rc<Cell<Option<PromptAction>>> {
		Rc::clone(&self.pending)
	}
}

impl Default for PromptActions {
	fn default() -> Self {
		Self::new()
	}
}

impl EditorCompletion for PromptActions {
	fn suggest(&mut self, text: &str, cursor: usize) -> Option<Suggestions> {
		if self.inside_command_args(text, cursor) {
			return None;
		}
		let start = prefix_start(text, cursor)?;
		let query = text[start + 1..cursor].to_ascii_lowercase();
		let mut ranked: SmallVec<(u16, usize), 8> = DEFINITIONS
			.iter()
			.enumerate()
			.filter_map(|(index, definition)| {
				let mut searchable = String::with_capacity(
					definition.label.len()
						+ definition.description.len()
						+ definition.keywords.len()
						+ 2,
				);
				searchable.push_str(definition.label);
				searchable.push(' ');
				searchable.push_str(definition.description);
				searchable.push(' ');
				searchable.push_str(definition.keywords);
				searchable.make_ascii_lowercase();
				fuzzy_score(&query, &searchable).map(|score| (score, index))
			})
			.collect();
		if ranked.is_empty() {
			return None;
		}
		ranked.sort_by_key(|(score, index)| (std::cmp::Reverse(*score), *index));
		let items = ranked
			.into_iter()
			.map(|(_, index)| {
				let definition = &DEFINITIONS[index];
				// The row's value is empty: accepting removes the `#query`
				// token and the action itself runs from the acceptance slot.
				Suggestion::new("", definition.label)
					.with_description(definition.description)
					.with_icon(definition.icon)
			})
			.collect();
		Some(Suggestions { range: start..cursor, items })
	}

	fn accepted(&mut self, replaced: &str, suggestion: &Suggestion) {
		let omp_tui::SuggestionDisplay::Text(label) = suggestion.display() else {
			return;
		};
		let Some(definition) = DEFINITIONS
			.iter()
			.find(|definition| definition.label == label.as_str())
		else {
			return;
		};
		self
			.pending
			.set(Some((definition.build)(Str::new(replaced))));
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn bare_hash_lists_every_action_in_pi_order() {
		let mut actions = PromptActions::new();
		let suggestions = actions.suggest("#", 1).expect("action rows");
		assert_eq!(suggestions.range, 0..1);
		let labels: Vec<&str> = suggestions
			.items
			.iter()
			.map(|item| match item.display() {
				omp_tui::SuggestionDisplay::Text(label) => label.as_str(),
				omp_tui::SuggestionDisplay::Emoji { .. } => unreachable!(),
			})
			.collect();
		assert_eq!(labels, [
			"Copy current line",
			"Copy whole prompt",
			"Undo",
			"Move cursor to message end",
			"Move cursor to message start",
			"Move cursor to line start",
			"Move cursor to line end",
		]);
	}

	#[test]
	fn query_ranks_by_fuzzy_score_and_stops_at_whitespace() {
		let mut actions = PromptActions::new();
		let suggestions = actions.suggest("note #undo", 10).expect("undo row");
		assert_eq!(suggestions.range, 5..10);
		assert!(matches!(
			suggestions.items[0].display(),
			omp_tui::SuggestionDisplay::Text(label) if label == "Undo"
		));
		assert!(actions.suggest("#copy done", 10).is_none());
		assert!(actions.suggest("#zzzz", 5).is_none());
	}

	#[test]
	fn recognized_slash_arguments_keep_hash_actions_literal() {
		let mut actions = PromptActions::new();
		actions.suppress_in_command_args(["mcp", "help"]);
		assert!(actions.suggest("/mcp test #copy", 15).is_none());
		assert!(actions.suggest("/unknown #copy", 14).is_some());
		assert!(
			actions
				.suggest("prose /mcp #copy", "prose /mcp #copy".len())
				.is_some()
		);
	}

	#[test]
	fn acceptance_records_the_action_with_its_transient_token() {
		let mut actions = PromptActions::new();
		let slot = actions.slot();
		let suggestions = actions.suggest("#un", 3).expect("rows");
		actions.accepted("#un", &suggestions.items[0]);
		assert_eq!(slot.take(), Some(PromptAction::Undo { transient: Str::new_static("#un") }));
		assert_eq!(slot.take(), None);
	}
}
