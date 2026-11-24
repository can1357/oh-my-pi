//! bash 5.3 syntax: lexer, incremental parser, syntax tree, printer and JSON
//! export.
//!
//! Shared by the engine ([`crate::bash`]), which parses and compiles one
//! top-level command at a time, and by clients that visualize a running
//! script: a client re-parses the bytes of a `UnitCompiled` event with the
//! same [`Features`] and alias substitutions and gets the same [`NodeId`]s
//! the engine reports in its events.
//!
//! # Node ids
//!
//! Within one [`CompleteCommand`], ids are a preorder numbering from 0 over
//! the and-or lists, pipelines, commands, assignments and words, visiting
//! fields in source order: a command's contents come before its
//! redirections, a simple command lists its assignments before its words,
//! and a word's id comes before everything nested in it (`${…}` operator
//! words, command and process substitution bodies, compound-array elements).
//! Here-document bodies and arithmetic text are not numbered (the engine
//! parses them with [`parse_text`] when it expands them, and ids in such a
//! word start at 0). Ids depend only on the bytes, the [`Features`] and the
//! alias substitutions ([`CompleteCommand::aliases`]).
//!
//! The crate is `no_std` + `alloc`, builds for `wasm32-unknown-unknown`, and
//! contains no `unsafe`.
//!
//! # Example
//!
//! ```
//! use omp_shell::bash::syntax::{CommandKind, Features, parse_all};
//!
//! let prog = parse_all(b"for i in 1 2; do echo $i; done\n", Features::NONE).unwrap();
//! let list = prog.commands[0].list();
//! let cmd = list
//! 	.items()
//! 	.first()
//! 	.unwrap()
//! 	.and_or()
//! 	.first()
//! 	.stages()
//! 	.first()
//! 	.unwrap();
//! assert!(matches!(cmd.kind(), CommandKind::For(_)));
//! ```

#![forbid(unsafe_code)]

mod ast;
mod features;
mod json;
mod parser;
mod print;
mod span;
pub mod tree;
mod util;
pub mod zsh;

use alloc::vec::Vec;

pub use crate::bash::syntax::{
	ast::*,
	features::{AliasLookup, Features, NO_ALIASES, NoAliases},
	json::to_json,
	parser::{ParseError, ParseErrorKind, Parser, Resume, TextMode, parse_text},
	print::{PrintStyle, command_string, print, print_function_as, print_list},
	span::{NodeId, Pos, Span},
	tree::{
		AndOr, ArithText, ArrayElem, Assign, AssignValue, Command, CommandKind, Cond, CondExpr,
		HereDoc, List, ListItem, Param, ParamName, ParamOp, Part, Pipeline, Redir, RedirFd,
		RedirTarget, Seq, Simple, Subscript, Tree, Word, WordPart,
	},
};
pub(crate) use crate::bash::syntax::{
	parser::{MAX_NESTING, RESERVED_WORDS},
	util::ansi_decode_all,
};

/// Parse a whole source without aliases (tools, visualizers, tests).
///
/// Stops at the first syntax error, as a non-interactive bash does.
pub fn parse_all(src: &[u8], feat: Features) -> Result<Program, ParseError> {
	let mut parser = Parser::new(src, feat, NO_ALIASES);
	let mut commands = Vec::new();
	while let Some(cmd) = parser.next_command() {
		let mut cmd = cmd?;
		cmd.tree.shrink_to_fit();
		commands.push(cmd);
	}
	Ok(Program { commands })
}

/// Drop each line continuation after `&&`, `||`, `|` or `|&` on a line whose
/// here-document body has not started.
///
/// `cmd <<EOF && \` continues the line, so bash reads the body only after the
/// next line, which runs as a command. Without the `\` the body starts on the
/// next line and the operator still chains the command after the delimiter.
/// `None` when nothing needs repair or the repaired source does not parse
/// (`cat <<EOF | \`, then `jq .`, the body and the delimiter as the last line).
///
/// # Example
///
/// ```
/// use omp_shell::bash::syntax::repair_heredoc_continuations;
///
/// let src = b"git commit -F - <<'EOF' && \\\nfix(js): x\nEOF\ngit push\n";
/// let fixed = repair_heredoc_continuations(src).unwrap();
/// assert_eq!(fixed, b"git commit -F - <<'EOF' && \nfix(js): x\nEOF\ngit push\n");
/// ```
pub fn repair_heredoc_continuations(src: &[u8]) -> Option<Vec<u8>> {
	let has = |pair: &[u8; 2]| src.array_windows().any(|w| w == pair);
	if !has(b"<<") || !has(b"\\\n") {
		return None;
	}
	// One repair per parse: a misread body desynchronizes the rest.
	let mut fixed: Option<Vec<u8>> = None;
	loop {
		let cur = fixed.as_deref().unwrap_or(src);
		let mut parser = Parser::new(cur, Features::NONE, NO_ALIASES);
		let mut valid = true;
		while let Some(cmd) = parser.next_command() {
			valid &= cmd.is_ok();
		}
		let Some(at) = parser.doc_line_cont() else {
			return fixed.filter(|_| valid);
		};
		let mut next = cur.to_vec();
		next.remove(at as usize);
		fixed = Some(next);
	}
}

/// JSON schema of [`to_json`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum JsonDialect {
	/// This crate's own node shapes, with node ids (documented on
	/// [`to_json`]'s module).
	Native,
	/// The shfmt `syntax` JSON shape consumed by bash-viz.
	Shfmt,
}

/// Unit of the offsets written by [`to_json`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Offsets {
	/// Byte offsets.
	Bytes,
	/// UTF-16 code-unit offsets (JavaScript string indices).
	Utf16,
}

#[cfg(test)]
mod suites;
