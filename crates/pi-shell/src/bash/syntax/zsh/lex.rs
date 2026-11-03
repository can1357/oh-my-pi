//! The zsh 5.9 lexer: a port of `Src/lex.c` (`zshlex`, `gettok`,
//! `gettokstr`, `dquote_parse`, `cmd_or_math`, `skipcomm`, `exalias`,
//! `checkalias`), of the input stack of `Src/input.c` (`ingetc`,
//! `inungetc`, `inpush`, `inpoptop`, `input_hasalias`) and of the
//! here-document reader `gethere` of `Src/exec.c`.
//!
//! zsh's lexer is a set of globals that its parser steers (`incmdpos`,
//! `incond`, `incasepat`, `intypeset`, `infor`); here they are the fields of
//! [`Ctx`], whose parser half lives in `parse.rs`. Tokens are produced
//! exactly as zsh leaves `tokstr`: metafied, with the token bytes of
//! [`super::tok`]. The source is read as raw bytes and metafied on the fly,
//! as zsh metafies every input line.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use alloc::{borrow::Cow, vec, vec::Vec};

use super::tok::{
	BANG, BAR, BNULL, COMMA, DASH, DNULL, EQUALS, HAT, INANG, INBRACE, INBRACK, INPAR, INPARMATH,
	META, OUTANG, OUTANGPROC, OUTBRACE, OUTBRACK, OUTPAR, OUTPARMATH, POUND, QSTRING, QTICK, QUEST,
	SNULL, STAR, STRING, TICK, TILDE, at, has_token, head, is_meta, is_null, is_tok, metafy, tail,
	tok_char, unmetafy,
};
use crate::bash::syntax::{
	ast::AliasUse,
	features::{AliasLookup, Features},
};

/// zsh `enum lextok`: the token kinds `gettok` returns and `exalias` turns
/// into reserved words.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(u8)]
pub(super) enum T {
	/// `SEPER`: `;` or a newline, after `zshlex`.
	Seper,
	/// `NEWLIN`
	Newlin,
	/// `SEMI`
	Semi,
	/// `DSEMI`: `;;`
	Dsemi,
	/// `AMPER`: `&`
	Amper,
	/// `INPAR`: `(`
	Inpar,
	/// `OUTPAR`: `)`
	Outpar,
	/// `DBAR`: `||`
	Dbar,
	/// `DAMPER`: `&&`
	Damper,
	/// `OUTANG`: `>`
	Outang,
	/// `OUTANGBANG`: `>|`
	Outangbang,
	/// `DOUTANG`: `>>`
	Doutang,
	/// `DOUTANGBANG`: `>>|`
	Doutangbang,
	/// `INANG`: `<`
	Inang,
	/// `INOUTANG`: `<>`
	Inoutang,
	/// `DINANG`: `<<`
	Dinang,
	/// `DINANGDASH`: `<<-`
	Dinangdash,
	/// `INANGAMP`: `<&`
	Inangamp,
	/// `OUTANGAMP`: `>&`
	Outangamp,
	/// `AMPOUTANG`: `&>`
	Ampoutang,
	/// `OUTANGAMPBANG`: `&>|`
	Outangampbang,
	/// `DOUTANGAMP`: `>>&`
	Doutangamp,
	/// `DOUTANGAMPBANG`: `>>&|`
	Doutangampbang,
	/// `TRINANG`: `<<<`
	Trinang,
	/// `BAR`: `|`
	Bar,
	/// `BARAMP`: `|&`
	Baramp,
	/// `INOUTPAR`: `()`
	Inoutpar,
	/// `DINPAR`: `((`
	Dinpar,
	/// `DOUTPAR`: `))`
	Doutpar,
	/// `AMPERBANG`: `&|` / `&!`
	Amperbang,
	/// `SEMIAMP`: `;&`
	Semiamp,
	/// `SEMIBAR`: `;|`
	Semibar,
	/// `DOUTBRACK`: `]]`
	Doutbrack,
	/// `STRING`: a word.
	String,
	/// `ENVSTRING`: `name=value` in command position.
	Envstring,
	/// `ENVARRAY`: `name=(` in command position.
	Envarray,
	/// `ENDINPUT`
	#[default]
	Endinput,
	/// `LEXERR`
	Lexerr,
	/// `!`
	Bang,
	/// `[[`
	Dinbrack,
	/// `{`
	Inbrace,
	/// `}`
	Outbrace,
	/// `case`
	Case,
	/// `coproc`
	Coproc,
	/// `do`
	Doloop,
	/// `done`
	Done,
	/// `elif`
	Elif,
	/// `else`
	Else,
	/// `end`
	Zend,
	/// `esac`
	Esac,
	/// `fi`
	Fi,
	/// `for`
	For,
	/// `foreach`
	Foreach,
	/// `function`
	Func,
	/// `if`
	If,
	/// `nocorrect`
	Nocorrect,
	/// `repeat`
	Repeat,
	/// `select`
	Select,
	/// `then`
	Then,
	/// `time`
	Time,
	/// `until`
	Until,
	/// `while`
	While,
	/// `typeset` and its relatives.
	Typeset,
}

impl T {
	/// zsh `IS_REDIROP`.
	pub(super) const fn is_redirop(self) -> bool {
		self as u8 >= Self::Outang as u8 && self as u8 <= Self::Trinang as u8
	}
}

/// zsh `tokstrings`: the text of a punctuation token.
const fn tokstring(t: T) -> Option<&'static [u8]> {
	Some(match t {
		T::Seper | T::Semi => b";",
		T::Newlin => b"\\n",
		T::Dsemi => b";;",
		T::Amper => b"&",
		T::Inpar => b"(",
		T::Outpar => b")",
		T::Dbar => b"||",
		T::Damper => b"&&",
		T::Outang => b">",
		T::Outangbang => b">|",
		T::Doutang => b">>",
		T::Doutangbang => b">>|",
		T::Inang => b"<",
		T::Inoutang => b"<>",
		T::Dinang => b"<<",
		T::Dinangdash => b"<<-",
		T::Inangamp => b"<&",
		T::Outangamp => b">&",
		T::Ampoutang => b"&>",
		T::Outangampbang => b"&>|",
		T::Doutangamp => b">>&",
		T::Doutangampbang => b">>&|",
		T::Trinang => b"<<<",
		T::Bar => b"|",
		T::Baramp => b"|&",
		T::Inoutpar => b"()",
		T::Dinpar => b"((",
		T::Doutpar => b"))",
		T::Amperbang => b"&|",
		T::Semiamp => b";&",
		T::Semibar => b";|",
		_ => return None,
	})
}

/// zsh `reswds` (`hashtable.c`): the reserved word spelled `s`.
pub(super) const fn reswd(s: &[u8]) -> Option<T> {
	Some(match s {
		b"!" => T::Bang,
		b"[[" => T::Dinbrack,
		b"{" => T::Inbrace,
		b"}" => T::Outbrace,
		b"case" => T::Case,
		b"coproc" => T::Coproc,
		b"declare" | b"export" | b"float" | b"integer" | b"local" | b"readonly" | b"typeset" => {
			T::Typeset
		},
		b"do" => T::Doloop,
		b"done" => T::Done,
		b"elif" => T::Elif,
		b"else" => T::Else,
		b"end" => T::Zend,
		b"esac" => T::Esac,
		b"fi" => T::Fi,
		b"for" => T::For,
		b"foreach" => T::Foreach,
		b"function" => T::Func,
		b"if" => T::If,
		b"nocorrect" => T::Nocorrect,
		b"repeat" => T::Repeat,
		b"select" => T::Select,
		b"then" => T::Then,
		b"time" => T::Time,
		b"until" => T::Until,
		b"while" => T::While,
		_ => return None,
	})
}

/// zsh `iblank`: space or tab.
pub(super) const fn iblank(c: u8) -> bool {
	matches!(c, b' ' | b'\t')
}

/// zsh `inblank`: space, tab or newline.
const fn inblank(c: u8) -> bool {
	matches!(c, b' ' | b'\t' | b'\n')
}

/// zsh `iident` for the bytes this port recognises: ASCII alphanumerics
/// and `_`. Used by the lexer and the zsh expander to find names.
pub const fn iident(c: u8) -> bool {
	c.is_ascii_alphanumeric() || c == b'_'
}

/// zsh `itype_end(s, IIDENT, 0)`: index of the first byte of `s[from..]`
/// that is not an identifier character (lexer assignments, expander
/// parameter names).
pub fn ident_end(s: &[u8], from: usize) -> usize {
	from + tail(s, from).iter().take_while(|&&c| iident(c)).count()
}

/// zsh `skipparens` (`utils.c`) over a token string.
///
/// With `s[*at] == inpar`, moves `*at` past the matching `outpar` (or to
/// the end) and returns the unmatched level (0 when matched); -1 when
/// `s[*at]` is not `inpar`. Used by the lexer, the parser and the zsh
/// expander.
pub fn skipparens(inpar: u8, outpar: u8, s: &[u8], at: &mut usize) -> i32 {
	if s.get(*at) != Some(&inpar) {
		return -1;
	}
	let mut level = 1;
	loop {
		*at += 1;
		let Some(&c) = s.get(*at) else { break };
		if level == 0 {
			break;
		}
		if c == inpar {
			level += 1;
		} else if c == outpar {
			level -= 1;
		}
	}
	level
}

