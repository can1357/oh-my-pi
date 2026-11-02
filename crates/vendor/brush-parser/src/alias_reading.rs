//! Alias substitution while input is read, as Bash's reader does it.
//!
//! Bash replaces an alias while it reads a command, before it parses it: the
//! alias value is read in place of the word, so a value can hold operators,
//! reserved words or the start of a quoted string. Whether a word is looked up
//! depends on the tokens read before it, which this module tracks the way
//! Bash's reader does (`read_token_word`, `special_case_tokens`,
//! `reserved_word_acceptable` and `command_token_position` in Bash's
//! `parse.y`). It also tracks how deeply the input nests, so a reader knows
//! where a complete command can end.

use std::collections::HashMap;
use std::sync::Arc;

use crate::tokenizer::TokenizerOptions;

/// An alias table: alias names and their values.
pub type AliasTable = Arc<HashMap<String, String>>;

/// The kind of a token Bash's reader last returned, as far as alias lookup
/// and reserved words depend on it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Tok {
    Start,
    Newline,
    Semi,
    Amp,
    AndAnd,
    OrOr,
    Pipe,
    PipeAmp,
    LParen,
    RParen,
    SemiSemi,
    Redirection,
    RedirectionTarget,
    Number,
    Word,
    AssignmentWord,
    If,
    Then,
    Else,
    Elif,
    Fi,
    Case,
    Esac,
    For,
    Select,
    While,
    Until,
    Do,
    Done,
    In,
    Function,
    Time,
    TimeOpt,
    TimeIgn,
    Bang,
    LBrace,
    RBrace,
    CondStart,
    CondEnd,
    Coproc,
    ArithCmd,
    ArithForExprs,
}

/// What an open parenthesis began.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Paren {
    Subshell,
    FunctionDefinition,
}

/// The reader state Bash keeps for one stream of commands.
#[derive(Clone, Debug)]
struct Lexer {
    last: Tok,
    before_last: Tok,
    case_pattern: bool,
    case_statement: bool,
    expand_next: bool,
    redirection_list: bool,
    allow_open_brace: bool,
    expecting_in: u32,
    esacs_needed: u32,
    open_braces: u32,
    condition: bool,
    parens: Vec<Paren>,
    /// Open `if`, `case`, `do`, `{` and `[[` constructs.
    nesting: u32,
    /// The previous token was `<` or `>` directly followed by `(`.
    process_substitution_next: bool,
    /// The previous token was an assignment word directly followed by `(`.
    compound_assignment_next: bool,
}

impl Lexer {
    const fn new() -> Self {
        Self {
            last: Tok::Start,
            before_last: Tok::Start,
            case_pattern: false,
            case_statement: false,
            expand_next: false,
            redirection_list: false,
            allow_open_brace: false,
            expecting_in: 0,
            esacs_needed: 0,
            open_braces: 0,
            condition: false,
            parens: Vec::new(),
            nesting: 0,
            process_substitution_next: false,
            compound_assignment_next: false,
        }
    }

    fn shift(&mut self, tok: Tok) {
        self.before_last = self.last;
        self.last = tok;
    }

    fn reserved_word_acceptable(&self) -> bool {
        match self.last {
            Tok::Start
            | Tok::Newline
            | Tok::Semi
            | Tok::LParen
            | Tok::RParen
            | Tok::Pipe
            | Tok::Amp
            | Tok::LBrace
            | Tok::RBrace
            | Tok::AndAnd
            | Tok::ArithCmd
            | Tok::Bang
            | Tok::PipeAmp
            | Tok::CondEnd
            | Tok::Do
            | Tok::Done
            | Tok::Elif
            | Tok::Else
            | Tok::Esac
            | Tok::Fi
            | Tok::If
            | Tok::OrOr
            | Tok::SemiSemi
            | Tok::Then
            | Tok::Time
            | Tok::TimeOpt
            | Tok::TimeIgn
            | Tok::Coproc
            | Tok::Until
            | Tok::While => true,
            Tok::Word => matches!(self.before_last, Tok::Coproc | Tok::Function),
            _ => false,
        }
    }

    fn command_token_position(&self) -> bool {
        self.last == Tok::AssignmentWord
            || (self.redirection_list && self.last == Tok::RedirectionTarget)
            || (self.last != Tok::SemiSemi && self.reserved_word_acceptable())
    }

    fn assignment_acceptable(&self) -> bool {
        self.command_token_position() && !self.case_pattern
    }

