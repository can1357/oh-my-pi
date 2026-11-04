//! Structural analysis of a shell command using the engine's own parser.
//!
//! The minimizer must not corrupt downstream parsing or stitch together
//! segments that emit interleaved output. This module parses the full
//! command with [`crate::bash::syntax`], the bash 5.3 parser the
//! [`crate::bash`] engine executes from, and classifies it into one of a few
//! shapes the engine can reason about. Segments therefore split exactly where
//! the executing engine splits the command.
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
//!   combined chain as opaque. Each segment's text is the verbatim source span
//!   of its pipeline, redirections included, so quoting and redirect spelling
//!   survive exactly as written.
//! - **Other compound commands are opaque.** `a || b`, background jobs, and
//!   compound shell syntax such as subshells or function definitions are left
//!   unchanged. Here-documents, command/process substitutions and arithmetic
//!   expansions keep a command out of segmentation as well.
//! - **Single simple commands** are safe for the whole-buffer path; the engine
//!   dispatches them through `detect.rs` as before.
//!
//! When the command fails to parse (syntax error, unsupported construct),
//! we return `Unsupported` and the engine passes through.

use crate::bash::syntax::{
	AndOrOp, ArithText, ArrayElem, Assign, AssignValue, Command, CommandKind, Features, ListItem,
	Param, ParamOp, Pipeline, Program, Redir, RedirTarget, Sep, Simple, Span, Subscript, Word,
	WordPart, parse_all,
};

/// One segment of a safe `&&` / `;` chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainSegment {
	/// The segment's pipeline verbatim from the source, redirections included.
	pub command:                   String,
	/// Leading command word of the segment's first stage, as written.
	pub program:                   String,
	/// The segment follows `&&`: it runs only when the previous one succeeded.
	pub run_if_previous_succeeded: bool,
	/// The segment is followed by `&&`, so its failure must not trip `errexit`.
	pub suppress_errexit:          bool,
}

/// Outcome of analyzing a raw command string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandPlan {
	/// Exactly one simple command. `program` is the leading word (without
	/// arguments), verbatim from the source.
	Single {
		/// Leading command word as written.
		program: String,
	},
	/// The command contains at least one `|` pipeline. We intentionally do
	/// NOT identify upstream / downstream programs here — any pipe defeats
	/// safe minimization for this engine.
	Piped,
	/// Top-level simple commands joined by `&&` and/or `;`. These can be
	/// minimized segment-by-segment, but not as one combined buffer.
	Chain {
		/// The segments in execution order.
		segments: Vec<ChainSegment>,
	},
	/// The command has multiple segments joined by `||`, `&`, or other
	/// unsupported shell syntax. This shape is left unchanged; the minimizer
	/// only rewrites whole simple command output.
	Compound,
	/// Parse failed, a compound shell construct (for loops, subshells, etc.)
	/// was encountered, or the command was empty.
	Unsupported,
}

/// Parse `command` with the engine's bash parser and classify its structure.
#[must_use]
pub fn analyze(command: &str) -> CommandPlan {
	if command.trim().is_empty() {
		return CommandPlan::Unsupported;
	}
	let Some(program) = parse(command) else {
		return CommandPlan::Unsupported;
	};
	classify(&program, command)
}

/// Parse `command` as plain bash 5.3 (no aliases, default shell options — the
/// grammar a fresh engine shell runs it with), discarding error detail.
/// Returns `None` on any syntax error.
fn parse(command: &str) -> Option<Program> {
	parse_all(command.as_bytes(), Features::NONE).ok()
}

/// Source text `span` covers in `src`; `None` when it is not valid UTF-8.
fn span_text(src: &str, span: Span) -> Option<&str> {
	std::str::from_utf8(span.slice(src.as_bytes())).ok()
}

/// `&` (or zsh `&|`) backgrounds the item: the parent's stdout is the
/// foreground command's, so we cannot tell which output we capture.
const fn is_async(sep: Sep) -> bool {
	matches!(sep, Sep::Amp | Sep::Disown)
}

