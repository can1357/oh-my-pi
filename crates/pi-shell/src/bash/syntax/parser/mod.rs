//! Incremental bash 5.3 parser: one top-level command per call.
//!
//! The structure follows bash's `parse.y`: a context-dependent lexer
//! (`read_token`, `read_token_word`, `special_case_tokens`) that tracks the
//! last tokens it returned and the parser-state flags bash keeps, under a
//! recursive-descent rendition of the yacc grammar. Reserved words, alias
//! expansion, here-document gathering and assignment-word recognition happen
//! in the lexer, exactly where bash does them.
//!
//! Input is a byte cursor over the source plus a stack of alias expansions;
//! nothing is copied per byte. Words are lexed straight into
//! [`WordPart`]s; command substitutions are parsed recursively at parse
//! time, as bash 5.3 does.
//!
//! Node ids are assigned once a top-level command is complete
//! ([`Tree::assign_ids`]), so they do not depend on lexer lookahead.

mod cursor;
mod grammar;
mod lex;
mod raw;
mod word;

use alloc::{boxed::Box, string::String, vec::Vec};
use core::fmt;

pub use self::lex::looks_like_assignment;
use self::{
	cursor::{Frame, Skip},
	lex::{LexState, Tok, TokArena},
};
use crate::bash::syntax::{
	ast::*,
	features::{AliasLookup, Features, NO_ALIASES},
	span::{Pos, Span},
	tree::{
		Id, Tree,
		shape::{self, Text},
	},
};

/// Short literal runs and names, kept out of the heap up to 24 bytes.
type SmallBytes = smallvec::SmallVec<[u8; 24]>;

/// A syntax error.
///
/// The message bash prints is rendered on demand ([`ParseError::bash_msg`])
/// so the error stays small on the parser's hot `Result` path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseError {
	/// Offending token (empty at end of input).
	pub span:      Span,
	/// 1-based line bash reports.
	pub line:      u32,
	/// What went wrong.
	pub kind:      ParseErrorKind,
	/// Warnings bash printed while parsing the command before it failed (a
	/// here-document delimited by end of file).
	pub warnings:  Box<[ParseWarning]>,
	/// Line and text of [`ParseError::detail`].
	detail:        Option<(u32, Box<[u8]>)>,
	/// The parser recovered, as bash does after an error inside a compound
	/// assignment (`x=(a & b)`): the command being parsed and the rest of
	/// the input line are dropped, `$?` becomes 1, and
	/// [`Parser::next_command`] continues with the next line. Otherwise the
	/// error ends the script.
	pub recovered: bool,
}

// The parser returns `Result<_, ParseError>` from every grammar function.
const _: () = assert!(size_of::<ParseError>() <= 88);