/// zsh `isident` (`params.c`) on a token string: a name, a number, or a
/// name followed by a literal `[…]` subscript. Used by the parser (`for`
/// variables) and the zsh expander.
pub fn isident(s: &[u8]) -> bool {
	if s.is_empty() {
		return false;
	}
	let end = if s[0].is_ascii_digit() {
		1 + tail(s, 1).iter().take_while(|c| c.is_ascii_digit()).count()
	} else {
		ident_end(s, 0)
	};
	if end == s.len() {
		return true;
	}
	if end == 0 || at(s, end) != b'[' {
		return false;
	}
	s.len() > end + 2 && s[s.len() - 1] == b']'
}

/// The untokenized text of a token string, still metafied (zsh
/// `untokenize` on a copy).
pub(super) fn untok(s: &[u8]) -> Vec<u8> {
	let mut out = s.to_vec();
	super::tok::untokenize(&mut out);
	out
}

/// The text a token string stands for: untokenized and unmetafied.
pub(super) fn plain(s: &[u8]) -> Vec<u8> {
	unmetafy(&untok(s))
}

/// zsh `quotesubst` + `untokenize` (as `gethere` applies them to a
/// here-document terminator): `$'…'` decoded, quotes removed. Returns raw
/// (unmetafied) bytes.
pub(super) fn munge_terminator(s: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(s.len());
	let mut i = 0;
	while i < s.len() {
		let c = s[i];
		if c == STRING && s.get(i + 1) == Some(&SNULL) {
			i = dollar_quote(s, i + 2, &mut out);
			continue;
		}
		if c == META && i + 1 < s.len() {
			out.push(s[i + 1] ^ 32);
			i += 2;
			continue;
		}
		if !is_null(c) {
			out.push(tok_char(c).unwrap_or(c));
		}
		i += 1;
	}
	out
}

/// Decodes the body of a `$'…'` token string starting at `i` (after the
/// opening `Snull`) into `out`, the escapes of zsh `getkeystring` with
/// `GETKEYS_DOLLARS_QUOTE` that a terminator can use; returns the index
/// after the closing `Snull`.
fn dollar_quote(text: &[u8], mut pos: usize, out: &mut Vec<u8>) -> usize {
	while pos < text.len() && text[pos] != SNULL {
		let ch = text[pos];
		pos += 1;
		if ch == META && pos < text.len() {
			out.push(text[pos] ^ 32);
			pos += 1;
			continue;
		}
		if ch != b'\\' && ch != BNULL {
			out.push(ch);
			continue;
		}
		let Some(&esc) = text.get(pos) else {
			out.push(b'\\');
			break;
		};
		pos += 1;
		let simple = match esc {
			b'a' => Some(7),
			b'b' => Some(8),
			b'e' | b'E' => Some(27),
			b'f' => Some(12),
			b'n' => Some(b'\n'),
			b'r' => Some(b'\r'),
			b't' => Some(b'\t'),
			b'v' => Some(11),
			b'\\' | b'\'' | b'"' => Some(esc),
			_ => None,
		};
		if let Some(byte) = simple {
			out.push(byte);
		} else if esc == b'x' {
			let mut val = 0u8;
			let mut count = 0;
			while count < 2 && pos < text.len() && text[pos].is_ascii_hexdigit() {
				val = val * 16 + (text[pos] as char).to_digit(16).unwrap_or(0) as u8;
				pos += 1;
				count += 1;
			}
			out.push(val);
		} else if (b'0'..=b'7').contains(&esc) {
			let mut val = u32::from(esc - b'0');
			let mut count = 1;
			while count < 3 && pos < text.len() && (b'0'..=b'7').contains(&text[pos]) {
				val = val * 8 + u32::from(text[pos] - b'0');
				pos += 1;
				count += 1;
			}
			out.push(val as u8);
		} else {
			out.push(b'\\');
			out.push(esc);
		}
	}
	pos + 1
}

/// Character classes of zsh `lexact1`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Act1 {
	Bkslash,
	Newlin,
	Semi,
	Amper,
	Bar,
	Inpar,
	Outpar,
	Inang,
	Outang,
	Other,
}

/// zsh `lexact1[c]`.
const fn lexact1(c: u8) -> Act1 {
	match c {
		b'\\' => Act1::Bkslash,
		b'\n' => Act1::Newlin,
		b';' => Act1::Semi,
		b'&' => Act1::Amper,
		b'|' => Act1::Bar,
		b'(' => Act1::Inpar,
		b')' => Act1::Outpar,
		b'<' => Act1::Inang,
		b'>' => Act1::Outang,
		_ => Act1::Other,
	}
}

/// Character classes of zsh `lexact2`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Act2 {
	Break,
	Outpar,
	Bar,
	String,
	Inbrack,
	Outbrack,
	Inpar,
	Inbrace,
	Outbrace,
	Outang,
	Inang,
	Equals,
	Bkslash,
	Quote,
	Dquote,
	Bquote,
	Comma,
	Dash,
	Bang,
	Other,
	Meta,
}

/// zsh `lexact2[c]` (`~` has its own class in zsh but no case of its own).
const fn lexact2(c: u8) -> Act2 {
	match c {
		b';' | b'&' => Act2::Break,
		b')' => Act2::Outpar,
		b'|' => Act2::Bar,
		b'$' => Act2::String,
		b'[' => Act2::Inbrack,
		b']' => Act2::Outbrack,
		b'(' => Act2::Inpar,
		b'{' => Act2::Inbrace,
		b'}' => Act2::Outbrace,
		b'>' => Act2::Outang,
		b'<' => Act2::Inang,
		b'=' => Act2::Equals,
		b'\\' => Act2::Bkslash,
		b'\'' => Act2::Quote,
		b'"' => Act2::Dquote,
		b'`' => Act2::Bquote,
		b',' => Act2::Comma,
		b'-' => Act2::Dash,
		b'!' => Act2::Bang,
		META => Act2::Meta,
		_ => Act2::Other,
	}
}

/// zsh `lextok2[c]`: the token an unquoted character becomes.
const fn lextok2(c: u8) -> u8 {
	match c {
		b'*' => STAR,
		b'?' => QUEST,
		b'{' => INBRACE,
		b'[' => INBRACK,
		b'$' => STRING,
		b'~' => TILDE,
		b'#' => POUND,
		b'^' => HAT,
		_ => c,
	}
}

/// Result of zsh `cmd_or_math`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Com {
	/// `CMD_OR_MATH_CMD`
	Cmd,
	/// `CMD_OR_MATH_MATH`
	Math,
	/// `CMD_OR_MATH_ERR`
	Err,
}

/// The alias a frame of the input stack expands (zsh `Alias` with its
/// `inuse` flag, which is "a live frame expands it" here).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct AliasKey {
	/// A suffix alias (`alias -s`), keyed by its suffix.
	pub(super) suffix: bool,
	/// Alias name (raw bytes).
	pub(super) name:   Vec<u8>,
}

/// One entry of zsh's input stack (`struct instacks` plus the current
/// buffer variables).
struct Frame<'s> {
	/// Raw (unmetafied) text.
	buf:      Cow<'s, [u8]>,
	/// Next byte to read.
	pos:      usize,
	/// `Meta` of the meta byte at `pos` was returned; its second half is
	/// next.
	half:     bool,
	/// The alias this frame expands.
	alias:    Option<AliasKey>,
	/// The alias's text ends in a blank (zsh sets `inalmore` on pop).
	al_space: bool,
	/// Pushed as an alias expansion: the frame below is `INP_ALCONT`.
	alcont:   bool,
	/// `INP_ALIAS`: its bytes are dropped from raw command text on pop.
	in_alias: bool,
	/// `INP_RAW_KEEP`.
	raw_keep: bool,
	/// Position of the frame below when this one was pushed (zsh
	/// `inbufpush`).
	below:    (usize, bool),
	/// Re-activated by `inungetc` after it was popped: empty.
	restored: bool,
}

impl<'s> Frame<'s> {
	const fn source(src: &'s [u8], pos: usize) -> Self {
		Self {
			buf: Cow::Borrowed(src),
			pos,
			half: false,
			alias: None,
			al_space: false,
			alcont: false,
			in_alias: false,
			raw_keep: false,
			below: (0, false),
			restored: false,
		}
	}
}

/// A here-document waiting for the next newline (zsh `struct heredocs`).
#[derive(Clone, Debug)]
pub(super) struct PendingDoc {
	/// Index into [`Ctx::docs`].
	pub(super) seq:    usize,
	/// Terminator after quote removal (raw bytes; leading tabs removed for
	/// `<<-`).
	pub(super) delim:  Vec<u8>,
	/// `<<-`.
	pub(super) strip:  bool,
	/// The terminator was quoted.
	pub(super) quoted: bool,
}

/// Lexer globals zsh saves in `lex_context_save` (and the token position
/// this port adds).
#[derive(Clone, Debug, Default)]
pub(super) struct LexState {
	/// `tok`
	pub(super) tok:       T,
	/// `lexbuf` / `tokstr` (metafied, tokenized).
	pub(super) buf:       Vec<u8>,
	/// `tokstr != NULL`.
	pub(super) has_str:   bool,
	/// `zshlextext`: untokenized text of the last token `exalias` saw.
	pub(super) lextext:   Option<Vec<u8>>,
	/// `tokfd`: explicit fd of a redirection operator, or -1.
	pub(super) tokfd:     i32,
	/// `dbparens`
	pub(super) dbparens:  bool,
	/// `toklineno`
	pub(super) toklineno: u32,
	/// Source offset of the token.
	pub(super) lo:        u32,
	/// Source offset after the token.
	pub(super) hi:        u32,
	/// End of the token before this one (end of the last consumed token).
	pub(super) last_hi:   u32,
	/// The `SEPER` was a newline.
	pub(super) sep_nl:    bool,
}

