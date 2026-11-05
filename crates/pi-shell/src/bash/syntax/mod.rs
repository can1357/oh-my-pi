//! bash 5.3 syntax: lexer, incremental parser, AST, printer and JSON export.
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
//! use pi_shell::bash::syntax::{CommandKind, Features, parse_all};
//!
//! let prog = parse_all(b"for i in 1 2; do echo $i; done\n", Features::NONE).unwrap();
//! let cmd = &prog.commands[0].list.items[0].and_or.first.stages[0].cmd;
//! assert!(matches!(cmd.kind, CommandKind::For(_)));
//! ```

#![forbid(unsafe_code)]

mod ast;
mod features;
mod json;
mod parser;
mod print;
mod span;
mod util;
pub mod zsh;

use alloc::vec::Vec;

pub(crate) use crate::bash::syntax::util::ansi_decode_all;
pub use crate::bash::syntax::{
	ast::*,
	features::{AliasLookup, Features, NO_ALIASES, NoAliases},
	json::to_json,
	parser::{ParseError, ParseErrorKind, Parser, Resume, TextMode, parse_text},
	print::{PrintStyle, command_string, print, print_list},
	span::{NodeId, Pos, Span},
};

/// Parse a whole source without aliases (tools, visualizers, tests).
///
/// Stops at the first syntax error, as a non-interactive bash does.
pub fn parse_all(src: &[u8], feat: Features) -> Result<Program, ParseError> {
	let mut parser = Parser::new(src, feat, NO_ALIASES);
	let mut commands = Vec::new();
	while let Some(cmd) = parser.next_command() {
		commands.push(cmd?);
	}
	Ok(Program { commands })
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
