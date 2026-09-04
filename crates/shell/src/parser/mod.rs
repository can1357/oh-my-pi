//! Implements a tokenizer and parsers for POSIX / bash shell syntax.

#![allow(
	clippy::unwrap_used,
	reason = "parser diagnostics retain source locations during recovery"
)]

use std::str::FromStr;

pub mod arithmetic;
pub mod ast;
pub mod pattern;
pub mod prompt;
pub mod readline_binding;
pub mod test_command;
pub mod word;

mod error;
mod program;
mod source;
mod tokenizer;

pub use error::{
	BindingParseError, ParseError, ParseErrorLocation, TestCommandParseError, WordParseError,
};
pub use program::{Parser, ParserBuilder, ParserImpl, ParserOptions, SourceInfo, parse_tokens};
pub use source::{SourcePosition, SourcePositionOffset, SourceSpan};
pub use tokenizer::{
	FlatShellCommandSegment, Token, TokenLocation, TokenizerError, TokenizerOptions,
	flat_shell_segments, tokenize_str, tokenize_str_with_options, uncached_tokenize_str,
	unquote_str,
};

#[cfg(test)]
mod test_result {
	use std::{error, result};

	/// Result type for parser tests that propagate heterogeneous errors.
	pub(crate) type TestResult<T, E = Box<dyn error::Error>> = result::Result<T, E>;
}

#[cfg(test)]
pub(crate) use test_result::TestResult;

fn parse_bounded_number<T: FromStr>(value: &str, context: &'static str) -> Result<T, &'static str> {
	value.parse().map_err(|_| context)
}