/// Parser globals zsh saves in `parse_context_save`.
#[derive(Clone, Debug, Default)]
pub(super) struct ParseFlags {
	/// `incmdpos`
	pub(super) incmdpos:  bool,
	/// `incond`
	pub(super) incond:    i32,
	/// `incasepat`
	pub(super) incasepat: i32,
	/// `intypeset`
	pub(super) intypeset: bool,
	/// `infor`
	pub(super) infor:     i32,
	/// `inrepeat_`
	pub(super) inrepeat:  i32,
	/// `isnewlin`
	pub(super) isnewlin:  i32,
	/// `hdocs`
	pub(super) hdocs:     Vec<PendingDoc>,
}

/// zsh's lexer and parser globals over one source.
pub(super) struct Ctx<'s> {
	/// The whole source.
	pub(super) src:        &'s [u8],
	/// Parse-affecting options.
	pub(super) feat:       Features,
	/// Alias tables.
	pub(super) aliases:    &'s dyn AliasLookup,
	/// Input stack; `frames[0]` is the source. Frames above `top` are
	/// popped alias frames `inungetc` may re-activate.
	frames:                Vec<Frame<'s>>,
	/// Index of the frame being read.
	top:                   usize,
	/// Line of the next source byte (zsh `lineno`).
	pub(super) line:       u32,
	/// Source offset of the last byte read.
	last_src_off:          u32,
	/// `lexstop`
	pub(super) lexstop:    bool,
	/// `lex_add_raw` nesting.
	lex_add_raw:           u32,
	/// `tokstr_raw`: raw text of the command substitution being skipped.
	raw:                   Vec<u8>,
	/// Length of `raw` before the command substitution started.
	raw_floor:             usize,
	/// Lexer state.
	pub(super) lx:         LexState,
	/// Parser state.
	pub(super) ps:         ParseFlags,
	/// `errflag & ERRFLAG_ERROR`
	pub(super) errflag:    bool,
	/// Messages zsh printed (`zerr`/`zwarn`), with their lines.
	pub(super) msgs:       Vec<(u32, Vec<u8>)>,
	/// `noaliases`
	pub(super) noaliases:  bool,
	/// `inalmore`
	inalmore:              bool,
	/// `inpartime` of `par_cmd`.
	pub(super) inpartime:  bool,
	/// Here-document bodies by sequence number.
	pub(super) docs:       Vec<Vec<u8>>,
	/// Alias substitutions of the current top-level command.
	pub(super) alias_uses: Vec<AliasUse>,
	/// Line of the first token of the event being parsed.
	pub(super) ev_line:    u32,
	/// The token `par_event` failed at (before it became `LEXERR`).
	pub(super) err_tok:    T,
	/// zsh `lexflags` (`LEXFLAGS_*`; 0 for command input).
	lexflags:              u32,
	/// zsh `nocomments`.
	nocomments:            bool,
}

/// zsh `LEXFLAGS_ACTIVE`: lexing a string for its words (unmatched quotes
/// end a word instead of failing).
pub const LEXFLAGS_ACTIVE: u32 = 0x0001;
/// zsh `LEXFLAGS_COMMENTS_KEEP`: comments are words of their own.
pub const LEXFLAGS_COMMENTS_KEEP: u32 = 0x0004;
/// zsh `LEXFLAGS_COMMENTS_STRIP`: comments are dropped.
pub const LEXFLAGS_COMMENTS_STRIP: u32 = 0x0008;
/// zsh `LEXFLAGS_NEWLINE`: newlines are not turned into `;`.
pub const LEXFLAGS_NEWLINE: u32 = 0x0010;
/// zsh `LEXFLAGS_COMMENTS`.
const LEXFLAGS_COMMENTS: u32 = LEXFLAGS_COMMENTS_KEEP | LEXFLAGS_COMMENTS_STRIP;

impl<'s> Ctx<'s> {
	/// Context reading `src` from `pos` (zsh `lexinit` + `init_parse_status`).
	pub(super) fn new(
		src: &'s [u8],
		pos: usize,
		line: u32,
		feat: Features,
		aliases: &'s dyn AliasLookup,
	) -> Self {
		Self {
			src,
			feat,
			aliases,
			frames: vec![Frame::source(src, pos.min(src.len()))],
			top: 0,
			line,
			last_src_off: pos as u32,
			lexstop: false,
			lex_add_raw: 0,
			raw: Vec::new(),
			raw_floor: 0,
			lx: LexState { tokfd: -1, ..LexState::default() },
			ps: ParseFlags { incmdpos: true, ..ParseFlags::default() },
			errflag: false,
			msgs: Vec::new(),
			noaliases: false,
			inalmore: false,
			inpartime: false,
			docs: Vec::new(),
			alias_uses: Vec::new(),
			ev_line: line,
			err_tok: T::Endinput,
			lexflags: 0,
			nocomments: false,
		}
	}

	/// Whether the zsh option behind `f` is on.
	pub(super) const fn opt(&self, f: Features) -> bool {
		self.feat.contains(f)
	}

	/// Offset of the next source byte.
	pub(super) fn src_off(&self) -> u32 {
		self.frames.first().map_or(0, |f| f.pos) as u32
	}

	/// The frames being read: the source (index 0) and the alias
	/// expansions above it up to `top`.
	fn live(&self) -> &[Frame<'s>] {
		head(&self.frames, self.top + 1)
	}

	/// Unread text of the alias expansions being read (top first) and the
	/// aliases they expand (outermost first).
	pub(super) fn pending_alias_text(&self) -> (Vec<u8>, Vec<Vec<u8>>) {
		let mut text = Vec::new();
		let mut names = Vec::new();
		for f in tail(self.live(), 1).iter().rev() {
			if !f.restored {
				text.extend_from_slice(tail(&f.buf, f.pos));
			}
		}
		for f in tail(self.live(), 1) {
			if let Some(a) = &f.alias {
				let mut n = Vec::with_capacity(a.name.len() + 1);
				if a.suffix {
					n.push(b'.');
				}
				n.extend_from_slice(&a.name);
				names.push(n);
			}
		}
		(text, names)
	}

	/// Pushes the unread alias text of a [`crate::bash::syntax::Resume`]: one
	/// empty frame per still-active alias, then the text.
	pub(super) fn push_resume(&mut self, pending: &'s [u8], active: &[Vec<u8>]) {
		for name in active {
			let key = match name.strip_prefix(b".") {
				Some(s) => AliasKey { suffix: true, name: s.to_vec() },
				None => AliasKey { suffix: false, name: name.clone() },
			};
			self.inpush(Cow::Borrowed(&[]), Some(key), false, false);
		}
		if !pending.is_empty() {
			self.inpush(Cow::Borrowed(pending), None, true, false);
		}
	}

	// ---- input.c -------------------------------------------------------

	/// zsh `ingetc`/`hgetc`: the next metafied input byte; `' '` with
	/// `lexstop` set at the end of input.
	pub(super) fn hgetc(&mut self) -> u8 {
		if self.lexstop {
			return b' ';
		}
		loop {
			let top = self.top;
			let src0 = self.src_off();
			let Some(f) = self.frames.get_mut(top) else {
				self.lexstop = true;
				return b' ';
			};
			if f.half {
				f.half = false;
				let c = at(&f.buf, f.pos) ^ 32;
				f.pos += 1;
				self.raw_add(c);
				return c;
			}
			if !f.restored && f.pos < f.buf.len() {
				let c = at(&f.buf, f.pos);
				self.last_src_off = if top == 0 { f.pos as u32 } else { src0 };
				if is_meta(c) {
					f.half = true;
					self.raw_add(META);
					return META;
				}
				f.pos += 1;
				if top == 0 && c == b'\n' {
					self.line += 1;
				}
				self.raw_add(c);
				return c;
			}
			// zsh: with no input left anywhere the input ends without
			// popping, which would mark the aliases being expanded unused
			// before the word is done (`alias cat='LC_ALL=C cat'`, then `cat`
			// ending the text would expand again and again).
			if self
				.live()
				.iter()
				.all(|f| f.restored || f.pos >= f.buf.len())
			{
				self.lexstop = true;
				return b' ';
			}
			self.inpoptop();
		}
	}

	/// zsh `inungetc`/`hungetc`: back up over the last byte read.
	pub(super) fn hungetc(&mut self, c: u8) {
		if self.lexstop {
			return;
		}
		let top = self.top;
		let Some(f) = self.frames.get_mut(top) else {
			return;
		};
		if f.half {
			f.half = false;
		} else if !f.restored && f.pos > 0 {
			f.pos -= 1;
			let b = at(&f.buf, f.pos);
			if is_meta(b) {
				f.half = true;
			} else if top == 0 && b == b'\n' {
				self.line -= 1;
			}
		} else if top == 0 {
			// zsh: "Garbled input"; nothing to back up over.
			return;
		} else {
			// Backing up over a byte of an exhausted lower layer: push it
			// as a continuation of its own.
			self.inpush(Cow::Owned(vec![c]), None, false, false);
			self.raw_back();
			return;
		}
		self.restore_aliases();
		self.raw_back();
	}

