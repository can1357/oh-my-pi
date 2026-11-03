use std::path::PathBuf;

use bon::bon;

use crate::alias_reading::AliasTable;
use crate::ast;
use crate::tokenizer::{OwnedChars, Token, TokenEndReason, Tokenizer, TokenizerOptions, Tokens};

pub mod peg;
#[cfg(feature = "winnow-parser")]
pub mod winnow_str;

/// Parser implementation to use
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Default)]
pub enum ParserImpl {
    /// PEG-based parser (token-based)
    #[default]
    Peg,
    /// Winnow-based parser (string-based, direct)
    #[cfg(feature = "winnow-parser")]
    Winnow,
}

/// Options used to control the behavior of the parser.
#[derive(Clone, Eq, Hash, PartialEq)]
pub struct ParserOptions {
    /// Whether or not to enable extended globbing (a.k.a. `extglob`).
    pub enable_extended_globbing: bool,
    /// Whether or not to enable POSIX compliance mode.
    pub posix_mode: bool,
    /// Whether or not to enable maximal compatibility with the `sh` shell.
    pub sh_mode: bool,
    /// Whether or not to perform tilde expansion for tildes at the start of words.
    pub tilde_expansion_at_word_start: bool,
    /// Whether or not to perform tilde expansion for tildes after colons.
    pub tilde_expansion_after_colon: bool,
    /// Select the parser internal implementation
    pub parser_impl: ParserImpl,
}

impl Default for ParserOptions {
    fn default() -> Self {
        Self {
            enable_extended_globbing: true,
            posix_mode: false,
            sh_mode: false,
            tilde_expansion_at_word_start: true,
            tilde_expansion_after_colon: false,
            parser_impl: ParserImpl::default(),
        }
    }
}

impl ParserOptions {
    /// Returns the tokenizer options implied by these parser options.
    pub const fn tokenizer_options(&self) -> TokenizerOptions {
        TokenizerOptions {
            enable_extended_globbing: self.enable_extended_globbing,
            posix_mode: self.posix_mode,
            sh_mode: self.sh_mode,
        }
    }
}

/// Information about the source of tokens.
#[derive(Clone, Debug, Default)]
#[allow(dead_code)]
pub struct SourceInfo {
    /// The source of the tokens.
    pub source: String,
}

impl From<PathBuf> for SourceInfo {
    fn from(path: PathBuf) -> Self {
        Self {
            source: path.to_string_lossy().to_string(),
        }
    }
}

/// Implements parsing for shell programs.
pub struct Parser<R: std::io::BufRead> {
    /// The reader to use for input
    reader: R,
    /// Parsing options
    options: ParserOptions,
}

#[bon]
impl<R: std::io::BufRead> Parser<R> {
    ///
    /// # Arguments
    ///
    /// * `reader` - The reader to use for input.
    /// * `options` - The options to use when parsing.
    pub fn new(reader: R, options: &ParserOptions) -> Self {
        Self {
            reader,
            options: options.clone(),
        }
    }

    /// Create a new parser instance through a builder
    #[builder(
        finish_fn(doc {
            /// Instantiate a parser with the provided reader as input
        })
    )]
    pub const fn builder(
        /// The reader to use for input
        #[builder(finish_fn)]
        reader: R,

        #[builder(default = true)]
        /// Whether or not to enable extended globbing (a.k.a. `extglob`).
        enable_extended_globbing: bool,
        #[builder(default = false)]
        /// Whether or not to enable POSIX compliance mode.
        posix_mode: bool,
        #[builder(default = false)]
        /// Whether or not to enable maximal compatibility with the `sh` shell.
        sh_mode: bool,
        #[builder(default = true)]
        /// Whether or not to perform tilde expansion for tildes at the start of words.
        tilde_expansion_at_word_start: bool,
        #[builder(default = false)]
        /// Whether or not to perform tilde expansion for tildes after colons.
        tilde_expansion_after_colon: bool,
        #[builder(default)]
        /// Select the parser internal implementation
        parser_impl: ParserImpl,
    ) -> Self {
        let options = ParserOptions {
            enable_extended_globbing,
            posix_mode,
            sh_mode,
            tilde_expansion_at_word_start,
            tilde_expansion_after_colon,
            parser_impl,
        };
        Self { reader, options }
    }

    /// Parses the input into an abstract syntax tree (AST) of a shell program.
    pub fn parse_program(&mut self) -> Result<ast::Program, crate::error::ParseError> {
        //
        // References:
        //   * https://www.gnu.org/software/bash/manual/bash.html#Shell-Syntax
        //   * https://mywiki.wooledge.org/BashParser
        //   * https://aosabook.org/en/v1/bash.html
        //   * https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html
        //
        match self.options.parser_impl {
            ParserImpl::Peg => {
                let tokens = self.tokenize()?;
                parse_tokens(&tokens, &self.options)
            }
            #[cfg(feature = "winnow-parser")]
            ParserImpl::Winnow => {
                // Read entire input to string for winnow_str parser
                let mut input_str = String::new();
                std::io::Read::read_to_string(&mut self.reader, &mut input_str).map_err(|e| {
                    crate::error::ParseError::Tokenizing {
                        inner: crate::tokenizer::TokenizerError::from(e),
                        position: None,
                    }
                })?;

                winnow_str::parse_program(&input_str, &self.options, &SourceInfo::default())
                    .map_err(|_e| {
                        // Convert winnow error to ParseError
                        // TODO: Extract position information from winnow error
                        crate::error::ParseError::ParsingAtEndOfInput
                    })
            }
        }
    }

    /// Parses a function definition body from the input. The body is expected to be
    /// preceded by "()", but no function name.
    pub fn parse_function_parens_and_body(
        &mut self,
    ) -> Result<ast::FunctionBody, crate::error::ParseError> {
        let tokens = self.tokenize()?;
        let parse_result =
            peg::token_parser::function_parens_and_body(&Tokens { tokens: &tokens }, &self.options);
        parse_result_to_error(parse_result, &tokens)
    }

    fn tokenize(&mut self) -> Result<Vec<Token>, crate::error::ParseError> {
        // First we tokenize the input, according to the policy implied by provided options.
        let mut tokenizer = Tokenizer::new(&mut self.reader, &self.options.tokenizer_options());

        tracing::debug!(target: "tokenize", "Tokenizing...");

        let mut tokens = vec![];
        loop {
            let result = match tokenizer.next_token() {
                Ok(result) => result,
                Err(e) => {
                    return Err(crate::error::ParseError::Tokenizing {
                        inner: e,
                        position: tokenizer.current_location(),
                    });
                }
            };

            let reason = result.reason;
            if let Some(token) = result.token {
                tracing::debug!(target: "tokenize", "TOKEN {}: {:?} {reason:?}", tokens.len(), token);
                tokens.push(token);
            }

            if matches!(reason, TokenEndReason::EndOfInput) {
                break;
            }
        }

        tracing::debug!(target: "tokenize", "  => {} token(s)", tokens.len());

        Ok(tokens)
    }
}

