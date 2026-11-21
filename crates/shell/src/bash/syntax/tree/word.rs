//! Words and their parts.
//!
//! | kind   | children                                  | fields                              |
//! |--------|-------------------------------------------|-------------------------------------|
//! | `Word` | parts                                     | span                                |
//! | `Part` | by [`Pk`] in `x`:                         |                                     |
//! |        | text kinds (`Lit`, `Escaped`, `SQuote`, `AnsiC`, `BadSubst`, `Zsh`): none | text range |
//! |        | `DQuote`, `Locale`: parts; `Compound`: elements |                                |
//! |        | `Param`: `[name, sub?, op operands…]`     | `c`: [`ParamCode`]; flags `BRACED`, `INDIRECT` |
//! |        | `Comsub`: `[body, text]`                  | `c`: [`ComsubKind`] code            |
//! |        | `Arith`: `[arith]`; `ProcSub`: `[body]`   | `ProcSub` flag `OUTPUT`             |
//! |        | `BadComsub`: `[text, message]`            | `c`: line                           |
//! | `Name` | none                                      | `x`: [`Nk`]; text range (`Var`) or `c` (position, [`Special`] code) |
//! | `Sub`  | `Expr`: `[word]`                          | `x`: [`Sk`]                         |

use super::{
	Code, Id, K, NONE, Nk, Node, Ok_, Pk, Run, Seq, Sk, Tree, flag, opt,
	shape::{Arith, Elem, List as ListS, Part as PartS, Word as WordS},
	view,
};
use crate::bash::syntax::{
	ast::{CaseMode, ComsubKind, ReplaceMode, Special},
	span::{NodeId, Span},
};

const PARAM_NAME: usize = 0;
const PARAM_SUB: usize = 1;
const PARAM_OP_A: usize = 2;
const PARAM_OP_B: usize = 3;
const SUB_EXPR: usize = 0;
const COMSUB_BODY: usize = 0;
const COMSUB_TEXT: usize = 1;
const PROCSUB_BODY: usize = 0;
const ARITH_PART: usize = 0;
const BAD_TEXT: usize = 0;
const BAD_MSG: usize = 1;

const BRACED: u8 = 1;
const INDIRECT: u8 = 2;
const OUTPUT: u8 = 1;

view!(
	/// A shell word.
	Word: Word,
	/// One piece of a word.
	WordPart: Part,
	/// A parameter expansion.
	Param: Part,
	/// A command substitution.
	Comsub: Part,
	/// A process substitution.
	ProcSub: Part,
	/// The deferred error of a bad command substitution.
	BadComsub: Part,
);

/// The part kinds that are a run of text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextPk {
	Lit,
	Escaped,
	SQuote,
	AnsiC,
	BadSubst,
	Zsh,
}

impl TextPk {
	const fn pk(self) -> Pk {
		match self {
			Self::Lit => Pk::Lit,
			Self::Escaped => Pk::Escaped,
			Self::SQuote => Pk::SQuote,
			Self::AnsiC => Pk::AnsiC,
			Self::BadSubst => Pk::BadSubst,
			Self::Zsh => Pk::Zsh,
		}
	}
}

impl Pk {
	/// Whether a part of this kind holds its text ([`TextPk`]) rather than
	/// child parts or nothing.
	pub const fn carries_text(self) -> bool {
		match self {
			Self::Lit | Self::Escaped | Self::SQuote | Self::AnsiC | Self::BadSubst | Self::Zsh => {
				true
			},
			Self::DQuote
			| Self::Locale
			| Self::Param
			| Self::Comsub
			| Self::Arith
			| Self::ProcSub
			| Self::Compound
			| Self::BadComsub
			| Self::DroppedQuote => false,
		}
	}
}

/// The part kinds that group other parts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GroupPk {
	DQuote,
	Locale,
}

/// The parameter being expanded, for [`Tree::param`].
#[derive(Clone, Copy, Debug)]
pub enum NameB<'a> {
	Var(&'a [u8]),
	Positional(u32),
	Special(Special),
}

/// A subscript, for [`Tree::param`].
#[derive(Clone, Copy, Debug)]
pub enum SubB {
	At,
	Star,
	Expr(Id<WordS>),
}