	/// The re-activation half of zsh `inungetc`: back at the point where
	/// an alias expansion was pushed, the popped alias frames above become
	/// current again (marking their aliases in use).
	fn restore_aliases(&mut self) {
		while let (Some(cur), Some(next)) = (self.frames.get(self.top), self.frames.get(self.top + 1))
		{
			let below = if cur.restored {
				(cur.buf.len(), false)
			} else {
				(cur.pos, cur.half)
			};
			if !next.alcont || next.below != below {
				break;
			}
			self.top += 1;
			if let Some(f) = self.frames.get_mut(self.top) {
				f.restored = true;
			}
		}
	}

	/// zsh `inpush`: read `buf` before the rest of the input.
	fn inpush(&mut self, buf: Cow<'s, [u8]>, alias: Option<AliasKey>, alcont: bool, al_space: bool) {
		self.frames.truncate(self.top + 1);
		let (below, in_alias) = self
			.frames
			.last()
			.map_or(((0, false), false), |cur| ((cur.pos, cur.half), cur.in_alias));
		let in_alias = alcont || in_alias;
		self.frames.push(Frame {
			buf,
			pos: 0,
			half: false,
			alias,
			al_space,
			alcont,
			in_alias,
			raw_keep: false,
			below,
			restored: false,
		});
		self.top += 1;
	}

	/// zsh `inpoptop`: leave an exhausted frame (kept for `inungetc`).
	fn inpoptop(&mut self) {
		let Some(f) = self.frames.get(self.top) else {
			return;
		};
		let n = if !f.restored && f.in_alias && !f.raw_keep {
			f.buf.len() + f.buf.iter().filter(|&&c| is_meta(c)).count()
		} else {
			0
		};
		if f.alcont && f.alias.is_some() && f.al_space {
			self.inalmore = true;
		}
		for _ in 0..n {
			self.raw_back();
		}
		self.top -= 1;
	}

	/// zsh `input_hasalias`: the innermost alias being expanded.
	pub(super) fn input_hasalias(&self) -> Option<Vec<u8>> {
		tail(self.live(), 1)
			.iter()
			.rev()
			.find_map(|f| f.alias.as_ref().map(|a| a.name.clone()))
	}

	/// Whether a live frame expands `key` (zsh `Alias.inuse`).
	fn alias_inuse(&self, key: &AliasKey) -> bool {
		tail(self.live(), 1)
			.iter()
			.any(|f| f.alias.as_ref() == Some(key))
	}

	/// zsh `zshlex_raw_add`.
	fn raw_add(&mut self, c: u8) {
		if self.lex_add_raw > 0 {
			self.raw.push(c);
		}
	}

	/// zsh `zshlex_raw_back`.
	fn raw_back(&mut self) {
		if self.lex_add_raw > 0 && self.raw.len() > self.raw_floor {
			self.raw.pop();
		}
	}

	// ---- messages -------------------------------------------------------

	/// zsh `zerr`: report unless an error is already pending; sets the
	/// error flag.
	pub(super) fn zerr(&mut self, msg: Vec<u8>) {
		if !self.errflag {
			self.msgs.push((self.line, msg));
		}
		self.errflag = true;
	}

	/// zsh `zwarn`: report unless an error is pending.
	pub(super) fn zwarn(&mut self, msg: Vec<u8>) {
		if !self.errflag {
			self.msgs.push((self.line, msg));
		}
	}

	/// zsh `yyerror`: ``parse error near `X'`` for the last token text.
	pub(super) fn yyerror(&mut self, noerr: bool) {
		let t = self.lx.lextext.as_deref().map(untok);
		let mut msg = Vec::new();
		match t {
			Some(t) if !t.is_empty() && at(&t, 0) != b'\n' => {
				let n = t.iter().take(20).take_while(|&&c| c != b'\n').count();
				msg.extend_from_slice(b"parse error near `");
				msg.extend_from_slice(&unmetafy(head(&t, n)));
				if n == 20 {
					msg.extend_from_slice(b"...");
				}
				msg.push(b'\'');
			},
			_ => msg.extend_from_slice(b"parse error"),
		}
		self.zwarn(msg);
		if !noerr {
			self.errflag = true;
		}
	}

	// ---- lex.c ------------------------------------------------------------

	/// zsh `add`.
	fn add(&mut self, c: u8) {
		self.lx.buf.push(c);
	}

	/// The current token string (`tokstr`), if any.
	pub(super) fn tokstr(&self) -> Option<&[u8]> {
		self.lx.has_str.then_some(&self.lx.buf[..])
	}

	/// zsh `zshlex`: the next token, with aliases and reserved words
	/// resolved and pending here-documents read after a newline.
	pub(super) fn zshlex(&mut self) {
		if self.lx.tok == T::Lexerr {
			return;
		}
		self.lx.last_hi = self.lx.hi;
		loop {
			if self.ps.inrepeat > 0 {
				self.ps.inrepeat += 1;
			}
			if self.ps.inrepeat == 3
				&& (self.opt(Features::ZSH_SHORT_LOOPS) || self.opt(Features::ZSH_SHORT_REPEAT))
			{
				self.ps.incmdpos = true;
			}
			self.lx.tok = self.gettok();
			self.lx.hi = self.src_off();
			if self.lx.tok == T::Endinput || !self.exalias() {
				break;
			}
		}
		if matches!(self.lx.tok, T::Newlin | T::Endinput) {
			let docs = core::mem::take(&mut self.ps.hdocs);
			for h in docs {
				let text = self.gethere(&h);
				if let Some(slot) = self.docs.get_mut(h.seq) {
					*slot = text;
				}
			}
		}
		self.ps.isnewlin = i32::from(self.lx.tok == T::Newlin);
		self.lx.sep_nl = self.lx.tok == T::Newlin;
		if self.lx.tok == T::Semi
			|| (self.lx.tok == T::Newlin && self.lexflags & LEXFLAGS_NEWLINE == 0)
		{
			self.lx.tok = T::Seper;
		}
	}

	/// zsh `isnumglob`: whether `<digits-digits>` follows (input unchanged).
	fn isnumglob(&mut self) -> bool {
		let mut ec = b'-';
		let mut read = Vec::new();
		let mut ret = false;
		loop {
			let c = self.hgetc();
			if self.lexstop {
				self.lexstop = false;
				break;
			}
			read.push(c);
			if !c.is_ascii_digit() {
				if c != ec {
					break;
				}
				if ec == b'>' {
					ret = true;
					break;
				}
				ec = b'>';
			}
		}
		while let Some(c) = read.pop() {
			self.hungetc(c);
		}
		ret
	}

