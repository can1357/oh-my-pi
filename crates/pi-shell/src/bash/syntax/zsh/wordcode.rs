//! zsh's word code compiler.
//!
//! A port of the code-emitting half of zsh 5.9
//! `Src/parse.c` (`parse_list`, `par_list`, `par_sublist`, `par_pline`,
//! `par_cmd`, `par_for`, `par_case`, `par_if`, `par_while`, `par_repeat`,
//! `par_subsh`, `par_funcdef`, `par_time`, `par_dinbrack`, `par_simple`,
//! `par_redir`, `par_wordlist`, `par_nl_wordlist`, the `par_cond` family,
//! `ecadd`/`ecispace`/`ecdel`/`ecstrcode`, `set_list_code`,
//! `set_sublist_code`, `setheredoc` and `bld_eprog`).
//!
//! It runs the same lexer as [`super::parse`] (zsh's token strings) and
//! emits the word code and string table zsh builds for the same text and
//! options, so the result can be written to a `.zwc` file that zsh itself
//! reads (`zcompile`). The control flow follows zsh's parser line by line:
//! the order of `ecstrcode` calls fixes the layout of the string table.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use alloc::{collections::BTreeMap, vec::Vec};

use super::{
	lex::{Ctx, PendingDoc, T, ident_end, isident, munge_terminator, plain, skipparens},
	parse::case_paren_pattern,
	parsestr,
	tok::{
		DASH, EQUALS, INANG, INBRACE, INBRACK, INPAR, OUTANGPROC, OUTBRACE, OUTBRACK, TILDE, at,
		has_token, is_null, metafy, tail,
	},
};
use crate::bash::syntax::features::{AliasLookup, Features};

/// A compiled program (zsh `struct eprog` without its pattern slots): the
/// word code, ending in `WC_END`, and the string table it points into.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Eprog {
	/// Word code (`prog`), host values (the dump writer orders the bytes).
	pub prog:  Vec<u32>,
	/// String table (`strs`): NUL-terminated metafied token strings.
	pub strs:  Vec<u8>,
	/// Patterns the code numbers (`npats`).
	pub npats: u32,
}

impl Eprog {
	/// zsh's `len - npats * sizeof(Patprog)`: bytes of code and strings.
	pub const fn byte_len(&self) -> usize {
		self.prog.len() * 4 + self.strs.len()
	}
}

/// Why [`compile`] produced no program.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CompileError {
	/// zsh reported a syntax error: the messages it printed (`zerr`/`zwarn`)
	/// with the line it printed each at (metafied text unmetafied).
	Syntax(Vec<(u32, Vec<u8>)>),
	/// The text uses a construct whose word code zsh leaves undefined
	/// (it reads uninitialised memory), so no faithful code exists.
	Undefined(&'static str),
}

/// Compile `src` (raw file bytes) as zsh `parse_string(src, 1)` does for
/// `zcompile`: the whole text as one list, lines counted from 1, aliases
/// from `aliases` unless `noaliases` (`zcompile -U`).
///
/// # Errors
/// [`CompileError`] when zsh would not produce a program (`zcompile`'s
/// `can't read file`).
pub fn compile(
	src: &[u8],
	feat: Features,
	aliases: &dyn AliasLookup,
	noaliases: bool,
) -> Result<Eprog, CompileError> {
	let mut cx = Ctx::new(src, 0, 1, feat | Features::ZSH, aliases);
	cx.noaliases = noaliases;
	let mut w = Wc::new(&mut cx);
	// zsh `parse_list`.
	w.cx.lx.tok = T::Endinput;
	w.lex();
	let mut c = false;
	w.par_list(&mut c);
	if let Some(what) = w.undefined {
		return Err(CompileError::Undefined(what));
	}
	if w.cx.lx.tok != T::Endinput {
		w.cx.lx.tok = T::Lexerr;
		w.cx.yyerror(false);
	}
	if w.cx.errflag || w.cx.lx.tok == T::Lexerr {
		return Err(CompileError::Syntax(core::mem::take(&mut w.cx.msgs)));
	}
	Ok(w.bld_eprog())
}

// ---- word code layout (zsh.h) ------------------------------------------

const WC_CODEBITS: u32 = 5;
const WC_END: u32 = 0;
const WC_LIST: u32 = 1;
const WC_SUBLIST: u32 = 2;
const WC_PIPE: u32 = 3;
const WC_REDIR: u32 = 4;
const WC_ASSIGN: u32 = 5;
const WC_SIMPLE: u32 = 6;
const WC_TYPESET: u32 = 7;
const WC_SUBSH: u32 = 8;
const WC_CURSH: u32 = 9;
const WC_TIMED: u32 = 10;
const WC_FUNCDEF: u32 = 11;
const WC_FOR: u32 = 12;
const WC_SELECT: u32 = 13;
const WC_WHILE: u32 = 14;
const WC_REPEAT: u32 = 15;
const WC_CASE: u32 = 16;
const WC_IF: u32 = 17;
const WC_COND: u32 = 18;
const WC_ARITH: u32 = 19;
const WC_TRY: u32 = 21;

const Z_SYNC: u32 = 1 << 1;
const Z_ASYNC: u32 = 1 << 2;
const Z_DISOWN: u32 = 1 << 3;
const Z_END: u32 = 1 << 4;
const Z_SIMPLE: u32 = 1 << 5;
const WC_LIST_FREE: u32 = 6;

const WC_SUBLIST_END: u32 = 0;
const WC_SUBLIST_AND: u32 = 1;
const WC_SUBLIST_OR: u32 = 2;
const WC_SUBLIST_COPROC: u32 = 4;
const WC_SUBLIST_NOT: u32 = 8;
const WC_SUBLIST_SIMPLE: u32 = 16;
const WC_SUBLIST_FREE: u32 = 5;

const WC_PIPE_END: u32 = 0;
const WC_PIPE_MID: u32 = 1;

const WC_ASSIGN_SCALAR: u32 = 0;
const WC_ASSIGN_ARRAY: u32 = 1;
const WC_ASSIGN_NEW: u32 = 0;
const WC_ASSIGN_INC: u32 = 1;

const WC_TIMED_EMPTY: u32 = 0;
const WC_TIMED_PIPE: u32 = 1;

const WC_FOR_PPARAM: u32 = 0;
const WC_FOR_LIST: u32 = 1;
const WC_FOR_COND: u32 = 2;
const WC_SELECT_PPARAM: u32 = 0;
const WC_SELECT_LIST: u32 = 1;
const WC_WHILE_WHILE: u32 = 0;
const WC_WHILE_UNTIL: u32 = 1;

const WC_CASE_HEAD: u32 = 0;
const WC_CASE_OR: u32 = 1;
const WC_CASE_AND: u32 = 2;
const WC_CASE_TESTAND: u32 = 3;
const WC_CASE_FREE: u32 = 3;

const WC_IF_HEAD: u32 = 0;
const WC_IF_IF: u32 = 1;
const WC_IF_ELIF: u32 = 2;
const WC_IF_ELSE: u32 = 3;

const COND_NOT: u32 = 0;
const COND_AND: u32 = 1;
const COND_OR: u32 = 2;
const COND_STREQ: u32 = 3;
const COND_STRDEQ: u32 = 4;
const COND_STRNEQ: u32 = 5;
const COND_STRLT: u32 = 6;
const COND_STRGTR: u32 = 7;
const COND_NT: u32 = 8;
const COND_REGEX: u32 = 17;
const COND_MOD: u32 = 18;
const COND_MODI: u32 = 19;

const REDIR_WRITE: u32 = 0;
const REDIR_WRITENOW: u32 = 1;
const REDIR_APP: u32 = 2;
const REDIR_APPNOW: u32 = 3;
const REDIR_ERRWRITE: u32 = 4;
const REDIR_ERRWRITENOW: u32 = 5;
const REDIR_ERRAPP: u32 = 6;
const REDIR_ERRAPPNOW: u32 = 7;
const REDIR_READWRITE: u32 = 8;
const REDIR_READ: u32 = 9;
const REDIR_HEREDOC: u32 = 10;
const REDIR_HEREDOCDASH: u32 = 11;
const REDIR_HERESTR: u32 = 12;
const REDIR_MERGEIN: u32 = 13;
const REDIR_MERGEOUT: u32 = 14;
const REDIR_INPIPE: u32 = 16;
const REDIR_OUTPIPE: u32 = 17;
const REDIR_VARID_MASK: u32 = 0x20;
const REDIR_FROM_HEREDOC_MASK: u32 = 0x40;

/// zsh `wc_bld`.
const fn wc_bld(c: u32, d: u32) -> u32 {
	c | (d << WC_CODEBITS)
}

/// zsh `wc_code`.
const fn wc_code(c: u32) -> u32 {
	c & ((1 << WC_CODEBITS) - 1)
}

/// zsh `wc_data`.
const fn wc_data(c: u32) -> u32 {
	c >> WC_CODEBITS
}

const fn wcb_list(t: u32, o: u32) -> u32 {
	wc_bld(WC_LIST, t | (o << WC_LIST_FREE))
}

const fn wcb_sublist(t: u32, f: u32, o: u32) -> u32 {
	wc_bld(WC_SUBLIST, t | f | (o << WC_SUBLIST_FREE))
}