/// A `${…}` operator, for [`Tree::param`].
#[derive(Clone, Copy, Debug)]
pub enum OpB {
	None,
	Length,
	Indirect,
	PrefixNames { star: bool },
	Default { colon: bool, word: Id<WordS> },
	Assign { colon: bool, word: Id<WordS> },
	Error { colon: bool, word: Option<Id<WordS>> },
	Alt { colon: bool, word: Id<WordS> },
	Substr { offset: Id<Arith>, len: Option<Id<Arith>> },
	Trim { suffix: bool, longest: bool, pat: Id<WordS> },
	Replace { mode: ReplaceMode, pat: Id<WordS>, rep: Option<Id<WordS>> },
	Case { mode: CaseMode, all: bool, pat: Option<Id<WordS>> },
	Transform(u8),
}

/// Where a word sits in a parameter expansion ([`Param::words`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParamSlot {
	kid: usize,
	/// The word is the subscript, inside the subscript node.
	sub: bool,
}

/// What `c` of a parameter part holds: the operator kind, its byte
/// argument (replace / case mode, transform letter) and its flags.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParamCode {
	pub op:    Ok_,
	pub arg:   u8,
	pub flags: u8,
}

impl ParamCode {
	pub const ALL: u8 = 32;
	pub const COLON: u8 = 4;
	pub const LONGEST: u8 = 16;
	pub const STAR: u8 = 64;
	pub const SUFFIX: u8 = 8;

	const fn pack(self) -> u32 {
		((self.op as u32) << 16) | ((self.arg as u32) << 8) | self.flags as u32
	}

	fn unpack(c: u32) -> Self {
		Self { op: Ok_::of((c >> 16) as u16), arg: (c >> 8) as u8, flags: c as u8 }
	}

	const fn has(self, bit: u8) -> bool {
		self.flags & bit != 0
	}
}

// ─── building ──────────────────────────────────────────────────────────

impl Tree {
	/// A text part of kind `pk` holding `bytes`.
	pub fn text_part(&mut self, pk: TextPk, bytes: &[u8]) -> Id<PartS> {
		Id::new(self.text_node(K::Part, pk.pk().code(), bytes))
	}

	/// A part grouping the parts of `run`.
	pub fn group_part(&mut self, pk: GroupPk, run: Run<PartS>) -> Id<PartS> {
		let pk = match pk {
			GroupPk::DQuote => Pk::DQuote,
			GroupPk::Locale => Pk::Locale,
		};
		Id::new(self.push_over(Node { x: pk.code(), ..Node::new(K::Part) }, run))
	}

	/// A compound array value (`(a [k]=b)`) over the elements of `run`.
	pub fn compound_part(&mut self, run: Run<Elem>) -> Id<PartS> {
		Id::new(self.push_over(Node { x: Pk::Compound.code(), ..Node::new(K::Part) }, run))
	}

	pub fn dropped_quote(&mut self) -> Id<PartS> {
		Id::new(self.push(Node { x: Pk::DroppedQuote.code(), ..Node::new(K::Part) }))
	}

	/// A word spanning `span` made of `parts`.
	pub fn word(&mut self, span: Span, parts: &[Id<PartS>]) -> Id<WordS> {
		let run = self.run(parts);
		self.word_unmerged(span, run)
	}

	/// A word over the parts of `run` as read.
	pub fn word_unmerged(&mut self, span: Span, run: Run<PartS>) -> Id<WordS> {
		Id::new(self.push_over(Node::spanning(K::Word, span), run))
	}

	/// A word over the parts of `run` with adjacent literals joined and
	/// empty ones dropped.
	pub fn word_over(&mut self, span: Span, run: Run<PartS>) -> Id<WordS> {
		let run = self.merged(run);
		self.word_unmerged(span, run)
	}

	/// A word of one zsh token string `s`.
	pub fn zword(&mut self, s: &[u8], span: Span) -> Id<WordS> {
		let p = self.text_part(TextPk::Zsh, s);
		self.word(span, &[p])
	}