	/// zsh `gettok`.
	#[allow(clippy::cognitive_complexity, reason = "a direct port of zsh's gettok")]
	fn gettok(&mut self) -> T {
		let mut peekfd: i32 = -1;
		loop {
			self.lx.has_str = false;
			let mut c = self.hgetc();
			while iblank(c) && !self.lexstop {
				c = self.hgetc();
			}
			self.lx.toklineno = self.line;
			self.lx.lo = self.last_src_off;
			if self.lexstop {
				self.lx.lo = self.src_off();
				return if self.errflag { T::Lexerr } else { T::Endinput };
			}
			if self.lx.dbparens {
				self.lx.buf.clear();
				self.lx.has_str = true;
				self.hungetc(c);
				let end = if self.ps.infor > 0 { b';' } else { b')' };
				let r = self.dquote_parse(end, false);
				if r.is_none() && self.ps.infor > 0 {
					self.ps.infor -= 1;
					return T::Dinpar;
				}
				let c2 = match r {
					Some(e) => e,
					None => self.hgetc(),
				};
				if r.is_some() || c2 != b')' {
					self.hungetc(c2);
					return T::Lexerr;
				}
				self.lx.dbparens = false;
				return T::Doutpar;
			}
			if c.is_ascii_digit() {
				let mut d = self.hgetc();
				if d == b'&' {
					d = self.hgetc();
					if d == b'>' {
						peekfd = i32::from(c - b'0');
						self.hungetc(b'>');
						c = b'&';
					} else {
						self.hungetc(d);
						self.lexstop = false;
						self.hungetc(b'&');
					}
				} else if d == b'>' || d == b'<' {
					peekfd = i32::from(c - b'0');
					c = d;
				} else {
					self.hungetc(d);
					self.lexstop = false;
				}
			}
			// zsh reads comments in non-interactive input; the engine says
			// so with the `interactivecomments` bit. Word splitting
			// (`bufferwords`) asks for them in `lexflags`.
			let comments =
				self.opt(Features::ZSH_INTERACTIVE_COMMENTS) || self.lexflags & LEXFLAGS_COMMENTS != 0;
			if c == b'#' && !self.nocomments && comments {
				let keep = self.lexflags & LEXFLAGS_COMMENTS_KEEP != 0;
				if keep {
					self.lx.buf.clear();
					self.lx.has_str = true;
					self.add(c);
				}
				loop {
					c = self.hgetc();
					if c == b'\n' || self.lexstop {
						break;
					}
					if keep {
						self.add(c);
					}
				}
				if self.errflag {
					return T::Lexerr;
				}
				if keep {
					if !self.lexstop {
						self.hungetc(c);
					}
					return T::String;
				}
				if self.lexflags & LEXFLAGS_COMMENTS_STRIP != 0 && self.lexstop {
					return T::Endinput;
				}
				return T::Newlin;
			}
			let mut unpeek = false;
			match lexact1(c) {
				Act1::Bkslash => {
					let d = self.hgetc();
					if d == b'\n' {
						continue;
					}
					self.hungetc(d);
					self.lexstop = false;
				},
				Act1::Newlin => return T::Newlin,
				Act1::Semi => {
					let d = self.hgetc();
					match d {
						b';' => return T::Dsemi,
						b'&' => return T::Semiamp,
						b'|' => return T::Semibar,
						_ => {},
					}
					self.hungetc(d);
					self.lexstop = false;
					return T::Semi;
				},
				Act1::Amper => return self.amper(peekfd),
				Act1::Bar => {
					let d = self.hgetc();
					if d == b'|' && self.ps.incasepat == 0 {
						return T::Dbar;
					} else if d == b'&' {
						return T::Baramp;
					}
					self.hungetc(d);
					self.lexstop = false;
					return T::Bar;
				},
				Act1::Inpar => {
					let d = self.hgetc();
					if d == b'(' {
						if self.ps.infor > 0 {
							self.lx.dbparens = true;
							return T::Dinpar;
						}
						if self.ps.incmdpos
							|| (self.opt(Features::ZSH_SH_GLOB) && !self.opt(Features::ZSH_KSH_GLOB))
						{
							self.lx.buf.clear();
							self.lx.has_str = true;
							return match self.cmd_or_math() {
								Com::Math => T::Dinpar,
								Com::Cmd => {
									self.lx.has_str = false;
									T::Inpar
								},
								Com::Err => {
									if self.lexflags & LEXFLAGS_ACTIVE != 0 {
										let mut b = b"((".to_vec();
										b.append(&mut self.lx.buf);
										self.lx.buf = b;
									}
									T::Lexerr
								},
							};
						}
					} else if d == b')' {
						return T::Inoutpar;
					}
					self.hungetc(d);
					self.lexstop = false;
					if self.opt(Features::ZSH_SH_GLOB) || self.ps.incond == 1 || self.ps.incmdpos {
						return T::Inpar;
					}
				},
				Act1::Outpar => return T::Outpar,
				Act1::Inang => {
					let d = self.hgetc();
					if d == b'(' {
						self.hungetc(d);
						self.lexstop = false;
						unpeek = true;
					} else {
						let peek = if d == b'>' {
							Some(T::Inoutang)
						} else if d == b'<' {
							let e = self.hgetc();
							if e == b'(' {
								self.hungetc(e);
								self.hungetc(d);
								Some(T::Inang)
							} else if e == b'<' {
								Some(T::Trinang)
							} else if e == b'-' {
								Some(T::Dinangdash)
							} else {
								self.hungetc(e);
								self.lexstop = false;
								Some(T::Dinang)
							}
						} else if d == b'&' {
							Some(T::Inangamp)
						} else {
							self.hungetc(d);
							if self.isnumglob() {
								None
							} else {
								Some(T::Inang)
							}
						};
						match peek {
							Some(p) => {
								self.lx.tokfd = peekfd;
								return p;
							},
							None => unpeek = true,
						}
					}
				},
				Act1::Outang => {
					let mut d = self.hgetc();
					if d == b'(' {
						self.hungetc(d);
						unpeek = true;
					} else {
						let peek = if d == b'&' {
							d = self.hgetc();
							if d == b'!' || d == b'|' {
								T::Outangampbang
							} else {
								self.hungetc(d);
								self.lexstop = false;
								T::Outangamp
							}
						} else if d == b'!' || d == b'|' {
							T::Outangbang
						} else if d == b'>' {
							d = self.hgetc();
							if d == b'&' {
								d = self.hgetc();
								if d == b'!' || d == b'|' {
									T::Doutangampbang
								} else {
									self.hungetc(d);
									self.lexstop = false;
									T::Doutangamp
								}
							} else if d == b'!' || d == b'|' {
								T::Doutangbang
							} else if d == b'(' {
								self.hungetc(d);
								self.hungetc(b'>');
								T::Outang
							} else {
								self.hungetc(d);
								self.lexstop = false;
								T::Doutang
							}
						} else {
							self.hungetc(d);
							self.lexstop = false;
							T::Outang
						};
						self.lx.tokfd = peekfd;
						return peek;
					}
				},
				Act1::Other => {},
			}
			if unpeek && peekfd != -1 {
				self.hungetc(c);
				c = b'0' + peekfd as u8;
			}
			return self.gettokstr(c, false);
		}
	}

	/// The `LX1_AMPER` case of zsh `gettok`.
	fn amper(&mut self, peekfd: i32) -> T {
		let mut d = self.hgetc();
		if d == b'&' {
			return T::Damper;
		}
		if d == b'!' || d == b'|' {
			return T::Amperbang;
		}
		if d == b'>' {
			self.lx.tokfd = peekfd;
			d = self.hgetc();
			if d == b'!' || d == b'|' {
				return T::Outangampbang;
			}
			if d == b'>' {
				d = self.hgetc();
				if d == b'!' || d == b'|' {
					return T::Doutangampbang;
				}
				self.hungetc(d);
				self.lexstop = false;
				return T::Doutangamp;
			}
			self.hungetc(d);
			self.lexstop = false;
			return T::Ampoutang;
		}
		self.hungetc(d);
		self.lexstop = false;
		T::Amper
	}

	/// zsh `cmd_or_math`: after `((`, whether the text up to `))` parses as
	/// arithmetic; if not, the input is put back to the first `(`.
	fn cmd_or_math(&mut self) -> Com {
		let oldlen = self.lx.buf.len();
		let mut c;
		match self.dquote_parse(b')', false) {
			None => {
				c = self.hgetc();
				if c == b')' {
					return Com::Math;
				}
				self.hungetc(c);
				self.lexstop = false;
				c = b')';
			},
			Some(_) if self.lexstop => return Com::Err,
			Some(e) => c = e,
		}
		self.hungetc(c);
		self.lexstop = false;
		while self.lx.buf.len() > oldlen && !self.errflag {
			let b = self.lx.buf.pop().unwrap_or(b' ');
			let back = if is_tok(b) {
				tok_char(b).unwrap_or(b)
			} else {
				b
			};
			self.hungetc(back);
		}
		if self.errflag {
			return Com::Err;
		}
		self.hungetc(b'(');
		Com::Cmd
	}

	/// zsh `cmd_or_math_sub`: after `$(`, a `$((…))` or a `$(…)`.
	fn cmd_or_math_sub(&mut self) -> Com {
		let mut c = self.hgetc();
		if c == b'\\' {
			c = self.hgetc();
			if c != b'\n' {
				self.hungetc(c);
				self.hungetc(b'\\');
				self.lexstop = false;
				return if self.skipcomm() { Com::Err } else { Com::Cmd };
			}
			c = self.hgetc();
		}
		if c == b'(' {
			let lexpos = self.lx.buf.len();
			self.add(INPAR);
			self.add(b'(');
			let ret = self.cmd_or_math();
			if ret == Com::Math {
				if let Some(c) = self.lx.buf.get_mut(lexpos) {
					*c = INPARMATH;
				}
				self.add(b')');
				return Com::Math;
			}
			if ret == Com::Err {
				return Com::Err;
			}
			let n = self.lx.buf.len();
			self.lx.buf.truncate(n.saturating_sub(2));
		} else {
			self.hungetc(c);
			self.lexstop = false;
		}
		if self.skipcomm() { Com::Err } else { Com::Cmd }
	}