    fn time_acceptable(&self) -> bool {
        match self.last {
            Tok::Start | Tok::Semi | Tok::Newline => self.before_last != Tok::Pipe,
            Tok::AndAnd
            | Tok::OrOr
            | Tok::Amp
            | Tok::While
            | Tok::Do
            | Tok::Until
            | Tok::If
            | Tok::Then
            | Tok::Elif
            | Tok::Else
            | Tok::LBrace
            | Tok::LParen
            | Tok::RParen
            | Tok::Bang
            | Tok::Time
            | Tok::TimeOpt
            | Tok::TimeIgn => true,
            _ => false,
        }
    }

    /// Bash's `special_case_tokens`: words whose meaning the previous tokens
    /// decide, checked before alias lookup.
    fn special_case(&mut self, word: &str) -> Option<Tok> {
        if word == "in" {
            if self.last == Tok::Word
                && matches!(self.before_last, Tok::For | Tok::Case | Tok::Select)
            {
                if self.before_last == Tok::Case {
                    self.case_pattern = true;
                    self.esacs_needed += 1;
                }
                self.expecting_in = self.expecting_in.saturating_sub(1);
                return Some(Tok::In);
            }
            if self.expecting_in > 0 && matches!(self.last, Tok::Word | Tok::Newline) {
                if self.case_statement {
                    self.case_pattern = true;
                    self.esacs_needed += 1;
                }
                self.expecting_in -= 1;
                return Some(Tok::In);
            }
        }
        if word == "do" {
            if self.expecting_in > 0 && matches!(self.last, Tok::Newline | Tok::Semi) {
                self.expecting_in -= 1;
                self.nesting += 1;
                return Some(Tok::Do);
            }
            if self.last == Tok::Word && matches!(self.before_last, Tok::For | Tok::Select) {
                self.expecting_in = self.expecting_in.saturating_sub(1);
                self.nesting += 1;
                return Some(Tok::Do);
            }
        }
        if self.esacs_needed > 0 && self.last == Tok::In && word == "esac" {
            self.esacs_needed -= 1;
            self.case_pattern = false;
            self.nesting = self.nesting.saturating_sub(1);
            return Some(Tok::Esac);
        }
        if std::mem::take(&mut self.allow_open_brace) && word == "{" {
            self.open_braces += 1;
            self.nesting += 1;
            return Some(Tok::LBrace);
        }
        if self.last == Tok::ArithForExprs {
            if word == "do" {
                self.nesting += 1;
                return Some(Tok::Do);
            }
            if word == "{" {
                self.open_braces += 1;
                self.nesting += 1;
                return Some(Tok::LBrace);
            }
        }
        if self.open_braces > 0 && self.reserved_word_acceptable() && word == "}" {
            self.open_braces -= 1;
            self.nesting = self.nesting.saturating_sub(1);
            return Some(Tok::RBrace);
        }
        if self.last == Tok::Time && word == "-p" {
            return Some(Tok::TimeOpt);
        }
        if matches!(self.last, Tok::Time | Tok::TimeOpt) && word == "--" {
            return Some(Tok::TimeIgn);
        }
        None
    }

    /// Bash's `CHECK_FOR_RESERVED_WORD`.
    fn reserved_word(&mut self, word: &str, sh_mode: bool) -> Option<Tok> {
        if word.contains('$') || !self.reserved_word_acceptable() {
            return None;
        }
        let tok = match word {
            "if" => Tok::If,
            "then" => Tok::Then,
            "else" => Tok::Else,
            "elif" => Tok::Elif,
            "fi" => Tok::Fi,
            "case" => Tok::Case,
            "esac" => Tok::Esac,
            "for" => Tok::For,
            "while" => Tok::While,
            "until" => Tok::Until,
            "do" => Tok::Do,
            "done" => Tok::Done,
            "in" => Tok::In,
            "time" => Tok::Time,
            "{" => Tok::LBrace,
            "}" => Tok::RBrace,
            "!" => Tok::Bang,
            "select" if !sh_mode => Tok::Select,
            "function" if !sh_mode => Tok::Function,
            "[[" if !sh_mode => Tok::CondStart,
            "]]" if !sh_mode => Tok::CondEnd,
            "coproc" if !sh_mode => Tok::Coproc,
            _ => return None,
        };
        if self.case_pattern && tok != Tok::Esac {
            return None;
        }
        if tok == Tok::Time && !self.time_acceptable() {
            return None;
        }
        if self.case_pattern && matches!(self.last, Tok::Pipe | Tok::LParen) {
            return None;
        }
        match tok {
            Tok::Esac => {
                self.case_pattern = false;
                self.case_statement = false;
                self.esacs_needed = self.esacs_needed.saturating_sub(1);
                self.nesting = self.nesting.saturating_sub(1);
            }
            Tok::Case => {
                self.case_statement = true;
                self.nesting += 1;
            }
            Tok::CondStart => {
                self.condition = true;
                self.nesting += 1;
            }
            Tok::LBrace => {
                self.open_braces += 1;
                self.nesting += 1;
            }
            Tok::RBrace => {
                self.open_braces = self.open_braces.saturating_sub(1);
                self.nesting = self.nesting.saturating_sub(1);
            }
            Tok::If | Tok::Do => self.nesting += 1,
            Tok::Fi | Tok::Done => self.nesting = self.nesting.saturating_sub(1),
            _ => (),
        }
        Some(tok)
    }
}

