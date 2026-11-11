//! Lexing, as jq's flex scanner (`src/lexer.l`) does it.
//!
//! Tokens are produced on demand by the parser, like `yylex`, because
//! errors in string escapes are reported between syntax errors.

use alloc::{string::String, vec::Vec};

/// Component of a string potentially containing escape sequences.
///
/// `S` is a type of strings (without escape sequences), and
/// `T` is a type of interpolated filters.
#[derive(Clone, Debug)]
pub enum StrPart<S, T> {
    /// string without escape sequences
    Str(S),
    /// interpolated term (`\(...)`)
    Term(T),
    /// escaped character (e.g. `\n`, `t`, `\u0041`)
    Char(char),
}

/// Bison symbol numbers of jq's tokens (indices into `yytname`).
#[allow(missing_docs)]
pub mod sym {
    pub const EOF: u8 = 0;
    pub const ERROR: u8 = 1;
    pub const INVALID_CHARACTER: u8 = 3;
    pub const IDENT: u8 = 4;
    pub const FIELD: u8 = 5;
    pub const BINDING: u8 = 6;
    pub const LITERAL: u8 = 7;
    pub const FORMAT: u8 = 8;
    pub const REC: u8 = 9;
    pub const SETMOD: u8 = 10;
    pub const EQ: u8 = 11;
    pub const NEQ: u8 = 12;
    pub const DEFINEDOR: u8 = 13;
    pub const AS: u8 = 14;
    pub const DEF: u8 = 15;
    pub const MODULE: u8 = 16;
    pub const IMPORT: u8 = 17;
    pub const INCLUDE: u8 = 18;
    pub const IF: u8 = 19;
    pub const THEN: u8 = 20;
    pub const ELSE: u8 = 21;
    pub const ELSE_IF: u8 = 22;
    pub const REDUCE: u8 = 23;
    pub const FOREACH: u8 = 24;
    pub const END: u8 = 25;
    pub const AND: u8 = 26;
    pub const OR: u8 = 27;
    pub const TRY: u8 = 28;
    pub const CATCH: u8 = 29;
    pub const LABEL: u8 = 30;
    pub const BREAK: u8 = 31;
    pub const LOC: u8 = 32;
    pub const SETPIPE: u8 = 33;
    pub const SETPLUS: u8 = 34;
    pub const SETMINUS: u8 = 35;
    pub const SETMULT: u8 = 36;
    pub const SETDIV: u8 = 37;
    pub const SETDEFINEDOR: u8 = 38;
    pub const LESSEQ: u8 = 39;
    pub const GREATEREQ: u8 = 40;
    pub const ALTERNATION: u8 = 41;
    pub const QQSTRING_START: u8 = 42;
    pub const QQSTRING_TEXT: u8 = 43;
    pub const QQSTRING_INTERP_START: u8 = 44;
    pub const QQSTRING_INTERP_END: u8 = 45;
    pub const QQSTRING_END: u8 = 46;
    pub const PIPE: u8 = 48;
    pub const COMMA: u8 = 49;
    pub const ASSIGN: u8 = 50;
    pub const LT: u8 = 51;
    pub const GT: u8 = 52;
    pub const PLUS: u8 = 53;
    pub const MINUS: u8 = 54;
    pub const STAR: u8 = 55;
    pub const SLASH: u8 = 56;
    pub const PERCENT: u8 = 57;
    pub const QUESTION: u8 = 59;
    pub const DOT: u8 = 60;
    pub const LBRACKET: u8 = 61;
    pub const SEMICOLON: u8 = 62;
    pub const COLON: u8 = 63;
    pub const LPAREN: u8 = 64;
    pub const RPAREN: u8 = 65;
    pub const RBRACKET: u8 = 66;
    pub const LBRACE: u8 = 67;
    pub const RBRACE: u8 = 68;
    pub const DOLLAR: u8 = 69;
}