fn classify(program: &Program, src: &str) -> CommandPlan {
	// Separator-separated top-level items across all complete commands.
	let items: Vec<&ListItem> = program
		.commands
		.iter()
		.flat_map(|complete| complete.list.items.iter())
		.collect();

	if let Some(chain) = classify_chain(&items, src) {
		return chain;
	}

	let [item] = items.as_slice() else {
		// `a ; b` or `a & b` produces multiple list items.
		return if items.is_empty() {
			CommandPlan::Unsupported
		} else {
			CommandPlan::Compound
		};
	};

	// Conservative bail on a backgrounded command, and on `&&` / `||`
	// continuations that did not form a safe chain.
	if is_async(item.sep) || !item.and_or.rest.is_empty() {
		return CommandPlan::Compound;
	}

	// Only a single pipeline at this point.
	classify_pipeline(&item.and_or.first, src).unwrap_or(CommandPlan::Unsupported)
}

fn classify_chain(items: &[&ListItem], src: &str) -> Option<CommandPlan> {
	let mut segments = Vec::new();

	for item in items {
		if is_async(item.sep) {
			return None;
		}

		let mut run_if_previous_succeeded = false;
		let mut pipeline = &item.and_or.first;
		let mut rest = item.and_or.rest.iter().peekable();

		loop {
			let (command, program) = simple_segment(pipeline, src)?;

			let suppress_errexit = rest.peek().is_some_and(|(op, _)| *op == AndOrOp::And);
			segments.push(ChainSegment {
				command,
				program,
				run_if_previous_succeeded,
				suppress_errexit,
			});

			match rest.next() {
				None => break,
				Some((AndOrOp::And, next_pipeline)) => {
					run_if_previous_succeeded = true;
					pipeline = next_pipeline;
				},
				Some((AndOrOp::Or, _)) => return None,
			}
		}
	}

	(segments.len() >= 2).then_some(CommandPlan::Chain { segments })
}

fn words_are_safe(words: &[Word]) -> bool {
	words.iter().all(word_is_safe)
}

fn word_is_safe(word: &Word) -> bool {
	parts_are_safe(&word.parts)
}

fn parts_are_safe(parts: &[WordPart]) -> bool {
	parts.iter().all(|part| match part {
		WordPart::Lit(_)
		| WordPart::Escaped(_)
		| WordPart::SQuote(_)
		| WordPart::AnsiC(_)
		| WordPart::DroppedQuote => true,
		WordPart::DQuote(inner) | WordPart::Locale(inner) => parts_are_safe(inner),
		WordPart::Param(param) => param_is_safe(param),
		WordPart::Compound(elems) => elems.iter().all(array_elem_is_safe),
		// Command (`$(…)`, backticks, `${ …;}`, `${| …;}`) and process
		// substitutions run commands of their own. Arithmetic text is not
		// parsed into the tree and may hide one. Deferred-error words fail
		// when expanded; zsh words never appear in bash grammar. All stay
		// with the unsegmented whole command.
		WordPart::Comsub(_)
		| WordPart::ProcSub(_)
		| WordPart::Arith(_)
		| WordPart::BadSubst(_)
		| WordPart::BadComsub(_)
		| WordPart::Zsh(_) => false,
	})
}

/// Arithmetic text inside `${x:off:len}` is unparsed; any `$` or backquote in
/// it may be a command substitution, so only expansion-free text is safe.
fn arith_text_is_safe(text: &ArithText) -> bool {
	!text.src.iter().any(|&byte| matches!(byte, b'$' | b'`'))
}

