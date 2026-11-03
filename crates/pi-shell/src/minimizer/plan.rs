//! Structural analysis of a shell command using `brush-parser`.
//!
//! The minimizer must not corrupt downstream parsing or stitch together
//! segments that emit interleaved output. This module parses the full
//! command with the same shell parser the vendored brush runtime uses and
//! classifies it into one of a few shapes the engine can reason about.
//!
//! ## Decisions encoded here
//!
//! - **Pipes are opaque.** Any `foo | bar` pipeline is marked as `Piped`
//!   regardless of what `bar` is. A user piping through `awk`, `jq`, `rg`, or
//!   any other consumer is almost certainly parsing the output; rewriting it
//!   would be a correctness bug. The engine falls back to passthrough.
//! - **Safe chains are segmented, not rewritten whole.** Top-level simple
//!   commands joined only by `&&` and `;` may be split into `ChainSegment`s for
//!   the segmented engine path, but the whole-buffer minimizer still treats the
//!   combined chain as opaque.
//! - **Other compound commands are opaque.** `a || b`, background jobs, and
//!   compound shell syntax such as subshells or function definitions are left
//!   unchanged.
//! - **Single simple commands** are safe for the whole-buffer path; the engine
//!   dispatches them through `detect.rs` as before.
//!
//! When the command fails to parse (syntax error, unsupported construct),
//! we return `Unsupported` and the engine passes through.

use brush_parser::{
	ParserOptions,
	ast::{
		AndOr, Command, CommandPrefixOrSuffixItem, CompoundListItem, IoFileRedirectTarget,
		IoRedirect, Pipeline, Program, SeparatorOperator, SimpleCommand, Word,
	},
	word::WordPiece,
};

/// One segment of a safe `&&` / `;` chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainSegment {
	pub command:                   String,
	pub program:                   String,
	pub run_if_previous_succeeded: bool,
	pub suppress_errexit:          bool,
	/// Whether the segment begins an input line of the command. The shell
	/// does things before each input line (it forgets the ended jobs a
	/// listing reported), which a later segment of the same line must not
	/// repeat when the segments run one at a time.
	pub starts_line:               bool,
	/// Whether the segment can change the shell's own state for the
	/// segments after it, from its spelling alone; see [`command_words`].
	/// Such a chain is not run segment by segment.
	pub mutates_shell:             bool,
	/// The words of the segment's commands that name a command, each with
	/// how the shell looks it up. Only the live shell knows whether one is a
	/// function or an alias, which may change the shell's state (an `exec`
	/// in a function body), so the runner checks them against it before it
	/// runs the chain segment by segment.
	pub command_words:             Vec<CommandWord>,
}

/// A word that names a command, which only the live shell can resolve to an
/// alias, a function, a builtin or a file (see
/// [`ChainSegment::command_words`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandWord {
	/// The word after quote removal.
	pub name:   String,
	/// How the shell looks the word up.
	pub lookup: WordLookup,
}

/// How the shell looks up a [`CommandWord`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WordLookup {
	/// A simple command's first word: an alias, a function, a builtin or a
	/// file.
	Command,
	/// A word after `command`, which skips functions: a builtin or a file.
	NoFunction,
	/// A word after `builtin`: a builtin only.
	Builtin,
}

/// Outcome of analyzing a raw command string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandPlan {
	/// Exactly one simple command. `program` is the leading word (without
	/// arguments), verbatim from the parsed AST.
	Single { program: String },
	/// The command contains at least one `|` pipeline. We intentionally do
	/// NOT identify upstream / downstream programs here — any pipe defeats
	/// safe minimization for this engine.
	Piped,
	/// Top-level simple commands joined by `&&` and/or `;`. These can be
	/// minimized segment-by-segment, but not as one combined buffer.
	Chain { segments: Vec<ChainSegment> },
	/// The command has multiple segments joined by `||`, `&`, or other
	/// unsupported shell syntax. This shape is left unchanged; the minimizer
	/// only rewrites whole simple command output.
	Compound,
	/// Parse failed, a compound shell construct (for loops, subshells, etc.)
	/// was encountered, or the command was empty.
	Unsupported,
}

