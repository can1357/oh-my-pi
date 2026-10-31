//! Parser for shell words, used in expansion and other contexts.
//!
//! Implements support for:
//!
//! - Text quoting (single, double, ANSI C).
//! - Escape sequences.
//! - Tilde prefixes.
//! - Parameter expansion expressions.
//! - Command substitution expressions.
//! - Arithmetic expansion expressions.

use std::fmt::Debug;
use std::fmt::Display;

use crate::ParserOptions;
use crate::SourceSpan;
use crate::ast;
use crate::error;

/// Encapsulates a `WordPiece` together with its position in the string it came from.
#[derive(Clone, Debug)]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct WordPieceWithSource {
    /// The word piece.
    pub piece: WordPiece,
    /// The start index of the piece in the source string.
    pub start_index: usize,
    /// The end index of the piece in the source string.
    pub end_index: usize,
}

/// Represents a piece of a word.
#[derive(Clone, Debug)]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum WordPiece {
    /// A simple unquoted, unescaped string.
    Text(String),
    /// A string that is single-quoted.
    SingleQuotedText(String),
    /// A string that is ANSI-C quoted.
    AnsiCQuotedText(String),
    /// A sequence of pieces that are embedded in double quotes.
    DoubleQuotedSequence(Vec<WordPieceWithSource>),
    /// Gettext enabled variant of [`WordPiece::DoubleQuotedSequence`].
    GettextDoubleQuotedSequence(Vec<WordPieceWithSource>),
    /// A tilde expansion.
    TildeExpansion(TildeExpr),
    /// A parameter expansion.
    ParameterExpansion(ParameterExpr),
    /// A command substitution.
    CommandSubstitution(String),
    /// A backquoted command substitution.
    BackquotedCommandSubstitution(String),
    /// An escape sequence.
    EscapeSequence(String),
    /// An arithmetic expression.
    ArithmeticExpression(ast::UnexpandedArithmeticExpr),
}

/// Represents an expandable tilde expression (e.g., ~).
#[derive(Clone, Debug)]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum TildeExpr {
    /// `~`
    Home,
    /// `~<user>`
    UserHome(String),
    /// `~+`
    WorkingDir,
    /// `~-`
    OldWorkingDir,
    /// Represents a tilde expansion of the form `~+N`, referring to the Nth directory in
    /// the shell's directory stack, starting at the top of the stack. Note that the directory
    /// stack is expected to contains the current working directory as its topmost entry.
    NthDirFromTopOfDirStack {
        /// Index into the directory stack (zero-based: 0 is the top of the stack).
        n: usize,
        /// Whether the '+' prefix was explicitly used.
        plus_used: bool,
    },
    /// Represents a tilde expansion of the form `~-N`, referring to the Nth directory in
    /// the shell's directory stack, starting at the bottom of the stack.
    NthDirFromBottomOfDirStack {
        /// Index into the directory stack (zero-based: 0 is the bottom of the stack).
        n: usize,
    },
}

/// Type of a parameter test.
#[derive(Clone, Debug)]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum ParameterTestType {
    /// Check for unset or null.
    UnsetOrNull,
    /// Check for unset.
    Unset,
}

/// A parameter, used in a parameter expansion.
#[derive(Clone, Debug)]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum Parameter {
    /// A 0-indexed positional parameter.
    Positional(u32),
    /// A special parameter.
    Special(SpecialParameter),
    /// A named variable.
    Named(String),
    /// An index into a named variable.
    NamedWithIndex {
        /// Variable name.
        name: String,
        /// Index.
        index: String,
    },
    /// A named array variable with all indices.
    NamedWithAllIndices {
        /// Variable name.
        name: String,
        /// Whether to concatenate the values.
        concatenate: bool,
    },
}

impl Display for Parameter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Positional(n) => write!(f, "${n}"),
            Self::Special(s) => write!(f, "${s}"),
            Self::Named(name) => write!(f, "${{{name}}}"),
            Self::NamedWithIndex { name, index } => {
                write!(f, "${{{name}[{index}]}}")
            }
            Self::NamedWithAllIndices { name, concatenate } => {
                if *concatenate {
                    write!(f, "${{{name}[*]}}")
                } else {
                    write!(f, "${{{name}[@]}}")
                }
            }
        }
    }
}

/// A special parameter, used in a parameter expansion.
#[derive(Clone, Debug)]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum SpecialParameter {
    /// All positional parameters.
    AllPositionalParameters {
        /// Whether to concatenate the values.
        concatenate: bool,
    },
    /// The count of positional parameters.
    PositionalParameterCount,
    /// The last exit status in the shell.
    LastExitStatus,
    /// The current shell option flags.
    CurrentOptionFlags,
    /// The current shell process ID.
    ProcessId,
    /// The last background process ID managed by the shell.
    LastBackgroundProcessId,
    /// The name of the shell.
    ShellName,
}

impl Display for SpecialParameter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AllPositionalParameters { concatenate } => {
                if *concatenate {
                    write!(f, "*")
                } else {
                    write!(f, "@")
                }
            }
            Self::PositionalParameterCount => write!(f, "#"),
            Self::LastExitStatus => write!(f, "?"),
            Self::CurrentOptionFlags => write!(f, "-"),
            Self::ProcessId => write!(f, "$"),
            Self::LastBackgroundProcessId => write!(f, "!"),
            Self::ShellName => write!(f, "0"),
        }
    }
}

/// A parameter expression, used in a parameter expansion.
#[derive(Clone, Debug)]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum ParameterExpr {
    /// A parameter, with optional indirection.
    Parameter {
        /// The parameter.
        parameter: Parameter,
        /// Whether to treat the expanded parameter as an indirect
        /// reference, which should be subsequently dereferenced
        /// for the expansion.
        indirect: bool,
    },
    /// Conditionally use default values.
    UseDefaultValues {
        /// The parameter.
        parameter: Parameter,
        /// Whether to treat the expanded parameter as an indirect
        /// reference, which should be subsequently dereferenced
        /// for the expansion.
        indirect: bool,
        /// The type of test to perform.
        test_type: ParameterTestType,
        /// Default value to conditionally use.
        default_value: Option<String>,
    },
    /// Conditionally assign default values.
    AssignDefaultValues {
        /// The parameter.
        parameter: Parameter,
        /// Whether to treat the expanded parameter as an indirect
        /// reference, which should be subsequently dereferenced
        /// for the expansion.
        indirect: bool,
        /// The type of test to perform.
        test_type: ParameterTestType,
        /// Default value to conditionally assign.
        default_value: Option<String>,
    },
    /// Indicate error if null or unset.
    IndicateErrorIfNullOrUnset {
        /// The parameter.
        parameter: Parameter,
        /// Whether to treat the expanded parameter as an indirect
        /// reference, which should be subsequently dereferenced
        /// for the expansion.
        indirect: bool,
        /// The type of test to perform.
        test_type: ParameterTestType,
        /// Error message to conditionally yield.
        error_message: Option<String>,
    },
    /// Conditionally use an alternative value.
    UseAlternativeValue {
        /// The parameter.
        parameter: Parameter,
        /// Whether to treat the expanded parameter as an indirect
        /// reference, which should be subsequently dereferenced
        /// for the expansion.
        indirect: bool,
        /// The type of test to perform.
        test_type: ParameterTestType,
        /// Alternative value to conditionally use.
        alternative_value: Option<String>,
    },
    /// Compute the length of the given parameter.
    ParameterLength {
        /// The parameter.
        parameter: Parameter,
        /// Whether to treat the expanded parameter as an indirect
        /// reference, which should be subsequently dereferenced
        /// for the expansion.
        indirect: bool,
    },
    /// Remove the smallest suffix from the given string matching the given pattern.
    RemoveSmallestSuffixPattern {
        /// The parameter.
        parameter: Parameter,
        /// Whether to treat the expanded parameter as an indirect
        /// reference, which should be subsequently dereferenced
        /// for the expansion.
        indirect: bool,
        /// Optionally provides a pattern to match.
        pattern: Option<String>,
    },
    /// Remove the largest suffix from the given string matching the given pattern.
    RemoveLargestSuffixPattern {
        /// The parameter.
        parameter: Parameter,
        /// Whether to treat the expanded parameter as an indirect
        /// reference, which should be subsequently dereferenced
        /// for the expansion.
        indirect: bool,
        /// Optionally provides a pattern to match.
        pattern: Option<String>,
    },
    /// Remove the smallest prefix from the given string matching the given pattern.
    RemoveSmallestPrefixPattern {
        /// The parameter.
        parameter: Parameter,
        /// Whether to treat the expanded parameter as an indirect
        /// reference, which should be subsequently dereferenced
        /// for the expansion.
        indirect: bool,
        /// Optionally provides a pattern to match.
        pattern: Option<String>,
    },
    /// Remove the largest prefix from the given string matching the given pattern.
    RemoveLargestPrefixPattern {
        /// The parameter.
        parameter: Parameter,
        /// Whether to treat the expanded parameter as an indirect
        /// reference, which should be subsequently dereferenced
        /// for the expansion.
        indirect: bool,
        /// Optionally provides a pattern to match.
        pattern: Option<String>,
    },
    /// Extract a substring from the given parameter.
    Substring {
        /// The parameter.
        parameter: Parameter,
        /// Whether to treat the expanded parameter as an indirect
        /// reference, which should be subsequently dereferenced
        /// for the expansion.
        indirect: bool,
        /// Arithmetic expression that will be expanded to compute the offset
        /// at which the substring should be extracted.
        offset: ast::UnexpandedArithmeticExpr,
        /// Optionally provides an arithmetic expression that will be expanded
        /// to compute the length of substring to be extracted; if left
        /// unspecified, the remainder of the string will be extracted.
        length: Option<ast::UnexpandedArithmeticExpr>,
    },
    /// Transform the given parameter.
    Transform {
        /// The parameter.
        parameter: Parameter,
        /// Whether to treat the expanded parameter as an indirect
        /// reference, which should be subsequently dereferenced
        /// for the expansion.
        indirect: bool,
        /// Type of transformation to apply.
        op: ParameterTransformOp,
    },
    /// Uppercase the first character of the given parameter.
    UppercaseFirstChar {
        /// The parameter.
        parameter: Parameter,
        /// Whether to treat the expanded parameter as an indirect
        /// reference, which should be subsequently dereferenced
        /// for the expansion.
        indirect: bool,
        /// Optionally provides a pattern to match.
        pattern: Option<String>,
    },
    /// Uppercase the portion of the given parameter matching the given pattern.
    UppercasePattern {
        /// The parameter.
        parameter: Parameter,
        /// Whether to treat the expanded parameter as an indirect
        /// reference, which should be subsequently dereferenced
        /// for the expansion.
        indirect: bool,
        /// Optionally provides a pattern to match.
        pattern: Option<String>,
    },
    /// Lowercase the first character of the given parameter.
    LowercaseFirstChar {
        /// The parameter.
        parameter: Parameter,
        /// Whether to treat the expanded parameter as an indirect
        /// reference, which should be subsequently dereferenced
        /// for the expansion.
        indirect: bool,
        /// Optionally provides a pattern to match.
        pattern: Option<String>,
    },
    /// Lowercase the portion of the given parameter matching the given pattern.
    LowercasePattern {
        /// The parameter.
        parameter: Parameter,
        /// Whether to treat the expanded parameter as an indirect
        /// reference, which should be subsequently dereferenced
        /// for the expansion.
        indirect: bool,
        /// Optionally provides a pattern to match.
        pattern: Option<String>,
    },
    /// Replace occurrences of the given pattern in the given parameter.
    ReplaceSubstring {
        /// The parameter.
        parameter: Parameter,
        /// Whether to treat the expanded parameter as an indirect
        /// reference, which should be subsequently dereferenced
        /// for the expansion.
        indirect: bool,
        /// Pattern to match.
        pattern: String,
        /// Replacement string.
        replacement: Option<String>,
        /// Kind of match to perform.
        match_kind: SubstringMatchKind,
    },
    /// Select variable names from the environment with a given prefix.
    VariableNames {
        /// The prefix to match.
        prefix: String,
        /// Whether to concatenate the results.
        concatenate: bool,
    },
    /// Select member keys from the named array.
    MemberKeys {
        /// Name of the array variable.
        variable_name: String,
        /// Whether to concatenate the results.
        concatenate: bool,
    },
}

/// Kind of substring match.
#[derive(Clone, Debug)]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum SubstringMatchKind {
    /// Match the prefix of the string.
    Prefix,
    /// Match the suffix of the string.
    Suffix,
    /// Match the first occurrence in the string.
    FirstOccurrence,
    /// Match all instances in the string.
    Anywhere,
}

/// Kind of operation to apply to a parameter.
#[derive(Clone, Debug)]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum ParameterTransformOp {
    /// Capitalizate initials.
    CapitalizeInitial,
    /// Expand escape sequences.
    ExpandEscapeSequences,
    /// Possibly quote with arrays expanded.
    PossiblyQuoteWithArraysExpanded {
        /// Whether or not to yield separate words.
        separate_words: bool,
    },
    /// Apply prompt expansion.
    PromptExpand,
    /// Quote the parameter.
    Quoted,
    /// Translate to a format usable in an assignment/declaration.
    ToAssignmentLogic,
    /// Translate to the parameter's attribute flags.
    ToAttributeFlags,
    /// Translate to lowercase.
    ToLowerCase,
    /// Translate to uppercase.
    ToUpperCase,
}

/// Represents a sub-word that is either a brace expression or some other word text.
#[derive(Clone, Debug)]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum BraceExpressionOrText {
    /// A brace expression.
    Expr(BraceExpression),
    /// Other word text.
    Text(String),
}

/// Represents a brace expression to be expanded.
pub type BraceExpression = Vec<BraceExpressionMember>;

/// Member of a brace expression.
#[derive(Clone, Debug)]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum BraceExpressionMember {
    /// An inclusive numerical sequence.
    NumberSequence {
        /// Start of the sequence.
        start: i64,
        /// Inclusive end of the sequence.
        end: i64,
        /// Increment value.
        increment: i64,
    },
    /// An inclusive character sequence.
    CharSequence {
        /// Start of the sequence.
        start: char,
        /// Inclusive end of the sequence.
        end: char,
        /// Increment value.
        increment: i64,
    },
    /// Child text or expressions.
    Child(Vec<BraceExpressionOrText>),
}

/// Parse a word into its constituent pieces.
///
/// # Arguments
///
/// * `word` - The word to parse.
/// * `options` - The parser options to use.
pub fn parse(
    word: &str,
    options: &ParserOptions,
) -> Result<Vec<WordPieceWithSource>, error::WordParseError> {
    cacheable_parse(word.to_owned(), options.to_owned())
}

#[cached::proc_macro::cached(size = 64, result = true)]
fn cacheable_parse(
    word: String,
    options: ParserOptions,
) -> Result<Vec<WordPieceWithSource>, error::WordParseError> {
    tracing::debug!(target: "expansion", "Parsing word '{}'", word);

    let pieces = parse_whole(word.as_str(), &options)?;

    tracing::debug!(target: "expansion", "Parsed word '{}' => {{{:?}}}", word, pieces);

    Ok(pieces)
}

