//! The aliases input is read with.
//!
//! Bash replaces an alias while it reads its input, so the alias table and the
//! `expand_aliases` option that count are the ones in force when a complete
//! command (one input line, or a compound command that spans lines) is read,
//! after the commands before it have run. The shell reads its input one
//! complete command at a time ([`brush_parser::CommandReader`]) and gives the
//! reader the aliases as they are at that moment.

use brush_parser::{AliasTable, TokenizerOptions, ast};

use crate::{Shell, extensions};

/// The aliases an input line was read with: the alias table as it was when the
/// line began, or none while `expand_aliases` was off.
///
/// Bash reads a whole line before it runs any of it. A host that runs the
/// commands of one line separately gives each of them the aliases the line
/// began with (see [`crate::ExecutionParameters::set_aliases_at_read`]), so a
/// command that changes the aliases does not change how the rest of its line
/// is read.
#[derive(Clone, Debug, Default)]
pub struct AliasesAtRead(Option<AliasTable>);

impl AliasesAtRead {
	/// The aliases a line beginning now in `shell` is read with.
	pub fn of<SE: extensions::ShellExtensions>(shell: &Shell<SE>) -> Self {
		Self(shell.aliases_for_reading())
	}

	pub(crate) fn table(&self) -> Option<AliasTable> {
		self.0.clone()
	}
}

/// Is `word`, as written, quoted? Bash never reads a quoted word as an alias.
pub(crate) fn is_quoted(word: &str, options: &TokenizerOptions) -> bool {
	brush_parser::word::is_quoted_for_alias(word, options)
}

/// Splits a process substitution's commands into the lines Bash reads one at
/// a time when it runs them (as the parser recorded them in `line_starts`).
pub(crate) fn split_into_read_units(command: &ast::SubshellCommand) -> Vec<ast::CompoundList> {
	let mut units = Vec::with_capacity(command.line_starts.len() + 1);
	let mut start = 0;
	for &end in command.line_starts.iter().chain(std::iter::once(&command.list.0.len())) {
		if let Some(items) = command.list.0.get(start..end) {
			units.push(ast::CompoundList(items.to_vec()));
		}
		start = end;
	}
	units
}