fn param_is_safe(param: &Param) -> bool {
	let index_is_safe = match &param.index {
		Some(Subscript::Expr(word)) => word_is_safe(word),
		Some(Subscript::At | Subscript::Star) | None => true,
	};
	index_is_safe
		&& match &param.op {
			ParamOp::None
			| ParamOp::Length
			| ParamOp::Indirect
			| ParamOp::PrefixNames { .. }
			| ParamOp::Transform(_) => true,
			ParamOp::Default { word, .. }
			| ParamOp::Assign { word, .. }
			| ParamOp::Alt { word, .. }
			| ParamOp::Trim { pat: word, .. } => word_is_safe(word),
			ParamOp::Error { word, .. } | ParamOp::Case { pat: word, .. } => {
				word.as_ref().is_none_or(word_is_safe)
			},
			ParamOp::Substr { offset, len } => {
				arith_text_is_safe(offset) && len.as_ref().is_none_or(arith_text_is_safe)
			},
			ParamOp::Replace { pat, rep, .. } => {
				word_is_safe(pat) && rep.as_ref().is_none_or(word_is_safe)
			},
		}
}

fn array_elem_is_safe(elem: &ArrayElem) -> bool {
	elem.key.as_ref().is_none_or(word_is_safe) && word_is_safe(&elem.value)
}

fn assign_is_safe(assign: &Assign) -> bool {
	assign.index.as_ref().is_none_or(word_is_safe)
		&& match &assign.value {
			AssignValue::Scalar(word) => word_is_safe(word),
			AssignValue::Array(elems) => elems.iter().all(array_elem_is_safe),
		}
}

fn redir_is_safe(redir: &Redir) -> bool {
	match &redir.target {
		RedirTarget::Word(word) => word_is_safe(word),
		// Here-docs are never safe to segment: the document body follows the
		// command's line, outside the pipeline's source span, so a segment
		// sliced from that span would run without its body ("unterminated
		// here document"). Leave any here-doc-bearing command to the
		// unsegmented single path.
		RedirTarget::HereDoc(_) => false,
	}
}

/// The simple command `command` is, when every part of it is safe to run as a
/// standalone segment: no command/process substitution, arithmetic expansion
/// or here-doc in its assignments, words, or redirections.
fn safe_simple(command: &Command) -> Option<&Simple> {
	let CommandKind::Simple(simple) = &command.kind else {
		return None;
	};
	let safe = simple.assigns.iter().all(assign_is_safe)
		&& words_are_safe(&simple.words)
		&& command.redirs.iter().all(redir_is_safe);
	safe.then_some(simple)
}

fn simple_segment(pipeline: &Pipeline, src: &str) -> Option<(String, String)> {
	if pipeline.time.is_some() || pipeline.bang {
		return None;
	}

	// Every stage must be a safe simple command. Compound stages
	// (`if` / `for` / `while` / subshells / `{ … }`) keep the whole chain
	// unsegmented; validating only the first stage once let
	// `git log … | while read x; do … done` through.
	let mut stages = pipeline.stages.iter();
	let first = safe_simple(&stages.next()?.cmd)?;
	if !stages.all(|stage| safe_simple(&stage.cmd).is_some()) {
		return None;
	}

	// Identify the segment by its first stage's program word. Multi-stage pipes
	// are captured but never rewritten (runtime detects `CommandPlan::Piped`),
	// keeping the chain decomposable when an inner stage pipes (e.g.
	// `ls | head -10 && git status`).
	let program = span_text(src, first.words.first()?.span)?;
	if program.trim().is_empty() {
		return None;
	}

	// The chain runner re-executes this text: take it verbatim from the
	// source span (all stages and their redirections) rather than re-printing
	// the tree, so it is exactly what the user wrote.
	let command = span_text(src, pipeline.span)?;
	if command.trim().is_empty() {
		return None;
	}
	Some((command.to_owned(), program.to_owned()))
}