/// Whether `word` is an assignment as written: a name, an optional array
/// subscript, then `=` or `+=`.
fn is_assignment(word: &str) -> bool {
    let bytes = word.as_bytes();
    let mut index = 0;
    match bytes.first() {
        Some(b) if b.is_ascii_alphabetic() || *b == b'_' => index += 1,
        _ => return false,
    }
    while index < bytes.len() && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_') {
        index += 1;
    }
    if bytes.get(index) == Some(&b'[') {
        let Some(close) = word[index..].find(']') else {
            return false;
        };
        index += close + 1;
    }
    if bytes.get(index) == Some(&b'+') {
        index += 1;
    }
    bytes.get(index) == Some(&b'=')
}

/// One stream of tokens being read.
#[derive(Clone, Debug)]
enum Frame {
    /// Commands: the top level, a process substitution's body, or (in POSIX
    /// mode) a command substitution's body. `substitute` says whether aliases
    /// are substituted in it while it is read.
    Commands {
        lexer: Lexer,
        substitute: bool,
        /// For a process substitution: whether it stands where a redirection
        /// target goes.
        process_substitution: Option<bool>,
    },
    /// Text Bash reads without looking for commands (`((...))`, `name=(...)`):
    /// parentheses are counted to find its end, nothing is looked up.
    Plain {
        depth: u32,
        /// For `((...))`, whether it follows `for`.
        arithmetic: Option<bool>,
    },
    /// Text inside a word the tokenizer reads as a whole (`$((...))`, `${...}`,
    /// and outside POSIX mode `$(...)`): nothing in it is looked at.
    Opaque,
}

/// What observing an operator does to the stack of frames.
enum FrameChange {
    None,
    Push(Frame),
    /// The innermost frame ends; for `((...))`, whether it followed `for`.
    EndPlain(Option<bool>),
    /// A process substitution's body ends; whether it stands where a
    /// redirection target goes.
    EndProcessSubstitution(bool),
}

/// A word the reader replaces with an alias's value.
#[derive(Clone, Debug)]
pub(crate) struct Substitution {
    pub name: String,
    pub value: String,
}

/// Alias substitution and nesting state for a tokenizer reading commands.
#[derive(Clone, Debug)]
pub(crate) struct AliasReading {
    aliases: Option<AliasTable>,
    posix_mode: bool,
    sh_mode: bool,
    frames: Vec<Frame>,
    being_expanded: Vec<String>,
}

impl AliasReading {
    pub(crate) fn new(options: &TokenizerOptions) -> Self {
        Self {
            aliases: None,
            posix_mode: options.posix_mode,
            sh_mode: options.sh_mode,
            frames: vec![Frame::Commands {
                lexer: Lexer::new(),
                substitute: true,
                process_substitution: None,
            }],
            being_expanded: Vec::new(),
        }
    }

    /// Sets the aliases substituted from now on (none while `expand_aliases`
    /// is off) and the options the input is read with.
    pub(crate) fn configure(&mut self, aliases: Option<AliasTable>, options: &TokenizerOptions) {
        self.aliases = aliases.filter(|aliases| !aliases.is_empty());
        self.posix_mode = options.posix_mode;
        self.sh_mode = options.sh_mode;
    }

    /// Whether the input read so far ends outside any construct, so a newline
    /// read now can end a complete command.
    pub(crate) fn at_top_level(&self) -> bool {
        matches!(
            self.frames.as_slice(),
            [Frame::Commands { lexer, .. }] if lexer.nesting == 0 && lexer.parens.is_empty() && !lexer.case_pattern
        )
    }