	/// The parts of `run` with adjacent literals joined and empty ones
	/// dropped; `run` itself when nothing changes.
	fn merged(&mut self, run: Run<PartS>) -> Run<PartS> {
		let is_lit = |t: &Self, p: u32| {
			let n = t.node(p);
			n.kind == K::Part && Pk::of(n.x) == Pk::Lit
		};
		let parts = self.run_ids(run);
		let clean = parts.iter().enumerate().all(|(i, &p)| {
			!(is_lit(self, p)
				&& (self.bytes_of(self.node(p)).is_empty() || (i > 0 && is_lit(self, parts[i - 1]))))
		});
		if clean {
			return run;
		}
		let mark = self.open::<PartS>();
		// Joined literal bytes are appended to the text; `lit` is where the
		// pending ones start.
		let mut lit = None;
		for i in 0..run.1 {
			let p = self.kids[(run.0 + i) as usize];
			if is_lit(self, p) {
				lit.get_or_insert(self.text.len());
				let n = self.nodes[p as usize];
				self.text.extend_from_within(n.lo as usize..n.hi as usize);
				continue;
			}
			self.flush_lit(&mut lit);
			self.scratch.push(p);
		}
		self.flush_lit(&mut lit);
		self.close_run(mark)
	}

	/// Push the literal part of the text from `lit` on (none when empty).
	fn flush_lit(&mut self, lit: &mut Option<usize>) {
		if let Some(lo) = lit.take()
			&& lo < self.text.len()
		{
			let (lo, hi) = (lo as u32, self.text.len() as u32);
			let i = self.push(Node { x: Pk::Lit.code(), lo, hi, ..Node::new(K::Part) });
			self.scratch.push(i);
		}
	}

	/// The node indices of `run`.
	pub fn run_ids<S>(&self, run: Run<S>) -> &[u32] {
		&self.kids[run.0 as usize..(run.0 + run.1) as usize]
	}

	/// The kind of part `p`.
	pub fn part_kind(&self, p: Id<PartS>) -> Pk {
		Pk::of(self.node(p.index()).x)
	}

	/// The text of text part `p`.
	pub fn part_text(&self, p: Id<PartS>) -> &[u8] {
		self.bytes_of(self.node(p.index()))
	}

	/// An arithmetic expansion part over arithmetic text `arith`.
	pub fn arith_part(&mut self, arith: Id<Arith>) -> Id<PartS> {
		let mut k = [NONE; 1];
		k[ARITH_PART] = arith.index();
		Id::new(self.push_with(Node { x: Pk::Arith.code(), ..Node::new(K::Part) }, &k))
	}

	pub fn comsub(&mut self, kind: ComsubKind, body: Id<ListS>, text: &[u8]) -> Id<PartS> {
		let mut k = [NONE; 2];
		k[COMSUB_BODY] = body.index();
		k[COMSUB_TEXT] = self.text(text).index();
		let n = Node { x: Pk::Comsub.code(), c: u32::from(kind.code()), ..Node::new(K::Part) };
		Id::new(self.push_with(n, &k))
	}

	pub fn procsub(&mut self, output: bool, body: Id<ListS>) -> Id<PartS> {
		let mut k = [NONE; 1];
		k[PROCSUB_BODY] = body.index();
		let n = Node { x: Pk::ProcSub.code(), flags: flag(output, OUTPUT), ..Node::new(K::Part) };
		Id::new(self.push_with(n, &k))
	}

	pub fn bad_comsub(&mut self, text: &[u8], line: u32, msg: &[u8]) -> Id<PartS> {
		let mut k = [NONE; 2];
		k[BAD_TEXT] = self.text(text).index();
		k[BAD_MSG] = self.text(msg).index();
		Id::new(self.push_with(Node { x: Pk::BadComsub.code(), c: line, ..Node::new(K::Part) }, &k))
	}

	fn name_node(&mut self, name: NameB<'_>) -> u32 {
		match name {
			NameB::Var(v) => self.text_node(K::Name, Nk::Var.code(), v),
			NameB::Positional(n) => {
				self.push(Node { x: Nk::Positional.code(), c: n, ..Node::new(K::Name) })
			},
			NameB::Special(s) => {
				self.push(Node { x: Nk::Special.code(), c: u32::from(s.code()), ..Node::new(K::Name) })
			},
		}
	}

