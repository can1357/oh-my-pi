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

use std::{
	collections::{HashMap, VecDeque},
	sync::Arc,
};

use brush_parser::{
	TokenizerOptions,
	ast::{self, CommandPrefixOrSuffixItem},
};

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
pub struct AliasesAtRead(Option<Arc<HashMap<String, String>>>);

impl AliasesAtRead {
	/// The aliases a line beginning now in `shell` is read with.
	pub fn of<SE: extensions::ShellExtensions>(shell: &Shell<SE>) -> Self {
		Self(
			shell
				.options()
				.expand_aliases
				.then(|| Arc::new(shell.aliases().clone())),
		)
	}

	pub(crate) fn table(&self) -> Option<&HashMap<String, String>> {
		self.0.as_deref()
	}
}

/// Substitutes the aliases of `aliases` (none while `expand_aliases` is off)
/// in `command`, a complete command about to run.
pub(crate) fn expand_complete_command<SE: extensions::ShellExtensions>(
	shell: &Shell<SE>,
	aliases: Option<&HashMap<String, String>>,
	command: &mut ast::CompoundList,
) {
	let Some(aliases) = aliases.filter(|aliases| !aliases.is_empty()) else {
		return;
	};
	Substitution { aliases, tokenizer_options: shell.parser_options().tokenizer_options() }
		.compound_list(command);
}

/// The aliases the shell substitutes now: its alias table, or none while
/// `expand_aliases` is off.
pub(crate) fn live_aliases<SE: extensions::ShellExtensions>(
	shell: &Shell<SE>,
) -> Option<&HashMap<String, String>> {
	shell.options().expand_aliases.then(|| shell.aliases())
}

/// Is `word`, as written, quoted? Bash never reads a quoted word as an alias,
/// and a quoted word leaves its reader's "check the next word" state alone.
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

struct Substitution<'a> {
	aliases:           &'a HashMap<String, String>,
	tokenizer_options: TokenizerOptions,
}

impl Substitution<'_> {
	fn is_quoted(&self, word: &str) -> bool {
		is_quoted(word, &self.tokenizer_options)
	}

	fn alias(&self, word: &str) -> Option<&str> {
		if self.is_quoted(word) {
			return None;
		}
		self.aliases.get(word).map(String::as_str)
	}

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

		let mut prefix = command.prefix.take().map(|prefix| prefix.0).unwrap_or_default();
		// Nothing but assignments and redirections read so far, from the source
		// or from an alias's value.
		let mut start = CommandStart::new();
		for item in &prefix {
			start.item(item);
		}

		let mut pending = VecDeque::from([Pending::Word(ReadWord::input(name))]);
		for item in command.suffix.take().map(|suffix| suffix.0).unwrap_or_default() {
			pending.push_back(match item {
				CommandPrefixOrSuffixItem::Word(word) => Pending::Word(ReadWord::input(word)),
				other => Pending::Other(other),
			});
		}

		let mut name = None;
		let mut suffix = Vec::new();
		// Bash's "check the next word for an alias" state.
		let mut expand_next = false;
		// Whether the command name is still to come.
		let mut before_name = true;

		while let Some(next) = pending.pop_front() {
			let read = match next {
				Pending::Word(read) => read,
				Pending::Other(item) => {
					// A redirection or process substitution ends the check. An
					// assignment after the command name is an argument word: as
					// for any word, a quoted one leaves the check alone and an
					// unquoted one ends it.
					let keeps_check = !before_name
						&& matches!(
							&item,
							CommandPrefixOrSuffixItem::AssignmentWord(_, word) if self.is_quoted(&word.value)
						);
					if !keeps_check {
						expand_next = false;
					}
					if before_name
						&& matches!(
							item,
							CommandPrefixOrSuffixItem::IoRedirect(_)
								| CommandPrefixOrSuffixItem::AssignmentWord(..)
						) {
						start.item(&item);
						prefix.push(item);
					} else {
						before_name = false;
						suffix.push(item);
					}
					continue;
				},
			};

			let quoted = self.is_quoted(&read.word.value);
			if ((before_name && start.command_position) || expand_next)
				&& !read.expanding.iter().any(|alias| *alias == read.word.value)
				&& let Some(value) = self.alias(&read.word.value)
			{
				let mut expanding = read.expanding;
				expanding.push(read.word.value);
				let after = read.after.or(Some(value.ends_with([' ', '\t'])));
				let body = self.alias_words(value, read.word.loc.as_ref());
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
			if before_name {
				if let Ok(mut assignment) = brush_parser::word::parse_assignment_word(&word.value) {
					// An alias's value can start with assignments.
					assignment.loc = word.loc.clone().unwrap_or_default();
					let item = CommandPrefixOrSuffixItem::AssignmentWord(assignment, word);
					start.item(&item);
					prefix.push(item);
				} else {
					name = Some(word);
					before_name = false;
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

	/// The words an alias's value reads as, located where the alias was used.
	///
	/// A value holding more than plain words (an operator, an unterminated
	/// quote) is split at blanks instead; substituting it as shell syntax would
	/// need the parser to read it.
	fn alias_words(&self, value: &str, loc: Option<&brush_parser::SourceSpan>) -> Vec<ast::Word> {
		let words: Vec<String> =
			match brush_parser::tokenize_str_with_options(value, &self.tokenizer_options) {
				Ok(tokens) if tokens.iter().all(|token| matches!(token, brush_parser::Token::Word(..))) => {
					tokens.iter().map(|token| token.to_str().to_owned()).collect()
				},
				_ => value.split_ascii_whitespace().map(str::to_owned).collect(),
			};
		words.into_iter().map(|value| ast::Word { value, loc: loc.cloned() }).collect()
	}
}

/// Bash's reader state for the assignments and redirections before a command
/// name, read from the source or from an alias's value, in order.
///
/// After an assignment read in command position, the next word is still looked
/// up. After a redirection it is only while every item before it was a
/// redirection: a redirection that follows an assignment ends the command
/// position, and an assignment read after that does not restore it
/// (`x=1 >out y=2 q`).
struct CommandStart {
	command_position:  bool,
	only_redirections: bool,
}

impl CommandStart {
	const fn new() -> Self {
		Self { command_position: true, only_redirections: true }
	}

	fn item(&mut self, item: &CommandPrefixOrSuffixItem) {
		match item {
			CommandPrefixOrSuffixItem::AssignmentWord(..) => self.only_redirections = false,
			CommandPrefixOrSuffixItem::IoRedirect(_) => {
				if !self.only_redirections {
					self.command_position = false;
				}
			},
			CommandPrefixOrSuffixItem::Word(_) | CommandPrefixOrSuffixItem::ProcessSubstitution(..) => {
				self.command_position = false;
			},
		}
	}
}
