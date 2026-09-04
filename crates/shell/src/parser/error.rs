use crate::parser::{SourcePosition, Token, tokenizer};

/// Represents an error that occurred while parsing tokens.
#[derive(thiserror::Error, Debug)]
pub enum ParseError {
	/// A parsing error occurred near the given position.
	#[error("syntax error at line {} col {}", .0.line, .0.column)]
	ParsingNear(SourcePosition),

	/// A parsing error occurred at the end of the input.
	#[error("syntax error at end of input")]
	ParsingAtEndOfInput,

	/// An error occurred while tokenizing the input stream.
	#[error("{} (detected near {})", .inner, .position.as_ref().map_or_else(|| String::from("<unknown position>"), |p| std::format!("line {} col {}", p.line, p.column)))]
	Tokenizing {
		/// The inner error.
		inner:    tokenizer::TokenizerError,
		/// Optionally provides the position of the error.
		position: Option<SourcePosition>,
	},
}

/// Represents a parsing error with its location information
#[derive(Debug, thiserror::Error)]
#[error(transparent)]
pub struct ParseErrorLocation {
	#[from]
	inner: peg::error::ParseError<peg::str::LineCol>,
}

/// Represents an error that occurred while parsing a word.
#[derive(Debug, thiserror::Error)]
pub enum WordParseError {
	/// A numeric literal used by word syntax exceeds its supported range.
	#[error("{0} out of range")]
	NumericLiteralOutOfRange(&'static str),

	/// An error occurred while parsing an arithmetic expression.
	#[error("failed to parse arithmetic expression")]
	ArithmeticExpression(ParseErrorLocation),

	/// An error occurred while parsing a shell pattern.
	#[error("failed to parse pattern")]
	Pattern(ParseErrorLocation),

	/// An error occurred while parsing a prompt string.
	#[error("failed to parse prompt string")]
	Prompt(ParseErrorLocation),

	/// An error occurred while parsing a parameter.
	#[error("failed to parse parameter '{0}'")]
	Parameter(String, ParseErrorLocation),

	/// An error occurred while parsing for brace expansion.
	#[error("failed to parse for brace expansion: '{0}'")]
	BraceExpansion(String, ParseErrorLocation),

	/// An error occurred while parsing a word.
	#[error("failed to parse word '{0}'")]
	Word(String, ParseErrorLocation),
}

/// Represents an error that occurred while parsing a (non-extended) test
/// command.
#[derive(Debug, thiserror::Error)]
#[error(transparent)]
pub struct TestCommandParseError(#[from] peg::error::ParseError<usize>);
/// Error produced while parsing a readline key-binding specification.
#[derive(Debug, thiserror::Error)]
pub enum BindingParseError {
	/// The binding could not be parsed.
	#[error("unknown error while parsing key-binding: '{0}'")]
	Unknown(String),

	/// A key code was missing from the binding.
	#[error("missing key code in binding")]
	MissingKeyCode,
}

pub(crate) fn convert_peg_parse_error(
	err: &peg::error::ParseError<usize>,
	tokens: &[Token],
) -> ParseError {
	let approx_token_index = err.location;

	if approx_token_index < tokens.len() {
		let token = &tokens[approx_token_index];
		ParseError::ParsingNear((*token.location().start).clone())
	} else {
		ParseError::ParsingAtEndOfInput
	}
}