/// Parses the whole of `word` in one call of the grammar, without the cache.
fn parse_whole(
    word: &str,
    options: &ParserOptions,
) -> Result<Vec<WordPieceWithSource>, error::WordParseError> {
    expansion_parser::unexpanded_word(word, options)
        .map_err(|err| error::WordParseError::Word(word.to_owned(), err.into()))
}

/// Parses `word` as [`parse`] does, without its cache: for a caller that
/// parses a word too long to be worth caching, as [`SteppedParse`]'s caller
/// does for the error of a word that does not parse.
///
/// # Arguments
///
/// * `word` - The word to parse.
/// * `options` - The parser options to use.
pub fn parse_uncached(
    word: &str,
    options: &ParserOptions,
) -> Result<Vec<WordPieceWithSource>, error::WordParseError> {
    parse_whole(word, options)
}

/// Parses a word a step at a time, to exactly the pieces [`parse`] gives it.
///
/// [`parse`] is one call of a PEG that, before it starts, matches the whole input once for a
/// trace hook, and whose literal rule then tries every other kind of piece at every character
/// of a literal: a word of 16 MiB is one synchronous parse of hundreds of milliseconds. This is
/// for a caller that must not hold its thread that long. It scans literal text itself, the way
/// the grammar's literal rules read it, and hands each other piece to the grammar started at
/// that piece's offset in the whole word, so the positions recorded and the colon looked back
/// for are the ones [`parse`] sees. Literal text is a single piece however many steps it spans.
///
/// Some pieces are what the grammar makes of them only if a character later in the word
/// closes them: a backquote inside double quotes, and a `$(`, `$((`, `$[` or `${`. Where none
/// does, the grammar reads to the end of the word before it gives up, which is one step of
/// any length. So that character is looked for first, a stride at a time, and the grammar is
/// handed the piece only once it is known to be there. Where it is not, the piece is what the
/// grammar falls back to: a backquote of text, or a `$` of text.
///
/// A step that fails ends the parse, and [`Self::finish`] then parses the whole word as
/// [`parse`] does, without its cache, so an error is the error [`parse`] gives.
pub struct SteppedParse<'a> {
    word: &'a str,
    options: &'a ParserOptions,
    /// Where the next step starts.
    at: usize,
    /// The pieces parsed so far, outside double quotes.
    pieces: Vec<WordPieceWithSource>,
    /// The double-quoted sequence the next step is inside, if any.
    quote: Option<OpenQuote>,
    /// The literal text the next step goes on scanning, if any.
    text: Option<OpenText>,
    /// Whether the tilde prefix a word can start with has been tried.
    started: bool,
    /// Bytes that end unquoted literal text besides the ones that always do: the stop
    /// condition `non_brace_expr_text` gives `word_piece` inside a brace expansion.
    stops: &'static [u8],
    /// Whether the parse ends with the first piece outside double quotes, for a brace
    /// expansion that needs to know only where one word piece ends.
    one_piece: bool,
    /// The closing character the next step goes on looking for, if any.
    search: Option<Search>,
    /// The first backquote inside double quotes found not to close. No backquote after it
    /// closes either: the search from it reached the end of the word, and took every later
    /// backquote as the second half of a backslash and a backquote, so the search from any of
    /// those is the end of that same search.
    unclosed_backquote: Option<usize>,
    /// What the searches so far know of where `)`, `}` and `]` are, in that order.
    closers: [CloserMemo; 3],
    /// How many bytes the steps taken so far have read.
    read: usize,
    /// The most of the word, from where a piece starts, that the grammar may be handed. Past
    /// it the parse is abandoned rather than hand it over: see [`Self::limit_grammar_reach`].
    grammar_reach: usize,
    /// Whether a piece would have handed the grammar more than [`Self::grammar_reach`].
    abandoned: std::cell::Cell<bool>,
    progress: Progress,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Progress {
    Running,
    Done,
    Failed,
}

/// A double-quoted sequence whose closing quote is still ahead.
struct OpenQuote {
    start: usize,
    gettext: bool,
    pieces: Vec<WordPieceWithSource>,
}

/// Literal text whose end is still ahead.
struct OpenText {
    kind: TextKind,
    start: usize,
    text: String,
}

#[derive(Clone, Copy)]
enum TextKind {
    /// Mirrors `unquoted_literal_text` outside a command.
    Unquoted,
    /// Mirrors `double_quote_body_text`.
    DoubleQuoted,
    /// The body of `single_quoted_literal_text`.
    SingleQuoted,
    /// The body of `ansi_c_quoted_text`.
    AnsiC,
    /// The name of an unbraced `$name`: mirrors `variable_name`, after the `$`.
    ParameterName,
}

/// How a scan of literal text stopped.
enum TextEnd {
    /// The step's stride ran out first.
    Stride,
    /// The text ends here.
    Closed,
    /// The text ends where this piece, which the scan had to parse to find the end, begins.
    Before(WordPieceWithSource),
    /// The text has reached a backquote, which ends it only if something closes it.
    Backquote,
}

/// A piece the step has reached, which the grammar is handed only once the character that
/// closes it is found.
#[derive(Clone, Copy)]
struct Search {
    /// Where the piece starts: the backquote, or the `$`.
    at: usize,
    /// Where the search goes on.
    scan: usize,
    kind: SearchKind,
}

#[derive(Clone, Copy)]
enum SearchKind {
    /// The backquote that closes one inside double quotes. Mirrors `backquoted_char`.
    Backquote,
    /// The character a `$(`, `$((`, `$[` or `${` cannot match without, anywhere after it.
    Closer(u8),
}

/// How a search for a closing character stopped.
enum SearchEnd {
    /// The step's stride ran out first, here.
    Stride(usize),
    Found,
    /// The word ends first.
    Absent,
}

/// What the searches so far know of where one closing character is.
#[derive(Clone, Copy)]
struct CloserMemo {
    /// A place where it is, which every search that has not gone past it would find.
    found: Option<usize>,
    /// Where it is absent from, to the end of the word.
    absent_from: Option<usize>,
}

const NO_CLOSER_KNOWN: CloserMemo = CloserMemo {
    found: None,
    absent_from: None,
};

/// A step found the word does not parse.
struct Failed;

impl<'a> SteppedParse<'a> {
    /// Starts parsing `word` with `options`.
    pub const fn new(word: &'a str, options: &'a ParserOptions) -> Self {
        Self {
            word,
            options,
            at: 0,
            pieces: Vec::new(),
            quote: None,
            text: None,
            started: false,
            stops: &[],
            one_piece: false,
            search: None,
            unclosed_backquote: None,
            closers: [NO_CLOSER_KNOWN; 3],
            read: 0,
            grammar_reach: usize::MAX,
            abandoned: std::cell::Cell::new(false),
            progress: Progress::Running,
        }
    }

    /// Starts parsing the one word piece at `at` in `word`, whose unquoted literal text also
    /// ends before any of `stops`. `at` begins a piece, and is no tilde prefix.
    const fn one_piece_at(
        word: &'a str,
        options: &'a ParserOptions,
        at: usize,
        stops: &'static [u8],
    ) -> Self {
        Self {
            word,
            options,
            at,
            pieces: Vec::new(),
            quote: None,
            text: None,
            started: true,
            stops,
            one_piece: true,
            search: None,
            unclosed_backquote: None,
            closers: [NO_CLOSER_KNOWN; 3],
            read: 0,
            grammar_reach: usize::MAX,
            abandoned: std::cell::Cell::new(false),
            progress: Progress::Running,
        }
    }

    /// Abandons the parse rather than hand the grammar a piece with more than `bytes` of the
    /// word from where the piece starts.
    ///
    /// A piece the grammar is handed is parsed in one call, and a piece that fails can read
    /// to the end of the word before it does: a `$((\))` followed by 16 MiB took 281 ms in one
    /// step, and a `$(case …)` prompt of 16 MiB that parses 174 ms. Literal text, quoted text
    /// and names never reach the grammar, so a word made of those is still parsed a step at a
    /// time. A word that would hand the grammar more is [`Self::abandoned`], and its caller
    /// parses it whole ([`parse_uncached`]) where that cannot hold its thread, which gives
    /// what this would have given.
    pub const fn limit_grammar_reach(&mut self, bytes: usize) {
        self.grammar_reach = bytes;
    }

    /// Whether the parse was abandoned at a piece past the reach [`Self::limit_grammar_reach`]
    /// set. An abandoned parse is also [`Self::failed`].
    #[must_use]
    pub const fn abandoned(&self) -> bool {
        self.abandoned.get()
    }

    /// Whether the grammar may be handed the piece at `at`, marking the parse abandoned if
    /// not.
    fn within_reach(&self, at: usize) -> bool {
        if self.word.len().saturating_sub(at) > self.grammar_reach {
            self.abandoned.set(true);
            return false;
        }
        true
    }

    /// Takes the next step, and returns whether there are steps left to take.
    ///
    /// A step stops once it has read `bytes` bytes of the word or made `pieces` pieces,
    /// whichever comes first, and always makes some progress. Literal text and the search for
    /// a closing character are read a byte at a time and can stop anywhere; any other piece
    /// is parsed whole, so a step can run past `bytes` by the length of the last piece it
    /// parsed.
    pub fn step(&mut self, bytes: usize, pieces: usize) -> bool {
        let mut budget = bytes.max(1);
        let pieces = pieces.max(1);
        let mut made = 0;
        while self.progress == Progress::Running && budget > 0 && made < pieces {
            let before = self.cursor();
            let result = self.advance(before.saturating_add(budget));
            // The parse can move back: text found to go on past a backquote or a `$` resumes
            // just after it, and a `$"` that never closes resumes at its `"`. A position is
            // therefore no measure of a step; what it read is, and reading the same bytes
            // again counts again.
            let read = self.cursor().saturating_sub(before);
            self.read = self.read.saturating_add(read);
            budget = budget.saturating_sub(read);
            match result {
                Ok(count) => made += count,
                Err(Failed) => self.progress = Progress::Failed,
            }
            // What the step made past an abandoned piece is not what the grammar would have
            // made of it, so the parse ends there and its caller parses the whole word.
            if self.abandoned.get() {
                self.progress = Progress::Failed;
            }
        }
        self.progress == Progress::Running
    }

    /// How far the parse has read: where the search under way goes on, or else where the
    /// next step starts.
    fn cursor(&self) -> usize {
        self.search.map_or(self.at, |search| search.scan)
    }

    /// Whether a step failed, so that [`Self::finish`] would parse the whole word for its
    /// error. A caller that must not hold its thread for that parse can run
    /// [`parse_uncached`] where it may.
    #[must_use]
    pub const fn failed(&self) -> bool {
        matches!(self.progress, Progress::Failed)
    }

    /// Takes whatever steps are left, and returns what [`parse`] returns for the word.
    pub fn finish(mut self) -> Result<Vec<WordPieceWithSource>, error::WordParseError> {
        while self.step(usize::MAX, usize::MAX) {}
        if self.progress == Progress::Failed {
            return parse_whole(self.word, self.options);
        }
        Ok(self.pieces)
    }

    /// Makes progress from `self.at`, and returns how many pieces that made.
    fn advance(&mut self, limit: usize) -> Result<usize, Failed> {
        if !self.started {
            self.started = true;
            return Ok(self.tilde_prefix());
        }
        if let Some(search) = self.search.take() {
            return self.continue_search(search, limit);
        }
        if let Some(text) = self.text.take() {
            return self.continue_text(text, limit);
        }
        let Some(&byte) = self.word.as_bytes().get(self.at) else {
            // The word has ended. Inside double quotes that is a quote never closed.
            if let Some(quote) = self.quote.take() {
                if !quote.gettext {
                    return Err(Failed);
                }
                // A `$"` that never closes is no gettext string, and `dollar_sign_word_piece`
                // takes its `$` alone. The `"` after it then begins a double-quoted sequence
                // with the same body, which fails here in its turn.
                return Ok(self.push(WordPieceWithSource {
                    piece: WordPiece::Text("$".to_owned()),
                    start_index: quote.start,
                    end_index: quote.start + 1,
                }));
            }
            self.progress = Progress::Done;
            return Ok(0);
        };
        if self.quote.is_some() {
            self.quoted_piece(byte)
        } else {
            self.unquoted_piece(byte)
        }
    }

    /// Starts the piece at `self.at`, outside double quotes. Mirrors `word_piece`.
    fn unquoted_piece(&mut self, byte: u8) -> Result<usize, Failed> {
        let at = self.at;
        match (byte, self.word.as_bytes().get(at + 1)) {
            (b'\'', _) => Ok(self.open_body(TextKind::SingleQuoted, at, at + 1)),
            (b'"', _) => Ok(self.open_quote(false, at, at + 1)),
            // An ANSI-C string that does not close fails here: a `$` before a `'` begins no
            // other piece. A gettext string that does not close is handled where the word ends.
            (b'$', Some(b'\'')) => Ok(self.open_body(TextKind::AnsiC, at, at + 2)),
            (b'$', Some(b'"')) => Ok(self.open_quote(true, at, at + 2)),
            (b'$', Some(&next)) if starts_variable_name(next) => {
                Ok(self.open_body(TextKind::ParameterName, at, at + 1))
            }
            (b'$', Some(&open @ (b'(' | b'[' | b'{'))) => Ok(self.search_closer(at, open)),
            // Nothing a `$` or a backquote begins is literal text here, so the grammar's
            // literal rule, the one that would scan a long run, is never reached. A backquote
            // that never closes fails the word, and the whole parse reports it.
            (b'$' | b'`', _) => {
                let piece = self.grammar_piece_at(at).ok_or(Failed)?;
                Ok(self.push(piece))
            }
            (b'\\', Some(_)) => self.escape_sequence(),
            (b'~', _) => match self.tilde_after_colon_at(at) {
                Some(piece) => Ok(self.push(piece)),
                None => self.open_literal(TextKind::Unquoted),
            },
            _ => self.open_literal(TextKind::Unquoted),
        }
    }

    /// Starts the piece at `self.at`, inside double quotes. Mirrors `double_quoted_word_piece`.
    fn quoted_piece(&mut self, byte: u8) -> Result<usize, Failed> {
        let at = self.at;
        match (byte, self.word.as_bytes().get(at + 1)) {
            (b'"', _) => {
                let quote = self.quote.take().ok_or(Failed)?;
                let piece = if quote.gettext {
                    WordPiece::GettextDoubleQuotedSequence(quote.pieces)
                } else {
                    WordPiece::DoubleQuotedSequence(quote.pieces)
                };
                self.at = at + 1;
                Ok(self.push(WordPieceWithSource {
                    piece,
                    start_index: quote.start,
                    end_index: at + 1,
                }))
            }
            (b'\\', Some(b'$' | b'`' | b'"' | b'\\')) => self.escape_sequence(),
            (b'$', Some(&next)) if starts_variable_name(next) => {
                Ok(self.open_body(TextKind::ParameterName, at, at + 1))
            }
            (b'$', Some(&open @ (b'(' | b'[' | b'{'))) => Ok(self.search_closer(at, open)),
            (b'`', _) => self.search_backquote(at),
            (b'$', _) => match self.dollar_sign_piece_at(at) {
                Some(piece) => Ok(self.push(piece)),
                None => self.open_literal(TextKind::DoubleQuoted),
            },
            _ => self.open_literal(TextKind::DoubleQuoted),
        }
    }

