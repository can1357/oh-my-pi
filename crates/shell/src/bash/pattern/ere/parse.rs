//! ERE parser: pattern bytes to a syntax tree shaped exactly like glibc's.
//!
//! The tree shape decides submatch priorities later (see `nfa`), so this
//! follows glibc's `parse_reg_exp`/`parse_branch`/`parse_expression`/
//! `parse_dup_op` step by step: left-associative alternation and
//! concatenation, `X{m,n}` unrolled into copies, `X?` as an alternation with
//! an empty branch, and the same error for every malformed construct.

use crate::bash::pattern::{
	class::Class,
	ere::{
		RegexErrorKind as Error,
		set::{Item, Set},
		unit::Mode,
	},
};

type Result<T, E = Error> = core::result::Result<T, E>;

/// Index of a node in [`Tree::nodes`].
pub type Id = usize;

/// glibc's `RE_DUP_MAX`: the largest count `{m,n}` accepts.
const DUP_MAX: usize = 0x7fff;
/// Most tree nodes a pattern may expand to (bounds `{m,n}` unrolling).
const MAX_NODES: usize = 1 << 17;
/// Deepest group nesting accepted (bounds the parser's recursion).
const MAX_DEPTH: usize = 256;

/// A zero-width assertion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Anchor {
	/// `^`, `` \` ``: start of the subject.
	First,
	/// `$`, `\'`: end of the subject.
	Last,
	/// `\<`: a word starts here.
	WordFirst,
	/// `\>`: a word ends here.
	WordLast,
	/// Half of `\B`: word characters on both sides.
	InsideWord,
	/// Half of `\B`: non-word characters (or the edges) on both sides.
	InsideNotWord,
}

/// A tree leaf: one NFA node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Leaf {
	/// A literal unit (folded unless it came from a `\` escape, as glibc).
	Unit(u32),
	/// A bracket expression, index into [`Tree::sets`].
	Set(usize),
	/// `.`
	Any,
	/// A zero-width assertion.
	Anchor(Anchor),
	/// `\1`..`\9` (1-based group number).
	BackRef(usize),
}

/// What a tree node is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
	/// A leaf; no children.
	Leaf(Leaf),
	/// `left right`; both children present.
	Concat,
	/// `left|right`; a missing child is an empty branch.
	Alt,
	/// `left*`.
	Star,
	/// `(left)`: group `sub` (1-based); `opt` when the group itself is
	/// under `*`, `?` or `{0,n}` (glibc's `opt_subexp`).
	Group {
		/// 1-based group number.
		sub: usize,
		/// The group is the operand of an optional repetition.
		opt: bool,
	},
}

/// A binary tree node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Node {
	/// What the node is.
	pub kind:  Kind,
	/// First child.
	pub left:  Option<Id>,
	/// Second child.
	pub right: Option<Id>,
}

/// A parsed pattern.
#[derive(Clone, Debug)]
pub struct Tree {
	/// Node arena.
	pub nodes:    Vec<Node>,
	/// The whole pattern; `None` for one that matches only the empty string.
	pub root:     Option<Id>,
	/// Bracket expressions referenced by [`Leaf::Set`].
	pub sets:     Vec<Set>,
	/// Number of groups.
	pub groups:   usize,
	/// Whether any back-reference occurs.
	pub backrefs: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tok {
	Char(u32),
	Alt,
	Star,
	Plus,
	Question,
	OpenDup,
	CloseDup,
	Open,
	Close,
	Bracket,
	Period,
	Anchor(Anchor),
	WordDelim,
	NotWordDelim,
	Word(bool),
	Space(bool),
	BackRef(usize),
	BackSlash,
	End,
}

/// A `{m,n}` bound as glibc's `fetch_number` returns it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Num {
	/// No digits (`-1`).
	Missing,
	/// Not a number, or the pattern ended (`-2`).
	Bad,
	Val(usize),
}

/// Parse an ERE.
pub fn parse(src: &[u8], mode: Mode) -> Result<Tree> {
	let mut p = Parser {
		src,
		mode,
		pos: 0,
		len: 0,
		tok: Tok::End,
		completed: 0,
		tree: Tree {
			nodes:    Vec::new(),
			root:     None,
			sets:     Vec::new(),
			groups:   0,
			backrefs: false,
		},
	};
	p.advance();
	p.tree.root = p.reg_exp(0)?;
	Ok(p.tree)
}

struct Parser<'a> {
	src:       &'a [u8],
	mode:      Mode,
	/// Start of the current token.
	pos:       usize,
	/// Length of the current token.
	len:       usize,
	tok:       Tok,
	/// Groups `\1`..`\9` may refer to (glibc's `completed_bkref_map`).
	completed: u16,
	tree:      Tree,
}

