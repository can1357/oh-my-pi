//! zsh grammar: zsh's string representation, the zsh lexer
//! and parser behind [`crate::bash::syntax::Features::ZSH`] (ports of zsh 5.9
//! `lex.c`/`parse.c`), and zsh's function text (`text.c`).

mod driver;
mod lex;
mod parse;
mod text;
pub mod tok;

pub use self::{
	driver::ZshParser,
	lex::{
		LEXFLAGS_ACTIVE, LEXFLAGS_COMMENTS_KEEP, LEXFLAGS_COMMENTS_STRIP, LEXFLAGS_NEWLINE,
		bufferwords, ident_end, iident, isident, parse_subscript, parse_subst_string, parsestr,
		skipparens,
	},
	text::{
		body_text, command_text, function_text, function_text_expand, getpermtext, reindent_function,
	},
};
