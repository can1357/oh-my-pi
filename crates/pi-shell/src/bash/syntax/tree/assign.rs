//! Assignments and compound array elements.
//!
//! | kind     | children                                   | fields                      |
//! |----------|--------------------------------------------|-----------------------------|
//! | `Assign` | `[name, index?, value]` or `[name, index?, elems…]` | span; flags `APPEND`, `ARRAY` |
//! | `Elem`   | `[key?, value]`                            | flag `APPEND`               |
//!
//! Names are text nodes.

use super::{
	Id, K, Mark, Node, Run, Seq, Tree, flag, opt,
	shape::{Assign as AssignS, Elem as ElemS, Word as WordS},
	view,
};
use crate::bash::syntax::span::{NodeId, Span};

const NAME: usize = 0;
const INDEX: usize = 1;
const VALUE: usize = 2;
const KEY: usize = 0;
const ELEM_VALUE: usize = 1;

const APPEND: u8 = 1;
const ARRAY: u8 = 2;

view!(
	/// `NAME=value`.
	Assign: Assign,
	/// One element of a compound array assignment.
	ArrayElem: Elem,
);

/// An assignment's value, for [`Tree::assign`].
#[derive(Clone, Copy, Debug)]
pub enum AssignB {
	Scalar(Id<WordS>),
	Array(Run<ElemS>),
}

impl Tree {
	/// An array element (`[key]=value`, `[key]+=value` or `value`).
	pub fn elem(&mut self, key: Option<Id<WordS>>, append: bool, value: Id<WordS>) -> Id<ElemS> {
		let mut k = [0; 2];
		k[KEY] = opt(key);
		k[ELEM_VALUE] = value.index();
		Id::new(self.push_with(Node { flags: flag(append, APPEND), ..Node::new(K::Elem) }, &k))
	}

	/// An assignment: a scalar value word, or the elements of `name=(…)`
	/// (`array`).
	pub fn assign(
		&mut self,
		span: Span,
		name: &[u8],
		index: Option<Id<WordS>>,
		append: bool,
		value: AssignB,
	) -> Id<AssignS> {
		let name = self.text(name);
		let mark: Mark<()> = self.open();
		debug_assert_eq!((NAME, INDEX, VALUE), (0, 1, 2));
		self.scratch.push(name.index());
		self.scratch.push(opt(index));
		let mut flags = flag(append, APPEND);
		match value {
			AssignB::Scalar(w) => self.scratch.push(w.index()),
			AssignB::Array(elems) => {
				flags |= ARRAY;
				let ids = &self.kids[elems.0 as usize..(elems.0 + elems.1) as usize];
				self.scratch.extend_from_slice(ids);
			},
		}
		Id::new(self.close(Node { flags, ..Node::spanning(K::Assign, span) }, mark))
	}
}

/// Right-hand side of an assignment.
#[derive(Clone, Copy, Debug)]
pub enum AssignValue<'t> {
	Scalar(super::Word<'t>),
	Array(Seq<'t, ArrayElem<'t>>),
}

impl<'t> Assign<'t> {
	pub fn id(self) -> NodeId {
		self.0.id()
	}

	pub fn span(self) -> Span {
		self.0.span()
	}

	pub fn name(self) -> &'t [u8] {
		self.0.must(NAME, "name").bytes()
	}

	pub fn index(self) -> Option<super::Word<'t>> {
		self.0.kid(INDEX).map(super::Word)
	}

	pub fn append(self) -> bool {
		self.0.flag(APPEND)
	}

	pub fn value(self) -> AssignValue<'t> {
		if self.0.flag(ARRAY) {
			AssignValue::Array(self.0.seq(VALUE))
		} else {
			AssignValue::Scalar(super::Word(self.0.must(VALUE, "value")))
		}
	}
}

impl<'t> ArrayElem<'t> {
	pub fn key(self) -> Option<super::Word<'t>> {
		self.0.kid(KEY).map(super::Word)
	}

	pub fn append(self) -> bool {
		self.0.flag(APPEND)
	}

	pub fn value(self) -> super::Word<'t> {
		super::Word(self.0.must(ELEM_VALUE, "value"))
	}
}