/// Semantic value of a token.
#[derive(Clone, Debug)]
pub enum TokVal<'s> {
    /// no value
    None,
    /// identifier, field name (without `.`), variable (with `$`),
    /// format (with `@`), number literal, or string text without escapes
    Text(&'s str),
    /// string text made of escape sequences, decoded
    Chars(Vec<char>),
    /// string escape sequences that jq's JSON parser rejects, with its message
    Invalid(String),
}

/// Token with its bison symbol number and byte range in the source.
#[derive(Clone, Debug)]
pub struct Token<'s> {
    /// bison symbol number, see [`sym`]
    pub sym: u8,
    /// start byte offset
    pub start: usize,
    /// end byte offset
    pub end: usize,
    /// semantic value
    pub val: TokVal<'s>,
}

#[derive(Copy, Clone, PartialEq, Eq)]
enum State {
    Paren,
    Bracket,
    Brace,
    QqInterp,
    QqString,
}

/// Lexer for jq programs.
pub struct Lexer<'s> {
    code: &'s str,
    pos: usize,
    /// byte range of the last match, which `yylloc` keeps at the end of input
    last: (usize, usize),
    states: Vec<State>,
    /// the previous token was `def`
    after_def: bool,
    /// lex `@name` after `def` as an identifier, to define formats in the prelude
    fmt_defs: bool,
}

const KEYWORDS: [(&str, u8); 18] = [
    ("as", sym::AS),
    ("import", sym::IMPORT),
    ("include", sym::INCLUDE),
    ("module", sym::MODULE),
    ("def", sym::DEF),
    ("if", sym::IF),
    ("then", sym::THEN),
    ("else", sym::ELSE),
    ("elif", sym::ELSE_IF),
    ("and", sym::AND),
    ("or", sym::OR),
    ("end", sym::END),
    ("reduce", sym::REDUCE),
    ("foreach", sym::FOREACH),
    ("try", sym::TRY),
    ("catch", sym::CATCH),
    ("label", sym::LABEL),
    ("break", sym::BREAK),
];

fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_'
}

fn is_ident_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// Length of `([a-zA-Z_][a-zA-Z_0-9]*::)*[a-zA-Z_][a-zA-Z_0-9]*` at the start of `s`.
fn ident_len(s: &[u8]) -> usize {
    let word = |i: usize| {
        if s.get(i).copied().is_some_and(is_ident_start) {
            let rest = s[i + 1..].iter().take_while(|c| is_ident_char(**c)).count();
            Some(i + 1 + rest)
        } else {
            None
        }
    };
    let Some(mut end) = word(0) else { return 0 };
    while s[end..].starts_with(b"::") {
        match word(end + 2) {
            Some(e) => end = e,
            None => break,
        }
    }
    end
}

/// Length of `([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?` at the start of `s`.
fn num_len(s: &[u8]) -> usize {
    let digits = |i: usize| s[i.min(s.len())..].iter().take_while(|c| c.is_ascii_digit()).count();
    let int = digits(0);
    let mut end = if int > 0 {
        if s.get(int) == Some(&b'.') {
            int + 1 + digits(int + 1)
        } else {
            int
        }
    } else if s.first() == Some(&b'.') && digits(1) > 0 {
        1 + digits(1)
    } else {
        return 0;
    };
    if matches!(s.get(end), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(s.get(end + 1), Some(b'+' | b'-')));
        let exp = digits(end + 1 + sign);
        if exp > 0 {
            end += 1 + sign + exp;
        }
    }
    end
}

impl<'s> Lexer<'s> {
    /// Initialise a new lexer for the given input.
    #[must_use]
    pub fn new(code: &'s str) -> Self {
        Self {
            code,
            pos: 0,
            last: (0, 0),
            states: Vec::new(),
            after_def: false,
            fmt_defs: false,
        }
    }

    /// Lex `def @name` as the definition of a format, as jaq's prelude does.
    pub(crate) fn with_fmt_defs(self) -> Self {
        Self { fmt_defs: true, ..self }
    }