/// Classes of syntax errors.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParseErrorKind {
	/// A token that cannot appear here.
	UnexpectedToken {
		/// Token text (`newline` for `\n`).
		token:   Box<[u8]>,
		/// The closing delimiter of the command substitution being parsed
		/// (bash adds ``while looking for matching `)'``).
		closing: Option<u8>,
	},
	/// Input ended inside a construct.
	UnexpectedEof {
		/// Innermost open compound command and its starting line.
		from: Option<(&'static str, u32)>,
	},
	/// Input ended inside a quote, `$(`, `${` or similar; holds the awaited
	/// closing text.
	Unmatched(&'static str),
	/// bash could not name the token and reports the text before the input
	/// position (``syntax error near `x'``), as after a `[[ … ]]` error.
	Near(Box<[u8]>),
	/// A message-only error (arithmetic `for` with the wrong number of
	/// expressions, every zsh-grammar error); holds the message.
	Message(Box<[u8]>),
}

impl ParseError {
	pub(super) fn new(span: Span, line: u32, kind: ParseErrorKind) -> Self {
		Self { span, line, kind, warnings: Box::new([]), detail: None, recovered: false }
	}

	/// Attach the line bash prints before the message.
	pub(super) fn with_detail(mut self, detail: Option<ParseWarning>) -> Self {
		self.detail = detail.map(|d| (d.line, d.bash_msg.into_boxed_slice()));
		self
	}

	/// The message as bash 5.3 prints it, without the `name: line N: `
	/// prefix, e.g. ``syntax error near unexpected token `fi'``.
	pub fn bash_msg(&self) -> Vec<u8> {
		let mut msg = Vec::new();
		let quoted = |msg: &mut Vec<u8>, pre: &[u8], text: &[u8]| {
			msg.extend_from_slice(pre);
			msg.extend_from_slice(text);
			msg.push(b'\'');
		};
		match &self.kind {
			ParseErrorKind::UnexpectedToken { token, closing } => {
				quoted(&mut msg, b"syntax error near unexpected token `", token);
				if let Some(c) = closing {
					quoted(&mut msg, b" while looking for matching `", &[*c]);
				}
			},
			ParseErrorKind::UnexpectedEof { from: None } => {
				msg.extend_from_slice(b"syntax error: unexpected end of file");
			},
			ParseErrorKind::UnexpectedEof { from: Some((kw, at)) } => {
				quoted(&mut msg, b"syntax error: unexpected end of file from `", kw.as_bytes());
				msg.extend_from_slice(b" command on line ");
				crate::bash::syntax::util::push_u32(&mut msg, *at);
			},
			ParseErrorKind::Unmatched(close) => {
				quoted(&mut msg, b"unexpected EOF while looking for matching `", close.as_bytes());
			},
			ParseErrorKind::Near(text) => quoted(&mut msg, b"syntax error near `", text),
			ParseErrorKind::Message(text) => msg.extend_from_slice(text),
		}
		msg
	}

	/// A message bash prints on its own line before [`ParseError::bash_msg`]:
	/// the cause of a `[[ … ]]` error (``unexpected token `b', conditional
	/// binary operator expected``) or the first half of an arithmetic `for`
	/// error.
	pub fn detail(&self) -> Option<ParseWarning> {
		self
			.detail
			.as_ref()
			.map(|(line, msg)| ParseWarning { line: *line, bash_msg: msg.to_vec() })
	}

	/// Whether bash also echoes the offending source line (``name: line N:
	/// `text'``) after the message.
	///
	/// Bash does so for token errors, not for end-of-input errors.
	pub const fn echoes_line(&self) -> bool {
		matches!(self.kind, ParseErrorKind::UnexpectedToken { .. } | ParseErrorKind::Near(_))
	}
}

impl fmt::Display for ParseError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(&String::from_utf8_lossy(&self.bash_msg()))
	}
}

// `thiserror` is not used here: the crate is dependency-free `no_std`.
impl core::error::Error for ParseError {}

type PResult<T> = Result<T, ParseError>;

/// A here-document whose body has not been read yet (bash `redir_stack`).
#[derive(Clone, Debug)]
struct PendingDoc {
	/// Index into `Parser::docs`.
	seq:    u32,
	/// Delimiter after quote removal.
	delim:  Vec<u8>,
	/// `<<-`.
	strip:  bool,
	/// Delimiter was quoted: no `\newline` removal in the body.
	quoted: bool,
}

