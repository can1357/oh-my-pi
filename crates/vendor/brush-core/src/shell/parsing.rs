//! Parsing for shell instances.

use std::io::Read;

use crate::{Shell, extensions, trace_categories};

impl<SE: extensions::ShellExtensions> Shell<SE> {
	/// Parses the given reader as a shell program, returning the resulting
	/// Abstract Syntax Tree for the program.
	pub fn parse<R: Read>(
		&self,
		reader: R,
	) -> Result<brush_parser::ast::Program, brush_parser::ParseError> {
		let mut parser = create_parser(reader, &self.parser_options());

		tracing::debug!(target: trace_categories::PARSE, "Parsing reader as program...");
		parser.parse_program()
	}

	/// Parses the given string as a shell program, returning the resulting
	/// Abstract Syntax Tree for the program.
	///
	/// # Arguments
	///
	/// * `s` - The string to parse as a program.
	pub fn parse_string<S: Into<String>>(
		&self,
		s: S,
	) -> Result<brush_parser::ast::Program, brush_parser::ParseError> {
		parse_string_impl(s.into(), self.parser_options())
	}

	/// [`Self::parse_string`] off the runtime's worker when the program is
	/// longer than one step of work.
	///
	/// The parse is one call into the tokenizer and the grammar with nothing
	/// inside that can yield, and its cache copies and hashes the whole text
	/// for its key: a command substitution of 16 MiB in a prompt held the
	/// worker 142 ms, 394 ms under load, parsing its body. A program within a
	/// stride is parsed where it is, with the cache, which is every program a
	/// person writes; a longer one is parsed on a blocking worker without the
	/// cache, unless this is one already (see
	/// [`crate::commands::builtin_on_blocking_worker`]).
	///
	/// # Errors
	///
	/// Returns the parse's own error in the inner result, and
	/// [`crate::error::ErrorKind::ThreadingError`] if the blocking worker's
	/// parse did not come back.
	pub(crate) async fn parse_string_off_worker(
		&self,
		s: String,
	) -> Result<Result<brush_parser::ast::Program, brush_parser::ParseError>, crate::error::Error> {
		if s.len() <= crate::interp::DIVIDE_COPY_ABOVE_BYTES
			|| crate::commands::builtin_on_blocking_worker()
		{
			return Ok(self.parse_string(s));
		}
		let options = self.parser_options();
		match tokio::task::spawn_blocking(move || parse_string_uncached(&s, &options)).await {
			Ok(parsed) => Ok(parsed),
			Err(join_error) if join_error.is_panic() => std::panic::resume_unwind(join_error.into_panic()),
			Err(join_error) => Err(crate::error::ErrorKind::ThreadingError(join_error).into()),
		}
	}

	/// Returns the options that should be used for parsing shell programs;
	/// reflects the current configuration state of the shell and may change
	/// over time.
	pub const fn parser_options(&self) -> brush_parser::ParserOptions {
		brush_parser::ParserOptions {
			enable_extended_globbing: self.options.extended_globbing,
			posix_mode: self.options.posix_mode,
			sh_mode: self.options.sh_mode,
			tilde_expansion_at_word_start: true,
			tilde_expansion_after_colon: false,
			parser_impl: self.parser_impl,
		}
	}
}

#[cached::proc_macro::cached(size = 64, result = true)]
fn parse_string_impl(
	s: String,
	parser_options: brush_parser::ParserOptions,
) -> Result<brush_parser::ast::Program, brush_parser::ParseError> {
	parse_string_uncached(&s, &parser_options)
}

fn parse_string_uncached(
	s: &str,
	parser_options: &brush_parser::ParserOptions,
) -> Result<brush_parser::ast::Program, brush_parser::ParseError> {
	let mut parser = create_parser(s.as_bytes(), parser_options);

	tracing::debug!(target: trace_categories::PARSE, "Parsing string as program...");
	parser.parse_program()
}

pub(super) fn create_parser<R: Read>(
	r: R,
	parser_options: &brush_parser::ParserOptions,
) -> brush_parser::Parser<std::io::BufReader<R>> {
	let reader = std::io::BufReader::new(r);
	brush_parser::Parser::new(reader, parser_options)
}
