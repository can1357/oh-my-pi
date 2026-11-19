//! JSON parsing as jq 1.8.2 does it (src/jv_parse.c).
//!
//! [`Parser`] is jq's incremental `jv_parser`: it is fed buffers of input and
//! yields values (or, with [`Flags::stream`], `[path, leaf]` events) and
//! errors whose text and positions are jq's.
use crate::{Map, Val};
use alloc::{format, string::String, vec::Vec};
use core::fmt;

mod literal;
pub mod utf8;

pub use literal::number;

/// Deepest nesting of arrays, objects and pending object keys that parsing
/// accepts, as jq's `MAX_PARSING_DEPTH`; deeper input fails with
/// `Exceeds depth limit for parsing`.
pub const MAX_DEPTH: usize = 10_000;

/// A parse error, displayed as jq's message.
#[derive(Clone, Debug)]
pub struct Error(String);

impl Error {
    /// jq's message for the error.
    pub fn message(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(feature = "std")]
impl std::error::Error for Error {}

/// Parser options: jq's `JV_PARSE_SEQ`, `JV_PARSE_STREAMING` and
/// `JV_PARSE_STREAM_ERRORS`.
#[derive(Clone, Copy, Debug, Default)]
pub struct Flags {
    /// `--seq`: input is a JSON text sequence of values each preceded by RS.
    pub seq: bool,
    /// `--stream`: yield `[path, leaf]` and `[path]` events instead of values.
    pub stream: bool,
    /// `--stream-errors`: with `stream`, a parse error is the value `[message, path]`.
    pub stream_errors: bool,
}

/// ASCII record separator, which starts each text of a JSON text sequence.
const RS: u8 = 0x1e;
const BOM: [u8; 3] = [0xef, 0xbb, 0xbf];
/// `bom` state: a BOM was seen or ruled out.
const BOM_DONE: u8 = 3;
/// `bom` state: input started with part of a BOM only.
const BOM_MALFORMED: u8 = 0xff;

/// An array or object being parsed, or the key of an object's next value.
enum Frame {
    Arr(Vec<Val>),
    Obj(Map),
    Key(Val),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LastSeen {
    None,
    OpenArray,
    OpenObject,
    Colon,
    Comma,
    Value,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Normal,
    String,
    StringEscape,
    /// After a parse error with `seq`: skip input until the next RS.
    WaitingForRs,
}

/// A streaming event waiting to be yielded.
enum Output {
    /// `[path, leaf]`, followed by the closing event `[path]` if the flag is set.
    Leaf(Val, Val, bool),
    /// `[path]`.
    Close(Val),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Class {
    Literal,
    Whitespace,
    Structure,
    Quote,
}

fn classify(c: u8) -> Class {
    match c {
        b' ' | b'\t' | b'\r' | b'\n' => Class::Whitespace,
        b'"' => Class::Quote,
        b'[' | b',' | b']' | b'{' | b':' | b'}' => Class::Structure,
        _ => Class::Literal,
    }
}

type Msg = &'static str;

/// jq's incremental JSON parser (`struct jv_parser`).
///
/// Give it a buffer with [`Parser::set_buf`], then call [`Parser::next`] with
/// the same buffer until it returns `None`, which means that it needs the
/// next buffer (or, after a last buffer, that the input is done).
pub struct Parser {
    flags: Flags,
    has_buf: bool,
    partial: bool,
    pos: usize,
    len: usize,
    eof: bool,
    bom: u8,
    stack: Vec<Frame>,
    path: Vec<Val>,
    last_seen: LastSeen,
    output: Option<Output>,
    next: Option<Val>,
    token: Vec<u8>,
    line: usize,
    column: usize,
    st: State,
    last_ch_was_ws: bool,
}

fn arr(v: Vec<Val>) -> Val {
    Val::Arr(v.into())
}

impl Parser {
    /// A parser for a new input (`jv_parser_new`).
    pub fn new(flags: Flags) -> Self {
        Self {
            flags,
            has_buf: false,
            partial: false,
            pos: 0,
            len: 0,
            eof: false,
            bom: 0,
            stack: Vec::new(),
            path: Vec::new(),
            last_seen: LastSeen::None,
            output: None,
            next: None,
            token: Vec::new(),
            line: 1,
            column: 0,
            st: if flags.seq { State::WaitingForRs } else { State::Normal },
            last_ch_was_ws: false,
        }
    }