/// Incremental parser over one source.
///
/// The engine parses one top-level command at a time (resuming with
/// [`Parser::with_pos`]) so alias and `extglob` changes made by the previous
/// command apply to the next, as in bash. Tools use
/// [`parse_all`](crate::bash::syntax::parse_all).
///
/// # Node ids
///
/// Within one [`CompleteCommand`], ids are assigned in preorder over the AST
/// in field order, starting at 0: an and-or list, then its pipelines; a
/// pipeline, then its stages' commands; a command, then its contents (for a
/// simple command: assignments, then words, then redirection target words;
/// for compound commands: the words and lists in the order they are written,
/// then the redirections); an assignment, then its subscript and value
/// words; a word, then the words, lists and commands nested in its parts
/// (parameter-operator words, command and process substitution bodies,
/// compound-array elements). Here-document text and arithmetic text carry no
/// ids. The numbering depends only on the bytes, the [`Features`] and the
/// alias substitutions, so re-parsing reproduces it.
pub struct Parser<'s> {
	/// The whole source.
	src:            &'s [u8],
	/// Offset added to every span (sub-parsers of backquoted text).
	base:           u32,
	feat:           Features,
	aliases:        &'s dyn AliasLookup,
	/// Current input buffer: `src` or an alias value.
	buf:            &'s [u8],
	/// Cursor in `buf`.
	pos:            usize,
	/// 1 + newlines consumed from `src` (the line of the next byte).
	line:           u32,
	/// Saved outer buffers while alias expansions are being read.
	frames:         Vec<Frame<'s>>,
	/// Byte bash appends to a final line without a newline (`\n`, or `\`
	/// after an odd trailing backslash); 0 when the source ends in `\n`.
	virt:           u8,
	virt_done:      bool,
	/// Here-document bodies read ahead of the current line.
	skip:           Option<Skip>,
	lx:             LexState,
	/// One-token lookahead.
	la:             Option<Tok>,
	/// Payloads of the current command's tokens.
	toks:           TokArena<'s>,
	/// End offset of the last token taken.
	last_hi:        u32,
	/// Gathered here-document texts, by sequence number.
	docs:           Vec<Vec<u8>>,
	/// Here-document text nodes waiting for their bodies, and the
	/// sequence numbers of the bodies.
	doc_nodes:      Vec<(Id<Text>, u32)>,
	/// Here-documents waiting for the next newline.
	pending:        Vec<PendingDoc>,
	/// The syntax of the command being parsed.
	t:              Tree,
	/// Open compound commands and their lines (bash `compoundcmd_lineno`).
	compound:       Vec<(lex::T, u32)>,
	warnings:       Vec<ParseWarning>,
	alias_uses:     Vec<AliasUse>,
	expand_aliases: bool,
	failed:         bool,
	/// Text of the last token read inside `[[ … ]]`, for messages.
	last_cond_text: Option<Vec<u8>>,
	/// Nesting of the raw scanner (`parse_matched_pair`).
	raw_depth:      u32,
	/// Nesting of the constructs being parsed ([`MAX_NESTING`]).
	depth:          u32,
	/// Top-level `;` offsets collected while scanning `for ((…))`.
	arith_semis:    Option<Vec<usize>>,
	/// Line of the `[[` being parsed (bash's `lineno` in its messages).
	cond_line:      u32,
	/// Whether the last `[[ … ]]` token read was the end of input.
	cond_eof:       bool,
	/// The zsh grammar under [`Features::ZSH`]: every call goes to it
	/// (boxed: a bash parser stays as small as it was).
	zsh:            Option<Box<crate::bash::syntax::zsh::ZshParser<'s>>>,
	/// Whether a comment consumed the virtual trailing backslash.
	virt_comment:   bool,
	/// The error being raised is one bash recovers from by dropping the
	/// rest of the input line.
	discard_line:   bool,
}

/// Where the next top-level command starts, alias text included.
///
/// When a command ends inside an alias expansion (`alias
/// a='cmd1<newline>cmd2'`), bash runs `cmd1` before it parses `cmd2`, so
/// `cmd2` is parsed by a new [`Parser`] that sees the alias table as `cmd1`
/// left it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Resume {
	/// Source position after the aliased word(s).
	pub pos:     Pos,
	/// Unread rest of the alias expansion text, read before the source
	/// continues at `pos`; empty when the command ended in the source or
	/// exactly at the end of the alias text.
	pub pending: Vec<u8>,
	/// Aliases still being expanded (not re-expanded while `pending` is
	/// read).
	pub active:  Vec<Vec<u8>>,
}

/// How [`parse_text`] reads its input.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TextMode {
	/// As if inside `"…"`: `$` and backquote expansions; `\` quotes `$`,
	/// `` ` ``, `"`, `\` and newline; a `"` is literal.
	DoubleQuote,
	/// Arithmetic text (`$((…))`, `(( ))`, `${x:off:len}`): double-quote
	/// rules, and `"…"` groups are quote-removed as bash does in
	/// arithmetic.
	Arith,
	/// Here-document body with an unquoted delimiter: like
	/// [`TextMode::DoubleQuote`] except that `\"` stays as written.
	HereDoc,
}

