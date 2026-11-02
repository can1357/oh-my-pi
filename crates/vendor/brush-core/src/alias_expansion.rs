//! Alias substitution at the moment Bash reads a command.
//!
//! Bash replaces an alias while it reads its input, so the alias table and the
//! `expand_aliases` option that count are the ones in force when a complete
//! command (one input line, or a compound command that spans lines) is read,
//! after the commands before it have run. This shell parses its input up front
//! instead, so it substitutes aliases in each complete command just before it
//! runs: what Bash would read at that moment. A function body keeps the words
//! it was read with; command substitutions, process substitutions, `eval`,
//! `source` and traps read their commands when they run.

use std::collections::VecDeque;

use brush_parser::ast::{self, CommandPrefixOrSuffixItem};

use crate::{Shell, extensions};

/// Substitutes aliases in `command`, a complete command about to run.
pub(crate) fn expand_complete_command<SE: extensions::ShellExtensions>(
	shell: &Shell<SE>,
	command: &mut ast::CompoundList,
) {
	if !shell.options().expand_aliases || shell.aliases().is_empty() {
		return;
	}
	Substitution { shell }.compound_list(command);
}

/// Is `word`, as written, quoted? Bash never reads a quoted word as an alias.
pub(crate) fn is_quoted(word: &str) -> bool {
	word.contains(['\'', '"', '\\'])
}

/// A word of a simple command as Bash's reader meets it.
struct ReadWord {
	word:      ast::Word,
	/// The aliases whose values the word was read from; none of them is
	/// substituted again for it.
	expanding: Vec<String>,
	/// After this word, the aliases it ends are done, and the outermost of them
	/// decides whether the next word is read as a possible alias: `Some(true)`
	/// when its value ends in a blank.
	after:     Option<bool>,
}

impl ReadWord {
	const fn input(word: ast::Word) -> Self {
		Self { word, expanding: Vec::new(), after: None }
	}
}

enum Pending {
	Word(ReadWord),
	Other(CommandPrefixOrSuffixItem),
}

struct Substitution<'a, SE: extensions::ShellExtensions> {
	shell: &'a Shell<SE>,
}