const fn wcb_pipe(t: u32, l: u32) -> u32 {
	wc_bld(WC_PIPE, t | (l << 1))
}

/// zsh `WC_PIPE_LINENO`.
const fn wc_pipe_lineno(c: u32) -> u32 {
	wc_data(c) >> 1
}

const fn wcb_redir(t: u32) -> u32 {
	wc_bld(WC_REDIR, t)
}

/// zsh `WC_REDIR_WORDS`.
const fn wc_redir_words(c: u32) -> usize {
	let d = wc_data(c);
	(if d & REDIR_VARID_MASK != 0 { 4 } else { 3 })
		+ if d & REDIR_FROM_HEREDOC_MASK != 0 {
			2
		} else {
			0
		}
}

const fn wcb_assign(t: u32, a: u32, n: u32) -> u32 {
	wc_bld(WC_ASSIGN, t | (a << 1) | (n << 2))
}

const fn wcb_for(t: u32, o: u32) -> u32 {
	wc_bld(WC_FOR, t | (o << 2))
}

const fn wcb_select(t: u32, o: u32) -> u32 {
	wc_bld(WC_SELECT, t | (o << 1))
}

const fn wcb_while(t: u32, o: u32) -> u32 {
	wc_bld(WC_WHILE, t | (o << 1))
}

const fn wcb_case(t: u32, o: u32) -> u32 {
	wc_bld(WC_CASE, t | (o << WC_CASE_FREE))
}

const fn wcb_if(t: u32, o: u32) -> u32 {
	wc_bld(WC_IF, t | (o << 2))
}

const fn wcb_cond(t: u32, o: u32) -> u32 {
	wc_bld(WC_COND, t | (o << 7))
}

/// zsh `IS_DASH`.
const fn is_dash(c: u8) -> bool {
	c == b'-' || c == DASH
}

/// zsh `IS_READFD`.
const fn is_readfd(t: u32) -> bool {
	(t >= REDIR_READWRITE && t <= REDIR_MERGEIN) || t == REDIR_INPIPE
}

/// zsh `redirtab[tok - OUTANG]`.
const fn redirtab(t: T) -> u32 {
	match t {
		T::Outangbang => REDIR_WRITENOW,
		T::Doutang => REDIR_APP,
		T::Doutangbang => REDIR_APPNOW,
		T::Inang => REDIR_READ,
		T::Inoutang => REDIR_READWRITE,
		T::Dinang => REDIR_HEREDOC,
		T::Dinangdash => REDIR_HEREDOCDASH,
		T::Inangamp => REDIR_MERGEIN,
		T::Outangamp => REDIR_MERGEOUT,
		T::Ampoutang => REDIR_ERRWRITE,
		T::Outangampbang => REDIR_ERRWRITENOW,
		T::Doutangamp => REDIR_ERRAPP,
		T::Doutangampbang => REDIR_ERRAPPNOW,
		T::Trinang => REDIR_HERESTR,
		_ => REDIR_WRITE,
	}
}

/// zsh `get_cond_num`.
fn get_cond_num(tst: &[u8]) -> Option<u32> {
	const CONDSTRS: [&[u8]; 9] = [b"nt", b"ot", b"ef", b"eq", b"ne", b"lt", b"gt", b"le", b"ge"];
	CONDSTRS.iter().position(|&c| c == tst).map(|i| i as u32)
}

/// zsh's C-string length of a token string (its bytes up to a NUL: the
/// parser truncates strings in place).
fn cstr(s: &[u8]) -> &[u8] {
	s.iter().position(|&c| c == 0).map_or(s, |n| &s[..n])
}

/// zsh `hasher` (`hashtable.c`).
fn hasher(s: &[u8]) -> u32 {
	s.iter()
		.fold(0u32, |h, &c| h.wrapping_add(h.wrapping_shl(5)).wrapping_add(u32::from(c)))
}

/// A here-document waiting for its body (zsh `struct heredocs`).
struct Hdoc {
	/// Word code index of its redirection.
	pc:    usize,
	/// The terminator's token string.
	str:   Vec<u8>,
	/// Its slot in [`Ctx::docs`].
	seq:   usize,
	/// The terminator was quoted (no expansion in the body).
	qt:    bool,
	/// `<<-`: leading tabs are stripped.
	strip: bool,
}

/// zsh's word code buffer and string table while compiling (`ecbuf`,
/// `ecstrs`, `ecsoffs`, `ecssub`, `ecnpats`, `ecnfunc`, `hdocs`).
struct Wc<'c, 's> {
	/// Lexer and parser state.
	cx:        &'c mut Ctx<'s>,
	/// `ecbuf[0..ecused]`.
	ec:        Vec<u32>,
	/// The string table so far (strings at their `aoffs`).
	strs:      Vec<u8>,
	/// `ecstrs`: long strings added so far, by function number and text.
	seen:      BTreeMap<(u32, Vec<u8>), u32>,
	/// `ecssub`: start of the current function's strings.
	ecssub:    u32,
	/// `ecnpats`.
	ecnpats:   u32,
	/// `ecnfunc`.
	ecnfunc:   u32,
	/// `hdocs`.
	hdocs:     Vec<Hdoc>,
	/// `par_cmd`'s static `inpartime`.
	inpartime: bool,
	/// The text hit a construct whose code zsh leaves undefined.
	undefined: Option<&'static str>,
}

impl<'c, 's> Wc<'c, 's> {
	fn new(cx: &'c mut Ctx<'s>) -> Self {
		Self {
			cx,
			ec: Vec::with_capacity(256),
			strs: Vec::new(),
			seen: BTreeMap::new(),
			ecssub: 0,
			ecnpats: 0,
			ecnfunc: 0,
			hdocs: Vec::new(),
			inpartime: false,
			undefined: None,
		}
	}

	// ---- buffer ---------------------------------------------------------

	/// `ecsoffs`.
	const fn ecsoffs(&self) -> u32 {
		self.strs.len() as u32
	}

	/// zsh `ecadjusthere`.
	fn ecadjusthere(&mut self, p: usize, d: isize) {
		for h in &mut self.hdocs {
			if h.pc >= p {
				h.pc = h.pc.wrapping_add_signed(d);
			}
		}
	}

	/// zsh `ecispace`: `n` free slots at `p`.
	fn ecispace(&mut self, p: usize, n: usize) {
		let p = p.min(self.ec.len());
		self.ec.splice(p..p, std::iter::repeat_n(0, n));
		self.ecadjusthere(p, n as isize);
	}

	/// zsh `ecadd`: index of the added code.
	fn ecadd(&mut self, c: u32) -> usize {
		self.ec.push(c);
		self.ec.len() - 1
	}

	/// zsh `ecdel`.
	fn ecdel(&mut self, p: usize) {
		if p < self.ec.len() {
			self.ec.remove(p);
		}
		self.ecadjusthere(p, -1);
	}

	/// `ecused = o`.
	fn set_ecused(&mut self, o: usize) {
		self.ec.resize(o, 0);
	}

	/// `ecbuf[p] = c`.
	fn set(&mut self, p: usize, c: u32) {
		if let Some(slot) = self.ec.get_mut(p) {
			*slot = c;
		}
	}

	/// `ecbuf[p]`.
	fn get(&self, p: usize) -> u32 {
		self.ec.get(p).copied().unwrap_or(0)
	}

	/// zsh `ecstrcode`.
	fn ecstrcode(&mut self, s: &[u8]) -> u32 {
		let s = cstr(s);
		let l = s.len() + 1;
		let t = has_token(s);
		if l <= 4 {
			let mut c: u32 = if t { 3 } else { 2 };
			match l {
				4 => {
					c |= u32::from(s[2]) << 19;
					c |= u32::from(s[1]) << 11;
					c |= u32::from(s[0]) << 3;
				},
				3 => {
					c |= u32::from(s[1]) << 11;
					c |= u32::from(s[0]) << 3;
				},
				2 => c |= u32::from(s[0]) << 3,
				_ => c = if t { 7 } else { 6 },
			}
			return c;
		}
		// zsh looks the string up in a tree ordered by function number,
		// hash and text, comparing `(long)p->hashval` (an `int`) with
		// `(long)val` (an `unsigned`): for a hash with its top bit set the
		// two never compare equal (LP64), so such a string is never reused.
		let reusable = hasher(s) < 0x8000_0000;
		let key = (self.ecnfunc, s.to_vec());
		if reusable && let Some(&offs) = self.seen.get(&key) {
			return offs;
		}
		let offs = ((self.ecsoffs() - self.ecssub) << 2) | u32::from(t);
		self.strs.extend_from_slice(s);
		self.strs.push(0);
		if reusable {
			self.seen.insert(key, offs);
		}
		offs
	}

	/// zsh `ecstr`.
	fn ecstr(&mut self, s: &[u8]) {
		let c = self.ecstrcode(s);
		self.ecadd(c);
	}

	/// The current token string (`tokstr`).
	fn tokstr(&self) -> Vec<u8> {
		self.cx.tokstr().map_or_default(<[u8]>::to_vec)
	}

	/// zsh `bld_eprog`.
	fn bld_eprog(mut self) -> Eprog {
		self.ecadd(wc_bld(WC_END, 0));
		Eprog { prog: self.ec, strs: self.strs, npats: self.ecnpats }
	}