	/// zsh `gettokstr`: the rest of a word starting with `c`, tokenized.
	/// `sub` is set when tokenizing a string rather than command input.
	#[allow(clippy::cognitive_complexity, reason = "a direct port of zsh's gettokstr")]
	pub(super) fn gettokstr(&mut self, mut c: u8, sub: bool) -> T {
		let (mut bct, mut pct, mut brct) = (0i32, 0i32, 0i32);
		let mut seen_brct = false;
		let mut fdpar = false;
		let mut intpos = 1u8;
		let mut in_brace_param = 0i32;
		let mut unmatched = 0u8;
		let mut peek = T::String;
		if !sub {
			self.lx.buf.clear();
			self.lx.has_str = true;
		}
		'outer: loop {
			let inbl = inblank(c);
			if fdpar && !inbl && c != b')' {
				fdpar = false;
			}
			let act = if inbl && in_brace_param == 0 && pct == 0 {
				Act2::Break
			} else {
				let a = lexact2(c);
				c = lextok2(c);
				a
			};
			'sw: {
				match act {
					Act2::Break => {
						if in_brace_param == 0 && !sub {
							break 'outer;
						}
					},
					Act2::Meta => {
						c = self.hgetc();
						self.add(META);
					},
					Act2::Outpar => {
						if fdpar {
							self.add(c);
							return T::Inoutpar;
						}
						if (sub || in_brace_param > 0) && self.opt(Features::ZSH_SH_GLOB) {
							break 'sw;
						}
						if in_brace_param == 0 {
							let was = pct;
							pct -= 1;
							if was == 0 {
								if sub {
									pct = 0;
									break 'sw;
								}
								break 'outer;
							}
						}
						c = OUTPAR;
					},
					Act2::Bar => {
						if pct == 0 && in_brace_param == 0 {
							if sub {
								break 'sw;
							}
							break 'outer;
						}
						if !self.opt(Features::ZSH_SH_GLOB) || (!sub && in_brace_param == 0) {
							c = BAR;
						}
					},
					Act2::String => {
						let mut e = self.hgetc();
						if e == b'\\' {
							e = self.hgetc();
							if e != b'\n' {
								self.hungetc(e);
								self.hungetc(b'\\');
								self.lexstop = false;
								break 'sw;
							}
							e = self.hgetc();
						}
						if e == b'[' {
							self.add(STRING);
							self.add(INBRACK);
							if let Some(err) = self.dquote_parse(b']', sub) {
								c = err;
								peek = T::Lexerr;
								break 'outer;
							}
							c = OUTBRACK;
						} else if e == b'(' {
							self.add(STRING);
							match self.cmd_or_math_sub() {
								Com::Cmd => c = OUTPAR,
								Com::Math => c = OUTPARMATH,
								Com::Err => {
									peek = T::Lexerr;
									break 'outer;
								},
							}
						} else if e == b'{' {
							self.add(c);
							c = INBRACE;
							bct += 1;
							if in_brace_param == 0 {
								in_brace_param = bct;
								seen_brct = false;
							}
						} else {
							self.hungetc(e);
							self.lexstop = false;
						}
					},
					Act2::Inbrack => {
						if in_brace_param == 0 {
							brct += 1;
							seen_brct = true;
						}
						c = INBRACK;
					},
					Act2::Outbrack => {
						if in_brace_param == 0 {
							brct -= 1;
						}
						if brct < 0 {
							brct = 0;
						}
						c = OUTBRACK;
					},
					Act2::Inpar => {
						if self.opt(Features::ZSH_SH_GLOB) {
							if sub || in_brace_param > 0 {
								break 'sw;
							}
							if self.ps.incasepat > 0 && self.lx.buf.is_empty() {
								return T::Inpar;
							}
							if !self.opt(Features::ZSH_KSH_GLOB) && !self.lx.buf.is_empty() {
								break 'outer;
							}
						}
						if in_brace_param == 0 {
							if !sub {
								let e = self.hgetc();
								self.hungetc(e);
								self.lexstop = false;
								if e == b')'
									|| (self.opt(Features::ZSH_SH_GLOB)
										&& inblank(e)
										&& bct == 0
										&& brct == 0
										&& intpos == 0
										&& self.ps.incmdpos)
								{
									break 'outer;
								}
							}
							let was = pct;
							pct += 1;
							if was == 0
								&& self.opt(Features::ZSH_SH_GLOB)
								&& intpos > 0
								&& bct == 0
								&& brct == 0
							{
								fdpar = true;
							}
						}
						c = INPAR;
					},
					Act2::Inbrace => {
						if self.opt(Features::ZSH_IGNORE_BRACES) || sub {
							c = b'{';
						} else {
							if self.lx.buf.is_empty() && self.ps.incmdpos {
								self.add(b'{');
								return T::String;
							}
							bct += 1;
						}
					},
					Act2::Outbrace => {
						if (self.opt(Features::ZSH_IGNORE_BRACES) || sub) && in_brace_param == 0 {
							break 'sw;
						}
						if bct == 0 {
							break 'sw;
						}
						if bct == in_brace_param {
							in_brace_param = 0;
						}
						bct -= 1;
						c = OUTBRACE;
					},
					Act2::Comma => {
						if !self.opt(Features::ZSH_IGNORE_BRACES) && !sub && bct > in_brace_param {
							c = COMMA;
						}
					},
					Act2::Outang => {
						if in_brace_param > 0 || sub {
							break 'sw;
						}
						let e = self.hgetc();
						if e != b'(' {
							self.hungetc(e);
							self.lexstop = false;
							break 'outer;
						}
						self.add(OUTANGPROC);
						if self.skipcomm() {
							peek = T::Lexerr;
							break 'outer;
						}
						c = OUTPAR;
					},
					Act2::Inang => {
						if self.opt(Features::ZSH_SH_GLOB) && sub {
							break 'sw;
						}
						let e = self.hgetc();
						if !(in_brace_param > 0 || sub) && e == b'(' {
							self.add(INANG);
							if self.skipcomm() {
								peek = T::Lexerr;
								break 'outer;
							}
							c = OUTPAR;
							break 'sw;
						}
						self.hungetc(e);
						if self.isnumglob() {
							self.add(INANG);
							loop {
								c = self.hgetc();
								if c == b'>' || self.lexstop {
									break;
								}
								self.add(c);
							}
							c = OUTANG;
							break 'sw;
						}
						self.lexstop = false;
						if in_brace_param > 0 || sub {
							break 'sw;
						}
						break 'outer;
					},
					Act2::Equals => {
						if sub {
							break 'sw;
						}
						if intpos > 0 {
							let e = self.hgetc();
							if e == b'(' {
								self.add(EQUALS);
								if self.skipcomm() {
									peek = T::Lexerr;
									break 'outer;
								}
								c = OUTPAR;
							} else {
								self.hungetc(e);
								self.lexstop = false;
								c = EQUALS;
							}
						} else if peek != T::Envstring
							&& (self.ps.incmdpos || self.ps.intypeset)
							&& bct == 0
							&& brct == 0
						{
							let buf = &self.lx.buf;
							let mut t;
							if buf.first().is_some_and(u8::is_ascii_digit) {
								t = 1;
								while t < buf.len() && buf[t].is_ascii_digit() {
									t += 1;
								}
							} else {
								t = ident_end(buf, 0);
								if t < buf.len() {
									skipparens(INBRACK, OUTBRACK, buf, &mut t);
								}
							}
							if buf.get(t) == Some(&b'+') {
								t += 1;
							}
							if t == buf.len() {
								let e = self.hgetc();
								if e == b'(' {
									return T::Envarray;
								}
								self.hungetc(e);
								self.lexstop = false;
								peek = T::Envstring;
								intpos = 2;
							} else {
								c = EQUALS;
							}
						} else {
							c = EQUALS;
						}
					},
					Act2::Bkslash => {
						c = self.hgetc();
						if c == b'\n' {
							c = self.hgetc();
							if !self.lexstop {
								continue 'outer;
							}
						} else {
							self.add(BNULL);
							if c == META {
								c = self.hgetc();
								self.add(META);
							}
						}
						if self.lexstop {
							break 'outer;
						}
					},
					Act2::Quote => {
						let strquote = self.lx.buf.last() == Some(&STRING);
						self.add(SNULL);
						let e;
						loop {
							loop {
								c = self.hgetc();
								if c == b'\'' || self.lexstop {
									break;
								}
								if strquote && c == b'\\' {
									c = self.hgetc();
									if self.lexstop {
										break;
									}
									if c == b'\\' || c == b'\'' {
										self.add(BNULL);
									} else {
										self.add(b'\\');
									}
								} else if !sub && self.opt(Features::ZSH_CSH_JUNKIE_QUOTES) && c == b'\n' {
									if self.lx.buf.last() == Some(&b'\\') {
										self.lx.buf.pop();
									} else {
										break;
									}
								}
								self.add(c);
							}
							if c != b'\'' {
								unmatched = b'\'';
								if self.lexflags & LEXFLAGS_ACTIVE == 0 {
									peek = T::Lexerr;
								}
								break 'outer;
							}
							let e2 = self.hgetc();
							if e2 != b'\'' || !self.opt(Features::ZSH_RC_QUOTES) || strquote {
								e = e2;
								break;
							}
							self.add(c);
						}
						self.hungetc(e);
						self.lexstop = false;
						c = SNULL;
					},
					Act2::Dquote => {
						self.add(DNULL);
						if let Some(err) = self.dquote_parse(b'"', sub) {
							c = err;
							unmatched = b'"';
							if self.lexflags & LEXFLAGS_ACTIVE == 0 {
								peek = T::Lexerr;
							}
							break 'outer;
						}
						c = DNULL;
					},
					Act2::Bquote => {
						self.add(TICK);
						loop {
							c = self.hgetc();
							if c == b'`' || self.lexstop {
								break;
							}
							if c == b'\\' {
								c = self.hgetc();
								if c != b'\n' {
									self.add(if matches!(c, b'`' | b'\\' | b'$') {
										BNULL
									} else {
										b'\\'
									});
									self.add(c);
								} else if !sub && self.opt(Features::ZSH_CSH_JUNKIE_QUOTES) {
									self.add(c);
								}
							} else {
								if !sub && self.opt(Features::ZSH_CSH_JUNKIE_QUOTES) && c == b'\n' {
									break;
								}
								self.add(c);
							}
						}
						if c != b'`' {
							unmatched = b'`';
							if self.lexflags & LEXFLAGS_ACTIVE == 0 {
								peek = T::Lexerr;
							}
							break 'outer;
						}
						c = TICK;
					},
					Act2::Dash => c = DASH,
					Act2::Bang => c = if seen_brct { BANG } else { b'!' },
					Act2::Other => {},
				}
			}
			self.add(c);
			c = self.hgetc();
			intpos = intpos.saturating_sub(1);
			if self.lexstop {
				break;
			}
		}
		// brk:
		if self.errflag {
			return T::Lexerr;
		}
		self.hungetc(c);
		if unmatched != 0 && self.lexflags & LEXFLAGS_ACTIVE == 0 {
			let mut msg = b"unmatched ".to_vec();
			msg.push(unmatched);
			self.zerr(msg);
		}
		if in_brace_param > 0 {
			self.zerr(b"closing brace expected".to_vec());
		} else if !self.opt(Features::ZSH_IGNORE_BRACES)
			&& !sub
			&& self.lx.buf.len() > 1
			&& peek == T::String
			&& self.lx.buf.ends_with(b"}")
			&& at(&self.lx.buf, self.lx.buf.len() - 2) != BNULL
		{
			self.lx.buf.pop();
			self.lexstop = false;
			self.hungetc(b'}');
		}
		peek
	}

	/// zsh `dquote_parse`: input up to `endchar` as if in double quotes
	/// (or arithmetic, for `)`/`]`), tokenized onto the token string.
	/// `None` on success, else the error value zsh returns.
	#[allow(clippy::cognitive_complexity, reason = "a direct port of zsh's dquote_parse")]
	pub(super) fn dquote_parse(&mut self, endchar: u8, sub: bool) -> Option<u8> {
		let (mut pct, mut brct, mut bct, mut intick) = (0i32, 0i32, 0i32, 0u8);
		let mut err: u32 = 0;
		let math = endchar == b')' || endchar == b']' || self.ps.infor > 0;
		let mut c;
		loop {
			c = self.hgetc();
			let more = (c != endchar || bct > 0 || (math && (pct > 0 || brct > 0)) || intick > 0)
				&& !self.lexstop;
			if !more {
				break;
			}
			// `continue` of zsh's loop: the byte is dropped.
			let mut skip = false;
			// `goto cont` re-dispatches the byte after a backslash.
			'cont: loop {
				match c {
					b'\\' => {
						c = self.hgetc();
						if c != b'\n' {
							if c == b'$'
								|| c == b'\\'
								|| (c == b'}' && intick == 0 && bct > 0)
								|| c == endchar
								|| c == b'`'
								|| (endchar == b']'
									&& (matches!(c, b'[' | b']' | b'(' | b')' | b'{' | b'}')
										|| (c == b'"' && sub)))
							{
								self.add(BNULL);
							} else {
								self.add(b'\\');
								continue 'cont;
							}
						} else if sub || !self.opt(Features::ZSH_CSH_JUNKIE_QUOTES) || endchar != b'"' {
							skip = true;
						}
					},
					b'\n' => {
						err = u32::from(
							!sub && self.opt(Features::ZSH_CSH_JUNKIE_QUOTES) && endchar == b'"',
						);
					},
					b'$' if intick == 0 => {
						c = self.hgetc();
						if c == b'(' {
							self.add(QSTRING);
							match self.cmd_or_math_sub() {
								Com::Cmd => c = OUTPAR,
								Com::Math => c = OUTPARMATH,
								Com::Err => err = 1,
							}
						} else if c == b'[' {
							self.add(STRING);
							self.add(INBRACK);
							err = self.dquote_parse(b']', sub).map_or(0, u32::from);
							c = OUTBRACK;
						} else if c == b'{' {
							self.add(QSTRING);
							c = INBRACE;
							bct += 1;
						} else if c == b'$' {
							self.add(QSTRING);
						} else {
							self.hungetc(c);
							self.lexstop = false;
							c = QSTRING;
						}
					},
					b'}' if intick == 0 && bct > 0 => {
						c = OUTBRACE;
						bct -= 1;
					},
					b'`' => {
						c = QTICK;
						intick = u8::from(intick == 0);
					},
					b'\'' if intick != 0 => {
						intick = if intick == 1 { 2 } else { 1 };
					},
					b'(' => {
						if !math || bct == 0 {
							pct += 1;
						}
					},
					b')' => {
						if !math || bct == 0 {
							err = u32::from(pct == 0 && math);
							pct -= 1;
						}
					},
					b'[' => {
						if !math || bct == 0 {
							brct += 1;
						}
					},
					b']' => {
						if !math || bct == 0 {
							err = u32::from(brct == 0 && math);
							brct -= 1;
						}
					},
					b'"' if intick == 0 && (endchar == b'"' || bct > 0) => {
						if bct > 0 {
							self.add(DNULL);
							err = self.dquote_parse(b'"', sub).map_or(0, u32::from);
							c = DNULL;
						} else {
							err = 1;
						}
					},
					_ => {},
				}
				break 'cont;
			}
			if skip {
				continue;
			}
			if err != 0 || self.lexstop {
				break;
			}
			self.add(c);
		}
		if self.lexstop {
			err = u32::from(intick != 0 || endchar != 0 || err != 0);
		} else if err == 1 {
			err = u32::from(c);
		}
		(err != 0).then_some(err as u8)
	}

	/// zsh `skipcomm`: after `$(`, `<(`, `>(` or `=(`, parses the command
	/// substitution (validating it) and keeps its raw text on the token
	/// string. Returns `lexstop`.
	fn skipcomm(&mut self) -> bool {
		let save_infor = self.ps.infor;
		self.ps.infor = 0;
		self.add(INPAR);
		let outer = self.lex_add_raw == 0;
		let saved_floor = self.raw_floor;
		if outer {
			if let Some(f) = self.frames.get_mut(self.top).filter(|f| f.in_alias) {
				f.raw_keep = true;
			}
			self.raw = core::mem::take(&mut self.lx.buf);
			self.raw_floor = self.raw.len();
		}
		let saved_lx =
			core::mem::replace(&mut self.lx, LexState { tokfd: -1, ..LexState::default() });
		let saved_ps = core::mem::take(&mut self.ps);
		let saved_lexstop = self.lexstop;
		self.lex_add_raw += 1;
		let ok = self.parse_event_nested(T::Outpar) && self.lx.tok == T::Outpar;
		if !ok {
			// zsh reads the rest of a string input raw.
			while !self.lexstop {
				self.hgetc();
			}
		}
		let new_lexstop = self.lexstop;
		self.lx = saved_lx;
		self.ps = saved_ps;
		self.lexstop = saved_lexstop;
		// parse_context_restore clears the error flag.
		self.errflag = false;
		self.lex_add_raw -= 1;
		if outer {
			let mut buf = core::mem::take(&mut self.raw);
			if !new_lexstop {
				buf.pop();
			}
			self.lx.buf = buf;
			self.lexstop = new_lexstop;
			self.raw_floor = saved_floor;
		}
		self.ps.infor = save_infor;
		self.lexstop
	}

	/// zsh `checkalias`: expand the alias the last token names.
	fn checkalias(&mut self) -> bool {
		let Some(text) = self.lx.lextext.as_ref() else {
			return false;
		};
		if self.noaliases || self.opt(Features::ZSH_NO_ALIASES) {
			return false;
		}
		let name = unmetafy(text);
		if self.opt(Features::ZSH_POSIX_ALIASES)
			&& !(self.lx.tok == T::String && self.reswd_on(&name).is_none())
		{
			return false;
		}
		let aliases = self.aliases;
		let (value, global) = match aliases.global_alias(&name) {
			Some(v) => (Some(v), true),
			None => (aliases.alias(&name), false),
		};
		if let Some(v) = value {
			let key = AliasKey { suffix: false, name: name.clone() };
			if !self.alias_inuse(&key)
				&& (global || (self.ps.incmdpos && self.lx.tok == T::String) || self.inalmore)
			{
				if !self.lexstop {
					let c = self.hgetc();
					self.hungetc(c);
					if !iblank(c) {
						self.inpush(Cow::Borrowed(b" "), None, true, false);
					}
				}
				let al_space = v.last() == Some(&b' ');
				self.inpush(Cow::Borrowed(v), Some(key), true, al_space);
				self.lexstop = false;
				self.alias_uses.push(AliasUse { name, value: v.to_vec() });
				return true;
			}
		}
		if let Some(dot) = name.iter().rposition(|&c| c == b'.')
			&& dot + 1 < name.len()
			&& dot > 0
			&& self.ps.incmdpos
			&& let Some(v) = aliases.suffix_alias(tail(&name, dot + 1))
		{
			let key = AliasKey { suffix: true, name: tail(&name, dot + 1).to_vec() };
			if !self.alias_inuse(&key) {
				let al_space = v.last() == Some(&b' ');
				self.inpush(Cow::Owned(name.clone()), Some(key), true, al_space);
				self.inpush(Cow::Borrowed(b" "), None, true, false);
				self.inpush(Cow::Borrowed(v), None, true, false);
				self.lexstop = false;
				self.alias_uses.push(AliasUse { name, value: v.to_vec() });
				return true;
			}
		}
		false
	}

	/// zsh `exalias`: alias expansion, then reserved words.
	fn exalias(&mut self) -> bool {
		if !self.lx.has_str {
			self.lx.lextext = tokstring(self.lx.tok).map(<[u8]>::to_vec);
			if self.lx.tok == T::Newlin {
				return false;
			}
			return self.checkalias();
		}
		let had_tokens = has_token(&self.lx.buf);
		self.lx.lextext = Some(if had_tokens {
			untok(&self.lx.buf)
		} else {
			self.lx.buf.clone()
		});
		if self.lx.tok == T::String {
			if (!had_tokens || !self.opt(Features::ZSH_POSIX_ALIASES)) && self.checkalias() {
				return true;
			}
			let text = self.lx.lextext.as_deref().unwrap_or_default();
			let rw = if self.ps.incmdpos
				|| (!self.opt(Features::ZSH_IGNORE_BRACES)
					&& !self.opt(Features::ZSH_IGNORE_CLOSE_BRACES)
					&& text == b"}")
			{
				self.reswd_on(text)
			} else {
				None
			};
			if let Some(rw) = rw {
				self.lx.tok = rw;
				self.ps.inrepeat = i32::from(rw == T::Repeat);
				if rw == T::Dinbrack {
					self.ps.incond = 1;
				}
			} else if self.ps.incond > 0 && text == b"]]" {
				self.lx.tok = T::Doutbrack;
				self.ps.incond = 0;
			} else if self.ps.incond == 1 && text == b"!" {
				self.lx.tok = T::Bang;
			}
		}
		self.inalmore = false;
		false
	}

	/// zsh `reswdtab->getnode`: the reserved word `s` unless `disable -r`
	/// turned it off.
	fn reswd_on(&self, s: &[u8]) -> Option<T> {
		reswd(s).filter(|_| !self.aliases.reserved_disabled(s))
	}

	/// zsh `gethere`: the body of a here-document, read up to its
	/// terminator line (raw bytes, each line with its newline).
	fn gethere(&mut self, h: &PendingDoc) -> Vec<u8> {
		let term = metafy(&h.delim);
		let mut buf: Vec<u8> = Vec::new();
		loop {
			let t = buf.len();
			let mut c = self.hgetc();
			while c == b'\t' && h.strip {
				c = self.hgetc();
			}
			loop {
				if self.lexstop || c == b'\n' {
					break;
				}
				if !h.quoted && c == b'\\' {
					buf.push(c);
					c = self.hgetc();
					if c == b'\n' {
						buf.pop();
						c = self.hgetc();
						continue;
					}
				}
				buf.push(c);
				c = self.hgetc();
			}
			if tail(&buf, t) == term.as_slice() {
				buf.truncate(t);
				break;
			}
			if self.lexstop {
				break;
			}
			buf.push(b'\n');
		}
		unmetafy(&buf)
	}
}

