//! zsh grammar: zsh's string representation, the zsh lexer
//! and parser behind [`crate::bash::syntax::Features::ZSH`] (ports of zsh 5.9
//! `lex.c`/`parse.c`), and zsh's function text (`text.c`).

mod driver;
mod lex;
mod parse;
mod text;
pub mod tok;
pub mod wordcode;

pub use self::{
	driver::ZshParser,
	lex::{
		CS_ALWAYS, CS_ARRAY, CS_BQUOTE, CS_BRACE, CS_BRACEPAR, CS_CASE, CS_CMDAND, CS_CMDOR,
		CS_CMDSUBST, CS_COND, CS_COUNT, CS_CURSH, CS_DQUOTE, CS_ELIF, CS_ELIFTHEN, CS_ELSE,
		CS_ERRPIPE, CS_FOR, CS_FOREACH, CS_FUNCDEF, CS_HEREDOC, CS_HEREDOCD, CS_IF, CS_IFTHEN,
		CS_MATH, CS_MATHSUBST, CS_PIPE, CS_QUOTE, CS_REPEAT, CS_SELECT, CS_SUBSH, CS_UNTIL, CS_WHILE,
		IN_MATH, LEXFLAGS_ACTIVE, LEXFLAGS_COMMENTS_KEEP, LEXFLAGS_COMMENTS_STRIP, LEXFLAGS_NEWLINE,
		LEXFLAGS_ZLE, T as LexTok, ZleLex, ZleWords, bufferwords, bufferwords_zle, cmdname,
		ctxtlex_ends, ident_end, iident, isident, mb_metacharlenconv, parse_subscript,
		parse_subst_string, parsestr, skipparens, tokstring, zle_curcmd,
	},
	text::{
		body_text, command_text, function_text, function_text_expand, getjobtext, getpermtext,
		herestring_word, list_text, quoted_name, reindent_function, source_body_text,
	},
};