const fn is_char(tok: Tok, c: u8) -> bool {
	matches!(tok, Tok::Char(u) if u == c as u32)
}

impl Parser<'_> {
	fn advance(&mut self) {
		self.pos += self.len;
		(self.tok, self.len) = self.peek();
	}

	/// glibc's `peek_token` for `RE_SYNTAX_POSIX_EXTENDED`.
	fn peek(&self) -> (Tok, usize) {
		let (src, i) = (self.src, self.pos);
		let Some(&c) = src.get(i) else {
			return (Tok::End, 0);
		};
		if c == b'\\' {
			let Some(&c2) = src.get(i + 1) else {
				return (Tok::BackSlash, 1);
			};
			let tok = match c2 {
				b'1'..=b'9' => Tok::BackRef(usize::from(c2 - b'0')),
				b'<' => Tok::Anchor(Anchor::WordFirst),
				b'>' => Tok::Anchor(Anchor::WordLast),
				b'`' => Tok::Anchor(Anchor::First),
				b'\'' => Tok::Anchor(Anchor::Last),
				b'b' => Tok::WordDelim,
				b'B' => Tok::NotWordDelim,
				b'w' => Tok::Word(false),
				b'W' => Tok::Word(true),
				b's' => Tok::Space(false),
				b'S' => Tok::Space(true),
				_ => {
					// glibc reads the escaped character without case folding.
					let (u, len) = self.mode.decode(src, i + 1);
					return (Tok::Char(u), 1 + len);
				},
			};
			return (tok, 2);
		}
		let tok = match c {
			b'|' => Tok::Alt,
			b'*' => Tok::Star,
			b'+' => Tok::Plus,
			b'?' => Tok::Question,
			b'{' => Tok::OpenDup,
			b'}' => Tok::CloseDup,
			b'(' => Tok::Open,
			b')' => Tok::Close,
			b'[' => Tok::Bracket,
			b'.' => Tok::Period,
			b'^' => Tok::Anchor(Anchor::First),
			b'$' => Tok::Anchor(Anchor::Last),
			_ => {
				let (u, len) = self.mode.decode(src, i);
				return (Tok::Char(self.mode.fold(u)), len);
			},
		};
		(tok, 1)
	}

	fn mk(&mut self, kind: Kind, left: Option<Id>, right: Option<Id>) -> Result<Id> {
		if self.tree.nodes.len() >= MAX_NODES {
			return Err(Error::Space);
		}
		self.tree.nodes.push(Node { kind, left, right });
		Ok(self.tree.nodes.len() - 1)
	}

	fn leaf(&mut self, leaf: Leaf) -> Result<Id> {
		self.mk(Kind::Leaf(leaf), None, None)
	}

	/// `branch|branch|…`
	fn reg_exp(&mut self, nest: usize) -> Result<Option<Id>> {
		let initial = self.completed;
		let mut tree = self.branch(nest)?;
		while self.tok == Tok::Alt {
			self.advance();
			let branch = if self.tok != Tok::Alt
				&& self.tok != Tok::End
				&& (nest == 0 || self.tok != Tok::Close)
			{
				let accumulated = self.completed;
				self.completed = initial;
				let branch = self.branch(nest)?;
				self.completed |= accumulated;
				branch
			} else {
				None
			};
			tree = Some(self.mk(Kind::Alt, tree, branch)?);
		}
		Ok(tree)
	}

	/// A concatenation of expressions.
	fn branch(&mut self, nest: usize) -> Result<Option<Id>> {
		let mut tree = self.expression(nest)?;
		while self.tok != Tok::Alt && self.tok != Tok::End && (nest == 0 || self.tok != Tok::Close) {
			let expr = self.expression(nest)?;
			tree = match (tree, expr) {
				(Some(left), Some(right)) => Some(self.mk(Kind::Concat, Some(left), Some(right))?),
				(None, expr) => expr,
				(tree, None) => tree,
			};
		}
		Ok(tree)
	}

	/// One atom and its repetition operators.
	fn expression(&mut self, nest: usize) -> Result<Option<Id>> {
		let atom = match self.tok {
			Tok::Char(u) => self.leaf(Leaf::Unit(u))?,
			Tok::Open => self.sub_exp(nest + 1)?,
			Tok::Bracket => self.bracket()?,
			Tok::BackRef(sub) => {
				if self.completed & (1 << (sub - 1)) == 0 {
					return Err(Error::BackRef);
				}
				self.tree.backrefs = true;
				self.leaf(Leaf::BackRef(sub))?
			},
			Tok::OpenDup | Tok::Star | Tok::Plus | Tok::Question => return Err(Error::BadRepeat),
			// RE_UNMATCHED_RIGHT_PAREN_ORD: a stray `)` is literal, as is `}`.
			Tok::Close => self.leaf(Leaf::Unit(u32::from(b')')))?,
			Tok::CloseDup => self.leaf(Leaf::Unit(u32::from(b'}')))?,
			// Anchors take no repetition: `^*` is an error, not `^` repeated.
			Tok::Anchor(anchor) => {
				let tree = self.leaf(Leaf::Anchor(anchor))?;
				self.advance();
				return Ok(Some(tree));
			},
			Tok::WordDelim | Tok::NotWordDelim => {
				let (a, b) = if self.tok == Tok::WordDelim {
					(Anchor::WordFirst, Anchor::WordLast)
				} else {
					(Anchor::InsideWord, Anchor::InsideNotWord)
				};
				let a = self.leaf(Leaf::Anchor(a))?;
				let b = self.leaf(Leaf::Anchor(b))?;
				let tree = self.mk(Kind::Alt, Some(a), Some(b))?;
				self.advance();
				return Ok(Some(tree));
			},
			Tok::Period => self.leaf(Leaf::Any)?,
			Tok::Word(negated) => {
				let items = vec![Item::Unit(u32::from(b'_')), Item::Class(Class::Alnum)];
				self.set_leaf(negated, items)?
			},
			Tok::Space(negated) => self.set_leaf(negated, vec![Item::Class(Class::Space)])?,
			Tok::Alt | Tok::End => return Ok(None),
			Tok::BackSlash => return Err(Error::Escape),
		};
		self.advance();
		let mut tree = Some(atom);
		while matches!(self.tok, Tok::Star | Tok::Plus | Tok::Question | Tok::OpenDup) {
			tree = self.dup_op(tree)?;
		}
		Ok(tree)
	}

	fn set_leaf(&mut self, negated: bool, items: Vec<Item>) -> Result<Id> {
		self.tree.sets.push(Set::new(negated, items, self.mode));
		self.leaf(Leaf::Set(self.tree.sets.len() - 1))
	}

	/// `( … )`; leaves the closing `)` as the current token.
	fn sub_exp(&mut self, nest: usize) -> Result<Id> {
		if nest > MAX_DEPTH {
			return Err(Error::Space);
		}
		self.tree.groups += 1;
		let sub = self.tree.groups;
		self.advance();
		let body = if self.tok == Tok::Close {
			None
		} else {
			let body = self.reg_exp(nest)?;
			if self.tok != Tok::Close {
				return Err(Error::Paren);
			}
			body
		};
		if sub <= 9 {
			self.completed |= 1 << (sub - 1);
		}
		self.mk(Kind::Group { sub, opt: false }, body, None)
	}

	/// glibc's `fetch_number`: digits up to `,` or `}`.
	fn number(&mut self) -> Num {
		let mut num = Num::Missing;
		loop {
			self.advance();
			match self.tok {
				Tok::End => return Num::Bad,
				Tok::CloseDup => return num,
				tok if is_char(tok, b',') => return num,
				Tok::Char(c @ 0x30..=0x39) if num != Num::Bad => {
					let digit = (c - 0x30) as usize;
					num = Num::Val(match num {
						Num::Val(n) => (n * 10 + digit).min(DUP_MAX + 1),
						_ => digit,
					});
				},
				_ => num = Num::Bad,
			}
		}
	}

	/// The repetition operator at the current token applied to `elem`.
	fn dup_op(&mut self, elem: Option<Id>) -> Result<Option<Id>> {
		let (start, end) = match self.tok {
			Tok::OpenDup => self.interval()?,
			Tok::Plus => (1, None),
			Tok::Question => (0, Some(1)),
			_ => (0, None),
		};
		self.advance();
		let Some(mut elem) = elem else {
			return Ok(None);
		};
		if start == 0 && end == Some(0) {
			return Ok(None);
		}
		// `X{m,n}` is `X` m times, then the rest optional.
		let old = if start > 0 {
			let mut tree = elem;
			for _ in 2..=start {
				elem = self.dup(elem)?;
				tree = self.mk(Kind::Concat, Some(tree), Some(elem))?;
			}
			if end == Some(start) {
				return Ok(Some(tree));
			}
			elem = self.dup(elem)?;
			Some(tree)
		} else {
			None
		};
		if let Kind::Group { opt, .. } = &mut self.tree.nodes[elem].kind {
			*opt = true;
		}
		let mut tree =
			self.mk(if end.is_none() { Kind::Star } else { Kind::Alt }, Some(elem), None)?;
		if let Some(end) = end {
			for _ in start + 2..=end {
				elem = self.dup(elem)?;
				tree = self.mk(Kind::Concat, Some(tree), Some(elem))?;
				tree = self.mk(Kind::Alt, Some(tree), None)?;
			}
		}
		if let Some(old) = old {
			tree = self.mk(Kind::Concat, Some(old), Some(tree))?;
		}
		Ok(Some(tree))
	}

	/// `{m}`, `{m,}`, `{m,n}`, `{,n}`; leaves `}` as the current token.
	fn interval(&mut self) -> Result<(usize, Option<usize>)> {
		let mut start = self.number();
		if start == Num::Missing {
			if is_char(self.tok, b',') {
				start = Num::Val(0);
			} else {
				return Err(Error::BadBrace);
			}
		}
		let end = match start {
			Num::Bad => Num::Bad,
			_ if self.tok == Tok::CloseDup => start,
			_ if is_char(self.tok, b',') => self.number(),
			_ => Num::Bad,
		};
		let Num::Val(start) = start else {
			return Err(if self.tok == Tok::End {
				Error::Brace
			} else {
				Error::BadBrace
			});
		};
		let end = match end {
			Num::Bad => {
				return Err(if self.tok == Tok::End {
					Error::Brace
				} else {
					Error::BadBrace
				});
			},
			Num::Missing => None,
			Num::Val(end) => Some(end),
		};
		if end.is_some_and(|end| start > end) || self.tok != Tok::CloseDup {
			return Err(Error::BadBrace);
		}
		if end.unwrap_or(start) > DUP_MAX {
			return Err(Error::Size);
		}
		Ok((start, end))
	}

	/// Copy the subtree at `root`.
	fn dup(&mut self, root: Id) -> Result<Id> {
		let mut stack = vec![(root, false)];
		let mut done: Vec<Id> = Vec::new();
		while let Some((id, visited)) = stack.pop() {
			let node = self.tree.nodes[id];
			if visited {
				let right = node.right.and_then(|_| done.pop());
				let left = node.left.and_then(|_| done.pop());
				let copy = self.mk(node.kind, left, right)?;
				done.push(copy);
			} else {
				stack.push((id, true));
				if let Some(right) = node.right {
					stack.push((right, false));
				}
				if let Some(left) = node.left {
					stack.push((left, false));
				}
			}
		}
		Ok(done.pop().unwrap_or(root))
	}

	/// `[ … ]`; the current token is the `[`.
	fn bracket(&mut self) -> Result<Id> {
		let mut b = Bracket { src: self.src, mode: self.mode, i: self.pos + 1 };
		let (negated, items) = b.parse()?;
		self.pos = b.i;
		self.len = 0;
		self.set_leaf(negated, items)
	}
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BTok {
	Char(u32),
	Hyphen,
	Close,
	Caret,
	/// `[.`, `[=` or `[:`, with the delimiter.
	OpenSym(u8),
	End,
}