/// zsh `bufferwords` (`hist.c`): shell words of a string, as `${(z)…}`
/// splits it.
///
/// `text` is metafied, possibly tokenized. Words come back untokenized and
/// metafied; operators are words of their
/// own (`;` for a newline unless [`LEXFLAGS_NEWLINE`]); `flags` is a set of
/// `LEXFLAGS_COMMENTS_KEEP`, `LEXFLAGS_COMMENTS_STRIP`, `LEXFLAGS_NEWLINE`.
#[allow(clippy::cognitive_complexity, reason = "a direct port of zsh's bufferwords")]
pub fn bufferwords(text: &[u8], flags: u32) -> Vec<Vec<u8>> {
	let mut raw = plain(text);
	raw.push(b' ');
	let mut cx = Ctx::new(
		&raw,
		0,
		1,
		Features::ZSH | Features::ZSH_SHORT_LOOPS,
		crate::bash::syntax::NO_ALIASES,
	);
	cx.lexflags = flags | LEXFLAGS_ACTIVE;
	cx.nocomments = flags & LEXFLAGS_COMMENTS == 0;
	cx.noaliases = true;
	let end = raw.len();
	let mut list = Vec::new();
	let mut forloop = 0u8;
	let mut envarray = false;
	let mut inredir = false;
	let mut oldpos = false;
	// `strip`: the word ends at the blank bufferwords added.
	let strip = |p: &mut Vec<u8>| {
		let n = p.len();
		if n > 0 && at(p, n - 1) == b' ' && (n == 1 || at(p, n - 2) != META) {
			p.pop();
		}
	};
	loop {
		if cx.ps.incond > 0 {
			cx.ps.incond = 1
				+ i32::from(!matches!(
					cx.lx.tok,
					T::Dinbrack | T::Inpar | T::Dbar | T::Damper | T::Bang
				));
		}
		// zsh `ctxtlex`.
		cx.zshlex();
		match cx.lx.tok {
			T::Seper
			| T::Newlin
			| T::Semi
			| T::Dsemi
			| T::Semiamp
			| T::Semibar
			| T::Amper
			| T::Amperbang
			| T::Inpar
			| T::Inbrace
			| T::Dbar
			| T::Damper
			| T::Bar
			| T::Baramp
			| T::Inoutpar
			| T::Doloop
			| T::Then
			| T::Elif
			| T::Else
			| T::Doutbrack => cx.ps.incmdpos = true,
			T::String | T::Typeset | T::Envarray | T::Outpar | T::Case | T::Dinbrack => {
				cx.ps.incmdpos = false;
			},
			_ => {},
		}
		if cx.lx.tok != T::Dinpar {
			cx.ps.infor = if cx.lx.tok == T::For { 2 } else { 0 };
		}
		if cx.lx.tok.is_redirop() || matches!(cx.lx.tok, T::For | T::Foreach | T::Select) {
			inredir = true;
			oldpos = cx.ps.incmdpos;
			cx.ps.incmdpos = false;
		} else if inredir {
			cx.ps.incmdpos = oldpos;
			inredir = false;
		}
		let tok = cx.lx.tok;
		if matches!(tok, T::Endinput | T::Lexerr) {
			break;
		}
		if tok == T::Outpar && envarray {
			cx.ps.incmdpos = true;
			envarray = false;
		}
		if tok == T::For {
			forloop = 5;
		} else {
			match forloop {
				1 if tok != T::Doutpar => forloop = 0,
				2..=4 if tok != T::Dinpar => forloop = 0,
				_ => {},
			}
		}
		if cx.lx.has_str {
			let mut p = match tok {
				T::Envarray => {
					envarray = true;
					[&cx.lx.buf[..], &b"=("[..]].concat()
				},
				T::Dinpar if forloop > 0 => [&cx.lx.buf[..], &b";"[..]].concat(),
				T::Dinpar => [&b"(("[..], &cx.lx.buf[..], &b"))"[..]].concat(),
				_ => cx.lx.buf.clone(),
			};
			if !p.is_empty() {
				super::tok::untokenize(&mut p);
				if cx.top == 0 && cx.src_off() as usize >= end {
					strip(&mut p);
				}
				list.push(p);
			}
		} else if tok.is_redirop() && cx.lx.tokfd >= 0 {
			let mut w = Vec::new();
			crate::bash::syntax::util::push_u32(&mut w, cx.lx.tokfd as u32);
			w.extend_from_slice(tokstring(tok).unwrap_or_default());
			list.push(w);
		} else if tok != T::Newlin {
			list.push(tokstring(tok).unwrap_or_default().to_vec());
		}
		if forloop > 0 {
			if forloop == 1 {
				list.push(b"))".to_vec());
			}
			forloop -= 1;
		}
	}
	if cx.lx.tok == T::Lexerr && cx.lx.has_str && !cx.lx.buf.is_empty() {
		let mut p = untok(&cx.lx.buf);
		strip(&mut p);
		list.push(p);
	}
	list
}