    /// Scans more of the literal text `text`, and returns how many pieces that made.
    fn continue_text(&mut self, mut text: OpenText, limit: usize) -> Result<usize, Failed> {
        let (end, how) = match text.kind {
            TextKind::Unquoted => self.unquoted_text_end(limit),
            TextKind::DoubleQuoted => self.double_quoted_text_end(limit),
            TextKind::SingleQuoted => self.single_quoted_body_end(limit)?,
            TextKind::AnsiC => self.ansi_c_body_end(limit)?,
            TextKind::ParameterName => self.variable_name_end(limit),
        };
        text.text.push_str(self.word.get(self.at..end).ok_or(Failed)?);
        self.at = end;
        let next = match how {
            TextEnd::Stride => {
                self.text = Some(text);
                return Ok(0);
            }
            TextEnd::Closed => None,
            TextEnd::Before(piece) => Some(piece),
            TextEnd::Backquote => {
                self.text = Some(text);
                self.search = Some(Search {
                    at: end,
                    scan: end + 1,
                    kind: SearchKind::Backquote,
                });
                return Ok(0);
            }
        };
        let (piece, end_index) = match text.kind {
            TextKind::Unquoted | TextKind::DoubleQuoted => (WordPiece::Text(text.text), end),
            // The scan stopped on the closing quote, which belongs to the piece.
            TextKind::SingleQuoted => (WordPiece::SingleQuotedText(text.text), end + 1),
            TextKind::AnsiC => (WordPiece::AnsiCQuotedText(text.text), end + 1),
            TextKind::ParameterName => (
                WordPiece::ParameterExpansion(ParameterExpr::Parameter {
                    parameter: Parameter::Named(text.text),
                    indirect: false,
                }),
                end,
            ),
        };
        self.at = end_index;
        let mut made = self.push(WordPieceWithSource {
            piece,
            start_index: text.start,
            end_index,
        });
        // With one piece wanted, the text was that piece, and the next is not wanted.
        if let Some(piece) = next
            && self.progress == Progress::Running
        {
            made += self.push(piece);
        }
        Ok(made)
    }

    /// Where unquoted literal text that goes on at `self.at` ends. Mirrors
    /// `unquoted_literal_text_piece` outside a command: it takes anything but a quote, a `$` or
    /// a backquote, stops before a backslash with a character after it, and stops before a
    /// tilde that `enabled_tilde_expr_after_colon` takes. A backslash at the very end of the
    /// word escapes nothing, and the text takes it.
    fn unquoted_text_end(&self, limit: usize) -> (usize, TextEnd) {
        let bytes = self.word.as_bytes();
        let mut at = self.at;
        while let Some(&byte) = bytes.get(at) {
            if at >= limit && self.word.is_char_boundary(at) {
                return (at, TextEnd::Stride);
            }
            match byte {
                b'\'' | b'"' | b'$' | b'`' => return (at, TextEnd::Closed),
                _ if self.stops.contains(&byte) => return (at, TextEnd::Closed),
                b'\\' if at + 1 < bytes.len() => return (at, TextEnd::Closed),
                b'~' => {
                    if let Some(piece) = self.tilde_after_colon_at(at) {
                        return (at, TextEnd::Before(piece));
                    }
                }
                _ => {}
            }
            at += 1;
        }
        (at, TextEnd::Closed)
    }

    /// Where literal text inside double quotes that goes on at `self.at` ends. Mirrors
    /// `double_quote_body_text`: it stops before the closing quote, before an escape sequence
    /// that double quotes keep, and before any piece `dollar_sign_word_piece` takes. That rule
    /// takes every `$` except one before a `'`, and a backquote only where another closes it,
    /// which a search decides: the text stops at a backquote not already known to be text.
    fn double_quoted_text_end(&self, limit: usize) -> (usize, TextEnd) {
        let bytes = self.word.as_bytes();
        let mut at = self.at;
        while let Some(&byte) = bytes.get(at) {
            if at >= limit && self.word.is_char_boundary(at) {
                return (at, TextEnd::Stride);
            }
            match (byte, bytes.get(at + 1)) {
                (b'"', _) | (b'\\', Some(b'$' | b'`' | b'"' | b'\\')) => {
                    return (at, TextEnd::Closed);
                }
                (b'$', next) if next != Some(&b'\'') => return (at, TextEnd::Closed),
                (b'`', _) if !self.backquote_cannot_close(at) => {
                    return (at, TextEnd::Backquote);
                }
                _ => {}
            }
            at += 1;
        }
        (at, TextEnd::Closed)
    }

    /// Where the body of a single-quoted string that goes on at `self.at` ends: at the next
    /// `'`, which has to be there.
    fn single_quoted_body_end(&self, limit: usize) -> Result<(usize, TextEnd), Failed> {
        let cut = self.stride_end(limit);
        let quote = self
            .word
            .as_bytes()
            .get(self.at..cut)
            .and_then(|span| span.iter().position(|byte| *byte == b'\''));
        match quote {
            Some(offset) => Ok((self.at + offset, TextEnd::Closed)),
            None if cut < self.word.len() => Ok((cut, TextEnd::Stride)),
            None => Err(Failed),
        }
    }

    /// Where the body of an ANSI-C quoted string that goes on at `self.at` ends: at the next
    /// `'` that `\\` or `\'` does not take, which has to be there.
    fn ansi_c_body_end(&self, limit: usize) -> Result<(usize, TextEnd), Failed> {
        let bytes = self.word.as_bytes();
        let mut at = self.at;
        while let Some(&byte) = bytes.get(at) {
            if at >= limit && self.word.is_char_boundary(at) {
                return Ok((at, TextEnd::Stride));
            }
            match (byte, bytes.get(at + 1)) {
                (b'\'', _) => return Ok((at, TextEnd::Closed)),
                (b'\\', Some(b'\\' | b'\'')) => at += 2,
                _ => at += 1,
            }
        }
        Err(Failed)
    }

    /// Where the name of an unbraced `$name` that goes on at `self.at` ends. Mirrors
    /// `variable_name`, which `unbraced_parameter` reaches for a `$` before a letter or `_`,
    /// every other kind of piece a `$` begins having failed on that character.
    fn variable_name_end(&self, limit: usize) -> (usize, TextEnd) {
        let bytes = self.word.as_bytes();
        let mut at = self.at;
        while let Some(&byte) = bytes.get(at) {
            if !(byte.is_ascii_alphanumeric() || byte == b'_') {
                break;
            }
            if at >= limit {
                return (at, TextEnd::Stride);
            }
            at += 1;
        }
        (at, TextEnd::Closed)
    }

    /// Starts looking for what closes the `$(`, `$((`, `$[` or `${` at `at`, whose second
    /// character is `open`, and returns how many pieces that made: none.
    ///
    /// Each of them is something the grammar matches only with a `)`, `]` or `}` somewhere
    /// after it: `$((` needs `))` as arithmetic and `)` as the command substitution it is
    /// tried as next. Without one, every alternative of `dollar_sign_word_piece` fails but
    /// the last, which takes the `$` alone, so that is the piece, and the grammar is not
    /// asked.
    const fn search_closer(&mut self, at: usize, open: u8) -> usize {
        let closer = match open {
            b'(' => b')',
            b'[' => b']',
            _ => b'}',
        };
        self.search = Some(Search {
            at,
            scan: at + 2,
            kind: SearchKind::Closer(closer),
        });
        0
    }

    /// Starts looking for the backquote that closes the one at `at`, inside double quotes.
    fn search_backquote(&mut self, at: usize) -> Result<usize, Failed> {
        if self.backquote_cannot_close(at) {
            return self.open_literal(TextKind::DoubleQuoted);
        }
        self.search = Some(Search {
            at,
            scan: at + 1,
            kind: SearchKind::Backquote,
        });
        Ok(0)
    }

    /// Whether the backquote at `at` is known not to close: it is no earlier than one that
    /// did not.
    fn backquote_cannot_close(&self, at: usize) -> bool {
        self.unclosed_backquote.is_some_and(|first| first <= at)
    }

    /// Looks further for what closes `search`, and returns how many pieces that made.
    fn continue_search(&mut self, search: Search, limit: usize) -> Result<usize, Failed> {
        let end = match search.kind {
            SearchKind::Backquote => self.closing_backquote(search.scan, limit),
            SearchKind::Closer(closer) => self.closing_character(closer, search, limit),
        };
        match (end, search.kind) {
            (SearchEnd::Stride(scan), _) => {
                self.search = Some(Search { scan, ..search });
                Ok(0)
            }
            (SearchEnd::Found, SearchKind::Backquote) => self.backquote_closes(search.at),
            (SearchEnd::Absent, SearchKind::Backquote) => {
                self.backquote_is_text(search.at);
                Ok(0)
            }
            (SearchEnd::Found, SearchKind::Closer(_)) => self.dollar_construct_at(search.at),
            (SearchEnd::Absent, SearchKind::Closer(_)) => Ok(self.push(WordPieceWithSource {
                piece: WordPiece::Text("$".to_owned()),
                start_index: search.at,
                end_index: search.at + 1,
            })),
        }
    }

    /// Looks for the backquote that closes one, from `from`. Mirrors `backquoted_char`: a
    /// backslash before a backquote or a backslash takes both, and any other byte but a
    /// backquote takes itself. A step can stop anywhere, since no byte of a multi-byte
    /// character is either.
    fn closing_backquote(&self, from: usize, limit: usize) -> SearchEnd {
        let bytes = self.word.as_bytes();
        let mut at = from;
        while let Some(&byte) = bytes.get(at) {
            if at >= limit {
                return SearchEnd::Stride(at);
            }
            match (byte, bytes.get(at + 1)) {
                (b'`', _) => return SearchEnd::Found,
                (b'\\', Some(b'`' | b'\\')) => at += 2,
                _ => at += 1,
            }
        }
        SearchEnd::Absent
    }

    /// Looks for `closer` anywhere after the `$` construct `search` stands for. What one
    /// search finds is kept for the next: a closer found is found by every search that has
    /// not gone past it, and one absent from a place is absent from everywhere after it.
    fn closing_character(&mut self, closer: u8, search: Search, limit: usize) -> SearchEnd {
        let word = self.word;
        let start = search.at + 2;
        let memo = &mut self.closers[match closer {
            b')' => 0,
            b'}' => 1,
            _ => 2,
        }];
        let absent = |memo: &mut CloserMemo| {
            memo.absent_from = Some(memo.absent_from.map_or(start, |from| from.min(start)));
            SearchEnd::Absent
        };
        if memo.found.is_some_and(|found| found >= search.scan) {
            return SearchEnd::Found;
        }
        if memo.absent_from.is_some_and(|from| from <= search.scan) {
            return absent(memo);
        }
        let end = limit.min(word.len());
        let found = word
            .as_bytes()
            .get(search.scan..end)
            .and_then(|span| span.iter().position(|byte| *byte == closer));
        match found {
            Some(offset) => {
                memo.found = Some(search.scan + offset);
                SearchEnd::Found
            }
            None if end < word.len() => SearchEnd::Stride(end),
            None => absent(memo),
        }
    }

    /// The backquote at `at` is closed, so it begins a backquoted command substitution, and
    /// any text before it ends there.
    fn backquote_closes(&mut self, at: usize) -> Result<usize, Failed> {
        let piece = self.dollar_sign_piece_at(at).ok_or(Failed)?;
        let mut made = 0;
        if let Some(text) = self.text.take() {
            made += self.push(WordPieceWithSource {
                piece: WordPiece::Text(text.text),
                start_index: text.start,
                end_index: at,
            });
        }
        Ok(made + self.push(piece))
    }

    /// The backquote at `at` never closes, so it is text inside the double quotes: the text
    /// before it takes it and goes on, or else text starts with it.
    fn backquote_is_text(&mut self, at: usize) {
        self.unclosed_backquote = Some(self.unclosed_backquote.map_or(at, |first| first.min(at)));
        self.text
            .get_or_insert_with(|| OpenText {
                kind: TextKind::DoubleQuoted,
                start: at,
                text: String::new(),
            })
            .text
            .push('`');
        self.at = at + 1;
    }

    /// The `$` construct at `at` has its closing character somewhere after it, so it is
    /// whatever the grammar makes of it.
    fn dollar_construct_at(&mut self, at: usize) -> Result<usize, Failed> {
        if self.quote.is_some() {
            return match self.dollar_sign_piece_at(at) {
                Some(piece) => Ok(self.push(piece)),
                None => self.open_literal(TextKind::DoubleQuoted),
            };
        }
        let piece = self.grammar_piece_at(at).ok_or(Failed)?;
        Ok(self.push(piece))
    }

    /// The first character boundary at or after `limit`, or the end of the word.
    fn stride_end(&self, limit: usize) -> usize {
        let mut cut = limit.min(self.word.len());
        while !self.word.is_char_boundary(cut) {
            cut += 1;
        }
        cut
    }

    /// Opens literal text whose first character is the one at `self.at`. Every other piece
    /// that character could begin has been ruled out, so the text takes it unconditionally.
    fn open_literal(&mut self, kind: TextKind) -> Result<usize, Failed> {
        let start = self.at;
        let first = self
            .word
            .get(start..)
            .and_then(|rest| rest.chars().next())
            .ok_or(Failed)?;
        self.text = Some(OpenText {
            kind,
            start,
            text: String::from(first),
        });
        self.at = start + first.len_utf8();
        Ok(0)
    }

    /// Opens the body of a quoted string that begins at `start`, its text at `body`.
    fn open_body(&mut self, kind: TextKind, start: usize, body: usize) -> usize {
        self.text = Some(OpenText {
            kind,
            start,
            text: String::new(),
        });
        self.at = body;
        0
    }

    /// Opens a double-quoted sequence that begins at `start`, its body at `body`.
    fn open_quote(&mut self, gettext: bool, start: usize, body: usize) -> usize {
        self.quote = Some(OpenQuote {
            start,
            gettext,
            pieces: Vec::new(),
        });
        self.at = body;
        0
    }

    /// Takes the backslash at `self.at` and the character after it. Mirrors
    /// `normal_escape_sequence` and `double_quoted_escape_sequence`.
    fn escape_sequence(&mut self) -> Result<usize, Failed> {
        let start = self.at;
        let escaped = self
            .word
            .get(start + 1..)
            .and_then(|rest| rest.chars().next())
            .ok_or(Failed)?;
        let end = start + 1 + escaped.len_utf8();
        let text = self.word.get(start..end).ok_or(Failed)?;
        self.at = end;
        Ok(self.push(WordPieceWithSource {
            piece: WordPiece::EscapeSequence(text.to_owned()),
            start_index: start,
            end_index: end,
        }))
    }

    /// Adds `piece` to the double-quoted sequence open, or else to the word, moves past it,
    /// and returns how many pieces that made: one.
    fn push(&mut self, piece: WordPieceWithSource) -> usize {
        self.at = piece.end_index;
        if let Some(quote) = self.quote.as_mut() {
            quote.pieces.push(piece);
        } else {
            self.pieces.push(piece);
            if self.one_piece {
                self.progress = Progress::Done;
            }
        }
        1
    }

