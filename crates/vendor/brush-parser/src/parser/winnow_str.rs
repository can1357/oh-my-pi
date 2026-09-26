//! String-based winnow parser

use winnow::error::ContextError;

use crate::ast;
use crate::parser::{ParserOptions, SourceInfo};

/// Type alias for parser error
type PError = winnow::error::ErrMode<ContextError>;

/// Parse a shell program from a string with full source location tracking
///
/// This is not yet implemented.
pub fn parse_program(
    _input: &str,
    _options: &ParserOptions,
    _source_info: &SourceInfo,
) -> Result<ast::Program, PError> {
    unimplemented!("winnow string parser is not yet implemented")
}