    /// Parse `buf` next; `partial` if more input follows it (`jv_parser_set_buf`).
    ///
    /// One UTF-8 BOM is skipped at the start of the input.
    pub fn set_buf(&mut self, buf: &[u8], partial: bool) {
        let mut start = 0;
        while start < buf.len() && self.bom < BOM_DONE {
            if buf[start] == BOM[usize::from(self.bom)] {
                start += 1;
                self.bom += 1;
            } else if self.bom == 0 {
                self.bom = BOM_DONE;
            } else {
                self.bom = BOM_MALFORMED;
            }
        }
        self.has_buf = true;
        self.pos = start;
        self.len = buf.len();
        self.partial = partial;
    }

    /// Bytes of the current buffer not parsed yet (`jv_parser_remaining`).
    pub fn remaining(&self) -> usize {
        if self.has_buf { self.len - self.pos } else { 0 }
    }

    fn reset(&mut self) {
        if self.flags.stream {
            self.path.clear();
        }
        self.last_seen = LastSeen::None;
        self.output = None;
        self.next = None;
        self.stack.clear();
        self.token.clear();
        self.st = State::Normal;
    }

    fn make_error(&self, msg: String) -> Result<Val, Error> {
        if self.flags.stream_errors {
            Ok(arr(Vec::from([Val::from(msg), arr(self.path.clone())])))
        } else {
            Err(Error(msg))
        }
    }

    /// The next value or error from `buf`, the buffer last given to
    /// [`Parser::set_buf`] (`jv_parser_next`).
    pub fn next(&mut self, buf: &[u8]) -> Option<Result<Val, Error>> {
        if self.eof || !self.has_buf {
            return None;
        }
        if self.bom == BOM_MALFORMED {
            if !self.flags.seq {
                return Some(Err(Error("Malformed BOM".into())));
            }
            // jq sets `WAITING_FOR_RS` here, which its reset undoes
            self.reset();
        }
        let mut value = None;
        if self.flags.stream && self.stream_check_done(&mut value) {
            return value.map(Ok);
        }
        let mut ch = 0;
        let mut msg = Ok(false);
        while self.pos < self.len {
            ch = buf[self.pos];
            self.pos += 1;
            if self.st == State::WaitingForRs {
                if ch == b'\n' {
                    self.line += 1;
                    self.column = 0;
                } else {
                    self.column += 1;
                }
                if ch == RS {
                    self.st = State::Normal;
                }
                continue;
            }
            msg = self.scan(ch, &mut value);
            if msg != Ok(false) {
                break;
            }
        }
        let (line, column) = (self.line, self.column);
        match msg {
            Ok(true) => value.map(Ok),
            Err(msg) if ch != RS && self.flags.seq => {
                // jq sets `WAITING_FOR_RS` here, which its reset undoes
                let e = self.make_error(format!("{msg} at line {line}, column {column} (need RS to resync)"));
                self.reset();
                Some(e)
            }
            Err(msg) => {
                let e = self.make_error(format!("{msg} at line {line}, column {column}"));
                self.reset();
                if !self.flags.seq {
                    // not a text sequence: throw the rest of this buffer away
                    self.has_buf = false;
                    self.pos = 0;
                }
                Some(e)
            }
            Ok(false) if self.partial => None,
            Ok(false) => self.finish(),
        }
    }

    /// End of input: the last value, or why the input ended too early.
    fn finish(&mut self) -> Option<Result<Val, Error>> {
        self.eof = true;
        let (line, column) = (self.line, self.column);
        if self.st == State::WaitingForRs {
            let msg = format!("Unfinished abandoned text at EOF at line {line}, column {column}");
            return Some(self.make_error(msg));
        }
        let msg = if self.st != State::Normal {
            Some(format!("Unfinished string at EOF at line {line}, column {column}"))
        } else if let Err(msg) = self.check_literal() {
            Some(format!("{msg} at EOF at line {line}, column {column}"))
        } else if (self.flags.stream && !self.path.is_empty()) || (!self.flags.stream && !self.stack.is_empty()) {
            Some(format!("Unfinished JSON term at EOF at line {line}, column {column}"))
        } else {
            None
        };
        if let Some(msg) = msg {
            let e = self.make_error(msg);
            self.reset();
            self.st = State::WaitingForRs;
            return Some(e);
        }
        let value = match self.next.take() {
            Some(v) if self.flags.stream => Some(arr(Vec::from([arr(self.path.clone()), v]))),
            v => v,
        };
        if self.flags.seq && !self.last_ch_was_ws && matches!(value, Some(Val::Num(_))) {
            let msg = format!("Potentially truncated top-level numeric value at EOF at line {line}, column {column}");
            return Some(self.make_error(msg));
        }
        value.map(Ok)
    }