    /// Tries the tilde prefix a word can start with, and returns how many pieces that made.
    fn tilde_prefix(&mut self) -> usize {
        if !self.options.tilde_expansion_at_word_start
            || !self.word.starts_with('~')
            || !self.within_reach(0)
        {
            return 0;
        }
        match expansion_parser::tilde_expr_prefix_at_word_start(self.word, self.options) {
            Ok(Some(piece)) => self.push(piece),
            _ => 0,
        }
    }

    fn grammar_piece_at(&self, at: usize) -> Option<WordPieceWithSource> {
        if !self.within_reach(at) {
            return None;
        }
        expansion_parser::word_piece_at(self.word, self.options, at)
            .ok()
            .flatten()
    }

    fn dollar_sign_piece_at(&self, at: usize) -> Option<WordPieceWithSource> {
        if !self.within_reach(at) {
            return None;
        }
        expansion_parser::dollar_sign_word_piece_at(self.word, self.options, at)
            .ok()
            .flatten()
    }

    /// The tilde expression after a colon at `at`, if the grammar takes one there. Most
    /// tildes are not after a colon, and those are answered without the grammar.
    fn tilde_after_colon_at(&self, at: usize) -> Option<WordPieceWithSource> {
        let after_colon = at
            .checked_sub(1)
            .and_then(|before| self.word.as_bytes().get(before))
            == Some(&b':');
        if !self.options.tilde_expansion_after_colon || !after_colon || !self.within_reach(at) {
            return None;
        }
        expansion_parser::tilde_expr_after_colon_at(self.word, self.options, at)
            .ok()
            .flatten()
    }
}