/// zsh `parse_subst_string`: tokenizes `s` as unquoted word text.
///
/// `s` is metafied, possibly tokenized, and may contain blanks; the zsh
/// expander tokenizes the operand of `${x#pat}`, `(Q)` and `(e)` so.
/// `Err` when zsh's lexer fails or reports an error (an unmatched
/// quote), with the lexer's first message (``unmatched "``) if it printed
/// one. zsh's final in-place decoding of `$'…'` (`getkeystring`) is left
/// to the caller.
pub fn parse_subst_string(s: &[u8]) -> Result<Vec<u8>, Option<Vec<u8>>> {
	if s.is_empty() || s == [super::tok::NULARG] {
		return Ok(s.to_vec());
	}
	let raw = plain(s);
	let mut cx = Ctx::new(&raw, 0, 1, Features::ZSH, crate::bash::syntax::NO_ALIASES);
	cx.lx.has_str = true;
	let c = cx.hgetc();
	if cx.gettokstr(c, true) == T::Lexerr || cx.errflag {
		return Err(cx.msgs.into_iter().next().map(|(_, m)| m));
	}
	Ok(core::mem::take(&mut cx.lx.buf))
}

/// zsh `parse_subscript`: tokenizes the subscript at the start of `s`.
///
/// `s` is metafied, possibly tokenized; tokenizing stops at `endchar`, as
/// zsh does in place. Returns the tokenized text and the index of
/// `endchar` in `s` (the tokenized text has the same length); `None` when
/// `s` is empty, starts with `endchar`, or the subscript does not parse.
/// `sub` is zsh's flag of the same name (`"` inside is taken as quoting).
pub fn parse_subscript(s: &[u8], sub: bool, endchar: u8) -> Option<(Vec<u8>, usize)> {
	if s.is_empty() || at(s, 0) == endchar {
		return None;
	}
	let raw = plain(s);
	let mut cx = Ctx::new(&raw, 0, 1, Features::ZSH, crate::bash::syntax::NO_ALIASES);
	cx.lx.has_str = true;
	if cx.dquote_parse(endchar, sub).is_some() {
		return None;
	}
	let toks = core::mem::take(&mut cx.lx.buf);
	let n = toks.len();
	Some((toks, n))
}

/// zsh `parsestrnoerr`: tokenizes `s` as if it were inside double quotes.
///
/// `s` is metafied, possibly tokenized; zsh tokenizes a here-document body
/// so before expanding it. `Err` carries zsh's error value: a character to
/// report as ``parse error near `c'`` when it is printable, else
/// `parse error`.
pub fn parsestr(s: &[u8]) -> Result<Vec<u8>, u8> {
	let raw = plain(s);
	let mut cx = Ctx::new(&raw, 0, 1, Features::ZSH, crate::bash::syntax::NO_ALIASES);
	cx.lx.has_str = true;
	match cx.dquote_parse(0, true) {
		None => Ok(core::mem::take(&mut cx.lx.buf)),
		Some(e) => Err(e),
	}
}
