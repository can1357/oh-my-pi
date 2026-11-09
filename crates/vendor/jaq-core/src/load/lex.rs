//! Lexing.

use alloc::vec::Vec;

/// Component of a string potentially containing escape sequences.
///
/// `S` is a type of strings (without escape sequences), and
/// `F` is a type of interpolated filters.
#[derive(Clone, Debug)]
pub enum StrPart<S, T> {
    /// string without escape sequences
    Str(S),
    /// interpolated term (`\(...)`)
    ///
    /// Here, the contained term `T` must be of the shape
    /// `Token(s, Tok::Block(...))` such that the first character of `s` is '('.
    Term(T),
    /// escaped character (e.g. `\n`, `t`, `\u0041`)
    Char(char),
}

/// Token (tree) generic over string type `S`.
///
/// If the contained `Tok` is of the shape:
/// * `Tok::Block(...)`, then `S` must start with `'('`, `'['`, or `'{'`.
/// * `Tok::Var`, then `S` must start with `'$'`.
#[derive(Debug)]
pub struct Token<S>(pub S, pub Tok<S>);

/// Type of token, generic over string type `S`.
///
/// This data structure should normally not be constructed manually.
/// It is exposed mostly for fuzzing.
#[derive(Debug)]
pub enum Tok<S> {
    /// keywords such as `def`, but also identifiers such as `map`, `f::g`
    Word,
    /// variables such as `$x`
    Var,
    /// formatters such as `@csv`
    Fmt,
    /// number
    Num,
    /// (interpolated) string, surrounded by opening and closing '"'
    Str(Vec<StrPart<S, Token<S>>>),
    /// symbol such as `.`, `;`, `-`, `|`, or `+=`
    Sym,
    /// delimited tokens, e.g. `(...)` or `[...]`
    Block(Vec<Token<S>>),
}

/// Type of character that we expected.
///
/// Each variant is annoted with jq programs that trigger it.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub enum Expect<S> {
    /// `0e`, `0.`
    Digit,
    /// `$`, `@`
    Ident,
    /// `(`, `[`, `{`
    Delim(S),
    /// `"\a"`
    Escape,
    /// `"\ux"`, `"\uD800"`
    Unicode,
    /// `&`, `§`, `💣`
    Token,
}

impl Expect<&str> {
    /// Return human-readable description of what we expected.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Digit => "digit",
            Self::Ident => "identifier",
            Self::Delim("(") => "closing parenthesis",
            Self::Delim("[") => "closing bracket",
            Self::Delim("{") => "closing brace",
            Self::Delim("\"") => "closing quote",
            Self::Delim(_) => panic!(),
            Self::Escape => "string escape sequence",
            Self::Unicode => "4-digit hexadecimal UTF-8 code point",
            Self::Token => "token",
        }
    }
}

/// Lexer error, storing what we expected and what we got instead.
pub type Error<S> = (Expect<S>, S);

/// Lexer for jq files.
pub struct Lexer<S> {
    i: S,
    e: Vec<Error<S>>,
}

impl<'a> Lexer<&'a str> {
    /// Initialise a new lexer for the given input.
    #[must_use]
    pub fn new(i: &'a str) -> Self {
        let e = Vec::new();
        Self { i, e }
    }

    /// Lex, returning the resulting tokens and errors.
    pub fn lex(mut self) -> Result<Vec<Token<&'a str>>, Vec<Error<&'a str>>> {
        let tokens = self.tokens();
        self.space();
        if !self.i.is_empty() {
            self.e.push((Expect::Token, self.i));
        }

        if self.e.is_empty() {
            Ok(tokens)
        } else {
            Err(self.e)
        }
    }

    fn next(&mut self) -> Option<char> {
        let mut chars = self.i.chars();
        let c = chars.next()?;
        self.i = chars.as_str();
        Some(c)
    }