/// Whether `byte` can begin the name `variable_name` takes: a letter or `_`, not a digit.
const fn starts_variable_name(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

/// Parses a word for brace expansion a step at a time, to exactly what
/// [`parse_brace_expansions`] gives it.
///
/// [`parse_brace_expansions`] is one call of a PEG over the whole word, and the text between
/// brace expressions is word pieces, read by the word grammar's literal rule a character at a
/// time: a prompt of 16 MiB with a `{` and a `}` in it reaches it whole. This takes the same
/// grammar a step at a time. Each word piece is skipped with a [`SteppedParse`] that stops at
/// the end of that piece, and each brace expression is tried as a frame on a stack whose
/// members are read the same way. A brace expression that does not match sends the parse back
/// to just after its `{`, as the grammar's backtracking does. Whether one matches at a `{`
/// depends on nothing but the word, so a `{` where one has failed is not tried again.
///
/// The pieces outside every brace expression can end short of the word, at a word piece that
/// does not parse after at least one that did. [`parse_brace_expansions`] then fails, and
/// [`Self::finish`] parses the whole word as it does, so the error is the error it gives.
pub struct SteppedBraceParse<'a> {
    word: &'a str,
    options: &'a ParserOptions,
    /// Where the next piece starts.
    at: usize,
    /// The pieces outside every brace expression.
    top: BraceRun,
    /// The brace expressions being tried, innermost last.
    frames: Vec<BraceFrame>,
    /// The word piece the next step goes on skipping, and how far into it its text is taken.
    piece: Option<(SteppedParse<'a>, usize)>,
    /// The `{`s at which no brace expression matches.
    no_match: std::collections::HashSet<usize>,
    /// Whether the parse has given what it gives.
    done: bool,
    /// What the parse gives, once it is done.
    result: Option<Vec<BraceExpressionOrText>>,
    /// Whether the pieces outside every brace expression ended short of the word.
    fell_short: bool,
    /// What [`SteppedParse::limit_grammar_reach`] sets for each word piece, and for the
    /// sequence tried at a `{`.
    grammar_reach: usize,
    /// Whether a word piece or a sequence would have handed the grammar more than that.
    abandoned: bool,
}

/// A run of `brace_expansion_piece`s: the pieces made, and the text the next one continues.
#[derive(Default)]
struct BraceRun {
    pieces: Vec<BraceExpressionOrText>,
    text: Option<String>,
}

impl BraceRun {
    /// Ends the text the run has open, as a piece.
    fn close_text(&mut self) {
        if let Some(text) = self.text.take() {
            self.pieces.push(BraceExpressionOrText::Text(text));
        }
    }

    /// The text the run has open, opened if it has none.
    fn text(&mut self) -> &mut String {
        self.text.get_or_insert_with(String::new)
    }
}

/// A brace expression being tried as a list: mirrors `brace_text_list_expr`.
struct BraceFrame {
    /// Where its `{` is.
    start: usize,
    members: Vec<BraceExpressionMember>,
    /// The member being read.
    member: BraceRun,
}

impl<'a> SteppedBraceParse<'a> {
    /// Starts parsing `word` for brace expansion with `options`.
    pub fn new(word: &'a str, options: &'a ParserOptions) -> Self {
        Self {
            word,
            options,
            at: 0,
            top: BraceRun::default(),
            frames: Vec::new(),
            piece: None,
            no_match: std::collections::HashSet::new(),
            done: false,
            result: None,
            fell_short: false,
            grammar_reach: usize::MAX,
            abandoned: false,
        }
    }

    /// [`SteppedParse::limit_grammar_reach`] for every word piece the brace parse skips, and
    /// for the sequence it tries at a `{`.
    pub const fn limit_grammar_reach(&mut self, bytes: usize) {
        self.grammar_reach = bytes;
    }

    /// Whether [`Self::finish`] would parse the whole word: the parse was abandoned at a
    /// piece past that reach, or the pieces outside every brace expression ended short of
    /// the word, which is an error the whole parse gives. A caller that must not hold its
    /// thread parses it with [`parse_brace_expansions`] where it may.
    #[must_use]
    pub const fn needs_whole_parse(&self) -> bool {
        self.abandoned || self.fell_short
    }

    /// Takes the next step, and returns whether there are steps left to take.
    ///
    /// A step stops once it has read `bytes` bytes of the word or made `pieces` pieces,
    /// whichever comes first, and always makes some progress. A word piece other than literal
    /// text or quoted text is parsed whole, and so is the sequence `{1..3}`. Text read again
    /// after a brace expression fails to match counts again.
    pub fn step(&mut self, bytes: usize, pieces: usize) -> bool {
        let mut bytes = bytes.max(1);
        let mut pieces = pieces.max(1);
        while !self.done && bytes > 0 && pieces > 0 {
            let (read, made) = self.advance(bytes, pieces);
            bytes = bytes.saturating_sub(read);
            pieces = pieces.saturating_sub(made);
        }
        !self.done
    }

    /// Takes whatever steps are left, and returns what [`parse_brace_expansions`] returns for
    /// the word.
    pub fn finish(
        mut self,
    ) -> Result<Option<Vec<BraceExpressionOrText>>, error::WordParseError> {
        while self.step(usize::MAX, usize::MAX) {}
        if self.fell_short || self.abandoned {
            return parse_brace_expansions(self.word, self.options);
        }
        Ok(self.result)
    }

    /// Makes progress, and returns how many bytes that read and how many pieces it made.
    fn advance(&mut self, bytes: usize, pieces: usize) -> (usize, usize) {
        if self.piece.is_none() {
            let at = self.at;
            match self.word.as_bytes().get(at).copied() {
                None => return (0, self.end_of_word()),
                // `brace_expansion_piece` tries a brace expression first.
                Some(b'{') => return (1, self.open_brace(at)),
                // Inside a brace expression a member ends at the stop condition, where
                // neither kind of piece can start.
                Some(b',' | b'}') if !self.frames.is_empty() => return (1, self.end_member(at)),
                Some(_) => {
                    let stops: &'static [u8] = if self.frames.is_empty() { b"{" } else { b"{,}" };
                    let mut piece = SteppedParse::one_piece_at(self.word, self.options, at, stops);
                    piece.limit_grammar_reach(self.grammar_reach);
                    self.piece = Some((piece, at));
                }
            }
        }
        self.skip_piece(bytes, pieces)
    }

    /// Skips more of the word piece under way, adding what it covers to the open text.
    fn skip_piece(&mut self, bytes: usize, pieces: usize) -> (usize, usize) {
        let Some((mut piece, taken)) = self.piece.take() else {
            return (0, 0);
        };
        // What the piece's step read, not how far its start of text moved: a search for a
        // closing character reads without moving it, and text can resume behind it.
        let before = piece.read;
        piece.step(bytes, pieces);
        let read = piece.read - before;
        if piece.abandoned() {
            self.abandoned = true;
            self.done = true;
            return (read, 0);
        }
        match piece.progress {
            Progress::Running => {
                let end = piece.at;
                self.take_text(taken, end);
                self.piece = Some((piece, end));
                (read, 0)
            }
            Progress::Done => {
                self.take_text(taken, piece.at);
                self.at = piece.at;
                (read, 1)
            }
            Progress::Failed => (read, self.piece_failed()),
        }
    }

    /// Makes the text the innermost run has open reach `to` in the word, from `taken`, where
    /// it had got to. A piece can end behind that, when a `$"` that never closes turns out to
    /// be its `$` alone, and the text is then cut back.
    fn take_text(&mut self, taken: usize, to: usize) {
        let word = self.word;
        let text = self.run().text();
        if to < taken {
            text.truncate(text.len().saturating_sub(taken - to));
        } else if let Some(more) = word.get(taken..to) {
            text.push_str(more);
        }
    }

    /// The run the next piece belongs to: the member being read, or the top level.
    fn run(&mut self) -> &mut BraceRun {
        match self.frames.last_mut() {
            Some(frame) => &mut frame.member,
            None => &mut self.top,
        }
    }

    fn end_of_word(&mut self) -> usize {
        if self.frames.is_empty() {
            self.top.close_text();
            let pieces = std::mem::take(&mut self.top.pieces);
            // `brace_expansion_piece()+` needs a piece, which an empty word does not have.
            self.result = (!pieces.is_empty()).then_some(pieces);
            self.done = true;
        } else {
            // The member ends with the word, short of the `,` or `}` the list needs.
            self.list_failed();
        }
        1
    }

    fn open_brace(&mut self, at: usize) -> usize {
        self.at = at + 1;
        if self.no_match.contains(&at) {
            self.run().text().push('{');
            return 0;
        }
        self.frames.push(BraceFrame {
            start: at,
            members: Vec::new(),
            member: BraceRun::default(),
        });
        1
    }

    /// Ends the member being read at the `,` or `}` at `at`.
    fn end_member(&mut self, at: usize) -> usize {
        let Some(frame) = self.frames.last_mut() else {
            return 0;
        };
        let mut member = std::mem::take(&mut frame.member);
        member.close_text();
        // A member with no pieces is the empty one `brace_text_list_member` matches first.
        let pieces = if member.pieces.is_empty() {
            vec![BraceExpressionOrText::Text(String::new())]
        } else {
            member.pieces
        };
        frame.members.push(BraceExpressionMember::Child(pieces));
        if self.word.as_bytes().get(at) == Some(&b',') {
            self.at = at + 1;
            return 0;
        }
        if frame.members.len() >= 2 {
            let members = std::mem::take(&mut frame.members);
            self.matched(members, at + 1);
        } else {
            self.list_failed();
        }
        1
    }

    /// The word piece at `self.at` does not parse. Inside a brace expression the member ends
    /// short of the `,` or `}` the list needs. Outside every one the pieces end short of the
    /// word: at its start, before any piece, `brace_expansions` matches nothing and gives
    /// `None`; anywhere later its first alternative has matched, and the parse fails.
    fn piece_failed(&mut self) -> usize {
        if !self.frames.is_empty() {
            self.list_failed();
        } else {
            self.fell_short = self.at > 0;
            self.done = true;
        }
        1
    }

    /// The innermost brace expression is no list, so it is tried as the sequence, the one
    /// other thing `brace_expr_inner` matches.
    fn list_failed(&mut self) {
        let Some(start) = self.frames.last().map(|frame| frame.start) else {
            return;
        };
        // A sequence reads only signs, digits and dots after its `{`, besides single
        // characters, so how far the grammar reads is that run: past the reach the parse is
        // abandoned, as at a word piece. The scan stops one byte past the reach.
        let run = self.word.as_bytes().get(start + 1..).map_or(0, |rest| {
            rest.iter()
                .take(self.grammar_reach.saturating_add(1))
                .take_while(|byte| byte.is_ascii_digit() || matches!(byte, b'-' | b'.'))
                .count()
        });
        if run > self.grammar_reach {
            self.abandoned = true;
            self.done = true;
            return;
        }
        match expansion_parser::brace_sequence_at(self.word, self.options, start) {
            Ok(Some((sequence, end))) => self.matched(vec![sequence], end),
            _ => self.no_match(),
        }
    }

    /// The innermost brace expression matches, as `expression`, up to `end`.
    fn matched(&mut self, expression: BraceExpression, end: usize) {
        self.frames.pop();
        let run = self.run();
        run.close_text();
        run.pieces.push(BraceExpressionOrText::Expr(expression));
        self.at = end;
    }

    /// No brace expression matches at the innermost `{`, which `non_brace_expr_text` then
    /// takes as text: the parse goes back to just after it.
    fn no_match(&mut self) {
        let Some(frame) = self.frames.pop() else {
            return;
        };
        self.no_match.insert(frame.start);
        self.run().text().push('{');
        self.at = frame.start + 1;
    }
}

/// Parse a heredoc body, treating `"` and `'` as literal characters.
///
/// # Arguments
///
/// * `word` - The heredoc body to parse.
/// * `options` - The parser options to use.
pub fn parse_heredoc(
    word: &str,
    options: &ParserOptions,
) -> Result<Vec<WordPieceWithSource>, error::WordParseError> {
    expansion_parser::unexpanded_heredoc_word(word, options)
        .map_err(|err| error::WordParseError::Word(word.to_owned(), err.into()))
}

/// Parse the given word into a parameter expression.
///
/// # Arguments
///
/// * `word` - The word to parse.
/// * `options` - The parser options to use.
pub fn parse_parameter(
    word: &str,
    options: &ParserOptions,
) -> Result<Parameter, error::WordParseError> {
    expansion_parser::parameter(word, options)
        .map_err(|err| error::WordParseError::Parameter(word.to_owned(), err.into()))
}

/// Parse brace expansion from a given word .
///
/// # Arguments
///
/// * `word` - The word to parse.
/// * `options` - The parser options to use.
pub fn parse_brace_expansions(
    word: &str,
    options: &ParserOptions,
) -> Result<Option<Vec<BraceExpressionOrText>>, error::WordParseError> {
    expansion_parser::brace_expansions(word, options)
        .map_err(|err| error::WordParseError::BraceExpansion(word.to_owned(), err.into()))
}

pub(crate) fn parse_assignment_word(
    word: &str,
) -> Result<ast::Assignment, peg::error::ParseError<peg::str::LineCol>> {
    expansion_parser::name_equals_scalar_value(word, &ParserOptions::default())
}

pub(crate) fn parse_array_assignment(
    word: &str,
    elements: &[&String],
) -> Result<ast::Assignment, &'static str> {
    let (assignment_name, append) = expansion_parser::name_equals(word, &ParserOptions::default())
        .map_err(|_| "not array assignment word")?;

    let elements = elements
        .iter()
        .map(|element| expansion_parser::literal_array_element(element, &ParserOptions::default()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "invalid array element in literal")?;

    let elements_as_words = elements
        .into_iter()
        .map(|(key, value)| {
            (
                key.map(|k| ast::Word::new(k.as_str())),
                ast::Word::new(value.as_str()),
            )
        })
        .collect();

    Ok(ast::Assignment {
        name: assignment_name,
        value: ast::AssignmentValue::Array(elements_as_words),
        append,
        loc: SourceSpan::default(),
    })
}

peg::parser! {
    grammar expansion_parser(parser_options: &ParserOptions) for str {
        // Helper rule that enables pegviz to be used to visualize debug peg traces.
        rule traced<T>(e: rule<T>) -> T =
            &(input:$([_]*) {
                #[cfg(feature = "debug-tracing")]
                println!("[PEG_INPUT_START]\n{input}\n[PEG_TRACE_START]");
            })
            e:e()? {?
                #[cfg(feature = "debug-tracing")]
                println!("[PEG_TRACE_STOP]");
                e.ok_or("")
            }

        pub(crate) rule unexpanded_word() -> Vec<WordPieceWithSource> = traced(<word(<![_]>)>)

        rule word<T>(stop_condition: rule<T>) -> Vec<WordPieceWithSource> =
            tilde:tilde_expr_prefix_with_source()? pieces:word_piece_with_source(<stop_condition()>, false /*in_command*/)* {
                let mut all_pieces = Vec::new();
                if let Some(tilde) = tilde {
                    all_pieces.push(tilde);
                }
                all_pieces.extend(pieces);
                all_pieces
            }

        // The entry points `SteppedParse` takes a word through, one piece at a time. Each is
        // given the whole word and starts at `offset` in it, rather than being given the piece
        // alone, so that the positions it records and the colon `last_char_is_colon` looks back
        // for are the ones the whole parse sees. Each matches the rest of the word without
        // reading it, and each returns `None` rather than failing, because a failed parse is
        // parsed a second time to report where it failed, and here nothing reads the report.

        // One piece of a word, outside double quotes.
        pub(crate) rule word_piece_at(offset: usize) -> Option<WordPieceWithSource> =
            at_offset(offset) piece:word_piece_with_source(<![_]>, false /*in_command*/)? rest() { piece }

        // One piece that starts with `$` or a backquote, inside double quotes or out.
        pub(crate) rule dollar_sign_word_piece_at(offset: usize) -> Option<WordPieceWithSource> =
            at_offset(offset) piece:(
                start_index:position!() piece:dollar_sign_word_piece() end_index:position!() {
                    WordPieceWithSource { piece, start_index, end_index }
                }
            )? rest() { piece }

        // A tilde expression after a colon, where the option for one is on.
        pub(crate) rule tilde_expr_after_colon_at(offset: usize) -> Option<WordPieceWithSource> =
            at_offset(offset) piece:(
                start_index:position!() piece:enabled_tilde_expr_after_colon() end_index:position!() {
                    WordPieceWithSource { piece, start_index, end_index }
                }
            )? rest() { piece }

        // The tilde prefix a word can start with.
        pub(crate) rule tilde_expr_prefix_at_word_start() -> Option<WordPieceWithSource> =
            piece:tilde_expr_prefix_with_source()? rest() { piece }

        // A brace expression at `offset` that is a sequence, and where it ends: the second
        // alternative of `brace_expr_inner`, which `SteppedBraceParse` tries once the first fails.
        pub(crate) rule brace_sequence_at(offset: usize) -> Option<(BraceExpressionMember, usize)> =
            at_offset(offset) found:(
                "{" seq:brace_sequence_expr() "}" end:position!() { (seq, end) }
            )? rest() { found }

        rule at_offset(offset: usize) = #{|_input, _pos| peg::RuleResult::Matched(offset, ())}

        rule rest() = #{|input: &str, _pos| peg::RuleResult::Matched(input.len(), ())}

        // Takes a word as input.
        pub(crate) rule brace_expansions() -> Option<Vec<BraceExpressionOrText>> =
            pieces:(brace_expansion_piece(<![_]>)+) { Some(pieces) } /
            [_]* { None }

        // Returns either a complete brace expression (without any prefix or suffix), or a
        // non-brace-expression string.
        rule brace_expansion_piece<T>(stop_condition: rule<T>) -> BraceExpressionOrText =
            expr:brace_expr() {
                BraceExpressionOrText::Expr(expr)
            } /
            text:$(non_brace_expr_text(<stop_condition()>)+) { BraceExpressionOrText::Text(text.to_owned()) }

        // Parses text that is not considered to contain a brace expression.
        rule non_brace_expr_text<T>(stop_condition: rule<T>) -> () =
            !"{" word_piece(<['{'] {} / stop_condition() {}>, false) {} /
            !brace_expr() !stop_condition() "{" {}

        // Parses a complete brace expression, with no prefix or suffix.
        pub(crate) rule brace_expr() -> BraceExpression =
            "{" inner:brace_expr_inner() "}" { inner }

        // Parses the text inside a complete brace expression; basically the complete brace
        // expression without the opening and closing brace characters.
        pub(crate) rule brace_expr_inner() -> BraceExpression =
            brace_text_list_expr() /
            seq:brace_sequence_expr() { vec![seq] }

        // Parses a list of brace expression members, including the separating commas; does
        // not include the opening and closing braces.
        pub(crate) rule brace_text_list_expr() -> BraceExpression =
            brace_text_list_member() **<2,> ","

        // Parses an element that can occur in a brace expression member list, not including the
        // terminating comma or closing brace.
        pub(crate) rule brace_text_list_member() -> BraceExpressionMember =
            // Matches an empty-string member, without consuming the comma or closing brace that terminates it.
            &[',' | '}'] { BraceExpressionMember::Child(vec![BraceExpressionOrText::Text(String::new())]) } /
            // Matches a nested string that may include some combination of concatenated textual strings
            // and brace expressions.
            child_pieces:(brace_expansion_piece(<[',' | '}']>)+) {
                BraceExpressionMember::Child(child_pieces)
            }

        pub(crate) rule brace_sequence_expr() -> BraceExpressionMember =
            start:number() ".." end:number() increment:(".." n:number() { n })? {
                BraceExpressionMember::NumberSequence { start, end, increment: increment.unwrap_or(1) }
            } /
            start:character() ".." end:character() increment:(".." n:number() { n })? {
                BraceExpressionMember::CharSequence { start, end, increment: increment.unwrap_or(1) }
            }

        rule number() -> i64 = sign:number_sign()? n:$(['0'..='9']+) {
            let sign = sign.unwrap_or(1);
            let num: i64 = n.parse().unwrap();
            num * sign
        }

        rule number_sign() -> i64 =
            ['-'] { -1 } /
            ['+'] { 1 }

        rule character() -> char = ['a'..='z' | 'A'..='Z']

        pub(crate) rule is_arithmetic_word() =
            arithmetic_word(<![_]>)

        // N.B. We don't bother returning the word pieces, as all users of this rule
        // only try to extract the consumed input string and not the parse result.
        rule arithmetic_word<T>(stop_condition: rule<T>) =
            arithmetic_word_piece(<stop_condition()>)* {}

        pub(crate) rule is_arithmetic_word_piece() =
            arithmetic_word_piece(<![_]>)

        // This rule matches an individual "piece" of an arithmetic expression. It needs to handle
        // matching nested parenthesized expressions as well. We stop consuming the input when
        // we reach the provided stop condition, which typically denotes the end of the containing
        // arithmetic expression.
        rule arithmetic_word_piece<T>(stop_condition: rule<T>) =
            // This branch matches a parenthesized piece; we consume the opening parenthesis and
            // delegate the rest to a helper rule. We don't worry about the stop condition passed
            // into us, because if we see an opening parenthesis then we *must* find its closing
            // partner.
            "(" arithmetic_word_plus_right_paren() {} /
            // This branch handles the case where we have an array element name with square brackets,
            // which may (legitimately) contain the stop condition.
            array_element_name() {} /
            // This branch matches any standard piece of a word, stopping as soon as we reach
            // either the overall stop condition *OR* an opening parenthesis. We add this latter
            // condition to ensure that *we* handle matching parentheses.
            !"(" word_piece(<param_rule_or_open_paren(<stop_condition()>)>, false /*in_command*/) {}

        // This is a helper rule that matches either the provided stop condition or an opening parenthesis.
        rule param_rule_or_open_paren<T>(stop_condition: rule<T>) -> () =
            stop_condition() {} /
            "(" {}

        // This rule matches an arithmetic word followed by a right parenthesis. It must consume the right parenthesis.
        rule arithmetic_word_plus_right_paren() =
            arithmetic_word(<[')']>) ")"

        rule word_piece_with_source<T>(stop_condition: rule<T>, in_command: bool) -> WordPieceWithSource =
            start_index:position!() piece:word_piece(<stop_condition()>, in_command) end_index:position!() {
                WordPieceWithSource { piece, start_index, end_index }
            }

        rule word_piece<T>(stop_condition: rule<T>, in_command: bool) -> WordPiece =
            // Rules that match quoted text.
            s:double_quoted_sequence() { WordPiece::DoubleQuotedSequence(s) } /
            s:single_quoted_literal_text() { WordPiece::SingleQuotedText(s.to_owned()) } /
            s:ansi_c_quoted_text() { WordPiece::AnsiCQuotedText(s.to_owned()) } /
            s:gettext_double_quoted_sequence() { WordPiece::GettextDoubleQuotedSequence(s) } /
            // Rules that match pieces starting with a dollar sign ('$').
            dollar_sign_word_piece() /
            // Rules that match unquoted text that doesn't start with an unescaped dollar sign.
            normal_escape_sequence() /
            // Allow tilde expression to be matched as a word piece (for tilde-after-colon expansion)
            enabled_tilde_expr_after_colon() /
            // Finally, match unquoted literal text.
            unquoted_literal_text(<stop_condition()>, in_command)

        rule dollar_sign_word_piece() -> WordPiece =
            arithmetic_expansion() /
            legacy_arithmetic_expansion() /
            command_substitution() /
            parameter_expansion()

        rule double_quoted_word_piece() -> WordPiece =
            arithmetic_expansion() /
            legacy_arithmetic_expansion() /
            command_substitution() /
            parameter_expansion() /
            double_quoted_escape_sequence() /
            double_quoted_text()

        rule double_quoted_sequence() -> Vec<WordPieceWithSource> =
            "\"" i:double_quoted_sequence_inner()* "\"" { i }

        rule gettext_double_quoted_sequence() -> Vec<WordPieceWithSource> =
            "$\"" i:double_quoted_sequence_inner()* "\"" { i }

        rule double_quoted_sequence_inner() -> WordPieceWithSource =
            start_index:position!() piece:double_quoted_word_piece() end_index:position!() {
                WordPieceWithSource {
                    piece,
                    start_index,
                    end_index
                }
            }

        rule single_quoted_literal_text() -> &'input str =
            "\'" inner:$([^'\'']*) "\'" { inner }

        rule ansi_c_quoted_text() -> &'input str =
            r"$'" inner:$((r"\\" / r"\'" / [^'\''])*) r"'" { inner }

        rule unquoted_literal_text<T>(stop_condition: rule<T>, in_command: bool) -> WordPiece =
            s:$(unquoted_literal_text_piece(<stop_condition()>, in_command)+) { WordPiece::Text(s.to_owned()) }

        // TODO(parser): Find a way to remove the special-case logic for extglob + subshell commands
        rule unquoted_literal_text_piece<T>(stop_condition: rule<T>, in_command: bool) =
            is_true(in_command) extglob_pattern() /
            is_true(in_command) subshell_command() /
            !stop_condition() !normal_escape_sequence() !enabled_tilde_expr_after_colon() [^'\'' | '\"' | '$' | '`'] {}

        rule enabled_tilde_expr_after_colon() -> WordPiece =
            tilde_exprs_after_colon_enabled() last_char_is_colon() piece:tilde_expression_piece() { piece }

        rule last_char_is_colon() = #{|input, pos| {
            if pos == 0 {
                // No preceding character - can't be preceded by ':'
                peg::RuleResult::Failed
            } else {
                // Check the byte directly (`:` is ASCII, single byte)
                if input.as_bytes()[pos - 1] == b':' {
                    peg::RuleResult::Matched(pos, ())
                } else {
                    peg::RuleResult::Failed
                }
            }
        }}

        rule is_true(value: bool) = &[_] {? if value { Ok(()) } else { Err("not true") } }

        rule extglob_pattern() =
            ("@" / "!" / "?" / "+" / "*") "(" extglob_body_piece()* ")" {}

        rule extglob_body_piece() =
            word_piece(<[')']>, true /*in_command*/) {}

        rule subshell_command() =
            "(" command() ")" {}

        rule double_quoted_text() -> WordPiece =
            s:double_quote_body_text() { WordPiece::Text(s.to_owned()) }

        rule double_quote_body_text() -> &'input str =
            $((!double_quoted_escape_sequence() !dollar_sign_word_piece() [^'\"'])+)

        // Heredoc body parsing: like double-quoted content, but " and ' are literal characters.
        pub(crate) rule unexpanded_heredoc_word() -> Vec<WordPieceWithSource> =
            traced(<heredoc_word(<![_]>)>)

        rule heredoc_word<T>(stop_condition: rule<T>) -> Vec<WordPieceWithSource> =
            pieces:heredoc_word_piece_with_source(<stop_condition()>)* { pieces }

        rule heredoc_word_piece_with_source<T>(stop_condition: rule<T>) -> WordPieceWithSource =
            !stop_condition() start_index:position!() piece:heredoc_word_piece() end_index:position!() {
                WordPieceWithSource { piece, start_index, end_index }
            }

        rule heredoc_word_piece() -> WordPiece =
            arithmetic_expansion() /
            legacy_arithmetic_expansion() /
            command_substitution() /
            parameter_expansion() /
            heredoc_escape_sequence() /
            heredoc_literal_text()

        rule heredoc_escape_sequence() -> WordPiece =
            s:$("\\" ['$' | '`' | '\\']) { WordPiece::EscapeSequence(s.to_owned()) }

        rule heredoc_literal_text() -> WordPiece =
            s:$((!heredoc_escape_sequence() !dollar_sign_word_piece() [^'`'])+) {
                WordPiece::Text(s.to_owned())
            }

        rule normal_escape_sequence() -> WordPiece =
            s:$("\\" [c]) { WordPiece::EscapeSequence(s.to_owned()) }

        rule double_quoted_escape_sequence() -> WordPiece =
            s:$("\\" ['$' | '`' | '\"' | '\\']) { WordPiece::EscapeSequence(s.to_owned()) }

        rule tilde_expr_prefix_with_source() -> WordPieceWithSource =
            start_index:position!() piece:tilde_expr_prefix() end_index:position!() {
                WordPieceWithSource {
                    piece,
                    start_index,
                    end_index
                }
            }

        rule tilde_expr_prefix() -> WordPiece =
            tilde_exprs_at_word_start_enabled() piece:tilde_expression_piece() { piece }

        rule tilde_expr_after_colon() -> WordPiece =
            tilde_exprs_after_colon_enabled() piece:tilde_expression_piece() { piece }

        rule tilde_expression_piece() -> WordPiece =
            "~" expr:tilde_expression() { WordPiece::TildeExpansion(expr) }

        rule tilde_expression() -> TildeExpr =
            &tilde_terminator() { TildeExpr::Home } /
            "+" &tilde_terminator() { TildeExpr::WorkingDir } /
            plus:("+"?) n:$(['0'..='9']*) &tilde_terminator() { TildeExpr::NthDirFromTopOfDirStack { n: n.parse().unwrap(), plus_used: plus.is_some() } } /
            "-" &tilde_terminator() { TildeExpr::OldWorkingDir } /
            "-" n:$(['0'..='9']*) &tilde_terminator() { TildeExpr::NthDirFromBottomOfDirStack { n: n.parse().unwrap() } } /
            user:$(portable_filename_char()*) &tilde_terminator() { TildeExpr::UserHome(user.to_owned()) }

        rule tilde_terminator() = ['/' | ':' | ';' | '}'] / ![_]

        rule portable_filename_char() = ['A'..='Z' | 'a'..='z' | '0'..='9' | '.' | '_' | '-']

        // TODO(parser): Deal with fact that there may be a quoted word or escaped closing brace chars.
        // TODO(parser): Improve on how we handle a '$' not followed by a valid variable name or parameter.
        rule parameter_expansion() -> WordPiece =
            "${" e:parameter_expression() "}" {
                WordPiece::ParameterExpansion(e)
            } /
            "$" parameter:unbraced_parameter() {
                WordPiece::ParameterExpansion(ParameterExpr::Parameter { parameter, indirect: false })
            } /
            "$" !['\''] {
                WordPiece::Text("$".to_owned())
            }

        rule parameter_expression() -> ParameterExpr =
            indirect:parameter_indirection() parameter:parameter() test_type:parameter_test_type() "-" default_value:parameter_expression_word()? {
                ParameterExpr::UseDefaultValues { parameter, indirect, test_type, default_value }
            } /
            indirect:parameter_indirection() parameter:parameter() test_type:parameter_test_type() "=" default_value:parameter_expression_word()? {
                ParameterExpr::AssignDefaultValues { parameter, indirect, test_type, default_value }
            } /
            indirect:parameter_indirection() parameter:parameter() test_type:parameter_test_type() "?" error_message:parameter_expression_word()? {
                ParameterExpr::IndicateErrorIfNullOrUnset { parameter, indirect, test_type, error_message }
            } /
            indirect:parameter_indirection() parameter:parameter() test_type:parameter_test_type() "+" alternative_value:parameter_expression_word()? {
                ParameterExpr::UseAlternativeValue { parameter, indirect, test_type, alternative_value }
            } /
            "#" parameter:parameter() {
                ParameterExpr::ParameterLength { parameter, indirect: false }
            } /
            indirect:parameter_indirection() parameter:parameter() "%%" pattern:parameter_expression_word()? {
                ParameterExpr::RemoveLargestSuffixPattern { parameter, indirect, pattern }
            } /
            indirect:parameter_indirection() parameter:parameter() "%" pattern:parameter_expression_word()? {
                ParameterExpr::RemoveSmallestSuffixPattern { parameter, indirect, pattern }
            } /
            indirect:parameter_indirection() parameter:parameter() "##" pattern:parameter_expression_word()? {
                ParameterExpr::RemoveLargestPrefixPattern { parameter, indirect, pattern }
            } /
            indirect:parameter_indirection() parameter:parameter() "#" pattern:parameter_expression_word()? {
                ParameterExpr::RemoveSmallestPrefixPattern { parameter, indirect, pattern }
            } /
            // N.B. The following case is for non-sh extensions.
            non_posix_extensions_enabled() e:non_posix_parameter_expression() { e } /
            indirect:parameter_indirection() parameter:parameter() {
                ParameterExpr::Parameter { parameter, indirect }
            }

        rule parameter_test_type() -> ParameterTestType =
            colon:":"? {
                if colon.is_some() {
                    ParameterTestType::UnsetOrNull
                } else {
                    ParameterTestType::Unset
                }
            }

        rule non_posix_parameter_expression() -> ParameterExpr =
            "!" variable_name:variable_name() "[*]" {
                ParameterExpr::MemberKeys { variable_name: variable_name.to_owned(), concatenate: true }
            } /
            "!" variable_name:variable_name() "[@]" {
                ParameterExpr::MemberKeys { variable_name: variable_name.to_owned(), concatenate: false }
            } /
            indirect:parameter_indirection() parameter:parameter() ":" offset:substring_offset() length:(":" l:substring_length() { l })? {
                ParameterExpr::Substring { parameter, indirect, offset, length }
            } /
            indirect:parameter_indirection() parameter:parameter() "@" op:non_posix_parameter_transformation_op() {
                ParameterExpr::Transform { parameter, indirect, op }
            } /
            "!" prefix:variable_name() "*" {
                ParameterExpr::VariableNames { prefix: prefix.to_owned(), concatenate: true }
            } /
            "!" prefix:variable_name() "@" {
                ParameterExpr::VariableNames { prefix: prefix.to_owned(), concatenate: false }
            } /
            indirect:parameter_indirection() parameter:parameter() "/#" pattern:parameter_search_pattern() replacement:parameter_replacement_str()? {
                ParameterExpr::ReplaceSubstring { parameter, indirect, pattern, replacement, match_kind: SubstringMatchKind::Prefix }
            } /
            indirect:parameter_indirection() parameter:parameter() "/%" pattern:parameter_search_pattern() replacement:parameter_replacement_str()? {
                ParameterExpr::ReplaceSubstring { parameter, indirect, pattern, replacement, match_kind: SubstringMatchKind::Suffix }
            } /
            indirect:parameter_indirection() parameter:parameter() "//" pattern:parameter_search_pattern() replacement:parameter_replacement_str()? {
                ParameterExpr::ReplaceSubstring { parameter, indirect, pattern, replacement, match_kind: SubstringMatchKind::Anywhere }
            } /
            indirect:parameter_indirection() parameter:parameter() "/" pattern:parameter_search_pattern() replacement:parameter_replacement_str()? {
                ParameterExpr::ReplaceSubstring { parameter, indirect, pattern, replacement, match_kind: SubstringMatchKind::FirstOccurrence }
            } /
            indirect:parameter_indirection() parameter:parameter() "^^" pattern:parameter_expression_word()? {
                ParameterExpr::UppercasePattern { parameter, indirect, pattern }
            } /
            indirect:parameter_indirection() parameter:parameter() "^" pattern:parameter_expression_word()? {
                ParameterExpr::UppercaseFirstChar { parameter, indirect, pattern }
            } /
            indirect:parameter_indirection() parameter:parameter() ",," pattern:parameter_expression_word()? {
                ParameterExpr::LowercasePattern { parameter, indirect, pattern }
            } /
            indirect:parameter_indirection() parameter:parameter() "," pattern:parameter_expression_word()? {
                ParameterExpr::LowercaseFirstChar { parameter, indirect, pattern }
            }

        rule parameter_indirection() -> bool =
            non_posix_extensions_enabled() "!" { true } /
            { false }

        rule non_posix_parameter_transformation_op() -> ParameterTransformOp =
            "U" { ParameterTransformOp::ToUpperCase } /
            "u" { ParameterTransformOp::CapitalizeInitial } /
            "L" { ParameterTransformOp::ToLowerCase } /
            "Q" { ParameterTransformOp::Quoted } /
            "E" { ParameterTransformOp::ExpandEscapeSequences } /
            "P" { ParameterTransformOp::PromptExpand } /
            "A" { ParameterTransformOp::ToAssignmentLogic } /
            "K" { ParameterTransformOp::PossiblyQuoteWithArraysExpanded { separate_words: false } } /
            "a" { ParameterTransformOp::ToAttributeFlags } /
            "k" { ParameterTransformOp::PossiblyQuoteWithArraysExpanded { separate_words: true } }


        rule unbraced_parameter() -> Parameter =
            p:unbraced_positional_parameter() { Parameter::Positional(p) } /
            p:special_parameter() { Parameter::Special(p) } /
            p:variable_name() { Parameter::Named(p.to_owned()) }

        // N.B. The indexing syntax is not a standard sh-ism.
        pub(crate) rule parameter() -> Parameter =
            p:positional_parameter() { Parameter::Positional(p) } /
            p:special_parameter() { Parameter::Special(p) } /
            non_posix_extensions_enabled() p:variable_name() "[@]" { Parameter::NamedWithAllIndices { name: p.to_owned(), concatenate: false } } /
            non_posix_extensions_enabled() p:variable_name() "[*]" { Parameter::NamedWithAllIndices { name: p.to_owned(), concatenate: true } } /
            non_posix_extensions_enabled() p:variable_name() "[" index:array_index() "]" {?
                Ok(Parameter::NamedWithIndex { name: p.to_owned(), index: index.to_owned() })
            } /
            p:variable_name() { Parameter::Named(p.to_owned()) }

        rule positional_parameter() -> u32 =
            n:$(['1'..='9'](['0'..='9']*)) {? n.parse().or(Err("u32")) }
        rule unbraced_positional_parameter() -> u32 =
            n:$(['1'..='9']) {? n.parse().or(Err("u32")) }

        rule special_parameter() -> SpecialParameter =
            "@" { SpecialParameter::AllPositionalParameters { concatenate: false } } /
            "*" { SpecialParameter::AllPositionalParameters { concatenate: true } } /
            "#" { SpecialParameter::PositionalParameterCount } /
            "?" { SpecialParameter::LastExitStatus } /
            "-" { SpecialParameter::CurrentOptionFlags } /
            "$" { SpecialParameter::ProcessId } /
            "!" { SpecialParameter::LastBackgroundProcessId } /
            "0" { SpecialParameter::ShellName }

        rule variable_name() -> &'input str =
            $(!['0'..='9'] ['_' | '0'..='9' | 'a'..='z' | 'A'..='Z']+)

        pub(crate) rule command_substitution() -> WordPiece =
            "$(" c:command_substitution_body() ")" { WordPiece::CommandSubstitution(c.to_owned()) } /
            "`" c:backquoted_command() "`" { WordPiece::BackquotedCommandSubstitution(c) }

        // Delimits the body with the tokenizer's here-document-aware scan (the one that already
        // produced this word) instead of `command()`: re-parsing the body as words let quotes and
        // parentheses inside a here-document body end the match early or swallow the real `)`.
        rule command_substitution_body() -> &'input str = #{|input, pos| {
            let body = input.get(pos..).and_then(|rest| {
                let len = crate::tokenizer::command_substitution_body_len(
                    rest,
                    &parser_options.tokenizer_options(),
                )?;
                rest.get(..len)
            });
            match body {
                Some(body) => peg::RuleResult::Matched(pos + body.len(), body),
                None => peg::RuleResult::Failed,
            }
        }}

        pub(crate) rule command() -> &'input str =
            $(command_piece()*)

        pub(crate) rule command_piece() -> () =
            word_piece(<[')']>, true /*in_command*/) {} /
            ([' ' | '\t'])+ {} /
            ['\'' | '`'] {}

        rule backquoted_command() -> String =
            chars:(backquoted_char()*) { chars.into_iter().collect() }

        rule backquoted_char() -> &'input str =
            "\\`" { "`" } /
            "\\\\" { "\\\\" } /
            s:$([^'`']) { s }

        rule arithmetic_expansion() -> WordPiece =
            "$((" e:$(arithmetic_word(<"))">)) "))" { WordPiece::ArithmeticExpression(ast::UnexpandedArithmeticExpr { value: e.to_owned() } ) }

        rule legacy_arithmetic_expansion() -> WordPiece =
            "$[" e:$(arithmetic_word(<"]">)) "]" { WordPiece::ArithmeticExpression(ast::UnexpandedArithmeticExpr { value: e.to_owned() } ) }

        rule substring_offset() -> ast::UnexpandedArithmeticExpr =
            s:$(arithmetic_word(<[':' | '}']>)) { ast::UnexpandedArithmeticExpr { value: s.to_owned() } }

        rule substring_length() -> ast::UnexpandedArithmeticExpr =
            s:$(arithmetic_word(<[':' | '}']>)) { ast::UnexpandedArithmeticExpr { value: s.to_owned() } }

        rule parameter_replacement_str() -> String =
            "/" s:$(word(<['}']>)) { s.to_owned() }

        rule parameter_search_pattern() -> String =
            s:$(word(<['}' | '/']>)) { s.to_owned() }

        rule parameter_expression_word() -> String =
            s:$(word(<['}']>)) { s.to_owned() }

        rule extglob_enabled() -> () =
            &[_] {? if parser_options.enable_extended_globbing { Ok(()) } else { Err("no extglob") } }

        rule non_posix_extensions_enabled() -> () =
            &[_] {? if !parser_options.sh_mode { Ok(()) } else { Err("posix") } }

        rule tilde_exprs_at_word_start_enabled() -> () =
            &[_] {? if parser_options.tilde_expansion_at_word_start { Ok(()) } else { Err("no tilde expansion at word start") } }

        rule tilde_exprs_after_colon_enabled() -> () =
            &[_] {? if parser_options.tilde_expansion_after_colon { Ok(()) } else { Err("no tilde expansion after colon") } }

        // Assignment rules.

        pub(crate) rule name_equals_scalar_value() -> ast::Assignment =
            nae:name_equals() value:assigned_scalar_value() {
                let (name, append) = nae;
                ast::Assignment { name, value, append, loc: SourceSpan::default() }
            }

        pub(crate) rule name_equals() -> (ast::AssignmentName, bool) =
            name:assignment_name() append:("+"?) "=" {
                (name, append.is_some())
            }

        pub(crate) rule literal_array_element() -> (Option<String>, String) =
            "[" inner:$((!"]" [_])*) "]=" value:$([_]*) {
                (Some(inner.to_owned()), value.to_owned())
            } /
            value:$([_]+) {
                (None, value.to_owned())
            }

        rule assignment_name() -> ast::AssignmentName =
            aen:array_element_name() {
                let (name, index) = aen;
                ast::AssignmentName::ArrayElementName(name.to_owned(), index.to_owned())
            } /
            name:assigned_scalar_name() {
                ast::AssignmentName::VariableName(name.to_owned())
            }

        rule array_element_name() -> (&'input str, &'input str) =
            name:assigned_scalar_name() "[" ai:array_index() "]" { (name, ai) }

        rule array_index() -> &'input str =
            $(arithmetic_word(<"]">))

        rule assigned_scalar_name() -> &'input str =
            $(alpha_or_underscore() non_first_variable_char()*)

        rule non_first_variable_char() -> () =
            ['_' | '0'..='9' | 'a'..='z' | 'A'..='Z'] {}

        rule alpha_or_underscore() -> () =
            ['_' | 'a'..='z' | 'A'..='Z'] {}

        rule assigned_scalar_value() -> ast::AssignmentValue =
            v:$([_]*) { ast::AssignmentValue::Scalar(ast::Word::from(v.to_owned())) }
    }
}

