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
//!   combined chain as opaque. Each segment is the verbatim source slice the
//!   user typed — the chain runner executes these strings, and re-rendering
//!   them from the AST has produced invalid shell before (see
//!   [`verbatim_segment_spans`]).
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
};

/// One segment of a safe `&&` / `;` chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainSegment {
	pub command:                   String,
	pub program:                   String,
	pub run_if_previous_succeeded: bool,
	pub suppress_errexit:          bool,
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
	classify(command, &program)
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

fn classify(command: &str, program: &Program) -> CommandPlan {
	if let Some(chain) = classify_chain(command, program) {
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

/// Trim the bytes bash uses to separate words (unquoted space, tab, and
/// newline) from a verbatim segment slice — and only where the whitespace is
/// unescaped.
///
/// `str::trim` is Unicode-aware and eats bytes bash keeps as word content
/// (`echo a\rb` is one word `a\rb`; NBSP and other Unicode whitespace are
/// word bytes too), while a plain `trim_matches([' ', '\t', '\n'])` eats
/// escaped blanks and the newline of a `\`+newline continuation, leaving a
/// dangling `\` that no longer re-parses and silently drops the chain out of
/// segmentation. Whitespace preceded by an odd number of backslashes is
/// escaped word content: stop there and keep everything before it, so the
/// trim can never strip past an escape and merge two words back together.
fn trim_word_separators(text: &str) -> &str {
	const fn is_separator(byte: u8) -> bool {
		matches!(byte, b' ' | b'\t' | b'\n')
	}
	// The whitespace byte at `at` is escaped when an odd number of
	// backslashes immediately precede it (`\ ` is a blank byte inside a word;
	// `\\ ` is a word-ending separator).
	fn is_escaped(text: &str, at: usize) -> bool {
		text[..at]
			.bytes()
			.rev()
			.take_while(|&byte| byte == b'\\')
			.count()
			% 2 == 1
	}

	let bytes = text.as_bytes();
	let mut start = 0;
	while start < bytes.len() && is_separator(bytes[start]) && !is_escaped(text, start) {
		start += 1;
	}
	let mut end = bytes.len();
	while end > start && is_separator(bytes[end - 1]) && !is_escaped(text, end - 1) {
		end -= 1;
	}
	&text[start..end]
}

fn classify_chain(command: &str, program: &Program) -> Option<CommandPlan> {
	let items: Vec<&CompoundListItem> = program
		.complete_commands
		.iter()
		.flat_map(|cl| cl.0.iter())
		.collect();

	if items.is_empty() {
		return None;
	}

	// Verbatim source text for each chain segment, in source order (the same
	// order `items` and their `&&` continuations produce below). A scan that
	// cannot slice the command unambiguously bails the whole chain out of
	// segmentation.
	let spans = verbatim_segment_spans(command)?;

	let mut segments = Vec::new();
	let mut run_if_previous_succeeded = false;

	for (item_index, item) in items.iter().enumerate() {
		if matches!(item.1, SeparatorOperator::Async) {
			return None;
		}

		let is_last_item = item_index + 1 == items.len();
		let mut pipeline = &item.0.first;
		let mut additional = item.0.additional.iter().peekable();

		loop {
			let &(span_start, span_end) = spans.get(segments.len())?;
			let source = trim_word_separators(&command[span_start..span_end]);
			let (segment_command, program) = simple_segment(pipeline, source)?;

			let suppress_errexit = additional
				.peek()
				.is_some_and(|and_or| matches!(and_or, AndOr::And(_)));
			segments.push(ChainSegment {
				command: segment_command,
				program,
				run_if_previous_succeeded,
				suppress_errexit,
			});

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

	// One span per segment proves the scan and the parser agreed on where the
	// separators are; a disagreement (or a chain that vanished above) falls
	// back to the unsegmented whole-command path rather than executing text
	// that may not correspond to the parsed segments.
	if segments.len() < 2 || segments.len() != spans.len() {
		return None;
	}
	Some(CommandPlan::Chain { segments })
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
		// Here-docs are never safe to segment. A here-doc's body starts on the
		// line after the `<<` operator and freely contains `&&`, `;`, and
		// newlines — separators `verbatim_segment_spans` would wrongly split
		// on, since the scan cannot see where the body ends. (Rendering
		// segments through the brush AST `Display` impl was worse still: it
		// re-emitted a quoted/escaped here-doc's *closing* delimiter with its
		// quotes intact (`<<'EOF'` … `'EOF'` rather than the required bare
		// `EOF`), and the re-run segment failed with "unterminated here
		// document".) Leave any here-doc-bearing command to the unsegmented
		// single path.
		IoRedirect::HereDocument(..) => false,
		IoRedirect::HereString(_, word) => !word_has_command_substitution(word),
		IoRedirect::OutputAndError(word, _) => !word_has_command_substitution(word),
	}
}

/// True when every part of a simple command is safe to slice verbatim with
/// [`verbatim_segment_spans`]: no command/process substitutions and no here-doc
/// in the command word, prefix, or suffix (their bodies hide `&&` / `;` /
/// newline separators from the scan). The full slice is still re-parse-verified
/// by [`segment_reparses_to_same_shape`] before any segment is executed.
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

fn simple_segment(pipeline: &Pipeline, source: &str) -> Option<(String, String)> {
	if pipeline.timed.is_some() || pipeline.bang || pipeline.seq.is_empty() {
		return None;
	}

	// Every stage must be a scan-safe simple command. Compound stages
	// (`if` / `for` / `while` / subshells / `{ … }`) and unsafe words/redirects
	// (here-docs, substitutions) hide `&&` / `;` / newline separators inside
	// bodies `verbatim_segment_spans` cannot see. Validating only
	// `seq.first()` once let a compound later stage through — e.g.
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

	// The chain runner re-executes this verbatim source slice. Re-parse it and
	// require the same pipeline shape before committing to segmentation:
	// `verbatim_segment_spans` is a hand-rolled scan (quotes, escapes,
	// comments, `${…}`), not a full lexer, so a mis-slice must fall back to the
	// unsegmented whole-command path instead of executing wrong text.
	if !segment_reparses_to_same_shape(source, pipeline.seq.len()) {
		return None;
	}
	Some((source.to_string(), program))
}

/// Raw source span of every chain segment in `command`, in source order.
///
/// The chain runner executes the returned slices, so they must be the user's
/// own bytes. Re-rendering segments from the brush AST `Display` impl is not a
/// guaranteed inverse of the parser: it normalizes spacing, re-emits a quoted
/// here-doc's closing delimiter with its quotes intact (`<<'EOF'` … `'EOF'`
/// rather than the required bare `EOF`), and has dropped compound terminators
/// (`while … done` losing `done`) — each producing either invalid shell that
/// fails with "pi-natives:command: syntax error …" or silently different
/// commands.
///
/// Splits on top-level `&&` and `;`, plus newlines once a pipeline has
/// actually started (a newline directly after `&&` / `|` is a line break, not a
/// separator). `|` never splits: a chain segment is a whole pipeline. Quote,
/// escape, comment, and `${…}` states are tracked so separators hidden inside
/// them never split. Anything the scan cannot account for yields `None` and the
/// caller falls back to the whole-command path; `simple_command_is_safe` also
/// excludes constructs whose bodies hide separators from this scan
/// (command/process substitutions, here-docs).
fn verbatim_segment_spans(command: &str) -> Option<Vec<(usize, usize)>> {
	#[derive(Clone, Copy, PartialEq, Eq)]
	enum State {
		Normal,
		SingleQuoted,
		DoubleQuoted,
		Comment,
	}

	let mut spans: Vec<(usize, usize)> = Vec::new();
	let mut state = State::Normal;
	let mut brace_depth = 0usize;
	let mut word_boundary = true;
	let mut has_command = false;
	let mut start = 0usize;
	let mut chars = command.char_indices().peekable();

	while let Some((idx, c)) = chars.next() {
		let after = idx + c.len_utf8();

		if state == State::Comment {
			if c == '\n' {
				// The comment-ending newline is still an ordinary newline:
				// fall through to the normal-state handling below.
				state = State::Normal;
			} else {
				continue;
			}
		}

		match state {
			State::Comment => unreachable!("handled above"),
			State::SingleQuoted => {
				// Everything but the closing quote is word text, newlines
				// included.
				if c == '\'' {
					state = State::Normal;
				}
			},
			State::DoubleQuoted => match c {
				'\\' => {
					// Escaped char (or line continuation) inside double quotes.
					chars.next();
				},
				'"' => state = State::Normal,
				'$' if chars.next_if(|&(_, c)| c == '{').is_some() => brace_depth += 1,
				'}' if brace_depth > 0 => brace_depth -= 1,
				_ => {},
			},
			State::Normal => {
				if brace_depth > 0 {
					// Inside `${…}`: nothing is a separator or comment start.
					match c {
						'$' if chars.next_if(|&(_, c)| c == '{').is_some() => brace_depth += 1,
						'}' => brace_depth -= 1,
						_ => {},
					}
					has_command = true;
					word_boundary = false;
					continue;
				}
				match c {
					'\\' => {
						let escaped = chars.next();
						// A line continuation (`\` + newline) is neither content
						// nor a break; any other escape is word content.
						if !matches!(escaped, Some((_, '\n'))) {
							has_command = true;
							word_boundary = false;
						}
					},
					'\'' => {
						state = State::SingleQuoted;
						has_command = true;
						word_boundary = false;
					},
					'"' => {
						state = State::DoubleQuoted;
						has_command = true;
						word_boundary = false;
					},
					'$' if chars.next_if(|&(_, c)| c == '{').is_some() => {
						brace_depth += 1;
						has_command = true;
						word_boundary = false;
					},
					'#' if word_boundary => state = State::Comment,
					'&' if chars.next_if(|&(_, c)| c == '&').is_some() => {
						spans.push((start, idx));
						start = idx + 2;
						has_command = false;
						word_boundary = true;
					},
					';' => {
						spans.push((start, idx));
						start = after;
						has_command = false;
						word_boundary = true;
					},
					'|' => {
						// A pipeline continues; a newline after `|` is a line
						// break, not a separator.
						has_command = false;
						word_boundary = true;
					},
					'\n' if has_command => {
						spans.push((start, idx));
						start = after;
						has_command = false;
						word_boundary = true;
					},
					c if c.is_whitespace() => word_boundary = true,
					_ => {
						has_command = true;
						word_boundary = false;
					},
				}
			},
		}
	}

	if !matches!(state, State::Normal | State::Comment) {
		// Unterminated quote; not something this scan can slice.
		return None;
	}
	spans.push((start, command.len()));

	// A trailing `;` leaves a trailing empty group; an empty group anywhere
	// else means the scan and the parser disagree about the separators.
	while spans
		.last()
		.is_some_and(|&(s, e)| trim_word_separators(&command[s..e]).is_empty())
	{
		spans.pop();
	}
	if spans
		.iter()
		.any(|&(s, e)| trim_word_separators(&command[s..e]).is_empty())
	{
		return None;
	}
	Some(spans)
}

/// Confirm a verbatim segment slice re-parses to the *same shape* the parser
/// saw: exactly one sequential top-level pipeline with `expected_stages`
/// commands, no `&&`/`||`/`;`/`&` continuation, and no `!`/`time` modifier.
///
/// This is a syntax/shape guard, not a proof of full semantic equivalence. It
/// guarantees the chain runner never executes a slice that fails to parse or
/// that the separator scan split at the wrong place. `verbatim_segment_spans`
/// is a hand-rolled scan rather than a full lexer, so a divergent slice drops
/// back to the unsegmented whole-command path instead of blowing up at
/// execution with "pi-natives:command: syntax error". The per-stage
/// `simple_command_is_safe` whitelist already excludes constructs whose bodies
/// hide separators from the scan (substitutions, here-docs).
fn segment_reparses_to_same_shape(segment: &str, expected_stages: usize) -> bool {
	let Some(program) = parse(segment) else {
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
				},
				ChainSegment {
					command:                   "git diff --name-only".to_string(),
					program:                   "git".to_string(),
					run_if_previous_succeeded: true,
					suppress_errexit:          false,
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
				},
				ChainSegment {
					command:                   "bun test".to_string(),
					program:                   "bun".to_string(),
					run_if_previous_succeeded: false,
					suppress_errexit:          false,
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
				},
				ChainSegment {
					command:                   "echo no".to_string(),
					program:                   "echo".to_string(),
					run_if_previous_succeeded: true,
					suppress_errexit:          false,
				},
				ChainSegment {
					command:                   "echo yes".to_string(),
					program:                   "echo".to_string(),
					run_if_previous_succeeded: false,
					suppress_errexit:          false,
				},
			])
		);
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
		// split. A here-doc body hides `&&` / `;` / newline separators from
		// the verbatim segment scan, and rendering segments through the brush
		// AST `Display` impl used to re-emit a quoted/escaped here-doc's
		// closing delimiter with quotes (`'EOF'` rather than `EOF`), so the
		// re-run segment failed with "unterminated here document". Both
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
		// (`while … done`) must never be segmented. Segments used to be rebuilt
		// via the brush AST `Display` impl, which dropped the compound
		// terminator, so the reconstruction failed to re-parse and blew up at
		// execution with "syntax error at end of input". Validating only
		// `seq.first()` (a simple `git`/`seq`) let it slip through; compound
		// stages now also hide separators from the verbatim segment scan.
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
	fn chain_segments_are_verbatim_source_text() {
		// The chain runner executes `ChainSegment.command` as shell text, so
		// each segment must be the user's own source bytes. Segments used to be
		// re-rendered through brush's AST `Display` impl, which normalized
		// spacing (`>file.txt` → `> file.txt`, `2>&1` → `2>& 1`) and, for
		// shapes it did not round-trip, produced invalid shell (quoted here-doc
		// close tags; `while … done` losing `done`) that failed at execution
		// with "pi-natives:command: syntax error".
		let command = "echo   spaced   args >file.txt 2>&1 && printf 'a;b' ; FOO=1 git status";
		let segments = chain_of(analyze(command)).expect("expected Chain");
		let texts: Vec<&str> = segments.iter().map(|s| s.command.as_str()).collect();
		assert_eq!(texts, vec![
			"echo   spaced   args >file.txt 2>&1",
			"printf 'a;b'",
			"FOO=1 git status",
		],);
	}

	#[test]
	fn quoted_and_escaped_separators_stay_inside_their_segment() {
		// `;` / `&&` inside quotes or after a backslash are word text, not
		// chain separators; splitting on them would run the wrong commands.
		let segments = chain_of(analyze(r#"echo a\;b && echo "c&&d""#)).expect("expected Chain");
		let texts: Vec<&str> = segments.iter().map(|s| s.command.as_str()).collect();
		assert_eq!(texts, vec![r#"echo a\;b"#, r#"echo "c&&d""#]);
	}

	#[test]
	fn expansion_bodies_stay_inside_their_segment() {
		// Same for `${…}` bodies: `&&` inside an expansion is word text.
		let segments =
			chain_of(analyze("echo ${greeting:-a&&b} && echo done")).expect("expected Chain");
		let texts: Vec<&str> = segments.iter().map(|s| s.command.as_str()).collect();
		assert_eq!(texts, vec!["echo ${greeting:-a&&b}", "echo done"]);
	}

	#[test]
	fn slice_boundaries_keep_non_separator_word_bytes() {
		// bash delimits words only at unquoted blanks (space/tab) and newlines:
		// `\r`, NBSP, and other Unicode whitespace are ordinary word bytes.
		// Slicing must not eat them at segment boundaries (CRLF-authored
		// chains hit this at every line boundary), or the re-run segment is a
		// different command than the one typed.
		let segments = chain_of(analyze("echo a\r && echo b")).expect("expected Chain");
		let texts: Vec<&str> = segments.iter().map(|s| s.command.as_str()).collect();
		assert_eq!(texts, vec!["echo a\r", "echo b"]);
		let segments = chain_of(analyze("echo a && \u{a0}echo b")).expect("expected Chain");
		let texts: Vec<&str> = segments.iter().map(|s| s.command.as_str()).collect();
		assert_eq!(texts, vec!["echo a", "\u{a0}echo b"]);
	}

	#[test]
	fn escaped_boundary_whitespace_stays_in_its_segment() {
		// Escaped blanks and `\`+newline continuations at a boundary are word
		// bytes, not separator gap: stripping them leaves a dangling `\` that
		// fails to re-parse and silently drops the chain out of segmentation.
		let segments = chain_of(analyze(r"echo a\ && echo b")).expect("expected Chain");
		let texts: Vec<&str> = segments.iter().map(|s| s.command.as_str()).collect();
		assert_eq!(texts, vec!["echo a\\ ", "echo b"]);
		let segments = chain_of(analyze("echo a \\\n&& echo b")).expect("expected Chain");
		let texts: Vec<&str> = segments.iter().map(|s| s.command.as_str()).collect();
		assert_eq!(texts, vec!["echo a \\\n", "echo b"]);
		// The same at the very end of the command: a trailing escaped blank
		// must survive the boundary trim.
		let segments = chain_of(analyze("echo a && echo b \\ ")).expect("expected Chain");
		let texts: Vec<&str> = segments.iter().map(|s| s.command.as_str()).collect();
		assert_eq!(texts, vec!["echo a", "echo b \\ "]);
	}

	#[test]
	fn newline_splits_commands_but_not_line_breaks() {
		// A newline after a complete command separates chain items…
		let segments = chain_of(analyze("echo a\necho b")).expect("expected Chain");
		let texts: Vec<&str> = segments.iter().map(|s| s.command.as_str()).collect();
		assert_eq!(texts, vec!["echo a", "echo b"]);
		// …while a newline after `&&` (or its comments) is a line break inside
		// the awaited right-hand side.
		let segments = chain_of(analyze("echo a && # note\n echo b")).expect("expected Chain");
		let texts: Vec<&str> = segments.iter().map(|s| s.command.as_str()).collect();
		assert_eq!(texts, vec!["echo a", "# note\n echo b"]);
	}

	#[test]
	fn chain_segments_reparse_cleanly() {
		// Every command string the chain runner will execute must itself re-parse
		// to a single pipeline — the contract enforced by
		// `segment_reparses_to_same_shape`. A segment whose verbatim slice
		// diverges from the parsed shape is dropped rather than emitted.
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