/// Parse `command` with `brush-parser` and classify its structure.
#[must_use]
pub fn analyze(command: &str) -> CommandPlan {
	if command.trim().is_empty() {
		return CommandPlan::Unsupported;
	}
	let Some(program) = parse(command) else {
		return CommandPlan::Unsupported;
	};
	classify(&program)
}

/// Parse `command` with the same `brush-parser` configuration the vendored
/// runtime uses, discarding error detail. Returns `None` on any syntax error
/// or unsupported construct.
fn parse(command: &str) -> Option<Program> {
	let options = ParserOptions::default();
	let reader = std::io::Cursor::new(command.as_bytes());
	let mut parser = brush_parser::Parser::new(reader, &options);
	parser.parse_program().ok()
}

fn classify(program: &Program) -> CommandPlan {
	if let Some(chain) = classify_chain(program) {
		return chain;
	}

	// Count separator-separated top-level items across all complete_commands.
	let items: Vec<&CompoundListItem> = program
		.complete_commands
		.iter()
		.flat_map(|cl| cl.0.iter())
		.collect();

	if items.is_empty() {
		return CommandPlan::Unsupported;
	}

	if items.len() > 1 {
		// `a ; b` or `a & b` produces multiple compound list items.
		return CommandPlan::Compound;
	}

	// Exactly one CompoundListItem: check the separator and the AndOrList.
	let CompoundListItem(and_or, separator) = items[0];

	// Async separator (`&`) backgrounds the command; treat as compound since
	// the parent shell's stdout is the foreground command's — we don't know
	// which one we're capturing. Conservative bail.
	if matches!(separator, SeparatorOperator::Async) {
		return CommandPlan::Compound;
	}

	// AndOrList.additional holds the `&&` / `||` continuations.
	if !and_or.additional.is_empty() {
		return CommandPlan::Compound;
	}

	// Only a single pipeline at this point.
	classify_pipeline(&and_or.first).unwrap_or(CommandPlan::Unsupported)
}

fn classify_chain(program: &Program) -> Option<CommandPlan> {
	// Complete commands are separated by newlines: the first item of each
	// begins an input line.
	let items: Vec<(bool, &CompoundListItem)> = program
		.complete_commands
		.iter()
		.flat_map(|cl| {
			cl.0
				.iter()
				.enumerate()
				.map(|(index, item)| (index == 0, item))
		})
		.collect();

	if items.is_empty() {
		return None;
	}

	let mut segments = Vec::new();
	let mut run_if_previous_succeeded = false;

	for (item_index, &(item_starts_line, item)) in items.iter().enumerate() {
		if matches!(item.1, SeparatorOperator::Async) {
			return None;
		}

		let is_last_item = item_index + 1 == items.len();
		let mut pipeline = &item.0.first;
		let mut additional = item.0.additional.iter().peekable();
		let mut starts_line = item_starts_line;

		loop {
			let (command, program, words) = simple_segment(pipeline)?;

			let suppress_errexit = additional
				.peek()
				.is_some_and(|and_or| matches!(and_or, AndOr::And(_)));
			segments.push(ChainSegment {
				command,
				program,
				run_if_previous_succeeded,
				suppress_errexit,
				starts_line,
				mutates_shell: words.is_none(),
				command_words: words.unwrap_or_default(),
			});
			starts_line = false;

			let Some(and_or) = additional.next() else {
				run_if_previous_succeeded = false;
				break;
			};

			match and_or {
				AndOr::And(next_pipeline) => {
					run_if_previous_succeeded = true;
					pipeline = next_pipeline;
				},
				AndOr::Or(_) => return None,
			}
		}

		if !is_last_item {
			run_if_previous_succeeded = false;
		}
	}

	(segments.len() >= 2).then_some(CommandPlan::Chain { segments })
}

