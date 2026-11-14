//! Redirections and here-documents.
//!
//! | kind      | children                     | fields                                          |
//! |-----------|------------------------------|-------------------------------------------------|
//! | `Redir`   | `[target]` or `[target, fd]` | span; `x`: [`RedirOp`] code; `c`: fd number or [`NONE`]; flag `FD_VAR` (`{var}>`: the fd child names it) |
//! | `HereDoc` | `[delim, delim_raw, text]`   | flag `QUOTED`                                   |
//!
//! The target is a word or a here-document; names and texts are text nodes.

use super::{
	Code, Id, K, NONE, Node, Tree, flag,
	shape::{HereDoc as HereDocS, Redir as RedirS, Text, Word as WordS},
	view,
};
use crate::bash::syntax::{ast::RedirOp, span::Span};

const TARGET: usize = 0;
const FD: usize = 1;
const DELIM: usize = 0;
const DELIM_RAW: usize = 1;
const BODY: usize = 2;

const FD_VAR: u8 = 1;
const QUOTED: u8 = 1;

view!(
	/// A redirection.
	Redir: Redir,
	/// A here-document.
	HereDoc: HereDoc,
);

/// A redirection's file descriptor, for [`Tree::redir`].
#[derive(Clone, Copy, Debug)]
pub enum FdB<'a> {
	Num(u32),
	Var(&'a [u8]),
}

/// What a redirection points at, for [`Tree::redir`].
#[derive(Clone, Copy, Debug)]
pub enum TargetB {
	Word(Id<WordS>),
	HereDoc(Id<HereDocS>),
}

impl Tree {
	/// A here-document; its body can be filled in later
	/// ([`Tree::heredoc_body`]).
	pub fn heredoc(
		&mut self,
		delim: &[u8],
		delim_raw: &[u8],
		quoted: bool,
		text: &[u8],
	) -> Id<HereDocS> {
		let mut k = [NONE; 3];
		k[DELIM] = self.text(delim).index();
		k[DELIM_RAW] = self.text(delim_raw).index();
		k[BODY] = self.text(text).index();
		Id::new(self.push_with(Node { flags: flag(quoted, QUOTED), ..Node::new(K::HereDoc) }, &k))
	}

	/// The body text node of here-document `h`.
	pub fn heredoc_body(&self, h: Id<HereDocS>) -> Id<Text> {
		Id::new(self.kids_of(h.index())[BODY])
	}

	pub fn redir(
		&mut self,
		span: Span,
		op: RedirOp,
		fd: Option<FdB<'_>>,
		target: TargetB,
	) -> Id<RedirS> {
		let mut k = [NONE; 2];
		k[TARGET] = match target {
			TargetB::Word(w) => w.index(),
			TargetB::HereDoc(h) => h.index(),
		};
		let (c, var) = match fd {
			Some(FdB::Num(v)) => (v, None),
			Some(FdB::Var(v)) => (NONE, Some(self.text(v))),
			None => (NONE, None),
		};
		if let Some(v) = var {
			k[FD] = v.index();
		}
		let n = Node {
			x: op.code(),
			flags: flag(var.is_some(), FD_VAR),
			c,
			..Node::spanning(K::Redir, span)
		};
		Id::new(self.push_with(n, &k[..=usize::from(var.is_some())]))
	}
}

/// Explicit redirection source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RedirFd<'t> {
	Num(u32),
	Var(&'t [u8]),
}

/// What a redirection points at.
#[derive(Clone, Copy, Debug)]
pub enum RedirTarget<'t> {
	Word(super::Word<'t>),
	HereDoc(HereDoc<'t>),
}

impl<'t> Redir<'t> {
	pub fn span(self) -> Span {
		self.0.span()
	}

	pub fn op(self) -> RedirOp {
		RedirOp::of(self.0.n().x)
	}

	pub fn fd(self) -> Option<RedirFd<'t>> {
		if self.0.flag(FD_VAR) {
			return Some(RedirFd::Var(self.0.must(FD, "fd variable").bytes()));
		}
		let c = self.0.n().c;
		(c != NONE).then_some(RedirFd::Num(c))
	}

	pub fn target(self) -> RedirTarget<'t> {
		let t = self.0.must(TARGET, "target");
		if t.n().kind == K::HereDoc {
			RedirTarget::HereDoc(HereDoc(t))
		} else {
			RedirTarget::Word(super::Word(t))
		}
	}
}

impl<'t> HereDoc<'t> {
	pub fn delim(self) -> &'t [u8] {
		self.0.must(DELIM, "delimiter").bytes()
	}

	pub fn delim_raw(self) -> &'t [u8] {
		self.0.must(DELIM_RAW, "delimiter").bytes()
	}

	pub fn quoted(self) -> bool {
		self.0.flag(QUOTED)
	}

	pub fn text(self) -> &'t [u8] {
		self.0.must(BODY, "body").bytes()
	}
}