	// ---- lexer ----------------------------------------------------------

	/// `zshlex`, with zsh's `setheredoc` for the here-documents whose
	/// bodies the lexer read at a newline.
	fn lex(&mut self) {
		self.cx.zshlex();
		if !self.hdocs.is_empty() && self.cx.ps.hdocs.is_empty() {
			for h in core::mem::take(&mut self.hdocs) {
				self.setheredoc(h);
			}
		}
	}

	/// zsh `setheredoc` with what zsh's `gethere` made of the body: the
	/// metafied text, tokenized as in double quotes unless the terminator
	/// was quoted.
	fn setheredoc(&mut self, h: Hdoc) {
		let mut doc = metafy(self.cx.docs.get(h.seq).map_or(&[][..], |d| &d[..]));
		if !h.qt {
			match parsestr(&doc) {
				Ok(t) => doc = t,
				Err(e) => {
					// zsh `parsestr`.
					let msg = if e > 32 && e < 127 {
						let mut m = b"parse error near `".to_vec();
						m.push(e);
						m.push(b'\'');
						m
					} else {
						b"parse error".to_vec()
					};
					self.cx.zerr(msg);
					self.cx.lx.tok = T::Lexerr;
				},
			}
		}
		let varid = wc_data(self.get(h.pc)) & REDIR_VARID_MASK;
		self.set(h.pc, wcb_redir(REDIR_HERESTR | REDIR_FROM_HEREDOC_MASK | varid));
		let munged = Self::munged_term(&h);
		let c = self.ecstrcode(&doc);
		self.set(h.pc + 2, c);
		let c = self.ecstrcode(&h.str);
		self.set(h.pc + 3, c);
		let c = self.ecstrcode(&munged);
		self.set(h.pc + 4, c);
	}

	/// The terminator as zsh's `gethere` leaves it (`quotesubst`,
	/// `untokenize`, leading tabs stripped for `<<-`).
	fn munged_term(h: &Hdoc) -> Vec<u8> {
		let mut t = munge_terminator(&h.str);
		if h.strip {
			let n = t.iter().take_while(|&&c| c == b'\t').count();
			t.drain(..n);
		}
		metafy(&t)
	}

	/// `while (tok == SEPER) zshlex();`
	fn skip_seps(&mut self) {
		while self.cx.lx.tok == T::Seper {
			self.lex();
		}
	}

	/// `YYERROR(o)`.
	fn yyerror_at(&mut self, o: usize) {
		self.cx.lx.tok = T::Lexerr;
		self.set_ecused(o);
	}

	// ---- lists ----------------------------------------------------------

	/// zsh `set_list_code`.
	fn set_list_code(&mut self, p: usize, ty: u32, cmplx: bool) {
		if !cmplx
			&& (ty == Z_SYNC || ty == (Z_SYNC | Z_END))
			&& (wc_data(self.get(p + 1)) & 3) == WC_SUBLIST_END
		{
			let ispipe = (wc_data(self.get(p + 1)) & 0x1c & WC_SUBLIST_SIMPLE) == 0;
			let skip = (self.ec.len() - 2 - p) as u32;
			self.set(p, wcb_list(ty | Z_SIMPLE, skip));
			self.ecdel(p + 1);
			if ispipe {
				let c = wc_pipe_lineno(self.get(p + 1));
				self.set(p + 1, c);
			}
		} else {
			self.set(p, wcb_list(ty, 0));
		}
	}

	/// zsh `set_sublist_code`.
	fn set_sublist_code(&mut self, p: usize, ty: u32, flags: u32, skip: usize, cmplx: bool) {
		if cmplx {
			self.set(p, wcb_sublist(ty, flags, skip as u32));
		} else {
			self.set(p, wcb_sublist(ty, flags | WC_SUBLIST_SIMPLE, skip as u32));
			let c = wc_pipe_lineno(self.get(p + 1));
			self.set(p + 1, c);
		}
	}

	/// zsh `par_save_list`.
	fn par_save_list(&mut self, cmplx: &mut bool) {
		let eu = self.ec.len();
		self.par_list(cmplx);
		if eu == self.ec.len() {
			self.ecadd(wc_bld(WC_END, 0));
		}
	}

	/// zsh `par_save_list1`.
	fn par_save_list1(&mut self, cmplx: &mut bool) {
		let eu = self.ec.len();
		self.par_list1(cmplx);
		if eu == self.ec.len() {
			self.ecadd(wc_bld(WC_END, 0));
		}
	}

	/// zsh `par_list`, one nesting level deeper ([`Ctx::enter`]).
	fn par_list(&mut self, cmplx: &mut bool) {
		if self.cx.enter() {
			self.par_list_items(cmplx);
			self.cx.leave();
		}
	}

	fn par_list_items(&mut self, cmplx: &mut bool) {
		let mut lp: Option<usize> = None;
		loop {
			self.skip_seps();
			let p = self.ecadd(0);
			let mut c = false;
			if self.par_sublist(&mut c) {
				*cmplx |= c;
				let tok = self.cx.lx.tok;
				if matches!(tok, T::Seper | T::Amper | T::Amperbang) {
					if tok != T::Seper {
						*cmplx = true;
					}
					let ty = match tok {
						T::Seper => Z_SYNC,
						T::Amper => Z_ASYNC,
						_ => Z_ASYNC | Z_DISOWN,
					};
					self.set_list_code(p, ty, c);
					self.cx.ps.incmdpos = true;
					loop {
						self.lex();
						if self.cx.lx.tok != T::Seper {
							break;
						}
					}
					lp = Some(p);
					continue;
				}
				self.set_list_code(p, Z_SYNC | Z_END, c);
			} else {
				self.ec.pop();
				if let Some(lp) = lp {
					let c = self.get(lp) | (Z_END << WC_CODEBITS);
					self.set(lp, c);
				}
			}
			return;
		}
	}

	/// zsh `par_list1`.
	fn par_list1(&mut self, cmplx: &mut bool) {
		let p = self.ecadd(0);
		let mut c = false;
		if self.par_sublist(&mut c) {
			self.set_list_code(p, Z_SYNC | Z_END, c);
			*cmplx |= c;
		} else {
			self.ec.pop();
		}
	}

	/// zsh `par_sublist`.
	fn par_sublist(&mut self, cmplx: &mut bool) -> bool {
		let p = self.ecadd(0);
		let mut c = false;
		let Some(f) = self.par_sublist2(&mut c) else {
			self.ec.pop();
			return false;
		};
		let e = self.ec.len();
		*cmplx |= c;
		if matches!(self.cx.lx.tok, T::Dbar | T::Damper) {
			let qtok = self.cx.lx.tok;
			self.lex();
			self.skip_seps();
			let sl = self.par_sublist(cmplx);
			let ty = if !sl {
				WC_SUBLIST_END
			} else if qtok == T::Dbar {
				WC_SUBLIST_OR
			} else {
				WC_SUBLIST_AND
			};
			self.set_sublist_code(p, ty, f, e - 1 - p, c);
		} else {
			if matches!(self.cx.lx.tok, T::Amper | T::Amperbang) {
				c = true;
				*cmplx |= c;
			}
			self.set_sublist_code(p, WC_SUBLIST_END, f, e - 1 - p, c);
		}
		true
	}

	/// zsh `par_sublist2`: the sublist flags, `None` for no pipeline.
	fn par_sublist2(&mut self, cmplx: &mut bool) -> Option<u32> {
		let mut f = 0;
		if self.cx.lx.tok == T::Coproc {
			*cmplx = true;
			f |= WC_SUBLIST_COPROC;
			self.lex();
		} else if self.cx.lx.tok == T::Bang {
			*cmplx = true;
			f |= WC_SUBLIST_NOT;
			self.lex();
		}
		if !self.par_pline(cmplx) && f == 0 {
			return None;
		}
		Some(f)
	}

	/// zsh `par_pline`.
	fn par_pline(&mut self, cmplx: &mut bool) -> bool {
		let line = self.cx.lx.toklineno;
		let p = self.ecadd(0);
		if !self.par_cmd(cmplx, false) {
			self.ec.pop();
			return false;
		}
		match self.cx.lx.tok {
			T::Bar => {
				*cmplx = true;
				self.lex();
				self.skip_seps();
				self.set(p, wcb_pipe(WC_PIPE_MID, line + 1));
				self.ecispace(p + 1, 1);
				let skip = (self.ec.len() - 1 - p) as u32;
				self.set(p + 1, skip);
				if !self.par_pline(cmplx) {
					self.cx.lx.tok = T::Lexerr;
				}
			},
			T::Baramp => {
				let mut r = p + 1;
				while wc_code(self.get(r)) == WC_REDIR {
					r += wc_redir_words(self.get(r));
				}
				self.ecispace(r, 3);
				self.set(r, wcb_redir(REDIR_MERGEOUT));
				self.set(r + 1, 2);
				let c = self.ecstrcode(b"1");
				self.set(r + 2, c);
				*cmplx = true;
				self.lex();
				self.skip_seps();
				self.set(p, wcb_pipe(WC_PIPE_MID, line + 1));
				self.ecispace(p + 1, 1);
				let skip = (self.ec.len() - 1 - p) as u32;
				self.set(p + 1, skip);
				if !self.par_pline(cmplx) {
					self.cx.lx.tok = T::Lexerr;
				}
			},
			_ => self.set(p, wcb_pipe(WC_PIPE_END, line + 1)),
		}
		true
	}