fn word_has_command_substitution(word: &Word) -> bool {
	word.value.contains("$(") || word.value.contains('`')
}

fn command_prefix_or_suffix_item_is_safe(item: &CommandPrefixOrSuffixItem) -> bool {
	match item {
		CommandPrefixOrSuffixItem::IoRedirect(io) => io_redirect_is_safe(io),
		CommandPrefixOrSuffixItem::Word(word) => !word_has_command_substitution(word),
		CommandPrefixOrSuffixItem::AssignmentWord(_, word) => !word_has_command_substitution(word),
		CommandPrefixOrSuffixItem::ProcessSubstitution(..) => false,
	}
}

fn io_redirect_is_safe(io: &IoRedirect) -> bool {
	match io {
		IoRedirect::File(_, _, target) => match target {
			IoFileRedirectTarget::Filename(word) | IoFileRedirectTarget::Duplicate(word) => {
				!word_has_command_substitution(word)
			},
			IoFileRedirectTarget::Fd(_) => true,
			IoFileRedirectTarget::ProcessSubstitution(..) => false,
		},
		// Here-docs are never safe to segment. The segmented runner rebuilds
		// each chain segment from the brush AST via `pipeline.to_string()`, and
		// that Display impl re-emits a quoted/escaped here-doc's *closing*
		// delimiter with its quotes intact (`<<'EOF'` … `'EOF'` rather than the
		// required bare `EOF`). The reconstructed close tag never matches, so
		// the re-run segment fails with "unterminated here document". Leave any
		// here-doc-bearing command to the unsegmented single path.
		IoRedirect::HereDocument(..) => false,
		IoRedirect::HereString(_, word) => !word_has_command_substitution(word),
		IoRedirect::OutputAndError(word, _) => !word_has_command_substitution(word),
	}
}

/// True when every part of a simple command is safe to reconstruct through
/// `brush`'s `Display` impl: no command/process substitutions and no here-doc
/// in the command word, prefix, or suffix (those re-emit in forms that diverge
/// from the source). The full reconstruction is still re-parse-verified by
/// [`reconstruction_reparses_to_same_shape`] before any segment is executed.
fn simple_command_is_safe(simple: &SimpleCommand) -> bool {
	if let Some(prefix) = simple.prefix.as_ref()
		&& prefix
			.0
			.iter()
			.any(|item| !command_prefix_or_suffix_item_is_safe(item))
	{
		return false;
	}
	if let Some(suffix) = simple.suffix.as_ref()
		&& suffix
			.0
			.iter()
			.any(|item| !command_prefix_or_suffix_item_is_safe(item))
	{
		return false;
	}
	if let Some(word) = simple.word_or_name.as_ref()
		&& word_has_command_substitution(word)
	{
		return false;
	}
	true
}