/// Parse `src` as one word in `mode`, for expansion by the engine.
///
/// Node ids start at 0 (the word itself). Errors carry bash's message and a
/// line relative to `src`; the engine adds the context (`command
/// substitution: `) and the base line.
pub fn parse_text(src: &[u8], feat: Features, mode: TextMode) -> Result<(Tree, u32), ParseError> {
	parse_text_at(src, feat, mode, 0)
}

/// [`parse_text`] of text that starts at offset `base` of a larger
/// source: every span is an offset into that source.
pub(crate) fn parse_text_at(
	src: &[u8],
	feat: Features,
	mode: TextMode,
	base: u32,
) -> Result<(Tree, u32), ParseError> {
	let mut p = Parser::new(src, feat, NO_ALIASES);
	p.base = base;
	p.virt = 0;
	let word = p.text_word(mode)?;
	debug_assert_eq!(p.t.scratch_len(), 0, "a builder left children on the scratch stack");
	p.fill_docs(0);
	p.t.assign_ids(word.index());
	Ok((p.t, word.index()))
}

impl<'s> Parser<'s> {
	/// Parser at the start of `src`.
	///
	/// `aliases` is consulted for words in command position (and after an
	/// alias whose value ends in a blank); pass [`NO_ALIASES`] when
	/// `expand_aliases` is off.
	pub fn new(src: &'s [u8], feat: Features, aliases: &'s dyn AliasLookup) -> Self {
		let virt = match src.last() {
			None | Some(b'\n') => 0,
			Some(_) => {
				let backslashes = src.iter().rev().take_while(|&&c| c == b'\\').count();
				if backslashes % 2 == 1 { b'\\' } else { b'\n' }
			},
		};
		Self {
			src,
			base: 0,
			feat,
			aliases,
			buf: src,
			pos: 0,
			line: 1,
			frames: Vec::new(),
			virt,
			virt_done: false,
			skip: None,
			lx: LexState::new(),
			la: None,
			toks: TokArena::default(),
			last_hi: 0,
			docs: Vec::new(),
			doc_nodes: Vec::new(),
			pending: Vec::new(),
			t: Tree::default(),
			compound: Vec::new(),
			warnings: Vec::new(),
			alias_uses: Vec::new(),
			expand_aliases: true,
			failed: false,
			last_cond_text: None,
			raw_depth: 0,
			depth: 0,
			arith_semis: None,
			cond_line: 0,
			cond_eof: false,
			virt_comment: false,
			discard_line: false,
			zsh: feat
				.contains(Features::ZSH)
				.then(|| Box::new(crate::bash::syntax::zsh::ZshParser::new(src, feat, aliases))),
		}
	}

	/// Resume at `pos` (from an earlier [`Parser::pos`] over the same source).
	pub fn with_pos(mut self, pos: Pos) -> Self {
		if let Some(z) = self.zsh.take() {
			self.zsh = Some(Box::new(z.with_pos(pos)));
			return self;
		}
		self.frames.clear();
		self.buf = self.src;
		self.pos = (pos.offset as usize).min(self.src.len());
		self.line = pos.line;
		self.virt_done = self.pos == self.src.len();
		self
	}

	/// Resume where an earlier parser over the same source stopped
	/// ([`Parser::resume`]), alias text included: the pending text is read
	/// as an alias expansion (with the active aliases suppressed), then the
	/// source continues at `resume.pos`.
	pub fn with_resume(mut self, resume: &'s Resume) -> Self {
		if let Some(z) = self.zsh.take() {
			self.zsh = Some(Box::new(z.with_resume(resume)));
			return self;
		}
		let mut p = self.with_pos(resume.pos);
		if resume.pending.is_empty() {
			return p;
		}
		p.virt_done = false;
		let mut names = resume.active.iter();
		p.frames.push(Frame {
			buf:         p.src,
			pos:         p.pos,
			alias:       names.next().cloned().unwrap_or_default(),
			expand_next: false,
		});
		for name in names {
			p.frames.push(Frame {
				buf:         cursor::EMPTY,
				pos:         0,
				alias:       name.clone(),
				expand_next: false,
			});
		}
		p.buf = &resume.pending;
		p.pos = 0;
		p
	}