    /// The source code being lexed.
    pub fn code(&self) -> &'s str {
        self.code
    }

    fn rest(&self) -> &'s [u8] {
        &self.code.as_bytes()[self.pos..]
    }

    fn matched(&mut self, len: usize) -> (usize, usize) {
        let start = self.pos;
        self.pos += len;
        self.last = (start, self.pos);
        self.last
    }

    fn token(&mut self, sym: u8, len: usize, val: impl FnOnce(&'s str) -> TokVal<'s>) -> Token<'s> {
        let (start, end) = self.matched(len);
        let val = val(&self.code[start..end]);
        Token { sym, start, end, val }
    }

    /// Length of the character at the current position, for slicing.
    fn char_len(&self) -> usize {
        self.code[self.pos..].chars().next().map_or(0, char::len_utf8)
    }

    /// A byte that no rule matches.
    ///
    /// flex returns `INVALID_CHARACTER` for each byte of a multibyte character;
    /// we return one token per byte, without a value.
    fn invalid(&mut self) -> Token<'s> {
        let (start, end) = self.matched(1);
        Token { sym: sym::INVALID_CHARACTER, start, end, val: TokVal::None }
    }

    /// Skip a comment, as `<IN_COMMENT>` does: a backslash escapes a newline
    /// or another backslash, a newline ends the comment.
    fn comment(&mut self) {
        self.matched(1);
        loop {
            let rest = self.rest();
            let len = match rest {
                [] => return,
                [b'\\', b'\\', ..] | [b'\\', b'\n', ..] => 2,
                [b'\\', b'\r', b'\n', ..] => 3,
                [b'\r', b'\n', ..] => {
                    self.matched(2);
                    return;
                }
                [b'\n', ..] => {
                    self.matched(1);
                    return;
                }
                _ => self.char_len(),
            };
            self.matched(len);
        }
    }

    /// Return the next token, or a token with symbol [`sym::EOF`]
    /// at the location of the last match.
    pub fn next_token(&mut self) -> Token<'s> {
        let tok = if self.states.last() == Some(&State::QqString) {
            self.qq_token()
        } else {
            self.plain_token()
        };
        let is_def = tok.sym == sym::DEF;
        let tok = match tok {
            Token { sym: sym::FORMAT, start, end, val } if self.after_def && self.fmt_defs => {
                Token { sym: sym::IDENT, start, end, val }
            }
            tok => tok,
        };
        self.after_def = is_def;
        tok
    }

    fn eof(&self) -> Token<'s> {
        let (start, end) = self.last;
        Token { sym: sym::EOF, start, end, val: TokVal::None }
    }

    fn plain_token(&mut self) -> Token<'s> {
        loop {
            let rest = self.rest();
            let ws = rest.iter().take_while(|c| matches!(c, b' ' | b'\r' | b'\n' | b'\t')).count();
            if ws > 0 {
                self.matched(ws);
            } else if rest.first() == Some(&b'#') {
                self.comment();
            } else {
                break;
            }
        }
        let rest = self.rest();
        let Some(&c) = rest.first() else {
            return self.eof();
        };
        let text = TokVal::Text;
        let op = |s: &str| rest.starts_with(s.as_bytes());
        match c {
            b'a'..=b'z' | b'A'..=b'Z' | b'_' => {
                let len = ident_len(rest);
                let word = &self.code[self.pos..self.pos + len];
                match KEYWORDS.iter().find(|(kw, _)| *kw == word) {
                    Some((_, kw)) => self.token(*kw, len, |_| TokVal::None),
                    None => self.token(sym::IDENT, len, text),
                }
            }
            b'$' => match ident_len(&rest[1..]) {
                0 => self.token(sym::DOLLAR, 1, |_| TokVal::None),
                len if &rest[..len + 1] == b"$__loc__" => self.token(sym::LOC, len + 1, |_| TokVal::None),
                len => self.token(sym::BINDING, len + 1, text),
            },
            b'@' => match rest[1..].iter().take_while(|c| is_ident_char(**c)).count() {
                0 => self.invalid(),
                len => self.token(sym::FORMAT, len + 1, text),
            },
            b'0'..=b'9' => {
                let len = num_len(rest);
                self.token(sym::LITERAL, len, text)
            }
            b'.' => {
                let field = if rest.get(1).copied().is_some_and(is_ident_start) {
                    1 + rest[1..].iter().take_while(|c| is_ident_char(**c)).count()
                } else {
                    0
                };
                let num = num_len(rest);
                if field > 0 {
                    self.token(sym::FIELD, field, |s| TokVal::Text(&s[1..]))
                } else if num > 0 {
                    self.token(sym::LITERAL, num, text)
                } else if op("..") {
                    self.token(sym::REC, 2, |_| TokVal::None)
                } else {
                    self.token(sym::DOT, 1, |_| TokVal::None)
                }
            }
            b'"' => {
                self.states.push(State::QqString);
                self.token(sym::QQSTRING_START, 1, |_| TokVal::None)
            }
            b'(' | b'[' | b'{' => {
                let (state, sym) = match c {
                    b'(' => (State::Paren, sym::LPAREN),
                    b'[' => (State::Bracket, sym::LBRACKET),
                    _ => (State::Brace, sym::LBRACE),
                };
                self.states.push(state);
                self.token(sym, 1, |_| TokVal::None)
            }
            b')' | b']' | b'}' => self.try_exit(c),
            _ => {
                const OPS: [(&str, u8); 26] = [
                    ("?//", sym::ALTERNATION),
                    ("//=", sym::SETDEFINEDOR),
                    ("!=", sym::NEQ),
                    ("==", sym::EQ),
                    ("//", sym::DEFINEDOR),
                    ("|=", sym::SETPIPE),
                    ("+=", sym::SETPLUS),
                    ("-=", sym::SETMINUS),
                    ("*=", sym::SETMULT),
                    ("/=", sym::SETDIV),
                    ("%=", sym::SETMOD),
                    ("<=", sym::LESSEQ),
                    (">=", sym::GREATEREQ),
                    ("?", sym::QUESTION),
                    ("=", sym::ASSIGN),
                    (";", sym::SEMICOLON),
                    (",", sym::COMMA),
                    (":", sym::COLON),
                    ("|", sym::PIPE),
                    ("+", sym::PLUS),
                    ("-", sym::MINUS),
                    ("*", sym::STAR),
                    ("/", sym::SLASH),
                    ("%", sym::PERCENT),
                    ("<", sym::LT),
                    (">", sym::GT),
                ];
                match OPS.iter().find(|(s, _)| op(s)) {
                    Some((s, sym)) => self.token(*sym, s.len(), |_| TokVal::None),
                    None => self.invalid(),
                }
            }
        }
    }

    /// A closing delimiter, as `try_exit` in jq's lexer: it closes the
    /// innermost open delimiter if it matches, else it is invalid.
    fn try_exit(&mut self, c: u8) -> Token<'s> {
        let (state, sym) = match c {
            b')' => (State::Paren, sym::RPAREN),
            b']' => (State::Bracket, sym::RBRACKET),
            _ => (State::Brace, sym::RBRACE),
        };
        match self.states.last() {
            Some(&s) if s == state => {
                self.states.pop();
                self.token(sym, 1, |_| TokVal::None)
            }
            Some(State::QqInterp) if c == b')' => {
                self.states.pop();
                self.token(sym::QQSTRING_INTERP_END, 1, |_| TokVal::None)
            }
            _ => self.invalid(),
        }
    }

    fn qq_token(&mut self) -> Token<'s> {
        let rest = self.rest();
        match rest {
            [] => self.eof(),
            [b'\\', b'(', ..] => {
                self.states.push(State::QqInterp);
                self.token(sym::QQSTRING_INTERP_START, 2, |_| TokVal::None)
            }
            [b'"', ..] => {
                self.states.pop();
                self.token(sym::QQSTRING_END, 1, |_| TokVal::None)
            }
            [b'\\'] => self.invalid(),
            [b'\\', ..] => {
                let len = self.escapes_len();
                self.token(sym::QQSTRING_TEXT, len, unescape)
            }
            _ => {
                let len = rest.iter().take_while(|c| !matches!(c, b'\\' | b'"')).count();
                self.token(sym::QQSTRING_TEXT, len, TokVal::Text)
            }
        }
    }

    /// Length of `(\\[^u(]|\\u[a-zA-Z0-9]{0,4})+` at the current position.
    fn escapes_len(&self) -> usize {
        let s = &self.code[self.pos..];
        let b = s.as_bytes();
        let mut i = 0;
        while b.get(i) == Some(&b'\\') {
            match b.get(i + 1) {
                None | Some(b'(') => break,
                Some(b'u') => {
                    let hex = b[i + 2..].iter().take(4).take_while(|c| c.is_ascii_alphanumeric());
                    i += 2 + hex.count();
                }
                Some(_) => i += 1 + s[i + 1..].chars().next().map_or(1, char::len_utf8),
            }
        }
        i
    }
}

