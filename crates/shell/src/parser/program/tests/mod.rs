//! Snapshot tests for the PEG parser implementation.

mod and_or_lists;
mod assignments;
mod complex;
mod compound_commands;
mod extended_test;
mod functions;
mod here_docs;
mod pipelines;
mod redirections;
mod simple_commands;

use std::io;

use crate::parser::{
	ast::Program,
	error::ParseError,
	program::{Parser, ParserOptions},
};

#[derive(serde::Serialize)]
struct ParseResult<'a, T> {
	input:  &'a str,
	result: &'a T,
}

/// Asserts a RON snapshot after redacting source locations.
#[macro_export]
macro_rules! assert_snapshot_redacted {
	($value:expr) => {{
		let mut settings = insta::Settings::clone_current();
		settings.add_redaction(".**.loc", "[location]");
		settings.bind(|| {
			insta::assert_ron_snapshot!($value);
		});
	}};
}

fn test_with_snapshot(input: &str) -> Result<Program, ParseError> {
	let mut parser = Parser::new(io::Cursor::new(input), &ParserOptions::default());
	parser.parse_program()
}