	// ---- commands -------------------------------------------------------

	/// zsh `par_cmd`.
	fn par_cmd(&mut self, cmplx: &mut bool, zsh_construct: bool) -> bool {
		let mut r = self.ec.len();
		let mut nr = 0;
		if self.cx.lx.tok.is_redirop() {
			*cmplx = true;
			while self.cx.lx.tok.is_redirop() {
				nr += self.par_redir(&mut r, None);
			}
		}
		match self.cx.lx.tok {
			T::For | T::Foreach => self.par_for(cmplx),
			T::Select => {
				*cmplx = true;
				self.par_for(cmplx);
			},
			T::Case => self.par_case(cmplx),
			T::If => self.par_if(cmplx),
			T::While | T::Until => self.par_while(cmplx),
			T::Repeat => self.par_repeat(cmplx),
			T::Inpar => {
				*cmplx = true;
				self.par_subsh(cmplx, zsh_construct);
			},
			T::Inbrace => self.par_subsh(cmplx, zsh_construct),
			T::Func => self.par_funcdef(cmplx),
			T::Dinbrack => self.par_dinbrack(),
			T::Dinpar => {
				self.ecadd(wc_bld(WC_ARITH, 0));
				let s = self.tokstr();
				self.ecstr(&s);
				self.lex();
			},
			T::Time if !self.inpartime => {
				*cmplx = true;
				self.inpartime = true;
				self.par_time();
				self.inpartime = false;
			},
			_ => {
				if self.cx.lx.tok == T::Time {
					self.cx.lx.tok = T::String;
				}
				let sr = self.par_simple(cmplx, nr);
				if sr == 0 {
					if nr == 0 {
						return false;
					}
				} else if sr > 1 {
					*cmplx = true;
					r += sr - 1;
				}
			},
		}
		if self.cx.lx.tok.is_redirop() {
			*cmplx = true;
			while self.cx.lx.tok.is_redirop() {
				self.par_redir(&mut r, None);
			}
		}
		self.cx.ps.incmdpos = true;
		self.cx.ps.incasepat = 0;
		self.cx.ps.incond = 0;
		self.cx.ps.intypeset = false;
		true
	}

	/// A loop body after its head (`DO list DONE | INBRACE list OUTBRACE |
	/// list ZEND | list1`) as `par_for`, `par_while` and `par_repeat`
	/// read it; `false` after `YYERRORV`.
	fn loop_body(&mut self, cmplx: &mut bool, oecused: usize, csh: bool, kind: T) -> bool {
		match self.cx.lx.tok {
			T::Doloop | T::Inbrace => {
				let close = if self.cx.lx.tok == T::Doloop {
					T::Done
				} else {
					T::Outbrace
				};
				self.lex();
				self.par_save_list(cmplx);
				if self.cx.lx.tok != close {
					self.yyerror_at(oecused);
					return false;
				}
				self.cx.ps.incmdpos = false;
				self.lex();
			},
			_ if csh || self.cx.opt(Features::ZSH_CSH_JUNKIE_LOOPS) => {
				self.par_save_list(cmplx);
				if self.cx.lx.tok != T::Zend {
					self.yyerror_at(oecused);
					return false;
				}
				if kind == T::For {
					self.cx.ps.incmdpos = false;
				}
				self.lex();
			},
			_ if !(self.cx.opt(Features::ZSH_SHORT_LOOPS)
				|| (kind == T::Repeat && self.cx.opt(Features::ZSH_SHORT_REPEAT))) =>
			{
				self.yyerror_at(oecused);
				return false;
			},
			_ => self.par_save_list1(cmplx),
		}
		true
	}

	/// zsh `par_for`.
	fn par_for(&mut self, cmplx: &mut bool) {
		let oecused = self.ec.len();
		let csh = self.cx.lx.tok == T::Foreach;
		let sel = self.cx.lx.tok == T::Select;
		let p = self.ecadd(0);
		self.cx.ps.incmdpos = false;
		self.cx.ps.infor = if self.cx.lx.tok == T::For { 2 } else { 0 };
		self.lex();
		let ty;
		if self.cx.lx.tok == T::Dinpar {
			for want in [T::Dinpar, T::Dinpar, T::Doutpar] {
				self.lex();
				if self.cx.lx.tok != want {
					return self.yyerror_at(oecused);
				}
				let s = self.tokstr();
				self.ecstr(&s);
			}
			self.cx.ps.infor = 0;
			self.cx.ps.incmdpos = true;
			self.lex();
			ty = WC_FOR_COND;
		} else {
			self.cx.ps.infor = 0;
			if self.cx.lx.tok != T::String
				|| !isident(&self.tokstr(), self.cx.opt(Features::ZSH_WIDE_IDENT))
			{
				return self.yyerror_at(oecused);
			}
			let np = if sel { None } else { Some(self.ecadd(0)) };
			let mut n = 0;
			self.cx.ps.incmdpos = true;
			let ona = self.cx.noaliases;
			self.cx.noaliases = true;
			loop {
				n += 1;
				let s = self.tokstr();
				self.ecstr(&s);
				self.lex();
				if self.cx.lx.tok != T::String || self.cx.lx.buf == b"in" || sel {
					break;
				}
				if !isident(&self.tokstr(), self.cx.opt(Features::ZSH_WIDE_IDENT)) || self.cx.errflag {
					self.cx.noaliases = ona;
					return self.yyerror_at(oecused);
				}
			}
			self.cx.noaliases = ona;
			if let Some(np) = np {
				self.set(np, n);
			}
			let posix_in = self.cx.ps.isnewlin;
			while self.cx.ps.isnewlin != 0 {
				self.lex();
			}
			if self.cx.lx.tok == T::String && self.cx.lx.buf == b"in" {
				self.cx.ps.incmdpos = false;
				self.lex();
				let np = self.ecadd(0);
				let n = self.par_wordlist();
				if self.cx.lx.tok != T::Seper {
					return self.yyerror_at(oecused);
				}
				self.set(np, n);
				ty = if sel { WC_SELECT_LIST } else { WC_FOR_LIST };
			} else if posix_in == 0 && self.cx.lx.tok == T::Inpar {
				self.cx.ps.incmdpos = false;
				self.lex();
				let np = self.ecadd(0);
				let n = self.par_nl_wordlist();
				if self.cx.lx.tok != T::Outpar {
					return self.yyerror_at(oecused);
				}
				self.set(np, n);
				self.cx.ps.incmdpos = true;
				self.lex();
				ty = if sel { WC_SELECT_LIST } else { WC_FOR_LIST };
			} else {
				ty = if sel { WC_SELECT_PPARAM } else { WC_FOR_PPARAM };
			}
		}
		self.cx.ps.incmdpos = true;
		self.skip_seps();
		if !self.loop_body(cmplx, oecused, csh, T::For) {
			return;
		}
		let skip = (self.ec.len() - 1 - p) as u32;
		self.set(
			p,
			if sel {
				wcb_select(ty, skip)
			} else {
				wcb_for(ty, skip)
			},
		);
	}

	/// zsh `par_case`.
	#[allow(clippy::cognitive_complexity, reason = "a direct port of zsh's par_case")]
	fn par_case(&mut self, cmplx: &mut bool) {
		let oecused = self.ec.len();
		let p = self.ecadd(0);
		self.cx.ps.incmdpos = false;
		self.lex();
		if self.cx.lx.tok != T::String {
			return self.yyerror_at(oecused);
		}
		let s = self.tokstr();
		self.ecstr(&s);
		self.cx.ps.incmdpos = true;
		let ona = self.cx.noaliases;
		self.cx.noaliases = true;
		self.lex();
		self.skip_seps();
		if !(self.cx.lx.tok == T::String && self.cx.lx.buf == b"in") && self.cx.lx.tok != T::Inbrace {
			self.cx.noaliases = ona;
			return self.yyerror_at(oecused);
		}
		let brflag = self.cx.lx.tok == T::Inbrace;
		self.cx.ps.incasepat = 1;
		self.cx.ps.incmdpos = false;
		self.cx.noaliases = ona;
		self.lex();
		loop {
			self.skip_seps();
			if self.cx.lx.tok == T::Outbrace {
				break;
			}
			if self.cx.lx.tok == T::Inpar {
				self.lex();
			}
			let skip_zshlex = self.cx.lx.tok == T::Bar;
			let mut s = if skip_zshlex {
				Vec::new()
			} else {
				if self.cx.lx.tok != T::String {
					return self.yyerror_at(oecused);
				}
				if self.cx.lx.buf == b"esac" {
					break;
				}
				self.tokstr()
			};
			let mut ty = WC_CASE_OR;
			let pp = self.ecadd(0);
			let palts = self.ecadd(0);
			let mut nalts = 0;
			self.cx.ps.incasepat = -1;
			self.cx.ps.incmdpos = true;
			if !skip_zshlex {
				self.lex();
			}
			loop {
				if self.cx.lx.tok == T::Outpar {
					self.ecstr(&s);
					self.ecadd(self.ecnpats);
					self.ecnpats += 1;
					nalts += 1;
					self.cx.ps.incasepat = 0;
					self.cx.ps.incmdpos = true;
					self.lex();
					break;
				} else if self.cx.lx.tok == T::Bar {
					self.ecstr(&s);
					self.ecadd(self.ecnpats);
					self.ecnpats += 1;
					nalts += 1;
					self.cx.ps.incasepat = 1;
					self.cx.ps.incmdpos = false;
				} else {
					if nalts == 0 && s.first() == Some(&INPAR) {
						if !case_paren_pattern(&mut s) {
							return self.yyerror_at(oecused);
						}
						self.ecstr(&s);
						self.ecadd(self.ecnpats);
						self.ecnpats += 1;
						nalts += 1;
						break;
					}
					return self.yyerror_at(oecused);
				}
				self.lex();
				match self.cx.lx.tok {
					T::String => {
						s = self.tokstr();
						self.lex();
					},
					T::Outpar | T::Bar => s = Vec::new(),
					_ => return self.yyerror_at(oecused),
				}
			}
			self.cx.ps.incasepat = 0;
			self.par_save_list(cmplx);
			if self.cx.lx.tok == T::Semiamp {
				ty = WC_CASE_AND;
			} else if self.cx.lx.tok == T::Semibar {
				ty = WC_CASE_TESTAND;
			}
			let skip = (self.ec.len() - 1 - pp) as u32;
			self.set(pp, wcb_case(ty, skip));
			self.set(palts, nalts);
			if (self.cx.lx.tok == T::Esac && !brflag) || (self.cx.lx.tok == T::Outbrace && brflag) {
				break;
			}
			if !matches!(self.cx.lx.tok, T::Dsemi | T::Semiamp | T::Semibar) {
				return self.yyerror_at(oecused);
			}
			self.cx.ps.incasepat = 1;
			self.cx.ps.incmdpos = false;
			self.lex();
		}
		self.cx.ps.incmdpos = true;
		self.cx.ps.incasepat = 0;
		self.lex();
		let skip = (self.ec.len() - 1 - p) as u32;
		self.set(p, wcb_case(WC_CASE_HEAD, skip));
	}

