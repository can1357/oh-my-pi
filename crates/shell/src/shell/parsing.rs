//! Parsing for shell instances.

use std::{io, io::Read};

use crate::{
	Shell, extensions,
	parser::{ParseError, Parser, ParserOptions, ast::Program},
};

impl<SE: extensions::ShellExtensions> Shell<SE> {
	/// Parses the given reader as a shell program, returning the resulting
	/// Abstract Syntax Tree for the program.
	#[tracing::instrument(name = "shell_parse", level = "debug", skip_all)]
	pub fn parse<R: Read>(&self, reader: R) -> Result<Program, ParseError> {
		let mut parser = create_parser(reader, &self.parser_options());
		parser.parse_program()
	}

	/// Parses the given string as a shell program, returning the resulting
	/// Abstract Syntax Tree for the program.
	///
	/// # Arguments
	///
	/// * `s` - The string to parse as a program.
	#[tracing::instrument(name = "shell_parse", level = "debug", skip_all)]
	pub fn parse_string<S: Into<String>>(&self, s: S) -> Result<Program, ParseError> {
		parse_string_impl(s.into(), self.parser_options())
	}

	/// Returns the options that should be used for parsing shell programs;
	/// reflects the current configuration state of the shell and may change
	/// over time.
	pub const fn parser_options(&self) -> ParserOptions {
		ParserOptions {
			enable_extended_globbing: self.options.extended_globbing,
			posix_mode: self.options.posix_mode,
			sh_mode: self.options.sh_mode,
			tilde_expansion_at_word_start: true,
			tilde_expansion_after_colon: false,
			parser_impl: self.parser_impl,
		}
	}
}

#[omp_macros::cached(size = 64, result = true)]
fn parse_string_impl(s: String, parser_options: ParserOptions) -> Result<Program, ParseError> {
	let mut parser = create_parser(s.as_bytes(), &parser_options);
	parser.parse_program()
}

pub(super) fn create_parser<R: Read>(
	r: R,
	parser_options: &ParserOptions,
) -> Parser<io::BufReader<R>> {
	let reader = io::BufReader::new(r);
	Parser::new(reader, parser_options)
}