#[cfg(test)]
#[allow(clippy::panic_in_result_fn)]
mod tests {
    use super::*;
    use anyhow::Result;
    use insta::assert_ron_snapshot;
    use pretty_assertions::assert_matches;

    #[derive(serde::Serialize, serde::Deserialize)]
    struct ParseTestResults<'a> {
        input: &'a str,
        result: Vec<WordPieceWithSource>,
    }

    fn test_parse(word: &str) -> Result<ParseTestResults<'_>> {
        let parsed = super::parse(word, &ParserOptions::default())?;
        Ok(ParseTestResults {
            input: word,
            result: parsed,
        })
    }

    #[test]
    fn parse_ansi_c_quoted_text() -> Result<()> {
        assert_ron_snapshot!(test_parse(r"$'hi\nthere\t'")?);
        Ok(())
    }

    #[test]
    fn parse_ansi_c_quoted_escape_seq() -> Result<()> {
        assert_ron_snapshot!(test_parse(r"$'\\'")?);
        Ok(())
    }

    #[test]
    fn parse_tilde_after_colon() -> Result<()> {
        let opts = ParserOptions {
            tilde_expansion_after_colon: true,
            ..ParserOptions::default()
        };

        let parsed = super::parse("a:~", &opts)?;

        // Should have: Text("a:"), TildeExpansion("")
        assert_eq!(parsed.len(), 2);
        assert_matches!(parsed[0].piece, WordPiece::Text(_));
        assert_matches!(parsed[1].piece, WordPiece::TildeExpansion(_));

        Ok(())
    }

    #[test]
    fn parse_double_quoted_text() -> Result<()> {
        assert_ron_snapshot!(test_parse(r#""a ${b} c""#)?);
        Ok(())
    }

    #[test]
    fn parse_gettext_double_quoted_text() -> Result<()> {
        assert_ron_snapshot!(test_parse(r#"$"a ${b} c""#)?);
        Ok(())
    }

    #[test]
    fn parse_command_substitution() -> Result<()> {
        super::expansion_parser::command_piece("echo", &ParserOptions::default())?;
        super::expansion_parser::command_piece("hi", &ParserOptions::default())?;
        super::expansion_parser::command("echo hi", &ParserOptions::default())?;
        super::expansion_parser::command_substitution("$(echo hi)", &ParserOptions::default())?;

        assert_ron_snapshot!(test_parse("$(echo hi)")?);

        Ok(())
    }

    #[test]
    fn parse_command_substitution_with_embedded_quotes() -> Result<()> {
        super::expansion_parser::command_piece("echo", &ParserOptions::default())?;
        super::expansion_parser::command_piece(r#""hi""#, &ParserOptions::default())?;
        super::expansion_parser::command(r#"echo "hi""#, &ParserOptions::default())?;
        super::expansion_parser::command_substitution(
            r#"$(echo "hi")"#,
            &ParserOptions::default(),
        )?;

        assert_ron_snapshot!(test_parse(r#"$(echo "hi")"#)?);
        Ok(())
    }

    #[test]
    fn parse_command_substitution_with_embedded_extglob() -> Result<()> {
        assert_ron_snapshot!(test_parse("$(echo !(x))")?);
        Ok(())
    }

    #[test]
    fn parse_command_sub_with_unbalanced_single_quote() -> Result<()> {
        assert_ron_snapshot!(test_parse("\"$(cat <<'EOF'\nit's here\nEOF\n)\"")?);
        Ok(())
    }

    #[test]
    fn parse_command_sub_with_unbalanced_backtick() -> Result<()> {
        assert_ron_snapshot!(test_parse("\"$(cat <<'EOF'\na ` b\nEOF\n)\"")?);
        Ok(())
    }

    #[test]
    fn parse_command_sub_with_balanced_double_quotes() -> Result<()> {
        assert_ron_snapshot!(test_parse("\"$(cat <<'EOF'\n\"hello\"\nEOF\n)\"")?);
        Ok(())
    }

    #[test]
    fn parse_command_sub_with_balanced_single_quotes() -> Result<()> {
        assert_ron_snapshot!(test_parse("\"$(cat <<'EOF'\n'hello'\nEOF\n)\"")?);
        Ok(())
    }

    #[test]
    fn parse_command_sub_with_balanced_backticks() -> Result<()> {
        assert_ron_snapshot!(test_parse("\"$(cat <<'EOF'\n`hello`\nEOF\n)\"")?);
        Ok(())
    }

    #[test]
    fn parse_command_sub_with_heredoc_hiding_parens_and_quotes() -> Result<()> {
        // Word parsing of the heredoc body used to pair `'s c) ... d'` and let the body's `(`
        // consume the real closer, demoting `$(` to text and the backticks to a live substitution.
        for body in ["a (b's c) `touch pwned` d's", ")"] {
            let inner = std::format!("cat <<'EOF'\n{body}\nEOF\n");
            let word = std::format!("\"$({inner})\"");
            let parsed = super::parse(&word, &ParserOptions::default())?;
            let [WordPieceWithSource { piece: WordPiece::DoubleQuotedSequence(pieces), .. }] =
                parsed.as_slice()
            else {
                anyhow::bail!("expected one double-quoted sequence, got {parsed:?}");
            };
            let pieces: Vec<&WordPiece> = pieces.iter().map(|p| &p.piece).collect();
            assert_eq!(pieces, [&WordPiece::CommandSubstitution(inner)]);
        }
        Ok(())
    }

    #[test]
    fn parse_backquoted_command() -> Result<()> {
        assert_ron_snapshot!(test_parse("`echo hi`")?);
        Ok(())
    }

    #[test]
    fn parse_backquoted_command_in_double_quotes() -> Result<()> {
        assert_ron_snapshot!(test_parse(r#""`echo hi`""#)?);
        Ok(())
    }

    #[test]
    fn parse_extglob_with_embedded_parameter() -> Result<()> {
        assert_ron_snapshot!(test_parse("+([$var])")?);
        Ok(())
    }

    #[test]
    fn parse_arithmetic_expansion() -> Result<()> {
        assert_ron_snapshot!(test_parse("$((0))")?);
        Ok(())
    }

    #[test]
    fn parse_arithmetic_expansion_with_parens() -> Result<()> {
        assert_ron_snapshot!(test_parse("$((((1+2)*3)))")?);
        Ok(())
    }

    #[test]
    fn test_arithmetic_word_parsing() {
        let options = ParserOptions::default();

        assert!(super::expansion_parser::is_arithmetic_word("a", &options).is_ok());
        assert!(super::expansion_parser::is_arithmetic_word("b", &options).is_ok());
        assert!(super::expansion_parser::is_arithmetic_word(" a + b ", &options).is_ok());
        assert!(super::expansion_parser::is_arithmetic_word("(a)", &options).is_ok());
        assert!(super::expansion_parser::is_arithmetic_word("((a))", &options).is_ok());
        assert!(super::expansion_parser::is_arithmetic_word("(((a)))", &options).is_ok());
        assert!(super::expansion_parser::is_arithmetic_word("(1+2)", &options).is_ok());
        assert!(super::expansion_parser::is_arithmetic_word("(1+2)*3", &options).is_ok());
        assert!(super::expansion_parser::is_arithmetic_word("((1+2)*3)", &options).is_ok());
    }

    #[test]
    fn test_arithmetic_word_piece_parsing() {
        let options = ParserOptions::default();

        assert!(super::expansion_parser::is_arithmetic_word_piece("a", &options).is_ok());
        assert!(super::expansion_parser::is_arithmetic_word_piece("b", &options).is_ok());
        assert!(super::expansion_parser::is_arithmetic_word_piece(" a + b ", &options).is_ok());
        assert!(super::expansion_parser::is_arithmetic_word_piece("(a)", &options).is_ok());
        assert!(super::expansion_parser::is_arithmetic_word_piece("((a))", &options).is_ok());
        assert!(super::expansion_parser::is_arithmetic_word_piece("(((a)))", &options).is_ok());
        assert!(super::expansion_parser::is_arithmetic_word_piece("(1+2)", &options).is_ok());
        assert!(super::expansion_parser::is_arithmetic_word_piece("((1+2))", &options).is_ok());
        assert!(super::expansion_parser::is_arithmetic_word_piece("((1+2)*3)", &options).is_ok());
        assert!(super::expansion_parser::is_arithmetic_word_piece("(a", &options).is_err());
        assert!(super::expansion_parser::is_arithmetic_word_piece("(a))", &options).is_err());
        assert!(super::expansion_parser::is_arithmetic_word_piece("((a)", &options).is_err());
    }

    #[test]
    fn test_brace_expansion_parsing() -> Result<()> {
        let options = ParserOptions::default();

        let inputs = ["x{a,b}y", "{a,b{1,2}}"];

        for input in inputs {
            assert_ron_snapshot!(super::parse_brace_expansions(input, &options)?.ok_or_else(
                || anyhow::anyhow!("Expected brace expansion to be parsed successfully")
            )?);
        }

        Ok(())
    }

    #[test]
    fn parse_assignment_word() -> Result<()> {
        super::parse_assignment_word("x=3")?;
        super::parse_assignment_word("x=")?;
        super::parse_assignment_word("x[3]=a")?;
        super::parse_assignment_word("x[${y[3]}]=a")?;
        super::parse_assignment_word("x[y[3]]=a")?;
        Ok(())
    }

    /// Words covering every construct of the word grammar, each next to the boundaries a
    /// step can stop on: quotes of all four kinds, every form of parameter, the operator
    /// families of a braced parameter with words nested in them, command substitutions with
    /// quotes and parentheses inside, arithmetic of both spellings, backquotes, escapes, a
    /// trailing backslash, a `$` before a bracket that never closes, tildes at the start and
    /// after a colon, extglob patterns, constructs that never close, and multi-byte
    /// characters on either side of all of them.
    const STEPPED_CORPUS: &[&str] = &[
        "",
        "plain",
        "a b\tc",
        "'single'",
        "''",
        "'unterminated",
        "a'b'c",
        r#""double $x ${y} $(z) `w` \$ \" \\ \a end""#,
        r#""""#,
        r#""unterminated"#,
        r#""unterminated\"#,
        r#"a"b\"#,
        r"$'ansi\n\'\\x'",
        r"$''",
        r"$'unterminated",
        r"$'tail\",
        r"$'a\\'b'",
        r#"$"gettext $x""#,
        r#"$"""#,
        r#"$"unterminated"#,
        "$name",
        "$1",
        "$12",
        "$@",
        "$*",
        "$#",
        "$?",
        "$-",
        "$$",
        "$!",
        "$0",
        "$_x",
        "$_",
        "$abc_9",
        "$a_1:b",
        "$a$b",
        "$a-b",
        "$9a",
        r#""$abc_9x-$y$""#,
        r#""$a"b"#,
        "${a}b$c",
        "${x}",
        "${x:-default}",
        "${x-d}",
        "${x:=v}",
        "${x=v}",
        "${x:?msg}",
        "${x?m}",
        "${x:+alt}",
        "${x+a}",
        "${#x}",
        "${x%%p}",
        "${x%p}",
        "${x##p}",
        "${x#p}",
        "${!x}",
        "${!x[@]}",
        "${!x[*]}",
        "${x:1:2}",
        "${x:1}",
        "${x@U}",
        "${x@Q}",
        "${x@P}",
        "${!pre*}",
        "${!pre@}",
        "${x/#a/b}",
        "${x/%a/b}",
        "${x//a/b}",
        "${x/a/b}",
        "${x/a}",
        "${x^^p}",
        "${x^p}",
        "${x,,p}",
        "${x,p}",
        "${x[@]}",
        "${x[*]}",
        "${x[1+2]}",
        r#"${x:-"q $y"}"#,
        "${x:-${y:-'z'}}",
        "${x:-$(echo })}",
        "${x",
        "${",
        "${}",
        "$(echo hi)",
        r#"$(echo "a)b" 'c)d' $(nested (x)))"#,
        "$(unclosed",
        "$(",
        "$()",
        "$((1+2))",
        "$(((1+2)*3))",
        "$((unclosed",
        "$((a)",
        "$[1+2]",
        "$[unclosed",
        "`echo hi`",
        "`unclosed",
        r"`a\`b`",
        r"`a\\`b",
        r#""`unclosed""#,
        r#""a`b"`c""#,
        r#""`a"b`""#,
        // A backquote inside double quotes that never closes, followed by a parameter, by
        // the closing quote, by escaped backquotes, and by multi-byte text; and one that
        // closes past the double quote, and one closed by a backquote after `\\`.
        r#""a`b$x""#,
        r#""`$x""#,
        r#""a`""#,
        r#""`""#,
        r#""a`b\`c""#,
        r#""a`b\`c\`d$x""#,
        r#""é`é\`é$xé""#,
        r#""`é""#,
        r#""a`b"c"#,
        r#""a`b"c`d""#,
        r#""a`b\\`c""#,
        r#""a``b""#,
        r#""a`b\"#,
        r#""a`$(x)`"#,
        r#""a`$(x"#,
        r#"x"a`b"`"#,
        r#"\a\$\'\""#,
        r"tail\",
        r"\",
        r"\\",
        "$",
        "a$",
        "x$(y",
        "x${y",
        "x$[y",
        // `$(`, `$((`, `$[` and `${` with no closing character after them, and with one
        // that comes too late or inside something else for the construct to match, inside
        // double quotes and out, beside multi-byte text.
        "a$(b",
        "a$(b)",
        "a$(b'c)",
        "a$((b",
        "a$((b)",
        "a$((1+2)",
        "a$((b)c)",
        "a$[b",
        "a$[b]",
        r#"a$[b"]"c"#,
        "a${b",
        "a${b}",
        "a${b)}",
        r#"a${b:-"}"#,
        r#"a${b:-"}"}"#,
        r#""a$(b""#,
        r#""a$(b" c)"#,
        r#""a$((b""#,
        r#""a$((b)""#,
        r#""a$[b""#,
        r#""a$[b"]"#,
        r#""a${b""#,
        r#""a${b" }"#,
        r#""a${b)}""#,
        "é$(é",
        "é$((é)",
        "é$[é",
        "é${é",
        r#""é$(é"é"#,
        r#""é${é}é""#,
        "$($(",
        "${${",
        "$[$[",
        "$($)",
        "${$}",
        "$(b",
        "${b",
        "$[b",
        r#"$""#,
        "$'",
        r#""$""#,
        r#""$'x'""#,
        r#""\x""#,
        r#""$(""#,
        r#""${""#,
        r#""$[""#,
        r#""a$"b"#,
        "~",
        "~/x",
        "~user/x",
        "~+",
        "~-",
        "~+3",
        "~-2",
        "~2",
        "~user:~",
        "~x;y",
        "~x}y",
        "~x(y",
        "a:~",
        "a:~/b:~user",
        "a:~+:b",
        "a:~-1/x",
        "a:~x(",
        "x~y",
        ":~",
        "~:~/a",
        r"\:~",
        "':'~",
        r#"":"~"#,
        "a::~~",
        "{a,b}",
        "{1..3}",
        "a{b",
        "}",
        "+(a|b)",
        "!(x)",
        "@(a)",
        "*(x)",
        "?(y)",
        "a+(b)c",
        "$(echo +(a|b))",
        "é",
        "é$x",
        "$xé",
        "'é'",
        r#""é$xé""#,
        r"\é",
        r"é\",
        "a:é~",
        "é:~",
        ":~é",
        "~é",
        r"$'é\é'",
        "日本$(echo 日本)語",
        r#"😀"😀"😀"#,
        "`😀`",
        "${x:-😀}",
        "$😀",
        r#"é'é'é"é"é$'é'é$"é"é`é`é\éé~é:~é${é}é$(é)é$((é))é$[é]é"#,
        r#""é\é\"é`é`é$é$'é'é""#,
        r#"mixed'q'"d $v"$'a'$"g"`b`\e~:~${p}$(c)$((1))$[2]end"#,
    ];

    /// Every option the word grammar reads, in every combination.
    fn every_word_option() -> Vec<ParserOptions> {
        (0..32_u8)
            .map(|bits| ParserOptions {
                enable_extended_globbing: bits & 1 != 0,
                posix_mode: bits & 2 != 0,
                sh_mode: bits & 4 != 0,
                tilde_expansion_at_word_start: bits & 8 != 0,
                tilde_expansion_after_colon: bits & 16 != 0,
                ..ParserOptions::default()
            })
            .collect()
    }

    /// Parses `word` a step at a time and checks it against `parse`: the same pieces, or the
    /// same error, and a failed step only where `parse` fails, so that falling back to the
    /// whole parse cannot hide a step that went wrong.
    fn check_stepped(word: &str, options: &ParserOptions, bytes: usize, pieces: usize) -> Result<()> {
        let whole = super::parse(word, options);
        let mut stepped = SteppedParse::new(word, options);
        while stepped.step(bytes, pieces) {}
        let failed = stepped.progress == Progress::Failed;
        let result = stepped.finish();
        let context = std::format!("word {word:?}, step {bytes} bytes or {pieces} pieces");
        assert_eq!(failed, whole.is_err(), "{context}: the steps and parse disagree on failing");
        match (&whole, &result) {
            (Ok(whole), Ok(result)) => assert_eq!(whole, result, "{context}"),
            (Err(whole), Err(result)) => {
                assert_eq!(
                    std::format!("{whole:?} {whole}"),
                    std::format!("{result:?} {result}"),
                    "{context}"
                );
            }
            _ => anyhow::bail!("{context}: parse gave {whole:?}, the steps {result:?}"),
        }
        Ok(())
    }

    #[test]
    fn parsing_in_steps_gives_what_parse_gives() -> Result<()> {
        for options in every_word_option() {
            for word in STEPPED_CORPUS {
                for bytes in 1..=word.len().max(1) {
                    for pieces in [1, 2, usize::MAX] {
                        check_stepped(word, &options, bytes, pieces)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// Every word of up to four characters drawn from the ones that begin or end a piece,
    /// so that no pair or triple of them goes unchecked.
    #[test]
    fn parsing_short_words_in_steps_gives_what_parse_gives() -> Result<()> {
        let alphabet = [
            '\'', '"', '$', '`', '\\', '~', ':', '(', ')', '{', '}', 'a', '1', 'é',
        ];
        let mut words = vec![String::new()];
        let mut last = vec![String::new()];
        for _ in 0..4 {
            last = last
                .iter()
                .flat_map(|word| {
                    alphabet.iter().map(move |c| {
                        let mut longer = word.clone();
                        longer.push(*c);
                        longer
                    })
                })
                .collect();
            words.extend(last.iter().cloned());
        }
        for tilde_expansion_after_colon in [false, true] {
            let options = ParserOptions {
                tilde_expansion_after_colon,
                ..ParserOptions::default()
            };
            for word in &words {
                check_stepped(word, &options, 1, 1)?;
                check_stepped(word, &options, word.len().max(1), usize::MAX)?;
            }
        }
        Ok(())
    }

    /// Literal text of every kind is scanned a stride at a time, so no one step covers much
    /// more of the word than it is asked to, and the pieces are still the ones `parse` gives.
    #[test]
    fn long_literal_text_is_scanned_a_stride_at_a_time() -> Result<()> {
        const STRIDE: usize = 64 * 1024;
        let literal = "h".repeat(1 << 20);
        let word = std::format!("$PWD{literal}\"{literal}$x{literal}\"'{literal}'$'{literal}'");
        let options = ParserOptions::default();

        let mut stepped = SteppedParse::new(&word, &options);
        let mut steps = 0;
        let mut at = 0;
        while stepped.step(STRIDE, usize::MAX) {
            steps += 1;
            // A step stops at the first character boundary past its stride, and may first
            // close a piece and open the next by a few bytes of quotes.
            assert!(stepped.at - at <= STRIDE + 8, "a step covered {} bytes", stepped.at - at);
            at = stepped.at;
        }
        assert!(steps >= word.len() / (STRIDE + 8), "{steps} steps");
        assert_eq!(stepped.finish()?, super::parse(&word, &options)?);

        Ok(())
    }

    /// Steps through `word` a stride at a time, checking that no step reads more than its
    /// stride and a few bytes of quotes past it, and returns how many steps it took.
    fn steps_within_stride(word: &str, stride: usize) -> Result<usize> {
        let options = ParserOptions::default();
        let mut stepped = SteppedParse::new(word, &options);
        let mut steps = 1;
        let mut read = 0;
        while stepped.step(stride, usize::MAX) {
            steps += 1;
            assert!(stepped.read - read <= stride + 8, "a step read {}", stepped.read - read);
            read = stepped.read;
        }
        assert_eq!(stepped.finish()?, super::parse(word, &options)?);
        Ok(steps)
    }

    /// A backquote inside double quotes that never closes is a backquote of text, and finding
    /// that out reads the rest of the word. That search is divided like any other scan: the
    /// rest of the word is read twice, once looking for the closing backquote and once as
    /// text, so the steps are at least as many as the two reads have strides.
    #[test]
    fn an_unclosed_backquote_in_double_quotes_is_searched_a_stride_at_a_time() -> Result<()> {
        const STRIDE: usize = 64 * 1024;
        let literal = "h".repeat(1 << 20);
        let steps = steps_within_stride(&std::format!("\"a`{literal}\""), STRIDE)?;
        assert!(steps >= 2 * literal.len() / STRIDE, "{steps} steps");

        Ok(())
    }

    /// A `$(`, `$((`, `$[` or `${` with no closing character anywhere after it can only be a
    /// `$` of text, and finding that out reads the rest of the word. That search is divided
    /// too, inside double quotes and out, so the rest of the word is read twice in strides.
    #[test]
    fn an_unclosed_dollar_construct_is_searched_a_stride_at_a_time() -> Result<()> {
        const STRIDE: usize = 64 * 1024;
        let literal = "h".repeat(1 << 20);
        // The third word closes a construct before the one that never closes, which has to
        // be searched for again rather than taken to close by the same character.
        for (open, close) in [("$(", ")"), ("$((", "))"), ("$[", "]"), ("${", "}")] {
            for word in [
                std::format!("a{open}{literal}"),
                std::format!("\"a{open}{literal}\""),
                std::format!("{open}x{close}a{open}{literal}"),
            ] {
                let steps = steps_within_stride(&word, STRIDE)?;
                assert!(steps >= 2 * literal.len() / STRIDE, "{open}: {steps} steps");
            }
        }

        Ok(())
    }

    /// The brace parse reads word pieces with the same steps, and counts what they read: a
    /// search reads without moving the piece on, and the steps through it are as many as
    /// they are outside a brace parse.
    #[test]
    fn a_search_inside_a_brace_parse_is_divided_too() -> Result<()> {
        const STRIDE: usize = 64 * 1024;
        let literal = "h".repeat(1 << 20);
        let options = ParserOptions::default();
        for word in [
            std::format!("\"a`{literal}\"{{x,y}}"),
            std::format!("a$({literal}{{x,y}}"),
        ] {
            let mut stepped = SteppedBraceParse::new(&word, &options);
            let mut steps = 1;
            while stepped.step(STRIDE, usize::MAX) {
                steps += 1;
            }
            assert!(steps >= 2 * literal.len() / STRIDE, "{steps} steps");
            assert_eq!(stepped.finish()?, super::parse_brace_expansions(&word, &options)?);
        }

        Ok(())
    }

    /// Every word of up to five characters drawn from the ones a search for a closing
    /// character turns on: quotes, backquotes, backslashes, and the openers and closers of
    /// `$(`, `$((`, `$[` and `${`.
    #[test]
    fn parsing_short_backquote_and_dollar_words_in_steps_gives_what_parse_gives() -> Result<()> {
        let alphabet = ['"', '`', '\\', '$', '(', ')', '{', '}', '[', ']', 'é'];
        let mut words = vec![String::new()];
        let mut last = vec![String::new()];
        for _ in 0..5 {
            last = last
                .iter()
                .flat_map(|word| {
                    alphabet.iter().map(move |c| {
                        let mut longer = word.clone();
                        longer.push(*c);
                        longer
                    })
                })
                .collect();
            words.extend(last.iter().cloned());
        }
        let options = ParserOptions::default();
        for word in &words {
            check_stepped(word, &options, 1, 1)?;
            check_stepped(word, &options, word.len().max(1), usize::MAX)?;
        }
        Ok(())
    }

    /// Words covering every part of the brace grammar: lists, nested lists, empty members,
    /// sequences of numbers and of letters with and without a step, braces that never match,
    /// commas and braces inside quotes, escapes and the other word pieces, pieces that never
    /// close inside and outside a brace expression, tildes after a colon, and multi-byte
    /// characters beside all of them.
    const BRACE_CORPUS: &[&str] = &[
        "",
        "abc",
        "{a,b}",
        "x{a,b}y",
        "{a,b}{c,d}",
        "{a,b{1,2}}",
        "{{a,b},{c,d}}",
        "{a,b{c,d}e,f}",
        "x{a{b,c}d}y",
        "{1..3}",
        "{a..c}",
        "{1..10..2}",
        "{-1..+2}",
        "{a..e..2}",
        "{1..}",
        "{1..2..}",
        "{..}",
        "{a..}",
        "{1..a}",
        "{a}",
        "{}",
        "{,}",
        "{,b}",
        "{a,}",
        "{a,,b}",
        "{a,{,}}",
        "a{b",
        "a}b",
        "}{",
        "{{a,b}",
        "{a,b}}",
        "{{{",
        "{{{}}}",
        "{a,{b,c}",
        "{a,b,",
        r#"{"a,b",c}"#,
        "{'a,b',c}",
        r"{a\,b,c}",
        r"{a,b\}",
        r"\{a,b}",
        "{$x,${y}}",
        "{${a,b},c}",
        "{$(echo {a,b}),c}",
        "{`a,b`,c}",
        "{$'a,b',c}",
        r#"{$"a,b",c}"#,
        "{$((1,2)),c}",
        r#"{a,"unterminated}"#,
        r#"{a,b"}"#,
        r#""unterminated"#,
        r#"x"y"#,
        r#"{a,b}"unterminated"#,
        "{a,`b}",
        "`{a,b}",
        "{a,$'b}",
        "{~,~:~}",
        "a:~{b,c}",
        "{a:~,b}",
        "{é,ü}",
        "é{a,b}é",
        "{é..ü}",
        "{a,😀{b,c}}",
        "$'{a,b}'",
        r#"$"{a,b}""#,
        "${a,b}{c,d}",
        r"\${a,b}",
        "{a,b}tail\\",
    ];

    /// Parses `word` for brace expansion a step at a time and checks it against
    /// `parse_brace_expansions`: the same pieces, or the same error, and a fallback to the
    /// whole parse only where that parse fails.
    fn check_stepped_brace(
        word: &str,
        options: &ParserOptions,
        bytes: usize,
        pieces: usize,
    ) -> Result<()> {
        let whole = super::parse_brace_expansions(word, options);
        let mut stepped = SteppedBraceParse::new(word, options);
        while stepped.step(bytes, pieces) {}
        let fell_short = stepped.fell_short;
        let result = stepped.finish();
        let context = std::format!("word {word:?}, step {bytes} bytes or {pieces} pieces");
        assert_eq!(fell_short, whole.is_err(), "{context}: the steps and parse disagree on failing");
        match (&whole, &result) {
            (Ok(whole), Ok(result)) => assert_eq!(whole, result, "{context}"),
            (Err(whole), Err(result)) => {
                assert_eq!(
                    std::format!("{whole:?} {whole}"),
                    std::format!("{result:?} {result}"),
                    "{context}"
                );
            }
            _ => anyhow::bail!("{context}: parse gave {whole:?}, the steps {result:?}"),
        }
        Ok(())
    }

    #[test]
    fn parsing_braces_in_steps_gives_what_parse_gives() -> Result<()> {
        for options in every_word_option() {
            for word in BRACE_CORPUS.iter().chain(STEPPED_CORPUS) {
                for bytes in 1..=word.len().max(1) {
                    for pieces in [1, 2, usize::MAX] {
                        check_stepped_brace(word, &options, bytes, pieces)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// Every word of up to five characters drawn from the ones the brace grammar and the
    /// pieces inside it turn on.
    #[test]
    fn parsing_short_words_for_braces_in_steps_gives_what_parse_gives() -> Result<()> {
        let alphabet = ['{', '}', ',', '.', '1', 'a', '$', '"', '\\', '~', ':'];
        let mut words = vec![String::new()];
        let mut last = vec![String::new()];
        for _ in 0..5 {
            last = last
                .iter()
                .flat_map(|word| {
                    alphabet.iter().map(move |c| {
                        let mut longer = word.clone();
                        longer.push(*c);
                        longer
                    })
                })
                .collect();
            words.extend(last.iter().cloned());
        }
        for tilde_expansion_after_colon in [false, true] {
            let options = ParserOptions {
                tilde_expansion_after_colon,
                ..ParserOptions::default()
            };
            for word in &words {
                check_stepped_brace(word, &options, 1, 1)?;
                check_stepped_brace(word, &options, word.len().max(1), usize::MAX)?;
            }
        }
        Ok(())
    }

    /// Long text is read a stride at a time inside a brace expression, around a brace that
    /// never matches, inside quotes, and outside every brace, and the result is still the one
    /// `parse_brace_expansions` gives.
    #[test]
    fn long_brace_text_is_read_a_stride_at_a_time() -> Result<()> {
        const STRIDE: usize = 64 * 1024;
        let literal = "h".repeat(1 << 20);
        let word = std::format!("{literal}{{a,{literal}}}{{{literal}}}\"{literal}\"{literal}");
        let options = ParserOptions::default();

        let mut stepped = SteppedBraceParse::new(&word, &options);
        let mut steps = 0;
        while stepped.step(STRIDE, usize::MAX) {
            steps += 1;
        }
        // The member of the brace that never matches is read twice: once in the brace, and
        // again as text once the brace fails.
        assert!(steps >= word.len() / STRIDE, "{steps} steps");
        assert_eq!(stepped.finish()?, super::parse_brace_expansions(&word, &options)?);

        Ok(())
    }
}