/// A bracket element before resolution.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Elem {
	Unit(u32),
	/// `[.name.]`, `[=name=]` or `[:name:]`, by delimiter.
	Sym(u8, Vec<u8>),
}

/// glibc's `parse_bracket_exp` over the bytes after `[`.
struct Bracket<'a> {
	src:  &'a [u8],
	mode: Mode,
	i:    usize,
}

impl Bracket<'_> {
	/// glibc's `peek_token_bracket` (no backslash escapes in ERE lists).
	fn peek(&self, i: usize) -> (BTok, usize) {
		let Some(&c) = self.src.get(i) else {
			return (BTok::End, 0);
		};
		if c >= 0x80 {
			let (u, len) = self.mode.decode(self.src, i);
			return (BTok::Char(self.mode.fold(u)), len);
		}
		let tok = match c {
			b'[' => match self.src.get(i + 1) {
				Some(&d @ (b'.' | b'=' | b':')) => return (BTok::OpenSym(d), 2),
				_ => BTok::Char(u32::from(c)),
			},
			b'-' => BTok::Hyphen,
			b']' => BTok::Close,
			b'^' => BTok::Caret,
			_ => BTok::Char(self.mode.fold(u32::from(c))),
		};
		(tok, 1)
	}

	fn parse(&mut self) -> Result<(bool, Vec<Item>)> {
		let (mut tok, mut len) = self.peek(self.i);
		if tok == BTok::End {
			return Err(Error::BadPattern);
		}
		let negated = tok == BTok::Caret;
		if negated {
			self.i += len;
			(tok, len) = self.peek(self.i);
			if tok == BTok::End {
				return Err(Error::BadPattern);
			}
		}
		// A leading `]` is literal.
		if tok == BTok::Close {
			tok = BTok::Char(u32::from(b']'));
		}
		let mut items = Vec::new();
		let mut first = true;
		loop {
			let start = self.element(tok, len, first)?;
			first = false;
			(tok, len) = self.peek(self.i);
			let mut range_end = None;
			if !matches!(start, Elem::Sym(b'=' | b':', _)) {
				if tok == BTok::End {
					return Err(Error::Bracket);
				}
				if tok == BTok::Hyphen {
					let (tok2, len2) = self.peek(self.i + len);
					if tok2 == BTok::End {
						return Err(Error::Bracket);
					}
					if tok2 == BTok::Close {
						// A `-` before the closing `]` is literal.
						tok = BTok::Char(u32::from(b'-'));
					} else {
						self.i += len;
						range_end = Some(self.element(tok2, len2, true)?);
						(tok, len) = self.peek(self.i);
					}
				}
			}
			items.push(match range_end {
				Some(end) => self.range(start, end)?,
				None => self.single(start)?,
			});
			match tok {
				BTok::End => return Err(Error::Bracket),
				BTok::Close => {
					self.i += len;
					return Ok((negated, items));
				},
				_ => {},
			}
		}
	}

	/// glibc's `parse_bracket_element`: consume the token at `self.i`.
	fn element(&mut self, tok: BTok, len: usize, accept_hyphen: bool) -> Result<Elem> {
		self.i += len;
		Ok(match tok {
			BTok::OpenSym(delim) => self.symbol(delim)?,
			BTok::Hyphen => {
				// A `-` that is neither first, last nor a range end.
				if !accept_hyphen && self.peek(self.i).0 != BTok::Close {
					return Err(Error::Range);
				}
				Elem::Unit(u32::from(b'-'))
			},
			BTok::Char(u) => Elem::Unit(u),
			BTok::Close => Elem::Unit(u32::from(b']')),
			BTok::Caret => Elem::Unit(u32::from(b'^')),
			BTok::End => return Err(Error::Bracket),
		})
	}

	/// glibc's `parse_bracket_symbol`: the name up to `delim]`.
	fn symbol(&mut self, delim: u8) -> Result<Elem> {
		let mut name = Vec::new();
		loop {
			if name.len() >= 32 {
				return Err(Error::Bracket);
			}
			let Some(&ch) = self.src.get(self.i) else {
				return Err(Error::Bracket);
			};
			self.i += 1;
			let Some(&after) = self.src.get(self.i) else {
				return Err(Error::Bracket);
			};
			if ch == delim && after == b']' {
				self.i += 1;
				return Ok(Elem::Sym(delim, name));
			}
			// Class names are read without case folding, as glibc.
			name.push(if delim == b':' || !self.mode.icase {
				ch
			} else {
				ch.to_ascii_uppercase()
			});
		}
	}

	/// A collating element or equivalence class naming one character.
	fn one_unit(&self, name: &[u8]) -> Result<u32> {
		if name.is_empty() {
			return Err(Error::Collate);
		}
		let (u, len) = self.mode.decode(name, 0);
		if len == name.len() {
			Ok(self.mode.fold(u))
		} else {
			Err(Error::Collate)
		}
	}

	fn single(&self, elem: Elem) -> Result<Item> {
		Ok(match elem {
			Elem::Unit(u) => Item::Unit(u),
			Elem::Sym(b':', name) => {
				let class = match Class::parse(&name) {
					None | Some(Class::Word | Class::Ascii) => return Err(Error::CharClass),
					Some(Class::Upper | Class::Lower) if self.mode.icase => Class::Alpha,
					Some(class) => class,
				};
				Item::Class(class)
			},
			Elem::Sym(_, name) => Item::Unit(self.one_unit(&name)?),
		})
	}

	fn range(&self, start: Elem, end: Elem) -> Result<Item> {
		let bound = |elem: Elem| match elem {
			Elem::Unit(u) => Ok(u),
			Elem::Sym(b'.', name) => self.one_unit(&name),
			Elem::Sym(..) => Err(Error::Range),
		};
		if matches!(end, Elem::Sym(b'=' | b':', _)) {
			return Err(Error::Range);
		}
		let (lo, hi) = (bound(start)?, bound(end)?);
		if lo > hi {
			return Err(Error::Range);
		}
		Ok(Item::Range(lo, hi))
	}
}