	/// zsh `par_if`.
	fn par_if(&mut self, cmplx: &mut bool) {
		let oecused = self.ec.len();
		let mut usebrace = false;
		let mut xtok;
		let p = self.ecadd(0);
		loop {
			xtok = self.cx.lx.tok;
			if xtok == T::Fi {
				self.cx.ps.incmdpos = false;
				self.lex();
				break;
			}
			self.lex();
			if xtok == T::Else {
				break;
			}
			self.skip_seps();
			if !(xtok == T::If || xtok == T::Elif) {
				return self.yyerror_at(oecused);
			}
			let pp = self.ecadd(0);
			let ty = if xtok == T::If { WC_IF_IF } else { WC_IF_ELIF };
			self.par_save_list(cmplx);
			self.cx.ps.incmdpos = true;
			if self.cx.lx.tok == T::Endinput {
				return self.yyerror_at(oecused);
			}
			self.skip_seps();
			xtok = T::Fi;
			if self.cx.lx.tok == T::Then {
				usebrace = false;
				self.lex();
				self.par_save_list(cmplx);
				let skip = (self.ec.len() - 1 - pp) as u32;
				self.set(pp, wcb_if(ty, skip));
				self.cx.ps.incmdpos = true;
			} else if self.cx.lx.tok == T::Inbrace {
				usebrace = true;
				self.lex();
				self.par_save_list(cmplx);
				if self.cx.lx.tok != T::Outbrace {
					return self.yyerror_at(oecused);
				}
				let skip = (self.ec.len() - 1 - pp) as u32;
				self.set(pp, wcb_if(ty, skip));
				self.lex();
				self.cx.ps.incmdpos = true;
				if self.cx.lx.tok == T::Seper {
					break;
				}
			} else if !self.cx.opt(Features::ZSH_SHORT_LOOPS) {
				return self.yyerror_at(oecused);
			} else {
				self.par_save_list1(cmplx);
				let skip = (self.ec.len() - 1 - pp) as u32;
				self.set(pp, wcb_if(ty, skip));
				self.cx.ps.incmdpos = true;
				break;
			}
		}
		if xtok == T::Else || self.cx.lx.tok == T::Else {
			let pp = self.ecadd(0);
			self.skip_seps();
			if self.cx.lx.tok == T::Inbrace && usebrace {
				self.lex();
				self.par_save_list(cmplx);
				if self.cx.lx.tok != T::Outbrace {
					return self.yyerror_at(oecused);
				}
			} else {
				self.par_save_list(cmplx);
				if self.cx.lx.tok != T::Fi {
					return self.yyerror_at(oecused);
				}
			}
			self.cx.ps.incmdpos = false;
			let skip = (self.ec.len() - 1 - pp) as u32;
			self.set(pp, wcb_if(WC_IF_ELSE, skip));
			self.lex();
		}
		let skip = (self.ec.len() - 1 - p) as u32;
		self.set(p, wcb_if(WC_IF_HEAD, skip));
	}

	/// zsh `par_while`.
	fn par_while(&mut self, cmplx: &mut bool) {
		let oecused = self.ec.len();
		let ty = if self.cx.lx.tok == T::Until {
			WC_WHILE_UNTIL
		} else {
			WC_WHILE_WHILE
		};
		let p = self.ecadd(0);
		self.lex();
		self.par_save_list(cmplx);
		self.cx.ps.incmdpos = true;
		self.skip_seps();
		if !self.loop_body(cmplx, oecused, false, T::While) {
			return;
		}
		let skip = (self.ec.len() - 1 - p) as u32;
		self.set(p, wcb_while(ty, skip));
	}

	/// zsh `par_repeat`.
	fn par_repeat(&mut self, cmplx: &mut bool) {
		let oecused = self.ec.len();
		let p = self.ecadd(0);
		self.cx.ps.incmdpos = false;
		self.lex();
		if self.cx.lx.tok != T::String {
			return self.yyerror_at(oecused);
		}
		let s = self.tokstr();
		self.ecstr(&s);
		self.cx.ps.incmdpos = true;
		self.lex();
		self.skip_seps();
		if !self.loop_body(cmplx, oecused, false, T::Repeat) {
			return;
		}
		let skip = (self.ec.len() - 1 - p) as u32;
		self.set(p, wc_bld(WC_REPEAT, skip));
	}

	/// zsh `par_subsh`.
	fn par_subsh(&mut self, cmplx: &mut bool, zsh_construct: bool) {
		let otok = self.cx.lx.tok;
		let oecused = self.ec.len();
		let p = self.ecadd(0);
		// Extra word only needed for an always block.
		let pp = self.ecadd(0);
		self.lex();
		self.par_list(cmplx);
		self.ecadd(wc_bld(WC_END, 0));
		let close = if otok == T::Inpar {
			T::Outpar
		} else {
			T::Outbrace
		};
		if self.cx.lx.tok != close {
			return self.yyerror_at(oecused);
		}
		self.cx.ps.incmdpos = !zsh_construct;
		self.lex();
		if otok == T::Inbrace && self.cx.lx.tok == T::String && self.cx.lx.buf == b"always" {
			let skip = (self.ec.len() - 1 - pp) as u32;
			self.set(pp, wc_bld(WC_TRY, skip));
			self.cx.ps.incmdpos = true;
			loop {
				self.lex();
				if self.cx.lx.tok != T::Seper {
					break;
				}
			}
			if self.cx.lx.tok != T::Inbrace {
				return self.yyerror_at(oecused);
			}
			self.lex();
			self.par_save_list(cmplx);
			self.skip_seps();
			self.cx.ps.incmdpos = true;
			if self.cx.lx.tok != T::Outbrace {
				return self.yyerror_at(oecused);
			}
			self.lex();
			let skip = (self.ec.len() - 1 - p) as u32;
			self.set(p, wc_bld(WC_TRY, skip));
		} else {
			let skip = (self.ec.len() - 1 - p) as u32;
			let code = if otok == T::Inpar { WC_SUBSH } else { WC_CURSH };
			self.set(p, wc_bld(code, skip));
		}
	}

	/// The start of a function body's own string table and pattern count
	/// (zsh's `ecnfunc++; ecssub = so = ecsoffs; onp = ecnpats; ecnpats =
	/// 0;`): `(so, oecssub, onp)`.
	const fn enter_function(&mut self) -> (u32, u32, u32) {
		let oecssub = self.ecssub;
		self.ecnfunc += 1;
		let so = self.ecsoffs();
		self.ecssub = so;
		let onp = self.ecnpats;
		self.ecnpats = 0;
		(so, oecssub, onp)
	}

	/// zsh's restore of the enclosing string table on an error in a
	/// function body.
	const fn abort_function(&mut self, oldlineno: u32, oecssub: u32, onp: u32) {
		self.cx.line = self.cx.line.wrapping_add(oldlineno);
		self.ecnpats = onp;
		self.ecssub = oecssub;
	}