    /// Consume one character; `Ok(true)` once `out` holds a value, or when
    /// a text sequence restarts.
    fn scan(&mut self, ch: u8, out: &mut Option<Val>) -> Result<bool, Msg> {
        self.column += 1;
        if ch == b'\n' {
            self.line += 1;
            self.column = 0;
        }
        if self.flags.seq && ch == RS {
            if self.check_truncation() {
                if self.check_literal().is_ok() && self.is_top_num() {
                    return Err("Potentially truncated top-level numeric value");
                }
                return Err("Truncated value");
            }
            self.check_literal()?;
            if self.st == State::Normal && self.check_done(out) {
                return Ok(true);
            }
            self.reset();
            *out = None;
            return Ok(true);
        }
        let mut answer = false;
        self.last_ch_was_ws = false;
        if self.st == State::Normal {
            let class = classify(ch);
            if class == Class::Whitespace {
                self.last_ch_was_ws = true;
            }
            if class != Class::Literal {
                self.check_literal()?;
                answer |= self.check_done(out);
            }
            match class {
                Class::Literal => self.token.push(ch),
                Class::Whitespace => {}
                Class::Quote => self.st = State::String,
                Class::Structure if self.flags.stream => self.stream_token(ch)?,
                Class::Structure => self.parse_token(ch)?,
            }
            answer |= self.check_done(out);
        } else if ch == b'"' && self.st == State::String {
            self.found_string()?;
            self.st = State::Normal;
            answer |= self.check_done(out);
        } else {
            self.token.push(ch);
            self.st = if ch == b'\\' && self.st == State::String {
                State::StringEscape
            } else {
                State::String
            };
        }
        Ok(answer)
    }

    fn value(&mut self, val: Val) -> Result<(), Msg> {
        if self.flags.stream {
            if self.next.is_some() || self.last_seen == LastSeen::Value {
                return Err("Expected separator between values");
            }
            self.last_seen = if self.path.is_empty() { LastSeen::None } else { LastSeen::Value };
        } else if self.next.is_some() {
            return Err("Expected separator between values");
        }
        self.next = Some(val);
        Ok(())
    }

    fn check_done(&mut self, out: &mut Option<Val>) -> bool {
        if self.flags.stream {
            self.stream_check_done(out)
        } else if self.stack.is_empty() && self.next.is_some() {
            *out = self.next.take();
            true
        } else {
            false
        }
    }

    fn stream_check_done(&mut self, out: &mut Option<Val>) -> bool {
        if self.path.is_empty() && self.next.is_some() {
            let v = self.next.take().into_iter();
            *out = Some(arr(core::iter::once(arr(Vec::new())).chain(v).collect()));
            return true;
        }
        let Some(output) = self.output.take() else {
            return false;
        };
        *out = Some(arr(match output {
            Output::Leaf(path, leaf, close) => {
                if close {
                    self.output = Some(Output::Close(path.clone()));
                }
                Vec::from([path, leaf])
            }
            Output::Close(path) => Vec::from([path]),
        }));
        true
    }

    fn check_truncation(&self) -> bool {
        if self.flags.stream {
            !self.path.is_empty() || matches!(self.next, Some(Val::Num(_) | Val::Bool(_) | Val::Null))
        } else {
            !self.last_ch_was_ws
                && (!self.stack.is_empty() || !self.token.is_empty() || matches!(self.next, Some(Val::Num(_))))
        }
    }

    fn is_top_num(&self) -> bool {
        let top = if self.flags.stream { self.path.is_empty() } else { self.stack.is_empty() };
        top && matches!(self.next, Some(Val::Num(_)))
    }