/// Decode a run of escape sequences as jq does, by parsing it as a JSON string
/// (`found_string` in `src/jv_parse.c`), with jq's error messages.
fn unescape(s: &str) -> TokVal<'_> {
    match decode_escapes(s) {
        Ok(chars) => TokVal::Chars(chars),
        Err(msg) => {
            // jq reports the position after the closing quote of `"<s>"`
            let wrapped = alloc::format!("\"{s}\"");
            let (mut line, mut column) = (1, 0);
            for c in wrapped.bytes() {
                column += 1;
                if c == b'\n' {
                    line += 1;
                    column = 0;
                }
            }
            TokVal::Invalid(alloc::format!(
                "{msg} at line {line}, column {column} (while parsing '{wrapped}')"
            ))
        }
    }
}

fn decode_escapes(s: &str) -> Result<Vec<char>, &'static str> {
    let unhex4 = |h: &[u8]| -> Option<u32> {
        let h = core::str::from_utf8(h.get(..4)?).ok()?;
        if h.bytes().all(|c| c.is_ascii_hexdigit()) {
            u32::from_str_radix(h, 16).ok()
        } else {
            None
        }
    };
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        // every unit starts with a backslash, see `escapes_len`
        let c = s[i + 1..].chars().next().ok_or("Expected escape character at end of string")?;
        i += 1 + c.len_utf8();
        out.push(match c {
            '\\' | '"' | '/' => c,
            'b' => '\x08',
            'f' => '\x0c',
            't' => '\t',
            'n' => '\n',
            'r' => '\r',
            'u' => {
                if i + 4 > b.len() {
                    return Err("Invalid \\uXXXX escape");
                }
                let mut cp = unhex4(&b[i..]).ok_or("Invalid characters in \\uXXXX escape")?;
                i += 4;
                if (0xD800..=0xDBFF).contains(&cp) {
                    let pair = "Invalid \\uXXXX\\uXXXX surrogate pair escape";
                    if i + 6 > b.len() || b[i] != b'\\' || b[i + 1] != b'u' {
                        return Err(pair);
                    }
                    let low = unhex4(&b[i + 2..]).filter(|l| (0xDC00..=0xDFFF).contains(l));
                    cp = 0x10000 + (((cp - 0xD800) << 10) | (low.ok_or(pair)? - 0xDC00));
                    i += 6;
                }
                char::from_u32(cp).unwrap_or('\u{FFFD}')
            }
            _ => return Err("Invalid escape"),
        });
    }
    Ok(out)
}