	/// Build the next command in `tree`'s buffers (cleared) instead of
	/// fresh ones. Each command takes the buffers it was built in; a caller
	/// done with a command hands its tree back here so the next one does
	/// not allocate. [`Parser::take_tree`] returns buffers no command took.
	pub fn recycle(&mut self, mut tree: Tree) {
		if let Some(z) = &mut self.zsh {
			return z.recycle(tree);
		}
		tree.clear();
		self.t = tree;
	}

	/// The buffers the next command would be built in (see
	/// [`Parser::recycle`]).
	pub fn take_tree(&mut self) -> Tree {
		if let Some(z) = &mut self.zsh {
			return z.take_tree();
		}
		core::mem::take(&mut self.t)
	}

	/// Where the next [`Parser::next_command`] starts in the source.
	///
	/// When the last command ended inside an alias expansion, this is the
	/// offset after the aliased word; use [`Parser::resume`] to keep the
	/// unread alias text.
	pub fn pos(&self) -> Pos {
		if let Some(z) = &self.zsh {
			return z.pos();
		}
		Pos { offset: self.src_pos() as u32, line: self.line }
	}

	/// Where the next [`Parser::next_command`] starts, with any unread alias
	/// text; feed it to [`Parser::with_resume`] on a new parser.
	pub fn resume(&self) -> Resume {
		if let Some(z) = &self.zsh {
			return z.resume();
		}
		let pending = self.alias_text_left();
		let active = if pending.is_empty() {
			Vec::new()
		} else {
			self.active_aliases()
		};
		Resume { pos: self.pos(), pending, active }
	}

	/// The grammar switches in effect.
	pub const fn features(&self) -> Features {
		self.feat
	}

	/// Under [`Features::ZSH`], the constructs left open where the input
	/// ran out, outermost first, as zsh names them in `PS2`'s `%_` (`if`,
	/// `then`, `dquote`, `cmdand`, `heredoc`, …); `None` for the bash
	/// grammar. Describes the event the last [`Parser::next_command`] call
	/// parsed: non-empty when the input ran out inside those constructs,
	/// even if that call returned a command (a here-document cut short);
	/// see [`crate::bash::syntax::zsh::ZshParser::cmdstack`].
	pub fn zsh_cmdstack(&self) -> Option<Vec<&'static str>> {
		let z = self.zsh.as_ref()?;
		Some(
			z.cmdstack()
				.iter()
				.map(|&cs| crate::bash::syntax::zsh::cmdname(cs))
				.collect(),
		)
	}

	/// Parse the next top-level command; `None` at end of input.
	///
	/// After an error the parser stays at end of input: a non-interactive
	/// bash abandons the rest of a script on a syntax error. The exception
	/// is an error with [`ParseError::recovered`] set: parsing goes on with
	/// the next line.
	pub fn next_command(&mut self) -> Option<Result<CompleteCommand, ParseError>> {
		if let Some(z) = &mut self.zsh {
			return z.next_command();
		}
		if self.failed {
			return None;
		}
		match self.complete_command() {
			Ok(Some(cc)) => Some(Ok(cc)),
			Ok(None) => None,
			Err(mut e) => {
				if core::mem::take(&mut self.discard_line) {
					self.drop_line();
					e.recovered = true;
				} else {
					self.failed = true;
					self.frames.clear();
					self.buf = self.src;
					self.pos = self.src.len();
					self.virt_done = true;
				}
				let mut warnings = core::mem::take(&mut self.warnings);
				warnings.extend(core::mem::take(&mut e.warnings));
				e.warnings = warnings.into_boxed_slice();
				Some(Err(e))
			},
		}
	}
}