/// A pipeline that can be one segment of a chain: its reconstructed text,
/// its first program word, and the words that name its commands (`None` when
/// its spelling alone shows it can change the shell's state; see
/// [`command_words`]).
fn simple_segment(pipeline: &Pipeline) -> Option<(String, String, Option<Vec<CommandWord>>)> {
	if pipeline.timed.is_some() || pipeline.bang || pipeline.seq.is_empty() {
		return None;
	}

	// Every stage must be a Display-safe simple command. Compound stages
	// (`if` / `for` / `while` / subshells / `{ … }`) and unsafe words/redirects
	// (here-docs, substitutions) do not round-trip through `Display`. Validating
	// only `seq.first()` once let a compound later stage through — e.g.
	// `git log … | while read x; do … done` — and the reconstructed segment then
	// failed to execute with "syntax error at end of input".
	for command in &pipeline.seq {
		let Command::Simple(simple) = command else {
			return None;
		};
		if !simple_command_is_safe(simple) {
			return None;
		}
	}

	// Identify the segment by its first stage's program word. Multi-stage pipes
	// are captured but never rewritten (runtime detects `CommandPlan::Piped`),
	// keeping the chain decomposable when an inner stage pipes (e.g.
	// `ls | head -10 && git status`).
	let Command::Simple(first) = pipeline.seq.first()? else {
		return None;
	};
	let program_word = first.word_or_name.as_ref()?;
	let program = program_word.to_string();
	if program.trim().is_empty() {
		return None;
	}

	// The chain runner re-executes this reconstructed string verbatim. brush's
	// `Display` is not a guaranteed inverse of its parser, so re-parse the
	// reconstruction and require the same pipeline shape before committing to
	// segmentation. Any divergence (a lossy compound terminator today, a future
	// `Display` change tomorrow) falls back to the unsegmented whole-command
	// path instead of failing at execution.
	let command = pipeline.to_string();
	if !reconstruction_reparses_to_same_shape(&command, pipeline.seq.len()) {
		return None;
	}
	let options = ParserOptions::default();
	let mut words = Some(Vec::new());
	for command in &pipeline.seq {
		if let (Command::Simple(simple), Some(all)) = (command, words.as_mut()) {
			match command_words(simple, &options) {
				Some(named) => all.extend(named),
				None => words = None,
			}
		}
	}
	Some((command, program, words))
}

/// The builtins whose effect on the shell outlives the command: `exec`
/// changes the shell's file descriptors, `eval`, `source` and `.` can do
/// anything, `trap` sets commands that run between later ones, `fc`
/// re-runs earlier commands, `mapfile` and `readarray` can run a callback,
/// and `alias`/`unalias` change how later text is read.
const SHELL_STATE_BUILTINS: [&str; 10] =
	["exec", "eval", "source", ".", "trap", "fc", "mapfile", "readarray", "alias", "unalias"];

/// The words of `simple` that name the command it runs, each with how the
/// shell looks it up: the first word, and through `command` and `builtin`
/// with their options each word after them; or `None` when its spelling
/// alone shows it can change the shell's own state for the commands after
/// it (see [`SHELL_STATE_BUILTINS`]). Words are read as the shell reads
/// them, after quote removal (`'exec'`, `"exec"` and `\exec` are `exec`). A
/// word the shell would expand (`$cmd`, `$(...)`, `~`, `$'...'`, an unquoted
/// `{` that brace expansion may take, as `{exec,}` is `exec`) cannot be
/// resolved here, so such a command counts as one that can. Whether a named
/// word is a function or an alias, which can too, only the live shell knows
/// ([`ChainSegment::command_words`]).
fn command_words(simple: &SimpleCommand, options: &ParserOptions) -> Option<Vec<CommandWord>> {
	let suffix_words = simple
		.suffix
		.iter()
		.flat_map(|suffix| suffix.0.iter())
		.filter_map(|item| match item {
			CommandPrefixOrSuffixItem::Word(word) => Some(word),
			_ => None,
		});
	let mut words = simple.word_or_name.iter().chain(suffix_words);
	let mut named = Vec::new();
	let mut lookup = WordLookup::Command;
	loop {
		let Some(word) = words.next() else {
			return Some(named);
		};
		let name = static_word_text(&word.value, options)?;
		// `command -p name` and `builtin -- name`: the options come before
		// the command they run.
		if lookup != WordLookup::Command && name.starts_with('-') && name.len() > 1 {
			if lookup == WordLookup::NoFunction && name.contains(['v', 'V']) {
				// `command -v`/`-V` only describes the command.
				return Some(named);
			}
			continue;
		}
		if SHELL_STATE_BUILTINS.contains(&name.as_str()) {
			return None;
		}
		let next = match name.as_str() {
			"command" => Some(WordLookup::NoFunction),
			"builtin" => Some(WordLookup::Builtin),
			_ => None,
		};
		named.push(CommandWord { name, lookup });
		match next {
			Some(next) => lookup = next,
			None => return Some(named),
		}
	}
}