    /// Enters a construct the tokenizer reads inside a word: a command
    /// substitution (`$(`), or other expansion text.
    pub(crate) fn enter_word_construct(&mut self, command_substitution: bool) {
        self.frames.push(if command_substitution {
            Frame::Commands {
                lexer: Lexer::new(),
                substitute: self.posix_mode,
                process_substitution: None,
            }
        } else {
            Frame::Opaque
        });
    }

    /// Leaves the construct entered last with `enter_word_construct`.
    pub(crate) fn leave_word_construct(&mut self) {
        if self.frames.len() > 1 {
            self.frames.pop();
        }
    }

    /// An alias's value has been read to its end.
    pub(crate) fn alias_ended(&mut self, name: &str, expand_next: bool) {
        if let Some(index) = self.being_expanded.iter().rposition(|n| n == name) {
            self.being_expanded.remove(index);
        }
        if let Some(Frame::Commands { lexer, .. }) = self.frames.last_mut() {
            lexer.expand_next = expand_next;
        }
    }

    /// An alias's value is about to be read in place of its name.
    pub(crate) fn alias_started(&mut self, name: &str) {
        self.being_expanded.push(name.to_owned());
    }

    /// Observes an operator token.
    pub(crate) fn operator(&mut self, op: &str, lookahead: Option<char>, arithmetic: bool) {
        let posix_mode = self.posix_mode;
        let nested = self.frames.len() > 1;
        let change = match self.frames.last_mut() {
            None | Some(Frame::Opaque) => FrameChange::None,
            Some(Frame::Plain { depth, arithmetic: arith }) => {
                if op == "(" {
                    *depth += 1;
                    FrameChange::None
                } else if op == ")" {
                    *depth = depth.saturating_sub(1);
                    if *depth == 0 { FrameChange::EndPlain(*arith) } else { FrameChange::None }
                } else {
                    FrameChange::None
                }
            }
            Some(Frame::Commands { lexer, process_substitution, .. }) => {
                Self::commands_operator(lexer, *process_substitution, nested, posix_mode, op, lookahead, arithmetic)
            }
        };
        match change {
            FrameChange::None => (),
            FrameChange::Push(frame) => self.frames.push(frame),
            FrameChange::EndPlain(arith) => {
                self.frames.pop();
                if let (Some(for_clause), Some(Frame::Commands { lexer, .. })) =
                    (arith, self.frames.last_mut())
                {
                    lexer.shift(if for_clause { Tok::ArithForExprs } else { Tok::ArithCmd });
                }
            }
            FrameChange::EndProcessSubstitution(target) => {
                self.frames.pop();
                if let Some(Frame::Commands { lexer, .. }) = self.frames.last_mut() {
                    lexer.expand_next = false;
                    lexer.shift(if target { Tok::RedirectionTarget } else { Tok::Word });
                }
            }
        }
    }

    fn commands_operator(
        lexer: &mut Lexer,
        process_substitution: Option<bool>,
        nested: bool,
        posix_mode: bool,
        op: &str,
        lookahead: Option<char>,
        arithmetic: bool,
    ) -> FrameChange {
        if lexer.condition {
            return FrameChange::None;
        }
        match op {
            "(" => {
                if std::mem::take(&mut lexer.process_substitution_next) {
                    return FrameChange::Push(Frame::Commands {
                        lexer: Lexer::new(),
                        substitute: posix_mode,
                        process_substitution: Some(lexer.last == Tok::Redirection),
                    });
                }
                if std::mem::take(&mut lexer.compound_assignment_next) {
                    return FrameChange::Push(Frame::Plain { depth: 1, arithmetic: None });
                }
                if arithmetic {
                    return FrameChange::Push(Frame::Plain {
                        depth: 1,
                        arithmetic: Some(lexer.last == Tok::For),
                    });
                }
                if !lexer.case_pattern {
                    lexer.parens.push(if lexer.last == Tok::Word {
                        Paren::FunctionDefinition
                    } else {
                        Paren::Subshell
                    });
                }
                lexer.shift(Tok::LParen);
            }
            ")" => {
                if lexer.case_pattern {
                    lexer.case_pattern = false;
                } else if let Some(paren) = lexer.parens.pop() {
                    if paren == Paren::FunctionDefinition
                        && lexer.last == Tok::LParen
                        && lexer.before_last == Tok::Word
                    {
                        lexer.allow_open_brace = true;
                        lexer.expand_next = false;
                    }
                } else if let Some(target) = process_substitution
                    && nested
                {
                    return FrameChange::EndProcessSubstitution(target);
                }
                lexer.shift(Tok::RParen);
            }
            "\n" => {
                lexer.expand_next = false;
                lexer.shift(Tok::Newline);
            }
            ";" => lexer.shift(Tok::Semi),
            "&" => lexer.shift(Tok::Amp),
            "&&" => lexer.shift(Tok::AndAnd),
            "||" => lexer.shift(Tok::OrOr),
            "|" => lexer.shift(Tok::Pipe),
            "|&" => lexer.shift(Tok::PipeAmp),
            ";;" | ";&" | ";;&" => {
                lexer.case_pattern = true;
                lexer.expand_next = false;
                lexer.shift(Tok::SemiSemi);
            }
            _ => {
                // `<` or `>` directly followed by `(` begins a process
                // substitution; any other operator here is a redirection.
                if matches!(op, "<" | ">") && lookahead == Some('(') {
                    lexer.process_substitution_next = true;
                    return FrameChange::None;
                }
                if op.starts_with(['<', '>']) {
                    lexer.expand_next = false;
                }
                if lexer.last != Tok::Number {
                    lexer.redirection_list = lexer.reserved_word_acceptable()
                        || (lexer.redirection_list && lexer.last == Tok::RedirectionTarget);
                }
                lexer.shift(Tok::Redirection);
            }
        }
        FrameChange::None
    }

