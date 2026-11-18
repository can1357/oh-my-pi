//! `[[ … ]]` expressions.
//!
//! | kind   | children (by [`Cx`] in `x`)                                   |
//! |--------|---------------------------------------------------------------|
//! | `Cond` | `Unary`: `[op, arg]`; `Binary`: `[op, lhs, rhs]`; `Word`:     |
//! |        | `[word]`; `Not`/`Group`: `[expr]`; `And`/`Or`: `[lhs, rhs]`   |
//!
//! Operators are text nodes.

use super::{
	Code, Cx, Id, K, NONE, Node, Tree,
	shape::{Cond as CondS, Word as WordS},
	view,
};

const OP: usize = 0;
const ARG: usize = 1;
const LHS: usize = 1;
const RHS: usize = 2;
const SUB: usize = 0;
const LEFT: usize = 0;
const RIGHT: usize = 1;

view!(
	/// `[[ … ]]` expression.
	CondExpr: Cond,
);

/// A `[[ … ]]` expression, for [`Tree::cond`].
#[derive(Clone, Copy, Debug)]
pub enum CondB<'a> {
	Unary { op: &'a [u8], arg: Id<WordS> },
	Binary { op: &'a [u8], lhs: Id<WordS>, rhs: Id<WordS> },
	Word(Id<WordS>),
	Not(Id<CondS>),
	And(Id<CondS>, Id<CondS>),
	Or(Id<CondS>, Id<CondS>),
	Group(Id<CondS>),
}

impl Tree {
	pub fn cond(&mut self, e: CondB<'_>) -> Id<CondS> {
		let mut k = [NONE; 3];
		let (x, n) = match e {
			CondB::Unary { op, arg } => {
				(k[OP], k[ARG]) = (self.text(op).index(), arg.index());
				(Cx::Unary, 2)
			},
			CondB::Binary { op, lhs, rhs } => {
				(k[OP], k[LHS], k[RHS]) = (self.text(op).index(), lhs.index(), rhs.index());
				(Cx::Binary, 3)
			},
			CondB::Word(w) => {
				k[SUB] = w.index();
				(Cx::Word, 1)
			},
			CondB::Not(a) => {
				k[SUB] = a.index();
				(Cx::Not, 1)
			},
			CondB::Group(a) => {
				k[SUB] = a.index();
				(Cx::Group, 1)
			},
			CondB::And(a, b) => {
				(k[LEFT], k[RIGHT]) = (a.index(), b.index());
				(Cx::And, 2)
			},
			CondB::Or(a, b) => {
				(k[LEFT], k[RIGHT]) = (a.index(), b.index());
				(Cx::Or, 2)
			},
		};
		Id::new(self.push_with(Node { x: x.code(), ..Node::new(K::Cond) }, &k[..n]))
	}
}

/// A `[[ … ]]` expression, as views.
#[derive(Clone, Copy, Debug)]
pub enum Cond<'t> {
	Unary { op: &'t [u8], arg: super::Word<'t> },
	Binary { op: &'t [u8], lhs: super::Word<'t>, rhs: super::Word<'t> },
	Word(super::Word<'t>),
	Not(CondExpr<'t>),
	And(CondExpr<'t>, CondExpr<'t>),
	Or(CondExpr<'t>, CondExpr<'t>),
	Group(CondExpr<'t>),
}

impl<'t> CondExpr<'t> {
	pub fn get(self) -> Cond<'t> {
		let k = |n: usize| self.0.must(n, "operand");
		match Cx::of(self.0.n().x) {
			Cx::Unary => Cond::Unary { op: k(OP).bytes(), arg: super::Word(k(ARG)) },
			Cx::Binary => {
				Cond::Binary { op: k(OP).bytes(), lhs: super::Word(k(LHS)), rhs: super::Word(k(RHS)) }
			},
			Cx::Word => Cond::Word(super::Word(k(SUB))),
			Cx::Not => Cond::Not(CondExpr(k(SUB))),
			Cx::Group => Cond::Group(CondExpr(k(SUB))),
			Cx::And => Cond::And(CondExpr(k(LEFT)), CondExpr(k(RIGHT))),
			Cx::Or => Cond::Or(CondExpr(k(LEFT)), CondExpr(k(RIGHT))),
		}
	}
}