impl<SE: extensions::ShellExtensions> Substitution<'_, SE> {
	fn compound_list(&self, list: &mut ast::CompoundList) {
		for ast::CompoundListItem(and_or, _) in &mut list.0 {
			self.pipeline(&mut and_or.first);
			for next in &mut and_or.additional {
				let (ast::AndOr::And(pipeline) | ast::AndOr::Or(pipeline)) = next;
				self.pipeline(pipeline);
			}
		}
	}

	fn pipeline(&self, pipeline: &mut ast::Pipeline) {
		for command in &mut pipeline.seq {
			self.command(command);
		}
	}

	fn command(&self, command: &mut ast::Command) {
		match command {
			ast::Command::Simple(simple) => self.simple_command(simple),
			ast::Command::Compound(compound, _) => self.compound_command(compound),
			ast::Command::Function(function) => self.compound_command(&mut function.body.0),
			ast::Command::ExtendedTest(..) => (),
		}
	}

	fn compound_command(&self, command: &mut ast::CompoundCommand) {
		match command {
			ast::CompoundCommand::Arithmetic(_) => (),
			ast::CompoundCommand::ArithmeticForClause(clause) => self.compound_list(&mut clause.body.list),
			ast::CompoundCommand::BraceGroup(group) => self.compound_list(&mut group.list),
			ast::CompoundCommand::Subshell(subshell) => self.compound_list(&mut subshell.list),
			ast::CompoundCommand::ForClause(clause) => self.compound_list(&mut clause.body.list),
			ast::CompoundCommand::CaseClause(clause) => {
				for item in &mut clause.cases {
					if let Some(list) = &mut item.cmd {
						self.compound_list(list);
					}
				}
			},
			ast::CompoundCommand::IfClause(clause) => {
				self.compound_list(&mut clause.condition);
				self.compound_list(&mut clause.then);
				for else_clause in clause.elses.iter_mut().flatten() {
					if let Some(condition) = &mut else_clause.condition {
						self.compound_list(condition);
					}
					self.compound_list(&mut else_clause.body);
				}
			},
			ast::CompoundCommand::WhileClause(clause) | ast::CompoundCommand::UntilClause(clause) => {
				self.compound_list(&mut clause.0);
				self.compound_list(&mut clause.1.list);
			},
			ast::CompoundCommand::Coprocess(coprocess) => self.command(&mut coprocess.body),
		}
	}

	/// Substitutes aliases for a simple command's words as Bash's reader does:
	/// for the command name, and for each word after an alias whose value ends
	/// in a blank.
	fn simple_command(&self, command: &mut ast::SimpleCommand) {
		let Some(name) = command.word_or_name.take() else {
			return;
		};

		let mut pending = VecDeque::from([Pending::Word(ReadWord::input(name))]);
		for item in command.suffix.take().map(|suffix| suffix.0).unwrap_or_default() {
			pending.push_back(match item {
				CommandPrefixOrSuffixItem::Word(word) => Pending::Word(ReadWord::input(word)),
				other => Pending::Other(other),
			});
		}

		let mut prefix = command.prefix.take().map(|prefix| prefix.0).unwrap_or_default();
		let mut name = None;
		let mut suffix = Vec::new();
		// Nothing but assignments and redirections read so far.
		let mut command_position = true;
		// Bash's "check the next word for an alias" state.
		let mut expand_next = false;

		while let Some(next) = pending.pop_front() {
			let read = match next {
				Pending::Word(read) => read,
				Pending::Other(item) => {
					// A redirection, assignment or process substitution: none of
					// its words is an alias, and reading one ends the check.
					expand_next = false;
					if command_position
						&& matches!(
							item,
							CommandPrefixOrSuffixItem::IoRedirect(_)
								| CommandPrefixOrSuffixItem::AssignmentWord(..)
						) {
						prefix.push(item);
					} else {
						command_position = false;
						suffix.push(item);
					}
					continue;
				},
			};

			let quoted = is_quoted(&read.word.value);
			if (command_position || expand_next)
				&& !read.expanding.iter().any(|alias| *alias == read.word.value)
				&& let Some(value) = self.shell.command_word_alias(&read.word.value)
			{
				let mut expanding = read.expanding;
				expanding.push(read.word.value);
				let after = read.after.or(Some(value.ends_with([' ', '\t'])));
				let body = alias_words(self.shell, value, read.word.loc.as_ref());
				if body.is_empty() {
					if let Some(check_next) = after {
						expand_next = check_next;
					}
				} else {
					let last = body.len() - 1;
					for (index, word) in body.into_iter().enumerate().rev() {
						pending.push_front(Pending::Word(ReadWord {
							word,
							expanding: expanding.clone(),
							after: if index == last { after } else { None },
						}));
					}
				}
				continue;
			}

			// A quoted word is never looked up, so it leaves the check pending.
			if !quoted {
				expand_next = false;
			}
			let ReadWord { word, after, .. } = read;
			if command_position {
				if let Ok(mut assignment) = brush_parser::word::parse_assignment_word(&word.value) {
					// An alias's value can start with assignments.
					assignment.loc = word.loc.clone().unwrap_or_default();
					prefix.push(CommandPrefixOrSuffixItem::AssignmentWord(assignment, word));
				} else {
					name = Some(word);
					command_position = false;
				}
			} else {
				suffix.push(CommandPrefixOrSuffixItem::Word(word));
			}
			if let Some(check_next) = after {
				expand_next = check_next;
			}
		}

		command.prefix = (!prefix.is_empty()).then(|| ast::CommandPrefix(prefix));
		command.word_or_name = name;
		command.suffix = (!suffix.is_empty()).then(|| ast::CommandSuffix(suffix));
	}
}

/// The words an alias's value reads as, located where the alias was used.
///
/// A value holding more than plain words (an operator, an unterminated quote)
/// is split at blanks instead; substituting it as shell syntax would need the
/// parser to read it.
fn alias_words<SE: extensions::ShellExtensions>(
	shell: &Shell<SE>,
	value: &str,
	loc: Option<&brush_parser::SourceSpan>,
) -> Vec<ast::Word> {
	let options = shell.parser_options().tokenizer_options();
	let words: Vec<String> = match brush_parser::tokenize_str_with_options(value, &options) {
		Ok(tokens) if tokens.iter().all(|token| matches!(token, brush_parser::Token::Word(..))) => {
			tokens.iter().map(|token| token.to_str().to_owned()).collect()
		},
		_ => value.split_ascii_whitespace().map(str::to_owned).collect(),
	};
	words.into_iter().map(|value| ast::Word { value, loc: loc.cloned() }).collect()
}