	/// A parameter expansion part.
	pub fn param(
		&mut self,
		name: NameB<'_>,
		sub: Option<SubB>,
		op: OpB,
		braced: bool,
		indirect: bool,
	) -> Id<PartS> {
		let mut k = [NONE; 4];
		k[PARAM_NAME] = self.name_node(name);
		k[PARAM_SUB] = match sub {
			None => NONE,
			Some(SubB::At) => self.push(Node { x: Sk::At.code(), ..Node::new(K::Sub) }),
			Some(SubB::Star) => self.push(Node { x: Sk::Star.code(), ..Node::new(K::Sub) }),
			Some(SubB::Expr(w)) => {
				let mut s = [NONE; 1];
				s[SUB_EXPR] = w.index();
				self.push_with(Node { x: Sk::Expr.code(), ..Node::new(K::Sub) }, &s)
			},
		};
		let colon = |c: bool| flag(c, ParamCode::COLON);
		let code = |op: Ok_, arg: u8, flags: u8| ParamCode { op, arg, flags };
		let (c, operands) = match op {
			OpB::None => (code(Ok_::None, 0, 0), 0),
			OpB::Length => (code(Ok_::Length, 0, 0), 0),
			OpB::Indirect => (code(Ok_::Indirect, 0, 0), 0),
			OpB::PrefixNames { star } => (code(Ok_::PrefixNames, 0, flag(star, ParamCode::STAR)), 0),
			OpB::Default { colon: cl, word } => {
				k[PARAM_OP_A] = word.index();
				(code(Ok_::Default, 0, colon(cl)), 1)
			},
			OpB::Assign { colon: cl, word } => {
				k[PARAM_OP_A] = word.index();
				(code(Ok_::Assign, 0, colon(cl)), 1)
			},
			OpB::Error { colon: cl, word } => {
				k[PARAM_OP_A] = opt(word);
				(code(Ok_::Error, 0, colon(cl)), 1)
			},
			OpB::Alt { colon: cl, word } => {
				k[PARAM_OP_A] = word.index();
				(code(Ok_::Alt, 0, colon(cl)), 1)
			},
			OpB::Substr { offset, len } => {
				(k[PARAM_OP_A], k[PARAM_OP_B]) = (offset.index(), opt(len));
				(code(Ok_::Substr, 0, 0), 2)
			},
			OpB::Trim { suffix, longest, pat } => {
				k[PARAM_OP_A] = pat.index();
				let fl = flag(suffix, ParamCode::SUFFIX) | flag(longest, ParamCode::LONGEST);
				(code(Ok_::Trim, 0, fl), 1)
			},
			OpB::Replace { mode, pat, rep } => {
				(k[PARAM_OP_A], k[PARAM_OP_B]) = (pat.index(), opt(rep));
				(code(Ok_::Replace, mode.code() as u8, 0), 2)
			},
			OpB::Case { mode, all, pat } => {
				k[PARAM_OP_A] = opt(pat);
				(code(Ok_::Case, mode.code() as u8, flag(all, ParamCode::ALL)), 1)
			},
			OpB::Transform(b) => (code(Ok_::Transform, b, 0), 0),
		};
		let node = Node {
			x: Pk::Param.code(),
			flags: flag(braced, BRACED) | flag(indirect, INDIRECT),
			c: c.pack(),
			..Node::new(K::Part)
		};
		Id::new(self.push_with(node, &k[..PARAM_OP_A + operands]))
	}

	/// Parameter part `p` with its variable name replaced by `name`.
	pub fn param_renamed(&mut self, p: Id<PartS>, name: &[u8]) -> Id<PartS> {
		let name = self.text_node(K::Name, Nk::Var.code(), name);
		let mark = self.open::<()>();
		debug_assert_eq!(PARAM_NAME, 0, "the name goes first");
		self.scratch.push(name);
		self.kid_children(mark, p.index(), PARAM_NAME + 1);
		Id::new(self.close(*self.node(p.index()), mark))
	}

	/// Parameter part `p` of `src` (whose text this tree shares) over
	/// children `kids` (copies of its own, in order) with the word at
	/// `slot` ([`Param::words`]) replaced by `word`.
	pub fn param_replaced(
		&mut self,
		src: &Self,
		p: u32,
		slot: ParamSlot,
		word: Id<WordS>,
		kids: &mut [u32],
	) -> Id<PartS> {
		kids[slot.kid] = if slot.sub {
			let mut s = [NONE; 1];
			s[SUB_EXPR] = word.index();
			self.copy_over(src, src.kids_of(p)[PARAM_SUB], &s)
		} else {
			word.index()
		};
		Id::new(self.copy_over(src, p, kids))
	}
}

// ─── reading ───────────────────────────────────────────────────────────

impl<'t> Word<'t> {
	pub fn id(self) -> NodeId {
		self.0.id()
	}

	pub fn span(self) -> Span {
		self.0.span()
	}

	pub fn parts(self) -> Seq<'t, WordPart<'t>> {
		self.0.seq(0)
	}