	/// The tail of a function definition after its body: the body's
	/// `WC_END`, string table bounds and pattern count at `p + num + 2…5`,
	/// and the enclosing string table back (`ecnfunc++`).
	fn leave_function(
		&mut self,
		p: usize,
		num: usize,
		(so, oecssub, onp): (u32, u32, u32),
		tracing: u32,
	) {
		self.ecadd(wc_bld(WC_END, 0));
		self.set(p + num + 2, so - oecssub);
		let len = self.ecsoffs() - so;
		self.set(p + num + 3, len);
		self.set(p + num + 4, self.ecnpats);
		self.set(p + num + 5, tracing);
		self.ecnpats = onp;
		self.ecssub = oecssub;
		self.ecnfunc += 1;
		let skip = (self.ec.len() - 1 - p) as u32;
		self.set(p, wc_bld(WC_FUNCDEF, skip));
	}

	/// zsh `par_funcdef`.
	fn par_funcdef(&mut self, cmplx: &mut bool) {
		let oecused = self.ec.len();
		let mut num = 0usize;
		let oldlineno = self.cx.line;
		let mut do_tracing = 0;
		let mut c = false;
		self.cx.line = 0;
		self.cx.ps.incmdpos = false;
		self.lex();
		let p = self.ecadd(0);
		self.ecadd(0);
		if self.cx.lx.tok == T::String && at(&self.cx.lx.buf, 0) == DASH {
			if self.cx.lx.buf[..] == [DASH, b'T'] {
				do_tracing += 1;
				self.lex();
			}
			if self.cx.lx.tok == T::String && self.cx.lx.buf[..] == [DASH, DASH] {
				self.lex();
			}
		}
		while self.cx.lx.tok == T::String {
			if matches!(self.cx.lx.buf[..], [INBRACE | b'{']) {
				self.cx.lx.tok = T::Inbrace;
				break;
			}
			let s = self.tokstr();
			self.ecstr(&s);
			num += 1;
			self.lex();
		}
		for _ in 0..4 {
			self.ecadd(0);
		}
		self.cx.ps.incmdpos = true;
		if self.cx.lx.tok == T::Inoutpar {
			self.lex();
		}
		self.skip_seps();
		let saved = self.enter_function();
		let (_, oecssub, onp) = saved;
		if self.cx.lx.tok == T::Inbrace {
			self.lex();
			self.par_list(&mut c);
			if self.cx.lx.tok != T::Outbrace {
				self.abort_function(oldlineno, oecssub, onp);
				return self.yyerror_at(oecused);
			}
			if num == 0 {
				// Anonymous function, possibly with arguments.
				self.cx.ps.incmdpos = false;
			}
			self.lex();
		} else if !self.cx.opt(Features::ZSH_SHORT_LOOPS) {
			self.abort_function(oldlineno, oecssub, onp);
			return self.yyerror_at(oecused);
		} else {
			self.par_list1(&mut c);
		}
		self.leave_function(p, num, saved, do_tracing);
		self.set(p + 1, num as u32);
		if num == 0 {
			// Arguments of an anonymous function.
			let parg = self.ecadd(0);
			self.ecadd(0);
			while self.cx.lx.tok == T::String {
				let s = self.tokstr();
				self.ecstr(&s);
				num += 1;
				self.lex();
			}
			if num > 0 {
				*cmplx = true;
			}
			let n = (self.ec.len() - parg) as u32;
			self.set(parg, n);
			self.set(parg + 1, num as u32);
		}
		self.cx.line = self.cx.line.wrapping_add(oldlineno);
	}

	/// zsh `par_time`.
	fn par_time(&mut self) {
		self.lex();
		let p = self.ecadd(0);
		self.ecadd(0);
		let mut c = false;
		match self.par_sublist2(&mut c) {
			None => {
				self.ec.pop();
				self.set(p, wc_bld(WC_TIMED, WC_TIMED_EMPTY));
			},
			Some(f) => {
				self.set(p, wc_bld(WC_TIMED, WC_TIMED_PIPE));
				let skip = self.ec.len() - 2 - p;
				self.set_sublist_code(p + 1, WC_SUBLIST_END, f, skip, c);
			},
		}
	}

	/// zsh `par_dinbrack`.
	fn par_dinbrack(&mut self) {
		let oecused = self.ec.len();
		self.cx.ps.incond = 1;
		self.cx.ps.incmdpos = false;
		self.lex();
		self.par_cond();
		if self.cx.lx.tok != T::Doutbrack {
			return self.yyerror_at(oecused);
		}
		self.cx.ps.incond = 0;
		self.cx.ps.incmdpos = true;
		self.lex();
	}

	/// An `ENVSTRING` split as `par_simple` splits it: the name (with its
	/// subscript, `+` cut) and the value; `inc` honours a `+=` (the
	/// assignment part of a command, not of a `typeset`).
	fn split_envstring(&mut self, inc: bool) -> Option<(Vec<u8>, Vec<u8>, bool)> {
		let s = self.tokstr();
		let mut ptr = 0;
		while ptr < s.len() && !matches!(s[ptr], INBRACK | b'=' | b'+') {
			ptr += 1;
		}
		if at(&s, ptr) == INBRACK {
			skipparens(INBRACK, OUTBRACK, &s, &mut ptr);
		}
		let mut name_end = s.len();
		let mut plus = false;
		if inc && at(&s, ptr) == b'+' {
			name_end = ptr;
			plus = true;
			ptr += 1;
		}
		if at(&s, ptr) == b'=' {
			return Some((s[..name_end.min(ptr)].to_vec(), tail(&s, ptr + 1).to_vec(), plus));
		}
		// zsh `equalsplit` over the (possibly cut) name.
		let head = &s[..name_end];
		if let Some(e) = head.iter().position(|&c| c == b'=') {
			Some((head[..e].to_vec(), head[e + 1..].to_vec(), plus))
		} else {
			self.undefined = Some("an assignment word without `='");
			self.cx.lx.tok = T::Lexerr;
			None
		}
	}