fn classify_pipeline(pipeline: &Pipeline, src: &str) -> Option<CommandPlan> {
	if pipeline.stages.len() > 1 {
		return Some(CommandPlan::Piped);
	}
	match &pipeline.stages.first()?.cmd.kind {
		CommandKind::Simple(simple) => {
			let program = span_text(src, simple.words.first()?.span)?;
			if program.trim().is_empty() {
				return None;
			}
			Some(CommandPlan::Single { program: program.to_owned() })
		},
		// Compound shell syntax (if / for / while / subshell / { ... }) is
		// not something the minimizer should touch.
		CommandKind::Brace(_)
		| CommandKind::Subshell(_)
		| CommandKind::If(_)
		| CommandKind::While(_)
		| CommandKind::For(_)
		| CommandKind::ArithFor(_)
		| CommandKind::Select(_)
		| CommandKind::Case(_)
		| CommandKind::Arith(_)
		| CommandKind::Cond(_)
		| CommandKind::FuncDef(_)
		| CommandKind::Coproc(_)
		| CommandKind::Repeat(_)
		| CommandKind::Try(_)
		| CommandKind::AnonFunc(_) => Some(CommandPlan::Compound),
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
		assert_eq!(segments[0].command, "ls -lh *.txt | head -5");
		assert_eq!(segments[0].program, "ls");
		assert_eq!(segments[1].program, "git");
	}

	#[test]
	fn segment_text_is_verbatim_source() {
		// Segments are sliced from the source, so quoting, spacing inside
		// quotes and redirect spelling survive exactly as written.
		let plan = analyze("echo 'a  b' \"c\"  >/dev/null 2>&1 && FOO=\"x y\" printf '%s\\n' z");
		let segments = chain_of(plan).expect("expected Chain");
		assert_eq!(segments[0].command, "echo 'a  b' \"c\"  >/dev/null 2>&1");
		assert_eq!(segments[0].program, "echo");
		assert_eq!(segments[1].command, "FOO=\"x y\" printf '%s\\n' z");
		assert_eq!(segments[1].program, "printf");
	}

	#[test]
	fn rejects_unsafe_chain_segments() {
		for command in [
			"echo $(pwd) ; git status",
			"echo `pwd` ; git status",
			"echo \"$(pwd)\" ; git status",
			"echo ${x:-$(pwd)} ; git status",
			"echo ${ pwd;} ; git status",
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
		// split. The document body lies outside the segment's source span, so
		// re-running the segment alone fails with "unterminated here
		// document". Both quoted and unquoted delimiters bail so the whole
		// command runs whole.
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
		// (`while`/`for`/`if`/subshell) must never be segmented. Validating only
		// the first stage (a simple `git`/`seq`) once let it slip through and
		// the re-run segment failed with "syntax error at end of input".
		assert_not_chain(
			"echo start && git log --oneline | while read h; do echo \"$h\"; done | head -3",
		);
		assert_not_chain("seq 3 | while read n; do echo \"$n\"; done && echo done");
		assert_not_chain("printf x && ls | for f in a b; do echo $f; done");
		// The reported shape classifies as Compound, so it runs whole and
		// unsegmented via the single path (no minimization).
		assert_eq!(
			analyze("echo a && seq 2 | while read n; do echo $n; done"),
			CommandPlan::Compound,
		);
	}

	#[test]
	fn chain_segments_reparse_cleanly() {
		// Every command string the chain runner will execute must itself parse
		// to exactly one pipeline with no `&&`/`||`/`;`/`&` continuation.
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
				let program = parse(&segment.command).unwrap_or_else(|| {
					panic!("segment {:?} from {command:?} did not re-parse", segment.command)
				});
				let items: Vec<&ListItem> = program
					.commands
					.iter()
					.flat_map(|complete| complete.list.items.iter())
					.collect();
				let single_pipeline = matches!(
					items.as_slice(),
					[item] if item.and_or.rest.is_empty() && !is_async(item.sep)
				);
				assert!(
					single_pipeline,
					"segment {:?} from {command:?} re-parsed to a different shape",
					segment.command,
				);
			}
		}
	}
}