	/// The text when the word is one literal part.
	pub fn lit(self) -> Option<&'t [u8]> {
		match self.parts().one()?.get() {
			Part::Lit(s) => Some(s),
			_ => None,
		}
	}
}

/// One piece of a word, as views.
#[derive(Clone, Copy, Debug)]
pub enum Part<'t> {
	Lit(&'t [u8]),
	Escaped(&'t [u8]),
	SQuote(&'t [u8]),
	DQuote(Seq<'t, WordPart<'t>>),
	AnsiC(&'t [u8]),
	Locale(Seq<'t, WordPart<'t>>),
	Param(Param<'t>),
	Comsub(Comsub<'t>),
	Arith(super::ArithText<'t>),
	ProcSub(ProcSub<'t>),
	Compound(Seq<'t, super::ArrayElem<'t>>),
	BadSubst(&'t [u8]),
	BadComsub(BadComsub<'t>),
	DroppedQuote,
	Zsh(&'t [u8]),
}

impl<'t> WordPart<'t> {
	pub fn get(self) -> Part<'t> {
		let at = self.0;
		match Pk::of(at.n().x) {
			Pk::Lit => Part::Lit(at.bytes()),
			Pk::Escaped => Part::Escaped(at.bytes()),
			Pk::SQuote => Part::SQuote(at.bytes()),
			Pk::AnsiC => Part::AnsiC(at.bytes()),
			Pk::BadSubst => Part::BadSubst(at.bytes()),
			Pk::Zsh => Part::Zsh(at.bytes()),
			Pk::DQuote => Part::DQuote(at.seq(0)),
			Pk::Locale => Part::Locale(at.seq(0)),
			Pk::Param => Part::Param(Param(at)),
			Pk::Comsub => Part::Comsub(Comsub(at)),
			Pk::Arith => Part::Arith(super::ArithText(at.must(ARITH_PART, "arithmetic"))),
			Pk::ProcSub => Part::ProcSub(ProcSub(at)),
			Pk::Compound => Part::Compound(at.seq(0)),
			Pk::BadComsub => Part::BadComsub(BadComsub(at)),
			Pk::DroppedQuote => Part::DroppedQuote,
		}
	}
}

/// The parameter being expanded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParamName<'t> {
	Var(&'t [u8]),
	Positional(u32),
	Special(Special),
}

/// Array subscript in a parameter expansion.
#[derive(Clone, Copy, Debug)]
pub enum Subscript<'t> {
	At,
	Star,
	Expr(Word<'t>),
}

/// Operator inside `${…}`, as views.
#[derive(Clone, Copy, Debug)]
pub enum ParamOp<'t> {
	None,
	Length,
	Indirect,
	PrefixNames { star: bool },
	Default { colon: bool, word: Word<'t> },
	Assign { colon: bool, word: Word<'t> },
	Error { colon: bool, word: Option<Word<'t>> },
	Alt { colon: bool, word: Word<'t> },
	Substr { offset: super::ArithText<'t>, len: Option<super::ArithText<'t>> },
	Trim { suffix: bool, longest: bool, pat: Word<'t> },
	Replace { mode: ReplaceMode, pat: Word<'t>, rep: Option<Word<'t>> },
	Case { mode: CaseMode, all: bool, pat: Option<Word<'t>> },
	Transform(u8),
}

impl<'t> Param<'t> {
	/// The words of the expansion: the subscript, then the operator words,
	/// with where each sits (for [`Tree::param_replaced`]).
	pub fn words(self) -> [Option<(ParamSlot, Word<'t>)>; 3] {
		let at = |kid, sub| ParamSlot { kid, sub };
		let index = match self.index() {
			Some(Subscript::Expr(w)) => Some((at(PARAM_SUB, true), w)),
			_ => None,
		};
		let (a, b) = match self.op() {
			ParamOp::Default { word, .. }
			| ParamOp::Assign { word, .. }
			| ParamOp::Alt { word, .. } => (Some(word), None),
			ParamOp::Error { word, .. } => (word, None),
			ParamOp::Trim { pat, .. } => (Some(pat), None),
			ParamOp::Replace { pat, rep, .. } => (Some(pat), rep),
			ParamOp::Case { pat, .. } => (pat, None),
			_ => (None, None),
		};
		[index, a.map(|w| (at(PARAM_OP_A, false), w)), b.map(|w| (at(PARAM_OP_B, false), w))]
	}

	pub fn braced(self) -> bool {
		self.0.flag(BRACED)
	}

	pub fn indirect(self) -> bool {
		self.0.flag(INDIRECT)
	}

	pub fn name(self) -> ParamName<'t> {
		let n = self.0.must(PARAM_NAME, "parameter name");
		match Nk::of(n.n().x) {
			Nk::Var => ParamName::Var(n.bytes()),
			Nk::Positional => ParamName::Positional(n.n().c),
			Nk::Special => ParamName::Special(Special::of(n.n().c as u16)),
		}
	}

	pub fn index(self) -> Option<Subscript<'t>> {
		let s = self.0.kid(PARAM_SUB)?;
		Some(match Sk::of(s.n().x) {
			Sk::At => Subscript::At,
			Sk::Star => Subscript::Star,
			Sk::Expr => Subscript::Expr(Word(s.must(SUB_EXPR, "subscript"))),
		})
	}

	pub fn op(self) -> ParamOp<'t> {
		let c = ParamCode::unpack(self.0.n().c);
		let colon = c.has(ParamCode::COLON);
		let w = |k: usize| self.0.kid(k).map(Word);
		let word = |k: usize| w(k).expect("operator word");
		match c.op {
			Ok_::None => ParamOp::None,
			Ok_::Length => ParamOp::Length,
			Ok_::Indirect => ParamOp::Indirect,
			Ok_::PrefixNames => ParamOp::PrefixNames { star: c.has(ParamCode::STAR) },
			Ok_::Default => ParamOp::Default { colon, word: word(PARAM_OP_A) },
			Ok_::Assign => ParamOp::Assign { colon, word: word(PARAM_OP_A) },
			Ok_::Error => ParamOp::Error { colon, word: w(PARAM_OP_A) },
			Ok_::Alt => ParamOp::Alt { colon, word: word(PARAM_OP_A) },
			Ok_::Substr => ParamOp::Substr {
				offset: super::ArithText(self.0.must(PARAM_OP_A, "offset")),
				len:    self.0.kid(PARAM_OP_B).map(super::ArithText),
			},
			Ok_::Trim => ParamOp::Trim {
				suffix:  c.has(ParamCode::SUFFIX),
				longest: c.has(ParamCode::LONGEST),
				pat:     word(PARAM_OP_A),
			},
			Ok_::Replace => ParamOp::Replace {
				mode: ReplaceMode::of(u16::from(c.arg)),
				pat:  word(PARAM_OP_A),
				rep:  w(PARAM_OP_B),
			},
			Ok_::Case => ParamOp::Case {
				mode: CaseMode::of(u16::from(c.arg)),
				all:  c.has(ParamCode::ALL),
				pat:  w(PARAM_OP_A),
			},
			Ok_::Transform => ParamOp::Transform(c.arg),
		}
	}
}

impl<'t> Comsub<'t> {
	pub fn kind(self) -> ComsubKind {
		ComsubKind::of(self.0.n().c as u16)
	}

	pub fn body(self) -> super::List<'t> {
		super::List(self.0.must(COMSUB_BODY, "body"))
	}

	/// Source text between the delimiters.
	pub fn text(self) -> &'t [u8] {
		self.0.must(COMSUB_TEXT, "text").bytes()
	}
}

impl<'t> ProcSub<'t> {
	pub fn output(self) -> bool {
		self.0.flag(OUTPUT)
	}

	pub fn body(self) -> super::List<'t> {
		super::List(self.0.must(PROCSUB_BODY, "body"))
	}
}

impl<'t> BadComsub<'t> {
	pub fn text(self) -> &'t [u8] {
		self.0.must(BAD_TEXT, "text").bytes()
	}

	pub fn line(self) -> u32 {
		self.0.n().c
	}

	pub fn msg(self) -> &'t [u8] {
		self.0.must(BAD_MSG, "message").bytes()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Every operator, with its byte argument and flags, reads back from
	/// the packed `c` field as written.
	#[test]
	fn param_codes_read_back() {
		for &op in Ok_::ALL {
			for (arg, flags) in
				[(0, 0), (b'Q', ParamCode::STAR), (3, ParamCode::COLON | ParamCode::ALL)]
			{
				let c = ParamCode { op, arg, flags };
				assert_eq!(ParamCode::unpack(c.pack()), c);
			}
		}
	}
}