    fn take(&mut self, len: usize) -> &'a str {
        let (head, tail) = self.i.split_at(len);
        self.i = tail;
        head
    }

    fn trim(&mut self, f: impl FnMut(char) -> bool) {
        self.i = self.i.trim_start_matches(f);
    }

    fn consumed(&mut self, skip: usize, f: impl FnOnce(&mut Self)) -> &'a str {
        self.with_consumed(|l| {
            l.i = &l.i[skip..];
            f(l);
        })
        .0
    }

    fn with_consumed<T>(&mut self, f: impl FnOnce(&mut Self) -> T) -> (&'a str, T) {
        let start = self.i;
        let y = f(self);
        (&start[..start.len() - self.i.len()], y)
    }

    /// Whitespace and comments.
    fn space(&mut self) {
        loop {
            self.i = self.i.trim_start();
            match self.i.strip_prefix('#') {
                Some(comment) => self.i = comment,
                None => break,
            }
            // ignore all lines that end with an odd number of backslashes
            loop {
                let (before, after) = self.i.split_once('\n').unwrap_or((self.i, ""));
                let before = before.strip_suffix('\r').unwrap_or(before);
                self.i = after;
                // does the line end with an even number of backslashes?
                if before.chars().rev().take_while(|c| *c == '\\').count() % 2 == 0 {
                    break;
                }
            }
        }
    }

    fn mod_then_ident(&mut self) {
        self.ident0();
        if let Some(rest) = self.i.strip_prefix("::") {
            self.i = rest.strip_prefix(['@', '$']).unwrap_or(rest);
            self.ident1();
        }
    }

    /// Lex a sequence matching `[a-zA-Z0-9_]*`.
    fn ident0(&mut self) {
        self.trim(|c: char| c.is_ascii_alphanumeric() || c == '_');
    }

    /// Lex a sequence matching `[a-zA-Z_][a-zA-Z0-9_]*`.
    fn ident1(&mut self) {
        let first = |c: char| c.is_ascii_alphabetic() || c == '_';
        if let Some(rest) = self.i.strip_prefix(first) {
            self.i = rest;
            self.ident0();
        } else {
            self.e.push((Expect::Ident, self.i));
        }
    }

    /// Lex a non-empty digit sequence.
    fn digits1(&mut self) {
        if let Some(rest) = self.i.strip_prefix(|c: char| c.is_ascii_digit()) {
            self.i = rest.trim_start_matches(|c: char| c.is_ascii_digit());
        } else {
            self.e.push((Expect::Digit, self.i));
        }
    }

    /// Decimal with optional exponent.
    fn num(&mut self) {
        self.trim(|c| c.is_ascii_digit());
        if let Some(i) = self.i.strip_prefix('.') {
            self.i = i;
            self.digits1();
        }
        if let Some(i) = self.i.strip_prefix(['e', 'E']) {
            self.i = i.strip_prefix(['+', '-']).unwrap_or(i);
            self.digits1();
        }
    }

    fn escape(&mut self) -> Option<StrPart<&'a str, Token<&'a str>>> {
        let mut chars = self.i.chars();
        let part = match chars.next() {
            Some(c @ ('\\' | '/' | '"')) => StrPart::Char(c),
            Some('b') => StrPart::Char('\x08'),
            Some('f') => StrPart::Char('\x0C'),
            Some('n') => StrPart::Char('\n'),
            Some('r') => StrPart::Char('\r'),
            Some('t') => StrPart::Char('\t'),
            Some('u') => {
                let err_at = |lex: &mut Self, pos| {
                    lex.i = pos;
                    lex.e.push((Expect::Unicode, lex.i));
                    None
                };
                let mut hex = 0;
                let start_i = chars.as_str();
                for _ in 0..4 {
                    let cur_i = chars.as_str();
                    if let Some(digit) = chars.next().and_then(|c| c.to_digit(16)) {
                        hex = (hex << 4) + digit;
                    } else {
                        return err_at(self, cur_i);
                    }
                }
                match char::from_u32(hex) {
                    None => return err_at(self, start_i),
                    Some(c) => StrPart::Char(c),
                }
            }
            Some('(') => {
                let (full, block) = self.with_consumed(Self::block);
                return Some(StrPart::Term(Token(full, block)));
            }
            Some(_) | None => {
                self.e.push((Expect::Escape, self.i));
                return None;
            }
        };

        self.i = chars.as_str();
        Some(part)
    }

    /// Lex a (possibly interpolated) string.
    ///
    /// The input string has to start with '"'.
    fn str(&mut self) -> Tok<&'a str> {
        let start = self.take(1);
        assert_eq!(start, "\"");
        let mut parts = Vec::new();

        loop {
            let s = self.consumed(0, |lex| lex.trim(|c| c != '\\' && c != '"'));
            if !s.is_empty() {
                parts.push(StrPart::Str(s));
            }
            match self.next() {
                Some('"') => break,
                Some('\\') => self.escape().map(|part| parts.push(part)),
                // SAFETY: due to `lex.trim()`
                Some(_) => unreachable!(),
                None => {
                    self.e.push((Expect::Delim(start), self.i));
                    break;
                }
            };
        }
        Tok::Str(parts)
    }

    fn token(&mut self) -> Option<Token<&'a str>> {
        self.space();

        let hd_op = |c| "|=!<>+-*/%".contains(c);
        let tl_op = |c| hd_op(c) && c != '-';

        let mut chars = self.i.chars();
        let (s, tok) = match chars.next()? {
            'a'..='z' | 'A'..='Z' | '_' => (self.consumed(1, Self::mod_then_ident), Tok::Word),
            '$' => (self.consumed(1, Self::ident1), Tok::Var),
            '@' => (self.consumed(1, Self::ident1), Tok::Fmt),
            '0'..='9' => (self.consumed(1, Self::num), Tok::Num),
            c if hd_op(c) => (self.consumed(1, |lex| lex.trim(tl_op)), Tok::Sym),
            '.' => match chars.next() {
                Some('.') => (self.take(2), Tok::Sym),
                Some('a'..='z' | 'A'..='Z' | '_') => (self.consumed(2, Self::ident0), Tok::Sym),
                _ => (self.take(1), Tok::Sym),
            },
            ':' | ';' | ',' | '?' => (self.take(1), Tok::Sym),
            '"' => self.with_consumed(Self::str),
            '(' | '[' | '{' => self.with_consumed(Self::block),
            _ => return None,
        };
        Some(Token(s, tok))
    }

    fn tokens(&mut self) -> Vec<Token<&'a str>> {
        core::iter::from_fn(|| self.token()).collect()
    }

    /// Lex a sequence of tokens that is surrounded by parentheses, curly braces, or brackets.
    ///
    /// The input string has to start with either '(', '[', or '{'.
    fn block(&mut self) -> Tok<&'a str> {
        let open = self.take(1);
        let close = match open {
            "(" => ')',
            "[" => ']',
            "{" => '}',
            _ => panic!(),
        };
        let mut tokens = self.tokens();

        self.space();
        if let Some(rest) = self.i.strip_prefix(close) {
            tokens.push(Token(&self.i[..1], Tok::Sym));
            self.i = rest;
        } else {
            self.e.push((Expect::Delim(open), self.i));
        }
        Tok::Block(tokens)
    }
}

impl<'a> Token<&'a str> {
    /// Return the string slice corresponding to an optional token.
    ///
    /// If the token is not present, return an empty string slice starting at the end of `code`.
    pub fn opt_as_str(found: Option<&Self>, code: &'a str) -> &'a str {
        found.map_or(&code[code.len()..], |found| found.as_str())
    }

    /// Return the string slice corresponding to the token.
    pub fn as_str(&self) -> &'a str {
        self.0
    }
}