    fn parse_token(&mut self, ch: u8) -> Result<(), Msg> {
        match ch {
            b'[' | b'{' => {
                if self.stack.len() >= MAX_DEPTH {
                    return Err("Exceeds depth limit for parsing");
                }
                if self.next.is_some() {
                    return Err("Expected separator between values");
                }
                self.stack.push(if ch == b'[' { Frame::Arr(Vec::new()) } else { Frame::Obj(Map::default()) });
            }
            b':' => {
                if self.next.is_none() {
                    return Err("Expected string key before ':'");
                }
                if !matches!(self.stack.last(), Some(Frame::Obj(_))) {
                    return Err("':' not as part of an object");
                }
                if !matches!(self.next, Some(Val::TStr(_))) {
                    return Err("Object keys must be strings");
                }
                self.stack.extend(self.next.take().map(Frame::Key));
            }
            b',' => {
                let Some(next) = self.next.take() else {
                    return Err("Expected value before ','");
                };
                match self.stack.last_mut() {
                    None => return Err("',' not as part of an object or array"),
                    Some(Frame::Arr(a)) => a.push(next),
                    Some(Frame::Key(_)) => self.insert(next),
                    Some(Frame::Obj(_)) => return Err("Objects must consist of key:value pairs"),
                }
            }
            b']' => {
                let Some(Frame::Arr(a)) = self.stack.last_mut() else {
                    return Err("Unmatched ']'");
                };
                if let Some(next) = self.next.take() {
                    a.push(next);
                } else if !a.is_empty() {
                    return Err("Expected another array element");
                }
                if let Some(Frame::Arr(a)) = self.stack.pop() {
                    self.next = Some(arr(a));
                }
            }
            b'}' => {
                if self.stack.is_empty() {
                    return Err("Unmatched '}'");
                }
                if let Some(next) = self.next.take() {
                    if !matches!(self.stack.last(), Some(Frame::Key(_))) {
                        return Err("Objects must consist of key:value pairs");
                    }
                    self.insert(next);
                } else {
                    let Some(Frame::Obj(o)) = self.stack.last() else {
                        return Err("Unmatched '}'");
                    };
                    if !o.is_empty() {
                        return Err("Expected another key-value pair");
                    }
                }
                if let Some(Frame::Obj(o)) = self.stack.pop() {
                    self.next = Some(Val::obj(o));
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Set the pending key of the object below it to `value`.
    fn insert(&mut self, value: Val) {
        if let Some(Frame::Key(key)) = self.stack.pop() {
            if let Some(Frame::Obj(o)) = self.stack.last_mut() {
                o.insert(key, value);
            }
        }
    }

    fn path_val(&self) -> Val {
        arr(self.path.clone())
    }

    fn stream_token(&mut self, ch: u8) -> Result<(), Msg> {
        let last_is_index = matches!(self.path.last(), Some(Val::Num(_)));
        match ch {
            b'[' | b'{' => {
                let open = if ch == b'[' {
                    if self.next.is_some() {
                        return Err("Expected a separator between values");
                    }
                    if self.last_seen == LastSeen::OpenObject {
                        return Err("Expected string key after '{', not '['");
                    }
                    if self.last_seen == LastSeen::Comma && !last_is_index {
                        return Err("Expected string key after ',' in object, not '['");
                    }
                    (Val::from(0usize), LastSeen::OpenArray)
                } else {
                    if self.last_seen == LastSeen::Value {
                        return Err("Expected a separator between values");
                    }
                    if self.last_seen == LastSeen::OpenObject {
                        return Err("Expected string key after '{', not '{'");
                    }
                    if self.last_seen == LastSeen::Comma && !last_is_index {
                        return Err("Expected string key after ',' in object, not '{'");
                    }
                    (Val::Null, LastSeen::OpenObject)
                };
                self.path.push(open.0);
                self.last_seen = open.1;
            }
            b':' => {
                if self.path.is_empty() || last_is_index {
                    return Err("':' not as part of an object");
                }
                if self.next.is_none() || self.last_seen == LastSeen::None {
                    return Err("Expected string key before ':'");
                }
                if !matches!(self.next, Some(Val::TStr(_))) {
                    return Err("Object keys must be strings");
                }
                if self.last_seen != LastSeen::Value {
                    return Err("':' should follow a key");
                }
                self.last_seen = LastSeen::Colon;
                if let (Some(last), Some(key)) = (self.path.last_mut(), self.next.take()) {
                    *last = key;
                }
            }
            b',' => {
                if self.last_seen != LastSeen::Value {
                    return Err("Expected value before ','");
                }
                let next_key = match self.path.last() {
                    None => return Err("',' not as part of an object or array"),
                    Some(Val::Num(n)) => Val::from(n.as_isize().unwrap_or(0) + 1),
                    Some(Val::TStr(_)) => Val::Null,
                    Some(_) => return Err("Objects must consist of key:value pairs"),
                };
                if let Some(next) = self.next.take() {
                    self.output = Some(Output::Leaf(self.path_val(), next, false));
                }
                if let Some(last) = self.path.last_mut() {
                    *last = next_key;
                }
                self.last_seen = LastSeen::Comma;
            }
            b']' => {
                if self.path.is_empty() {
                    return Err("Unmatched ']' at the top-level");
                }
                if self.last_seen == LastSeen::Comma {
                    return Err("Expected another array element");
                }
                if !last_is_index {
                    return Err("Unmatched ']' in the middle of an object");
                }
                if let Some(next) = self.next.take() {
                    self.output = Some(Output::Leaf(self.path_val(), next, true));
                } else if self.last_seen != LastSeen::OpenArray {
                    self.output = Some(Output::Close(self.path_val()));
                }
                self.close(Val::Arr(Vec::new().into()), LastSeen::OpenArray);
            }
            b'}' => {
                if self.path.is_empty() {
                    return Err("Unmatched '}' at the top-level");
                }
                if self.last_seen == LastSeen::Comma {
                    return Err("Expected another key:value pair");
                }
                if last_is_index {
                    return Err("Unmatched '}' in the middle of an array");
                }
                if self.next.is_some() {
                    if !matches!(self.path.last(), Some(Val::TStr(_))) {
                        return Err("Objects must consist of key:value pairs");
                    }
                    let next = self.next.take().unwrap_or(Val::Null);
                    self.output = Some(Output::Leaf(self.path_val(), next, true));
                } else {
                    match self.last_seen {
                        LastSeen::Colon => return Err("Missing value in key:value pair"),
                        LastSeen::Comma => return Err("Expected another key-value pair"),
                        LastSeen::OpenArray => return Err("Unmatched '}' in the middle of an array"),
                        LastSeen::Value => self.output = Some(Output::Close(self.path_val())),
                        LastSeen::OpenObject => {}
                        LastSeen::None => return Err("Unmatched '}'"),
                    }
                }
                self.close(Val::obj(Map::default()), LastSeen::OpenObject);
            }
            _ => {}
        }
        Ok(())
    }

    /// Leave the innermost array or object; an empty one (`opened` was the
    /// last thing seen) is a leaf.
    fn close(&mut self, empty: Val, opened: LastSeen) {
        self.path.pop();
        self.next = None;
        if self.last_seen == opened {
            self.output = Some(Output::Leaf(self.path_val(), empty, false));
        }
        self.last_seen = if self.path.is_empty() { LastSeen::None } else { LastSeen::Value };
    }

    fn found_string(&mut self) -> Result<(), Msg> {
        let s = unescape(&self.token)?;
        self.value(Val::utf8_str(utf8::lossy(s)))?;
        self.token.clear();
        Ok(())
    }

    fn check_literal(&mut self) -> Result<(), Msg> {
        let Some(&first) = self.token.first() else {
            return Ok(());
        };
        let pattern: Option<(&[u8], Val)> = match first {
            b't' => Some((&b"true"[..], Val::Bool(true))),
            b'f' => Some((&b"false"[..], Val::Bool(false))),
            b'\'' => return Err("Invalid string literal; expected \", but got '"),
            b'n' if self.token.get(1) == Some(&b'u') => Some((&b"null"[..], Val::Null)),
            _ => None,
        };
        if let Some((pattern, v)) = pattern {
            if self.token != pattern {
                return Err("Invalid literal");
            }
            self.value(v)?;
        } else {
            // jq reads the token as a C string, which ends at a NUL
            let end = self.token.iter().position(|&c| c == 0).unwrap_or(self.token.len());
            let n = number(&self.token[..end]).ok_or("Invalid numeric literal")?;
            self.value(Val::Num(n))?;
        }
        self.token.clear();
        Ok(())
    }
}

fn unhex4(hex: &[u8]) -> Option<u32> {
    hex.iter().try_fold(0, |acc, &c| Some((acc << 4) | char::from(c).to_digit(16)?))
}

/// The bytes of a string token, with its escapes resolved (`found_string`).
fn unescape(token: &[u8]) -> Result<Vec<u8>, Msg> {
    let mut out = Vec::with_capacity(token.len());
    let mut i = 0;
    while let Some(&c) = token.get(i) {
        i += 1;
        if c != b'\\' {
            if c < 0x20 {
                return Err("Invalid string: control characters from U+0000 through U+001F must be escaped");
            }
            out.push(c);
            continue;
        }
        let Some(&c) = token.get(i) else {
            return Err("Expected escape character at end of string");
        };
        i += 1;
        match c {
            b'\\' | b'"' | b'/' => out.push(c),
            b'b' => out.push(0x08),
            b'f' => out.push(0x0c),
            b't' => out.push(b'\t'),
            b'n' => out.push(b'\n'),
            b'r' => out.push(b'\r'),
            b'u' => {
                let hex = token.get(i..i + 4).ok_or("Invalid \\uXXXX escape")?;
                let mut codepoint = unhex4(hex).ok_or("Invalid characters in \\uXXXX escape")?;
                i += 4;
                if (0xd800..=0xdbff).contains(&codepoint) {
                    const PAIR: Msg = "Invalid \\uXXXX\\uXXXX surrogate pair escape";
                    let low = match token.get(i..i + 6) {
                        Some([b'\\', b'u', hex @ ..]) => unhex4(hex).filter(|c| (0xdc00..=0xdfff).contains(c)),
                        _ => None,
                    };
                    let low = low.ok_or(PAIR)?;
                    i += 6;
                    codepoint = 0x10000 + (((codepoint - 0xd800) << 10) | (low - 0xdc00));
                }
                // a lone low surrogate is encoded as is and replaced later
                utf8::encode(codepoint, &mut out);
            }
            _ => return Err("Invalid escape"),
        }
    }
    Ok(out)
}

/// Parse a text that must hold exactly one value, as jq's `jv_parse_sized`
/// (`fromjson`, `--argjson`, `--jsonargs`); errors end in `(while parsing '<text>')`.
pub fn parse_single(text: &[u8]) -> Result<Val, Error> {
    let mut parser = Parser::new(Flags::default());
    parser.set_buf(text, false);
    let result = match parser.next(text) {
        Some(Ok(v)) => match parser.next(text) {
            Some(Ok(_)) => Err(Error("Unexpected extra JSON values".into())),
            Some(Err(e)) => Err(e),
            None => Ok(v),
        },
        Some(Err(e)) => Err(e),
        None => Err(Error("Expected JSON value".into())),
    };
    result.map_err(|Error(msg)| {
        // jq prints the text as a C string, which ends at a NUL
        let end = text.iter().position(|&c| c == 0).unwrap_or(text.len());
        let text = String::from_utf8_lossy(&text[..end]);
        Error(format!("{msg} (while parsing '{text}')"))
    })
}

/// The values of a complete input held in one buffer, ending after the first error.
pub fn parse_many(text: &[u8]) -> impl Iterator<Item = Result<Val, Error>> + '_ {
    let mut parser = Parser::new(Flags::default());
    parser.set_buf(text, false);
    core::iter::from_fn(move || parser.next(text))
}

/// The values of a file's contents, as jq's `jv_load_file` reads them
/// (`--slurpfile`, data modules): in chunks of 4096 bytes, each completed to
/// a whole UTF-8 sequence, failing on the first error.
pub fn parse_file(mut bytes: &[u8]) -> Result<Vec<Val>, Error> {
    const CHUNK: usize = 4096;
    let mut parser = Parser::new(Flags::default());
    let mut vals = Vec::new();
    while !bytes.is_empty() {
        let mut n = bytes.len().min(CHUNK);
        let mut eof = n < CHUNK;
        if !eof {
            if let Some(missing) = utf8::missing_bytes(&bytes[..n]).filter(|&m| m > 0) {
                let extra = missing.min(bytes.len() - n);
                n += extra;
                eof = extra < missing;
            }
        }
        let (chunk, rest) = bytes.split_at(n);
        bytes = rest;
        parser.set_buf(chunk, !eof);
        while let Some(v) = parser.next(chunk) {
            vals.push(v?);
        }
        if eof {
            break;
        }
    }
    Ok(vals)
}