/// The text of `word` after quote removal, or `None` when the shell would
/// expand part of it.
fn static_word_text(word: &str, options: &ParserOptions) -> Option<String> {
	let pieces = brush_parser::word::parse(word, options).ok()?;
	let mut text = String::new();
	for piece in &pieces {
		push_static_piece(&piece.piece, &mut text)?;
	}
	Some(text)
}

fn push_static_piece(piece: &WordPiece, text: &mut String) -> Option<()> {
	match piece {
		// Brace expansion reads an unquoted `{` (`{exec,}` is `exec`).
		WordPiece::Text(part) if part.contains('{') => return None,
		WordPiece::Text(part) | WordPiece::SingleQuotedText(part) => text.push_str(part),
		WordPiece::EscapeSequence(escaped) => {
			text.push_str(escaped.strip_prefix('\\').unwrap_or(escaped));
		},
		WordPiece::DoubleQuotedSequence(inner) | WordPiece::GettextDoubleQuotedSequence(inner) => {
			for part in inner {
				push_static_piece(&part.piece, text)?;
			}
		},
		_ => return None,
	}
	Some(())
}

/// Confirm a reconstructed segment string re-parses to the *same shape* it was
/// built from: exactly one sequential top-level pipeline with `expected_stages`
/// commands, no `&&`/`||`/`;`/`&` continuation, and no `!`/`time` modifier.
///
/// This is a syntax/shape guard, not a proof of full semantic equivalence. It
/// guarantees the chain runner never executes a reconstruction that fails to
/// parse or that `Display` reshaped into different top-level structure. brush's
/// `Display` is not a guaranteed inverse of its parser — compound terminators
/// (`while … done`) and quoted here-doc close tags re-emit in forms that fail
/// to re-parse — so a divergent segment drops back to the unsegmented
/// whole-command path instead of blowing up at execution with
/// "pi-natives:command: syntax error". The per-stage `simple_command_is_safe`
/// whitelist already excludes constructs whose `Display` is value-lossy
/// (substitutions, here-docs); words carry raw source text and round-trip
/// verbatim.
fn reconstruction_reparses_to_same_shape(reconstructed: &str, expected_stages: usize) -> bool {
	let Some(program) = parse(reconstructed) else {
		return false;
	};
	let mut items = program.complete_commands.iter().flat_map(|cl| cl.0.iter());
	let Some(CompoundListItem(and_or, separator)) = items.next() else {
		return false;
	};
	// A second top-level item, a trailing `&` (Async), or an `&&`/`||`
	// continuation all mean `Display` reshaped the command.
	if items.next().is_some()
		|| !and_or.additional.is_empty()
		|| matches!(separator, SeparatorOperator::Async)
	{
		return false;
	}
	let pipeline = &and_or.first;
	!pipeline.bang && pipeline.timed.is_none() && pipeline.seq.len() == expected_stages
}