/// Parses a sequence of tokens into the abstract syntax tree (AST) of a shell program.
///
/// # Arguments
///
/// * `tokens` - The tokens to parse.
/// * `options` - The options to use when parsing.
pub fn parse_tokens(
    tokens: &[Token],
    options: &ParserOptions,
) -> Result<ast::Program, crate::error::ParseError> {
    let parse_result = peg::token_parser::program(&Tokens { tokens }, options);
    parse_result_to_error(parse_result, tokens)
}

/// Reads shell input one complete command at a time, as Bash does: an input
/// line, or a compound command that spans lines. Aliases are substituted while
/// the input is read, from the table given for each complete command, so the
/// commands run before it decide which aliases it is read with.
pub struct CommandReader {
    tokenizer: Tokenizer<OwnedChars>,
    pending: Vec<Token>,
    /// Whether the last token read other than a newline is an operator that
    /// needs a command after it (`&&`, `||`, `|`, `|&`): a newline after it
    /// cannot end the command, so the reader does not try to parse there.
    /// Trying would parse the whole unfinished command again at every line
    /// of a long chain.
    continued: bool,
    finished: bool,
}

impl CommandReader {
    /// A reader of `input`.
    pub fn new(input: String, options: &ParserOptions) -> Self {
        Self {
            tokenizer: Tokenizer::reading_commands(input, &options.tokenizer_options()),
            pending: vec![],
            continued: false,
            finished: false,
        }
    }

    /// Reads the next complete command, with `options` and `aliases` (none
    /// while `expand_aliases` is off) as they are now. Returns `None` at the
    /// end of the input. After an error, the reader reads nothing more.
    pub fn next_program(
        &mut self,
        options: &ParserOptions,
        aliases: Option<AliasTable>,
    ) -> Result<Option<ast::Program>, crate::error::ParseError> {
        if self.finished {
            return Ok(None);
        }
        self.tokenizer
            .configure_reading(&options.tokenizer_options(), aliases);

        loop {
            let result = match self.tokenizer.next_token() {
                Ok(result) => result,
                Err(inner) => {
                    self.finished = true;
                    return Err(crate::error::ParseError::Tokenizing {
                        inner,
                        position: self.tokenizer.current_location(),
                    });
                }
            };
            let at_end = matches!(result.reason, TokenEndReason::EndOfInput);

            if let Some(token) = result.token {
                let newline = match &token {
                    Token::Operator(op, _) if op == "\n" => true,
                    Token::Operator(op, _) => {
                        self.continued = matches!(op.as_str(), "&&" | "||" | "|" | "|&");
                        false
                    }
                    Token::Word(..) => {
                        self.continued = false;
                        false
                    }
                };
                self.pending.push(token);
                if newline && !at_end && !self.continued && self.tokenizer.reading_at_top_level() {
                    match parse_tokens(&self.pending, options) {
                        Ok(program) => {
                            self.pending.clear();
                            if !program.complete_commands.is_empty() {
                                return Ok(Some(program));
                            }
                        }
                        // The input so far is the start of a longer command.
                        Err(crate::error::ParseError::ParsingAtEndOfInput) => (),
                        Err(err) => {
                            self.finished = true;
                            return Err(err);
                        }
                    }
                }
            }

            if at_end {
                self.finished = true;
                let program = parse_tokens(&std::mem::take(&mut self.pending), options)?;
                return Ok((!program.complete_commands.is_empty()).then_some(program));
            }
        }
    }
}

fn parse_result_to_error<R>(
    parse_result: Result<R, ::peg::error::ParseError<usize>>,
    tokens: &[Token],
) -> Result<R, crate::error::ParseError>
where
    R: std::fmt::Debug,
{
    match parse_result {
        Ok(program) => {
            tracing::debug!(target: "parse", "PROG: {:?}", program);
            Ok(program)
        }
        Err(parse_error) => {
            tracing::debug!(target: "parse", "Parse error: {:?}", parse_error);
            Err(crate::error::convert_peg_parse_error(&parse_error, tokens))
        }
    }
}

#[cfg(test)]
mod tests;