impl Parser<'_> {
	/// bash's `DISCARD`: forget the command being parsed, any alias text,
	/// and the rest of the source line; the next command starts on the next
	/// line.
	fn drop_line(&mut self) {
		let at = self.src_pos().min(self.src.len());
		self.frames.clear();
		self.buf = self.src;
		self.pos = at;
		self.skip = None;
		self.raw_depth = 0;
		self.arith_semis = None;
		self.expand_aliases = true;
		while let Some(c) = self.peek() {
			self.bump();
			if c == b'\n' {
				break;
			}
		}
	}

	/// Put the here-document bodies gathered for the registrations from
	/// `from` on into their text nodes, retiring those registrations: the
	/// next command's document numbers start over (a backquoted list
	/// parses its commands into one tree), and a substitution must not
	/// fill the enclosing command's documents before they are read.
	fn fill_docs(&mut self, from: usize) {
		for (node, seq) in self.doc_nodes.drain(from..) {
			if let Some(text) = self.docs.get(seq as usize) {
				self.t.set_text(node, text);
			}
		}
	}

	/// Run `f` one nesting level deeper. Past [`MAX_NESTING`] levels the
	/// command is a syntax error rather than a stack overflow.
	fn nested<T, E: From<ParseError>>(
		&mut self,
		f: impl FnOnce(&mut Self) -> Result<T, E>,
	) -> Result<T, E> {
		if self.depth >= MAX_NESTING {
			return Err(E::from(self.too_deep()));
		}
		self.depth += 1;
		let r = f(self);
		self.depth -= 1;
		r
	}

	/// The error for input nested past [`MAX_NESTING`], here.
	fn too_deep(&self) -> ParseError {
		let at = self.off();
		ParseError::new(
			Span::new(at, at),
			self.bash_line(),
			ParseErrorKind::Message(Box::from(TOO_DEEP)),
		)
	}
}

const TOO_DEEP: &[u8] = b"syntax error: maximum nesting level exceeded";

/// Deepest nesting the parsers accept: compound commands, substitutions
/// (two levels each: a word and a list), `${…}` operands, `[[ … ]]` groups
/// and operator chains. Every level costs native stack in the parser and
/// in each walk of the tree after it (lowering, printing, the trace view),
/// so a command nested deeper is a syntax error instead of a stack
/// overflow. The value fits a 2 MiB thread, the default the shells run
/// on, with room to spare even in a debug build; bash's own parser
/// rejects compound commands nested a few thousand deep and overflows on
/// command substitutions.
pub(crate) const MAX_NESTING: u32 = 400;

/// Parse `code` (text bash re-parses at run time: a backquoted command, a
/// `$((…))` that is not arithmetic) into `t` as one list; spans are
/// shifted by `base`, `depth` is the nesting it is parsed at. Aliases are
/// not expanded. A syntax error yields an empty list, as bash reports it
/// only when the text runs; text nested past [`MAX_NESTING`] yields
/// `None`, the caller's syntax error (the stack limit is not bash's).
fn sub_parse_list(
	t: &mut Tree,
	code: &[u8],
	feat: Features,
	base: u32,
	depth: u32,
) -> Option<Id<shape::List>> {
	let mut p = Parser::new(code, feat, NO_ALIASES);
	p.base = base;
	p.depth = depth + 1;
	p.t = core::mem::take(t);
	let mark = p.t.open();
	let mut too_deep = depth >= MAX_NESTING;
	let mut failed = too_deep;
	while !failed {
		match p.top_list() {
			Ok(Some(top)) => {
				p.fill_docs(0);
				p.t.kid_items(mark, top.list);
			},
			Ok(None) => break,
			Err(e) => {
				too_deep = matches!(&e.kind, ParseErrorKind::Message(m) if **m == *TOO_DEEP);
				failed = true;
			},
		}
	}
	if failed {
		p.t.drop_opened(mark);
	}
	let list = p.t.list_at(mark);
	debug_assert_eq!(p.t.opened_len(mark), 0, "a builder left children on the scratch stack");
	*t = p.t;
	(!too_deep).then_some(list)
}