	/// zsh `par_simple`: 0 for no code, else 1 plus the code words
	/// redirections took.
	#[allow(clippy::cognitive_complexity, reason = "a direct port of zsh's par_simple")]
	fn par_simple(&mut self, cmplx: &mut bool, mut nr: usize) -> usize {
		let oecused = self.ec.len();
		let mut isnull = true;
		let mut argc = 0u32;
		let mut isfunc = false;
		let mut sr = 0usize;
		let mut c = *cmplx;
		let mut assignments = false;
		let mut ppost = 0usize;
		let mut is_typeset = false;
		let mut hasalias = self.cx.input_hasalias();
		let mut postassigns = 0u32;
		let mut r = self.ec.len();
		loop {
			match self.cx.lx.tok {
				T::Nocorrect => {
					*cmplx = true;
					c = true;
				},
				T::Envstring => {
					let Some((name, value, plus)) = self.split_envstring(true) else {
						return 0;
					};
					let ty = if plus { WC_ASSIGN_INC } else { WC_ASSIGN_NEW };
					self.ecadd(wcb_assign(WC_ASSIGN_SCALAR, ty, 0));
					let mut i = 0;
					while i < value.len() {
						if at(&value, i + 1) == INPAR && matches!(value[i], EQUALS | INANG | OUTANGPROC) {
							*cmplx = true;
							break;
						}
						i += 1;
					}
					self.ecstr(&name);
					self.ecstr(&value);
					isnull = false;
					assignments = true;
				},
				T::Envarray => {
					let oldcmdpos = self.cx.ps.incmdpos;
					*cmplx = true;
					c = true;
					let p = self.ecadd(0);
					self.cx.ps.incmdpos = false;
					let mut s = self.tokstr();
					let type2 = if s.len() > 1 && s.last() == Some(&b'+') {
						s.pop();
						WC_ASSIGN_INC
					} else {
						WC_ASSIGN_NEW
					};
					self.ecstr(&s);
					self.lex();
					let n = self.par_nl_wordlist();
					self.set(p, wcb_assign(WC_ASSIGN_ARRAY, type2, n));
					if self.cx.lx.tok != T::Outpar {
						self.yyerror_at(oecused);
						return 0;
					}
					self.cx.ps.incmdpos = oldcmdpos;
					isnull = false;
					assignments = true;
				},
				t if t.is_redirop() => {
					*cmplx = true;
					c = true;
					nr += self.par_redir(&mut r, None);
					continue;
				},
				_ => break,
			}
			self.lex();
			if hasalias.is_none() {
				hasalias = self.cx.input_hasalias();
			}
		}
		if matches!(self.cx.lx.tok, T::Amper | T::Amperbang) {
			self.yyerror_at(oecused);
			return 0;
		}
		let mut p = self.ecadd(wc_bld(WC_SIMPLE, 0));
		loop {
			match self.cx.lx.tok {
				T::String | T::Typeset => {
					let mut redir_var = false;
					*cmplx = true;
					self.cx.ps.incmdpos = false;
					if self.cx.lx.tok == T::Typeset {
						self.cx.ps.intypeset = true;
						is_typeset = true;
					}
					let b = self.tokstr();
					if !self.cx.opt(Features::ZSH_IGNORE_BRACES)
						&& at(&b, 0) == INBRACE
						&& b.len() > 2
						&& b.last() == Some(&OUTBRACE)
						&& ident_end(&b, 1, self.cx.opt(Features::ZSH_WIDE_IDENT)) >= b.len() - 1
					{
						let toksave = b;
						let idstring = toksave[1..toksave.len() - 1].to_vec();
						redir_var = true;
						self.lex();
						if hasalias.is_none() {
							hasalias = self.cx.input_hasalias();
						}
						if self.cx.lx.tok.is_redirop() && self.cx.lx.tokfd == -1 {
							*cmplx = true;
							c = true;
							let n = self.par_redir(&mut r, Some(idstring));
							p += n;
							sr += n;
						} else if postassigns > 0 {
							postassigns += 1;
							self.ecadd(wcb_assign(WC_ASSIGN_SCALAR, WC_ASSIGN_INC, 0));
							self.ecstr(&toksave);
							self.ecstr(b"");
						} else {
							self.ecstr(&toksave);
							argc += 1;
						}
					}
					if !redir_var {
						let s = self.tokstr();
						if postassigns > 0 {
							postassigns += 1;
							self.ecadd(wcb_assign(WC_ASSIGN_SCALAR, WC_ASSIGN_INC, 0));
							self.ecstr(&s);
							self.ecstr(b"");
						} else {
							self.ecstr(&s);
							argc += 1;
						}
						self.lex();
						if hasalias.is_none() {
							hasalias = self.cx.input_hasalias();
						}
					}
				},
				t if t.is_redirop() => {
					*cmplx = true;
					c = true;
					let n = self.par_redir(&mut r, None);
					p += n;
					if ppost != 0 {
						ppost += n;
					}
					sr += n;
				},
				T::Envstring => {
					if postassigns == 0 {
						ppost = self.ecadd(0);
					}
					postassigns += 1;
					let Some((name, value, _)) = self.split_envstring(false) else {
						return 0;
					};
					self.ecadd(wcb_assign(WC_ASSIGN_SCALAR, WC_ASSIGN_NEW, 0));
					self.ecstr(&name);
					self.ecstr(&value);
					self.lex();
					if hasalias.is_none() {
						hasalias = self.cx.input_hasalias();
					}
				},
				T::Envarray => {
					if postassigns == 0 {
						ppost = self.ecadd(0);
					}
					postassigns += 1;
					let parr = self.ecadd(0);
					let s = self.tokstr();
					self.ecstr(&s);
					// The typeset case: no assignments until this one ends.
					self.cx.ps.intypeset = false;
					self.lex();
					let n = self.par_nl_wordlist();
					self.set(parr, wcb_assign(WC_ASSIGN_ARRAY, WC_ASSIGN_NEW, n));
					self.cx.ps.intypeset = true;
					if self.cx.lx.tok != T::Outpar {
						self.yyerror_at(oecused);
						return 0;
					}
					self.lex();
				},
				T::Inoutpar => {
					let oldlineno = self.cx.line;
					if !self.cx.opt(Features::ZSH_MULTI_FUNC_DEF) && argc > 1 {
						self.yyerror_at(oecused);
						return 0;
					}
					if assignments || postassigns > 0 {
						self.yyerror_at(oecused);
						return 0;
					}
					if let Some(a) = &hasalias
						&& !self.cx.opt(Features::ZSH_ALIAS_FUNC_DEF)
						&& argc > 0
						&& self.cx.input_hasalias().as_ref() != Some(a)
					{
						let mut msg = b"defining function based on alias `".to_vec();
						msg.extend_from_slice(a);
						msg.push(b'\'');
						self.cx.zwarn(msg);
						self.yyerror_at(oecused);
						return 0;
					}
					*cmplx = c;
					self.cx.line = 0;
					self.cx.ps.incmdpos = true;
					self.lex();
					self.skip_seps();
					self.ecispace(p + 1, 1);
					self.set(p + 1, argc);
					for _ in 0..4 {
						self.ecadd(0);
					}
					let saved = self.enter_function();
					let (_, oecssub, onp) = saved;
					// The body's own complexity; the outer `c` stays the command's.
					let mut body_c = false;
					if self.cx.lx.tok == T::Inbrace {
						self.lex();
						self.par_list(&mut body_c);
						if self.cx.lx.tok != T::Outbrace {
							self.abort_function(oldlineno, oecssub, onp);
							self.yyerror_at(oecused);
							return 0;
						}
						if argc == 0 {
							// Anonymous function, possibly with arguments.
							self.cx.ps.incmdpos = false;
						}
						self.lex();
					} else {
						let ll = self.ecadd(0);
						let sl = self.ecadd(0);
						self.ecadd(wcb_pipe(WC_PIPE_END, 0));
						if !self.par_cmd(&mut body_c, argc == 0) {
							self.yyerror_at(oecused);
							return 0;
						}
						if argc == 0 {
							self.cx.ps.incmdpos = false;
						}
						let skip = self.ec.len() - 1 - sl;
						self.set_sublist_code(sl, WC_SUBLIST_END, 0, skip, body_c);
						self.set_list_code(ll, Z_SYNC | Z_END, body_c);
					}
					self.leave_function(p, argc as usize, saved, 0);
					if argc == 0 {
						// Arguments of an anonymous function.
						let mut parg = self.ecadd(0);
						self.ecadd(0);
						while self.cx.lx.tok == T::String || self.cx.lx.tok.is_redirop() {
							if self.cx.lx.tok == T::String {
								let s = self.tokstr();
								self.ecstr(&s);
								argc += 1;
								self.lex();
							} else {
								*cmplx = true;
								c = true;
								let n = self.par_redir(&mut r, None);
								p += n;
								if ppost != 0 {
									ppost += n;
								}
								sr += n;
								parg += n;
							}
						}
						if argc > 0 {
							*cmplx = true;
						}
						let n = (self.ec.len() - parg) as u32;
						self.set(parg, n);
						self.set(parg + 1, argc);
					}
					self.cx.line = self.cx.line.wrapping_add(oldlineno);
					isfunc = true;
					isnull = false;
					break;
				},
				_ => break,
			}
			isnull = false;
		}
		// zsh's local `c` is only read by a function definition.
		let _ = c;
		if isnull && sr + nr == 0 {
			self.set_ecused(p);
			return 0;
		}
		self.cx.ps.incmdpos = true;
		self.cx.ps.intypeset = false;
		if !isfunc {
			if is_typeset {
				self.set(p, wc_bld(WC_TYPESET, argc));
				if postassigns > 0 {
					self.set(ppost, postassigns);
				} else {
					self.ecadd(0);
				}
			} else {
				self.set(p, wc_bld(WC_SIMPLE, argc));
			}
		}
		sr + 1
	}

	/// zsh `par_redir`: the code words the redirection took.
	fn par_redir(&mut self, rp: &mut usize, idstring: Option<Vec<u8>>) -> usize {
		let r = *rp;
		let oldcmdpos = self.cx.ps.incmdpos;
		self.cx.ps.incmdpos = false;
		let rtok = self.cx.lx.tok;
		let mut ty = redirtab(rtok);
		let mut fd1 = self.cx.lx.tokfd;
		self.lex();
		if !matches!(self.cx.lx.tok, T::String | T::Envstring) {
			let n = self.ec.len();
			self.yyerror_at(n);
			return 0;
		}
		self.cx.ps.incmdpos = oldcmdpos;
		if fd1 == -1 {
			fd1 = i32::from(!is_readfd(ty));
		}
		let name = self.tokstr();
		match ty {
			REDIR_HEREDOC | REDIR_HEREDOCDASH => {
				let strip = ty == REDIR_HEREDOCDASH;
				let ncodes = if idstring.is_some() {
					ty |= REDIR_VARID_MASK;
					6
				} else {
					5
				};
				self.ecispace(r, ncodes);
				*rp = r + ncodes;
				self.set(r, wcb_redir(ty | REDIR_FROM_HEREDOC_MASK));
				self.set(r + 1, fd1 as u32);
				if let Some(id) = &idstring {
					let c = self.ecstrcode(id);
					self.set(r + 5, c);
				}
				// The lexer reads the body at the next newline (zsh's
				// `hdocs` list, `gethere`).
				let mut delim = munge_terminator(&name);
				if strip {
					let n = delim.iter().take_while(|&&c| c == b'\t').count();
					delim.drain(..n);
				}
				let quoted = name.iter().any(|&c| is_null(c));
				let seq = self.cx.docs.len();
				self.cx.docs.push(Vec::new());
				self
					.cx
					.ps
					.hdocs
					.push(PendingDoc { seq, delim, strip, quoted });
				self
					.hdocs
					.push(Hdoc { pc: r, str: name, seq, qt: quoted, strip });
				self.lex();
				return ncodes;
			},
			REDIR_WRITE | REDIR_WRITENOW => {
				if at(&name, 0) == OUTANGPROC && at(&name, 1) == INPAR {
					ty = REDIR_OUTPIPE;
				} else if at(&name, 0) == INANG && at(&name, 1) == INPAR {
					let n = self.ec.len();
					self.yyerror_at(n);
					return 0;
				}
			},
			REDIR_READ => {
				if at(&name, 0) == INANG && at(&name, 1) == INPAR {
					ty = REDIR_INPIPE;
				} else if at(&name, 0) == OUTANGPROC && at(&name, 1) == INPAR {
					let n = self.ec.len();
					self.yyerror_at(n);
					return 0;
				}
			},
			REDIR_READWRITE if matches!(at(&name, 0), INANG | OUTANGPROC) && at(&name, 1) == INPAR => {
				ty = if at(&name, 0) == INANG {
					REDIR_INPIPE
				} else {
					REDIR_OUTPIPE
				};
			},
			_ => {},
		}
		self.lex();
		let ncodes = if idstring.is_some() {
			ty |= REDIR_VARID_MASK;
			4
		} else {
			3
		};
		self.ecispace(r, ncodes);
		*rp = r + ncodes;
		self.set(r, wcb_redir(ty));
		self.set(r + 1, fd1 as u32);
		let c = self.ecstrcode(&name);
		self.set(r + 2, c);
		if let Some(id) = &idstring {
			let c = self.ecstrcode(id);
			self.set(r + 3, c);
		}
		ncodes
	}