    /// Observes a word token, returning the alias to read in its place when it
    /// is one. `quoted` is whether the tokenizer read quoting of the word's
    /// own (Bash's reader never takes a quoted word for an alias).
    pub(crate) fn word(&mut self, word: &str, quoted: bool, lookahead: Option<char>) -> Option<Substitution> {
        let posix_mode = self.posix_mode;
        let sh_mode = self.sh_mode;
        let Some(Frame::Commands { lexer, substitute, .. }) = self.frames.last_mut() else {
            return None;
        };
        let word = word.trim_start_matches([' ', '\t']);
        if lexer.condition {
            if word == "]]" {
                lexer.condition = false;
                lexer.nesting = lexer.nesting.saturating_sub(1);
                lexer.shift(Tok::CondEnd);
            }
            return None;
        }
        lexer.process_substitution_next = false;
        lexer.compound_assignment_next = false;

        if lexer.last == Tok::Redirection {
            lexer.expand_next = false;
            lexer.shift(Tok::RedirectionTarget);
            return None;
        }

        let redirects_next = matches!(lookahead, Some('<' | '>'));
        let redirection_word = redirects_next
            && (word.bytes().all(|b| b.is_ascii_digit())
                || (word.len() > 2 && word.starts_with('{') && word.ends_with('}')));
        if !word.is_empty() && redirection_word {
            lexer.redirection_list = lexer.reserved_word_acceptable()
                || (lexer.redirection_list && lexer.last == Tok::RedirectionTarget);
            lexer.shift(Tok::Number);
            return None;
        }

        if !quoted && let Some(tok) = lexer.special_case(word) {
            lexer.shift(tok);
            return None;
        }

        if posix_mode && !quoted && let Some(tok) = lexer.reserved_word(word, sh_mode) {
            lexer.shift(tok);
            return None;
        }

        if !quoted && *substitute {
            if let Some(aliases) = &self.aliases {
                let eligible = lexer.expand_next || lexer.assignment_acceptable();
                if eligible
                    && !self.being_expanded.iter().any(|name| name == word)
                    && let Some(value) = aliases.get(word)
                {
                    return Some(Substitution { name: word.to_owned(), value: value.clone() });
                }
            }
            lexer.expand_next = false;
        }

        if !posix_mode && !quoted && let Some(tok) = lexer.reserved_word(word, sh_mode) {
            lexer.shift(tok);
            return None;
        }

        let assignment = is_assignment(word);
        if assignment && lookahead == Some('(') && word.ends_with('=') {
            lexer.compound_assignment_next = true;
        }
        let tok = if assignment && lexer.assignment_acceptable() {
            Tok::AssignmentWord
        } else {
            Tok::Word
        };
        match lexer.last {
            Tok::Function => lexer.allow_open_brace = true,
            Tok::Case | Tok::Select | Tok::For => lexer.expecting_in += 1,
            _ => (),
        }
        lexer.shift(tok);
        None
    }
}

#[cfg(test)]
mod tests {
    use super::is_assignment;

    #[test]
    fn assignment_words() {
        for word in ["a=", "a=1", "_b+=x", "c[1]=y", "d[$i]+=z"] {
            assert!(is_assignment(word), "{word}");
        }
        for word in ["=a", "1a=", "a", "a[1", "a-b=c"] {
            assert!(!is_assignment(word), "{word}");
        }
    }
}