fn classify_pipeline(pipeline: &Pipeline) -> Option<CommandPlan> {
	if pipeline.seq.len() > 1 {
		return Some(CommandPlan::Piped);
	}
	let single = pipeline.seq.first()?;
	match single {
		Command::Simple(simple) => {
			let program_word = simple.word_or_name.as_ref()?;
			let program_text = program_word.to_string();
			if program_text.trim().is_empty() {
				return None;
			}
			Some(CommandPlan::Single { program: program_text })
		},
		// Compound shell syntax (if / for / while / subshell / { ... }) is
		// not something the minimizer should touch.
		Command::Compound(..) | Command::Function(_) | Command::ExtendedTest(..) => {
			Some(CommandPlan::Compound)
		},
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn program_of(plan: CommandPlan) -> Option<String> {
		match plan {
			CommandPlan::Single { program } => Some(program),
			_ => None,
		}
	}

	fn chain_of(plan: CommandPlan) -> Option<Vec<ChainSegment>> {
		match plan {
			CommandPlan::Chain { segments } => Some(segments),
			_ => None,
		}
	}

	/// The first word of a simple command, looked up as a command.
	fn named(name: &str) -> Vec<CommandWord> {
		vec![CommandWord { name: name.to_owned(), lookup: WordLookup::Command }]
	}

	fn assert_not_chain(command: &str) {
		assert!(
			!matches!(analyze(command), CommandPlan::Chain { .. }),
			"{command:?} unexpectedly classified as Chain"
		);
	}

	#[test]
	fn single_simple_command() {
		let plan = analyze("git status --short");
		assert_eq!(program_of(plan), Some("git".to_string()));
	}

	#[test]
	fn env_prefix_is_still_single() {
		// env assignments are prefix, the program is `git`.
		let plan = analyze("FOO=1 git status");
		assert!(matches!(plan, CommandPlan::Single { .. }));
	}

	#[test]
	fn safe_and_chain_is_segmented() {
		let plan = analyze("git diff --stat && git diff --name-only");
		assert_eq!(
			chain_of(plan),
			Some(vec![
				ChainSegment {
					command:                   "git diff --stat".to_string(),
					program:                   "git".to_string(),
					run_if_previous_succeeded: false,
					suppress_errexit:          true,
					starts_line:               true,
					mutates_shell:             false,
					command_words:             named("git"),
				},
				ChainSegment {
					command:                   "git diff --name-only".to_string(),
					program:                   "git".to_string(),
					run_if_previous_succeeded: true,
					suppress_errexit:          false,
					starts_line:               false,
					mutates_shell:             false,
					command_words:             named("git"),
				},
			])
		);
	}

	#[test]
	fn safe_sequence_chain_is_segmented() {
		let plan = analyze("git status ; bun test");
		assert_eq!(
			chain_of(plan),
			Some(vec![
				ChainSegment {
					command:                   "git status".to_string(),
					program:                   "git".to_string(),
					run_if_previous_succeeded: false,
					suppress_errexit:          false,
					starts_line:               true,
					mutates_shell:             false,
					command_words:             named("git"),
				},
				ChainSegment {
					command:                   "bun test".to_string(),
					program:                   "bun".to_string(),
					run_if_previous_succeeded: false,
					suppress_errexit:          false,
					starts_line:               false,
					mutates_shell:             false,
					command_words:             named("bun"),
				},
			])
		);
	}

	#[test]
	fn mixed_chain_is_segmented() {
		let plan = analyze("false && echo no ; echo yes");
		assert_eq!(
			chain_of(plan),
			Some(vec![
				ChainSegment {
					command:                   "false".to_string(),
					program:                   "false".to_string(),
					run_if_previous_succeeded: false,
					suppress_errexit:          true,
					starts_line:               true,
					mutates_shell:             false,
					command_words:             named("false"),
				},
				ChainSegment {
					command:                   "echo no".to_string(),
					program:                   "echo".to_string(),
					run_if_previous_succeeded: true,
					suppress_errexit:          false,
					starts_line:               false,
					mutates_shell:             false,
					command_words:             named("echo"),
				},
				ChainSegment {
					command:                   "echo yes".to_string(),
					program:                   "echo".to_string(),
					run_if_previous_succeeded: false,
					suppress_errexit:          false,
					starts_line:               false,
					mutates_shell:             false,
					command_words:             named("echo"),
				},
			])
		);
	}

	/// A command that changes the shell's own state, in any spelling the
	/// shell resolves to it, keeps the chain from running segment by segment;
	/// one that only names or describes it does not.
	#[test]
	fn every_spelling_of_a_shell_state_builtin_is_resolved() {
		let mutates = |command: &str| {
			chain_of(analyze(&format!("{command} ; echo O")))
				.expect("expected Chain")
				.iter()
				.any(|segment| segment.mutates_shell)
		};
		for command in [
			"exec 2>/dev/null",
			"'exec' 2>/dev/null",
			"\"exec\" 2>/dev/null",
			"\\exec 2>/dev/null",
			"e'x'ec 2>/dev/null",
			"command exec 2>/dev/null",
			"command 'exec' 2>/dev/null",
			"command -p exec 2>/dev/null",
			"builtin exec 2>/dev/null",
			"builtin -- \"exec\" 2>/dev/null",
			"FOO=1 exec 2>/dev/null",
			"'eval' echo hi",
			"\\. ./env.sh",
			"'source' ./env.sh",
			"\"alias\" ll=ls",
			"$cmd 2>/dev/null",
			"\"$cmd\" 2>/dev/null",
			"{exec,} 2>/dev/null",
			"command {exec,} 2>/dev/null",
			"trap 'exec >out' ERR",
			"command trap - ERR",
			"mapfile -C cb lines",
			"fc -s",
		] {
			assert!(mutates(command), "{command}");
		}
		for command in
			["echo exec", "command -v exec", "printf '%s' exec", "'git' status", "echo {a,b}"]
		{
			assert!(!mutates(command), "{command}");
		}
	}

	/// Each word that names a command is kept with how the shell looks it
	/// up, through `command` and `builtin` and their options, for every stage
	/// of a segment's pipeline: only the live shell can tell a function or an
	/// alias.
	#[test]
	fn each_command_word_is_kept_with_its_lookup() {
		let words = |command: &str| -> Vec<(String, WordLookup)> {
			chain_of(analyze(&format!("{command} ; echo O")))
				.expect("expected Chain")
				.remove(0)
				.command_words
				.into_iter()
				.map(|word| (word.name, word.lookup))
				.collect()
		};
		let lookups = |pairs: &[(&str, WordLookup)]| -> Vec<(String, WordLookup)> {
			pairs
				.iter()
				.map(|&(name, lookup)| (name.to_owned(), lookup))
				.collect()
		};
		assert_eq!(words("quiet"), lookups(&[("quiet", WordLookup::Command)]));
		assert_eq!(words("'quiet' arg"), lookups(&[("quiet", WordLookup::Command)]));
		assert_eq!(
			words("command -p -- quiet"),
			lookups(&[("command", WordLookup::Command), ("quiet", WordLookup::NoFunction)])
		);
		assert_eq!(
			words("builtin command echo"),
			lookups(&[
				("builtin", WordLookup::Command),
				("command", WordLookup::Builtin),
				("echo", WordLookup::NoFunction),
			])
		);
		assert_eq!(
			words("cat file | quiet"),
			lookups(&[("cat", WordLookup::Command), ("quiet", WordLookup::Command)])
		);
		assert_eq!(words("command -v quiet"), lookups(&[("command", WordLookup::Command)]));
	}

	/// Each line of a chain that spans lines begins with a segment that starts
	/// a line; the shell's per-line work (forgetting reported jobs) runs before
	/// it and before no other segment.
	#[test]
	fn each_line_of_a_chain_starts_with_a_line_segment() {
		let plan = analyze("git status ; echo one\necho two && echo three\necho four");
		let starts: Vec<bool> = chain_of(plan)
			.expect("expected Chain")
			.iter()
			.map(|segment| segment.starts_line)
			.collect();
		assert_eq!(starts, [true, false, true, false, true]);
	}

	#[test]
	fn chain_with_piped_segment_is_segmented() {
		// A chain that contains a piped segment (`ls | head -5`) must still be
		// classified as Chain so the segmented runner can decompose it. The
		// piped segment is identified by its first stage's program; the
		// per-segment minimizer::apply will treat that segment as Piped at
		// runtime and pass it through unchanged.
		let plan = analyze("ls -lh *.txt | head -5 && git status --short");
		let segments = chain_of(plan).expect("expected Chain");
		assert_eq!(segments.len(), 2);
		assert_eq!(segments[0].program, "ls");
		assert_eq!(segments[1].program, "git");
	}

	#[test]
	fn rejects_unsafe_chain_segments() {
		for command in [
			"echo $(pwd) ; git status",
			"echo `pwd` ; git status",
			"cat <(printf hi) ; git status",
			"git status > >(cat) ; bun test",
			"! git status ; bun test",
		] {
			assert_not_chain(command);
		}
	}

	#[test]
	fn heredoc_chains_are_not_segmented() {
		// Regression: a chain whose segment carries a here-doc must not be
		// split. The segmented runner rebuilds each segment with the brush AST
		// Display impl, which re-emits a quoted/escaped here-doc's closing
		// delimiter with quotes (`'EOF'` rather than `EOF`); re-running that
		// reconstructed segment fails with "unterminated here document". Both
		// quoted and unquoted delimiters bail so the whole command runs whole.
		assert_not_chain("cat <<'EOF'\nbody\nEOF\necho done");
		assert_not_chain("cat <<\"EOF\"\nbody\nEOF\necho done");
		assert_not_chain("cat <<EOF\nbody\nEOF\necho done");
		assert_not_chain("cat <<'EOF' && echo done\nbody\nEOF");
	}

	#[test]
	fn rejects_legacy_opaque_shapes() {
		assert_eq!(analyze("foo || bar"), CommandPlan::Compound);
		assert_eq!(analyze("git status | cat"), CommandPlan::Piped);
		assert_eq!(analyze("sleep 1 &"), CommandPlan::Compound);
		assert_eq!(analyze("(cd foo && make)"), CommandPlan::Compound);
		assert_eq!(analyze("{ echo hi; }"), CommandPlan::Compound);
		assert_eq!(analyze("f() { echo hi; }"), CommandPlan::Compound);
		assert_eq!(analyze("[[ -f foo ]]"), CommandPlan::Compound);
		assert_eq!(analyze("a && && b"), CommandPlan::Unsupported);
	}

	#[test]
	fn empty_is_unsupported() {
		assert_eq!(analyze(""), CommandPlan::Unsupported);
		assert_eq!(analyze("   "), CommandPlan::Unsupported);
	}

	#[test]
	fn compound_later_pipeline_stage_is_not_segmented() {
		// Regression: a pipeline whose *later* stage is a compound command
		// (`while`/`for`/`if`/subshell) must never be segmented. The chain runner
		// re-executes `pipeline.to_string()`, and brush's `Display` drops the
		// compound terminator, so the reconstruction failed to re-parse and blew
		// up at execution with "syntax error at end of input". Validating only
		// `seq.first()` (a simple `git`/`seq`) let it slip through.
		assert_not_chain(
			"echo start && git log --oneline | while read h; do echo \"$h\"; done | head -3",
		);
		assert_not_chain("seq 3 | while read n; do echo \"$n\"; done && echo done");
		assert_not_chain("printf x && ls | for f in a b; do echo $f; done");
		// The reported shape classifies as Compound, so it runs whole and
		// unsegmented via the single path (no reconstruction, no minimization).
		assert_eq!(
			analyze("echo a && seq 2 | while read n; do echo $n; done"),
			CommandPlan::Compound,
		);
	}

	#[test]
	fn chain_segments_reparse_cleanly() {
		// Every command string the chain runner will execute must itself re-parse
		// to a single pipeline — the contract enforced by
		// `reconstruction_reparses_to_same_shape`. A segment whose `Display`
		// reconstruction diverges is dropped rather than emitted.
		for command in [
			"git diff --stat && git diff --name-only",
			"ls -lh *.txt | head -5 && git status --short",
			"grep -c foo bar 2>/dev/null && echo done",
			"FOO=1 git status ; bun test",
		] {
			let Some(segments) = chain_of(analyze(command)) else {
				panic!("{command:?} should classify as Chain");
			};
			for segment in &segments {
				assert!(
					parse(&segment.command).is_some(),
					"segment {:?} from {command:?} did not re-parse",
					segment.command,
				);
			}
		}
	}
}