	/// zsh `par_wordlist`.
	fn par_wordlist(&mut self) -> u32 {
		let mut num = 0;
		while self.cx.lx.tok == T::String {
			let s = self.tokstr();
			self.ecstr(&s);
			num += 1;
			self.lex();
		}
		num
	}

	/// zsh `par_nl_wordlist`.
	fn par_nl_wordlist(&mut self) -> u32 {
		let mut num = 0;
		while matches!(self.cx.lx.tok, T::String | T::Seper) {
			if self.cx.lx.tok != T::Seper {
				let s = self.tokstr();
				self.ecstr(&s);
				num += 1;
			}
			self.lex();
		}
		num
	}

	// ---- conditions -----------------------------------------------------

	/// zsh `COND_SEP`: a newline inside `[[ … ]]`.
	fn cond_sep(&self) -> bool {
		self.cx.lx.tok == T::Seper && self.cx.lx.sep_nl
	}

	/// `while (COND_SEP()) condlex();`
	fn skip_cond_seps(&mut self) {
		while self.cond_sep() {
			self.lex();
		}
	}

	/// `do condlex(); while (COND_SEP());`
	fn cond_next(&mut self) {
		loop {
			self.lex();
			if !self.cond_sep() {
				break;
			}
		}
	}

	/// zsh `COND_ERROR`.
	fn cond_error(&mut self, pre: &[u8], arg: &[u8]) -> bool {
		let mut msg = pre.to_vec();
		msg.extend_from_slice(&plain(arg));
		self.cx.zwarn(msg);
		self.cx.errflag = true;
		let n = self.ec.len();
		self.yyerror_at(n);
		false
	}

	/// zsh `par_cond`.
	fn par_cond(&mut self) -> bool {
		let p = self.ec.len();
		let r = self.par_cond_1();
		self.skip_cond_seps();
		if self.cx.lx.tok == T::Dbar {
			self.lex();
			self.skip_cond_seps();
			self.ecispace(p, 1);
			if self.cx.enter() {
				self.par_cond();
				self.cx.leave();
			}
			let skip = (self.ec.len() - 1 - p) as u32;
			self.set(p, wcb_cond(COND_OR, skip));
			return true;
		}
		r
	}

	/// zsh `par_cond_1`.
	fn par_cond_1(&mut self) -> bool {
		let p = self.ec.len();
		let r = self.par_cond_2();
		self.skip_cond_seps();
		if self.cx.lx.tok == T::Damper {
			self.lex();
			self.skip_cond_seps();
			self.ecispace(p, 1);
			if self.cx.enter() {
				self.par_cond_1();
				self.cx.leave();
			}
			let skip = (self.ec.len() - 1 - p) as u32;
			self.set(p, wcb_cond(COND_AND, skip));
			return true;
		}
		r
	}

	/// zsh `par_cond_2` (the `[[ … ]]` case: no `test` arguments).
	fn par_cond_2(&mut self) -> bool {
		self.skip_cond_seps();
		if self.cx.lx.tok == T::Bang {
			self.lex();
			self.ecadd(wcb_cond(COND_NOT, 0));
			if !self.cx.enter() {
				return false;
			}
			let r = self.par_cond_2();
			self.cx.leave();
			return r;
		}
		if self.cx.lx.tok == T::Inpar {
			self.lex();
			self.skip_cond_seps();
			let r = self.cx.enter() && {
				let r = self.par_cond();
				self.cx.leave();
				r
			};
			self.skip_cond_seps();
			if self.cx.lx.tok != T::Outpar {
				let n = self.ec.len();
				self.yyerror_at(n);
				return false;
			}
			self.lex();
			return r;
		}
		let s1 = self.cx.tokstr().map(<[u8]>::to_vec);
		let dble = s1
			.as_ref()
			.is_some_and(|s| is_dash(at(s, 0)) && at(s, 2) == 0 && s.len() <= 2);
		if self.cx.lx.tok != T::String {
			if let Some(s1) = s1
				&& self.cx.lx.tok != T::Lexerr
				&& !dble
			{
				self.cond_next();
				return self.par_cond_double(b"-n", &s1);
			}
			let n = self.ec.len();
			self.yyerror_at(n);
			return false;
		}
		let s1 = s1.unwrap_or_default();
		self.lex();
		self.skip_cond_seps();
		if matches!(self.cx.lx.tok, T::Inang | T::Outang) {
			let xtok = self.cx.lx.tok;
			self.cond_next();
			if self.cx.lx.tok != T::String {
				let n = self.ec.len();
				self.yyerror_at(n);
				return false;
			}
			let s3 = self.tokstr();
			self.cond_next();
			let ty = if xtok == T::Inang {
				COND_STRLT
			} else {
				COND_STRGTR
			};
			self.ecadd(wcb_cond(ty, 0));
			self.ecstr(&s1);
			self.ecstr(&s3);
			return true;
		}
		if self.cx.lx.tok != T::String {
			if self.cx.lx.tok != T::Lexerr {
				return if dble {
					self.par_cond_multi(&s1, &[])
				} else {
					self.par_cond_double(b"-n", &s1)
				};
			}
			let n = self.ec.len();
			self.yyerror_at(n);
			return false;
		}
		let s2 = self.tokstr();
		let dble = is_dash(at(&s2, 0)) && s2.len() <= 2;
		self.cx.ps.incond += 1;
		self.cond_next();
		self.cx.ps.incond -= 1;
		if self.cx.lx.tok == T::String && !dble {
			let s3 = self.tokstr();
			self.cond_next();
			if self.cx.lx.tok == T::String {
				let mut l = alloc::vec![s2, s3];
				while self.cx.lx.tok == T::String {
					l.push(self.tokstr());
					self.cond_next();
				}
				return self.par_cond_multi(&s1, &l);
			}
			return self.par_cond_triple(&s1, &s2, &s3);
		}
		self.par_cond_double(&s1, &s2)
	}

	/// zsh `par_cond_double`.
	fn par_cond_double(&mut self, a: &[u8], b: &[u8]) -> bool {
		if !is_dash(at(a, 0)) || at(a, 1) == 0 {
			return self.cond_error(b"parse error: condition expected: ", a);
		}
		if at(a, 2) == 0 && b"abcdefgknoprstuvwxzhLONGS".contains(&a[1]) {
			self.ecadd(wcb_cond(u32::from(a[1]), 0));
		} else {
			self.ecadd(wcb_cond(COND_MOD, 1));
			self.ecstr(a);
		}
		self.ecstr(b);
		true
	}

	/// zsh `par_cond_triple`.
	fn par_cond_triple(&mut self, a: &[u8], b: &[u8], c: &[u8]) -> bool {
		let eq = |x: u8| x == EQUALS || x == b'=';
		let pat = |w: &mut Self, ty: u32| {
			w.ecadd(wcb_cond(ty, 0));
			w.ecstr(a);
			w.ecstr(c);
			w.ecadd(w.ecnpats);
			w.ecnpats += 1;
		};
		if eq(at(b, 0)) && at(b, 1) == 0 {
			pat(self, COND_STREQ);
		} else if eq(at(b, 0)) && eq(at(b, 1)) && at(b, 2) == 0 {
			pat(self, COND_STRDEQ);
		} else if at(b, 0) == b'!' && eq(at(b, 1)) && at(b, 2) == 0 {
			pat(self, COND_STRNEQ);
		} else if eq(at(b, 0)) && matches!(at(b, 1), b'~' | TILDE) && at(b, 2) == 0 {
			self.ecadd(wcb_cond(COND_REGEX, 0));
			self.ecstr(a);
			self.ecstr(c);
		} else if is_dash(at(b, 0)) {
			if let Some(t0) = get_cond_num(tail(b, 1)) {
				self.ecadd(wcb_cond(t0 + COND_NT, 0));
			} else {
				self.ecadd(wcb_cond(COND_MODI, 0));
				self.ecstr(b);
			}
			self.ecstr(a);
			self.ecstr(c);
		} else if is_dash(at(a, 0)) && at(a, 1) != 0 {
			self.ecadd(wcb_cond(COND_MOD, 2));
			self.ecstr(a);
			self.ecstr(b);
			self.ecstr(c);
		} else {
			return self.cond_error(b"condition expected: ", b);
		}
		true
	}

	/// zsh `par_cond_multi`.
	fn par_cond_multi(&mut self, a: &[u8], l: &[Vec<u8>]) -> bool {
		if !is_dash(at(a, 0)) || at(a, 1) == 0 {
			return self.cond_error(b"condition expected: ", a);
		}
		self.ecadd(wcb_cond(COND_MOD, l.len() as u32));
		self.ecstr(a);
		for s in l {
			self.ecstr(s);
		}
		true
	}
}
