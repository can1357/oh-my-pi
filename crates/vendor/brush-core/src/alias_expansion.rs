//! The aliases input is read with.
//!
//! Bash replaces an alias while it reads its input, so the alias table and the
//! `expand_aliases` option that count are the ones in force when a complete
//! command (one input line, or a compound command that spans lines) is read,
//! after the commands before it have run. The shell reads its input one
//! complete command at a time ([`brush_parser::CommandReader`]) and gives the
//! reader the aliases as they are at that moment.

use std::{
	collections::HashMap,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use brush_parser::{AliasTable, TokenizerOptions, ast};

use crate::{
	Shell, error, extensions,
	variables::{ShellValue, ShellValueLiteral},
};

/// The aliases an input line was read with: the alias table as it was when the
/// line began, or none while `expand_aliases` was off.
///
/// Bash reads a whole line before it runs any of it. A host that runs the
/// commands of one line separately gives each of them the aliases the line
/// began with (see [`crate::ExecutionParameters::set_aliases_at_read`]), so a
/// command that changes the aliases does not change how the rest of its line
/// is read. A newline inside an alias's value ends a complete command within
/// the line: as in Bash, what is read after it, in that command and in the
/// rest of the line, is read with the aliases as they are then.
///
/// The default is no aliases at all, for text read again after its aliases
/// were substituted.
#[derive(Clone, Debug, Default)]
pub struct AliasesAtRead {
	table: Option<AliasTable>,
	/// For a line, whether a complete command after the first has been read
	/// from it; shared by the clones the line's commands hold. `None` for no
	/// aliases at all.
	line_ended: Option<Arc<AtomicBool>>,
}

impl AliasesAtRead {
	/// The aliases a line beginning now in `shell` is read with.
	pub fn of<SE: extensions::ShellExtensions>(shell: &Shell<SE>) -> Self {
		Self {
			table: shell.aliases_for_reading(),
			line_ended: Some(Arc::new(AtomicBool::new(false))),
		}
	}

	/// The aliases a complete command is read with: the line's table for its
	/// first command (`first`) until the line has ended, then `live`, the
	/// aliases as they are now.
	pub(crate) fn table_for_command(&self, first: bool, live: Option<AliasTable>) -> Option<AliasTable> {
		match &self.line_ended {
			None => None,
			Some(ended) if first && !ended.load(Ordering::Relaxed) => self.table.clone(),
			Some(_) => live,
		}
	}

	/// A complete command after the first was read: the line ended inside an
	/// alias's value.
	pub(crate) fn end_line(&self) {
		if let Some(ended) = &self.line_ended {
			ended.store(true, Ordering::Relaxed);
		}
	}
}

/// Is `word`, as written, quoted? Bash never reads a quoted word as an alias.
pub(crate) fn is_quoted(word: &str, options: &TokenizerOptions) -> bool {
	brush_parser::word::is_quoted_for_alias(word, options)
}

/// Is `name` a name Bash accepts for an alias? Bash rejects a name that holds
/// a character with a meaning in shell syntax; other printable punctuation,
/// such as `-`, `.`, `{`, `[`, `*`, `~`, `#` and `!`, is valid.
pub fn is_legal_alias_name(name: &str) -> bool {
	!name.is_empty()
		&& !name.contains([
			'/', '$', '\'', '"', '\\', '`', ' ', '\t', '\n', ';', '|', '&', '(', ')', '<', '>',
		])
}

impl<SE: extensions::ShellExtensions> Shell<SE> {
	/// Assigns to `BASH_ALIASES` while it is the view of the alias table, as
	/// Bash does: an element assignment (`index`) defines that alias, a list
	/// defines each alias it gives without removing the others, and a scalar
	/// defines the alias `0`. With `append`, a scalar value is added to the one
	/// its alias has; a list always replaces the values of the aliases it gives
	/// (`BASH_ALIASES+=([q]=new)` makes `q` `new`). Where Bash appends depends
	/// on the caller: `BASH_ALIASES[q]+=v` appends, `BASH_ALIASES+=v` does not,
	/// `declare BASH_ALIASES+=v` does.
	///
	/// An element whose name Bash rejects, or whose name is empty, is skipped;
	/// its error is returned for the caller to report, and the assignment goes
	/// on. A readonly `BASH_ALIASES`, an empty name given to an element
	/// assignment and a list given to one element fail the assignment.
	pub fn assign_to_alias_table(
		&mut self,
		index: Option<String>,
		value: ShellValueLiteral,
		append: bool,
	) -> Result<Vec<error::Error>, error::Error> {
		if self.env().get("BASH_ALIASES").is_some_and(|(_, var)| var.is_readonly()) {
			return Err(error::ErrorKind::ReadonlyVariable.into());
		}

		let mut skipped = vec![];
		match (index, value) {
			(Some(name), ShellValueLiteral::Scalar(value)) => {
				if name.is_empty() {
					return Err(error::ErrorKind::BadArraySubscript("BASH_ALIASES[]".to_owned()).into());
				}
				define_alias(self.aliases_mut(), name, value, append, &mut skipped);
			},
			(Some(_), ShellValueLiteral::Array(_)) => {
				return Err(error::ErrorKind::AssigningListToArrayMember.into());
			},
			(None, ShellValueLiteral::Scalar(value)) => {
				define_alias(self.aliases_mut(), "0".to_owned(), value, append, &mut skipped);
			},
			(None, ShellValueLiteral::Array(literals)) => {
				let aliases = self.aliases_mut();
				ShellValue::for_each_associative_pair(literals, |name, value| {
					if name.is_empty() {
						skipped.push(error::ErrorKind::BadArraySubscript(format!("[]={value}")).into());
					} else {
						define_alias(aliases, name, value, false, &mut skipped);
					}
				})?;
			},
		}
		Ok(skipped)
	}
}

/// Defines the alias `name`, or adds `value` to it with `append`, unless Bash
/// rejects the name; then the error goes to `skipped`.
fn define_alias(
	aliases: &mut HashMap<String, String>,
	name: String,
	value: String,
	append: bool,
	skipped: &mut Vec<error::Error>,
) {
	if !is_legal_alias_name(&name) {
		skipped.push(error::ErrorKind::InvalidAliasName(name).into());
	} else if append {
		aliases.entry(name).or_default().push_str(&value);
	} else {
		aliases.insert(name, value);
	}
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
