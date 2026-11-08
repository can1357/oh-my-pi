//! Generate arbitrary instances of central lexer types.
//!
//! This is useful for fuzzing the parser.
//!
//! This code can generate any tokens that might ever be output by the lexer.
//! However, it also outputs many tokens that would never be output by the lexer.
//! It is hard to avoid this because we cannot construct
//! specific values of type `&str` at runtime other than by `arbitrary()`,
//! which does not allow us to provide side conditions for the generated strings.
//! For example, we cannot generate random `&str`s that can be parsed to numbers.
//! (If we would use `String`, then this would be no problem.
//! But `String` cannot encode the position of tokens, unlike `&str`.)
//!
//! We are aiming at creating tokens that satisfy just enough constraints
//! such that the parser and the compiler do not panic.

use super::lex::{StrPart, Tok, Token};
use arbitrary::{Arbitrary, Result, Unstructured};

impl<'a> Arbitrary<'a> for StrPart<&'a str, Token<&'a str>> {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        match u.choose_index(3)? {
            0 => Ok(StrPart::Str(u.arbitrary()?)),
            1 => Ok(StrPart::Term(Token("(", Tok::Block(u.arbitrary()?)))),
            _ => Ok(StrPart::Char(u.arbitrary()?)),
        }
    }
}

impl<'a> Arbitrary<'a> for Token<&'a str> {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        let s: &str = u.arbitrary::<&str>()?.trim();
        let mut chars = s.chars();
        let tok = match chars.next() {
            Some('a'..='z' | 'A'..='Z' | '_') => Tok::Word,
            Some('$') => Tok::Var,
            Some('0'..='9') => Tok::Num,
            Some('-') if matches!(chars.next(), Some('0'..='9')) => Tok::Num,
            Some('"') => Tok::Str(u.arbitrary()?),
            Some('(' | '[' | '{') => Tok::Block(u.arbitrary()?),
            Some(_) => Tok::Sym,
            None => u.choose_iter([Tok::Word, Tok::Num])?,
        };
        Ok(Self(s, tok))
    }
}
