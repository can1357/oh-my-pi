//! The syntax tree of one top-level command as one flat array of nodes.
//!
//! Every node is a fixed-size [`Node`]; a node's children are a contiguous
//! run of indices in [`Tree::kids`] (absent optional children are [`NONE`]).
//! Literal bytes are ranges of one text buffer ([`Tree::text`]). Building a
//! tree appends to a few buffers; dropping one frees them; a parser that
//! reuses a tree only clears them.
//!
//! Each family of node kinds has one module holding its whole encoding: the
//! child slots ([`slot`]-style constants), the builders that write it and
//! the `Copy` views that read it ([`List`], [`Command`], [`Word`],
//! [`WordPart`], …), which mirror the shapes of the bash grammar. Builders
//! take and return typed handles ([`Id`]), so a child of the wrong shape
//! does not compile; children collected on the scratch stack go through a
//! typed [`Mark`] the same way.

mod assign;
mod code;
mod command;
mod cond;
mod ids;
mod list;
mod redir;
mod stored;
mod word;

use alloc::vec::Vec;
use core::{fmt, hash, marker::PhantomData};

use serde::{Deserialize, Serialize};

pub(crate) use self::code::Code;
pub use self::{
	assign::*,
	code::{Cx, Nk, Ok_, Pk, Sk},
	command::*,
	cond::*,
	list::*,
	redir::*,
	word::*,
};
use crate::bash::syntax::span::{NodeId, Span};

/// An absent optional child.
pub const NONE: u32 = u32::MAX;

/// Node kinds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum K {
	List,
	Item,
	AndOr,
	Pipeline,
	Command,
	Simple,
	If,
	While,
	For,
	Words,
	ArithFor,
	Case,
	CaseArm,
	FuncDef,
	Coproc,
	Repeat,
	Try,
	AnonFunc,
	Arith,
	Cond,
	Assign,
	Elem,
	Redir,
	HereDoc,
	Word,
	Part,
	Name,
	Sub,
	Text,
}

/// One node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Node {
	pub kind:  K,
	pub flags: u8,
	/// Kind-specific small value (command kind, part kind, separator…).
	pub x:     u16,
	/// Preorder id ([`NodeId`]), for the kinds that carry one.
	pub id:    u32,
	/// Source span, or the text range of text nodes.
	pub lo:    u32,
	pub hi:    u32,
	/// Children: `kids[a..a + b]`.
	pub a:     u32,
	pub b:     u32,
	/// Kind-specific scalar.
	pub c:     u32,
}

// The tree's footprint is its node count times this: a field added to
// `Node` must be a decision.
const _: () = assert!(core::mem::size_of::<Node>() == 28);

impl Node {
	/// A node of `kind` with nothing set.
	pub const fn new(kind: K) -> Self {
		Self { kind, flags: 0, x: 0, id: 0, lo: 0, hi: 0, a: 0, b: 0, c: 0 }
	}

	/// A node of `kind` spanning `span`.
	pub(crate) const fn spanning(kind: K, span: Span) -> Self {
		Self { lo: span.lo, hi: span.hi, ..Self::new(kind) }
	}

	/// Whether `lo..hi` is a range of the tree's text rather than a source
	/// span: [`Tree::text`] and [`Tree::text_part`] nodes and a variable's
	/// name hold bytes.
	pub fn carries_text(&self) -> bool {
		match self.kind {
			K::Text => true,
			K::Part => Pk::of(self.x).carries_text(),
			K::Name => Nk::of(self.x) == Nk::Var,
			K::List
			| K::Item
			| K::AndOr
			| K::Pipeline
			| K::Command
			| K::Simple
			| K::If
			| K::While
			| K::For
			| K::Words
			| K::ArithFor
			| K::Case
			| K::CaseArm
			| K::FuncDef
			| K::Coproc
			| K::Repeat
			| K::Try
			| K::AnonFunc
			| K::Arith
			| K::Cond
			| K::Assign
			| K::Elem
			| K::Redir
			| K::HereDoc
			| K::Word
			| K::Sub => false,
		}
	}
}

const fn flag(on: bool, bit: u8) -> u8 {
	if on { bit } else { 0 }
}

// ─── typed handles ─────────────────────────────────────────────────────

/// Node shapes: the type parameter of [`Id`] and [`Mark`].
pub mod shape {
	macro_rules! shapes {
		($($(#[$m:meta])* $name:ident),* $(,)?) => {$(
			$(#[$m])*
			#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
			#[allow(clippy::empty_enums, reason = "a type-level marker, never a value")]
			pub enum $name {}
		)*};
	}

	shapes!(
		List,
		Item,
		AndOr,
		Pipeline,
		Command,
		Simple,
		If,
		While,
		For,
		/// The `in` words of `for`, a declaration's elements.
		Words,
		ArithFor,
		Case,
		CaseArm,
		FuncDef,
		Coproc,
		Repeat,
		Try,
		AnonFunc,
		/// Arithmetic text (`$((…))`, `(( ))`, `${x:off:len}`, `for ((…))`).
		Arith,
		/// A `[[ … ]]` expression.
		Cond,
		Assign,
		/// An element of a compound array value.
		Elem,
		Redir,
		HereDoc,
		Word,
		/// A word part.
		Part,
		/// A text node.
		Text,
		/// A simple command's child: an assignment, a word or a redirection.
		Arg,
	);
}

/// A node of shape `S` ([`shape`]): its index in its tree.
pub struct Id<S>(u32, PhantomData<fn() -> S>);

impl<S> Id<S> {
	/// Node `i`, which the caller knows to be of shape `S`.
	pub(crate) const fn new(i: u32) -> Self {
		Self(i, PhantomData)
	}

	/// The node index.
	pub const fn index(self) -> u32 {
		self.0
	}
}

impl<S> Clone for Id<S> {
	fn clone(&self) -> Self {
		*self
	}
}

impl<S> Copy for Id<S> {}

impl<S> PartialEq for Id<S> {
	fn eq(&self, other: &Self) -> bool {
		self.0 == other.0
	}
}

impl<S> Eq for Id<S> {}

impl<S> hash::Hash for Id<S> {
	fn hash<H: hash::Hasher>(&self, h: &mut H) {
		self.0.hash(h);
	}
}

impl<S> fmt::Debug for Id<S> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "#{}", self.0)
	}
}

/// An optional child's index.
const fn opt<S>(i: Option<Id<S>>) -> u32 {
	match i {
		Some(i) => i.0,
		None => NONE,
	}
}

macro_rules! upcast {
	($to:ident: $($from:ident),*) => {$(
		impl From<Id<shape::$from>> for Id<shape::$to> {
			fn from(i: Id<shape::$from>) -> Self {
				Self::new(i.0)
			}
		}
	)*};
}

upcast!(Arg: Assign, Word, Redir);

/// Where children of shape `S` started collecting on the scratch stack
/// ([`Tree::open`]).
pub struct Mark<S>(usize, PhantomData<fn() -> S>);

impl<S> Clone for Mark<S> {
	fn clone(&self) -> Self {
		*self
	}
}

impl<S> Copy for Mark<S> {}

/// Children of shape `S` committed as one run of [`Tree::kids`]: `(start,
/// len)`.
pub struct Run<S>(u32, u32, PhantomData<fn() -> S>);

impl<S> Clone for Run<S> {
	fn clone(&self) -> Self {
		*self
	}
}

impl<S> Copy for Run<S> {}

impl<S> Run<S> {
	pub const fn len(self) -> u32 {
		self.1
	}

	pub const fn is_empty(self) -> bool {
		self.1 == 0
	}

	/// Children `[from, to)` of this run.
	pub const fn slice(self, from: usize, to: usize) -> Self {
		Self(self.0 + from as u32, (to - from) as u32, PhantomData)
	}
}

impl<S> fmt::Debug for Run<S> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "kids[{}..{}]", self.0, self.0 + self.1)
	}
}

// ─── the tree ──────────────────────────────────────────────────────────

/// Nodes of one top-level command (or one run-time parsed word). Stored in
/// a packed form of its own ([`stored`]).
#[derive(Clone, Default)]
pub struct Tree {
	/// The text of every text-carrying node.
	pub text:  Vec<u8>,
	pub nodes: Vec<Node>,
	pub kids:  Vec<u32>,
	/// Builder stack of children not yet committed.
	scratch:   Vec<u32>,
}

impl fmt::Debug for Tree {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("Tree")
			.field("nodes", &self.nodes.len())
			.finish_non_exhaustive()
	}
}

/// The same nodes over the same text: where a node's children sit in
/// [`Tree::kids`] (`a`) is layout, which a stored tree does not keep.
impl PartialEq for Tree {
	fn eq(&self, other: &Self) -> bool {
		self.text == other.text
			&& self.nodes.len() == other.nodes.len()
			&& self
				.nodes
				.iter()
				.zip(&other.nodes)
				.enumerate()
				.all(|(i, (a, b))| {
					Node { a: 0, ..*a } == Node { a: 0, ..*b }
						&& self.kids_of(i as u32) == other.kids_of(i as u32)
				})
	}
}

impl Eq for Tree {}

// Building blocks the family modules encode nodes with.
impl Tree {
	/// Forget every node, keeping the buffers.
	pub fn clear(&mut self) {
		self.text.clear();
		self.nodes.clear();
		self.kids.clear();
		self.scratch.clear();
	}

	/// Reserve room for the tree of about `len` bytes of source, so
	/// building it does not regrow the buffers.
	pub fn reserve_for(&mut self, len: usize) {
		self.nodes.reserve(len / 3 + 8);
		self.kids.reserve(len / 3 + 8);
		self.text.reserve(len / 2 + 16);
		self.scratch.reserve(32);
	}

	/// Release the buffers' spare capacity, for a tree kept with many others
	/// (a parse may reserve for more than the command needed).
	pub fn shrink_to_fit(&mut self) {
		self.text.shrink_to_fit();
		self.nodes.shrink_to_fit();
		self.kids.shrink_to_fit();
		self.scratch = Vec::new();
	}

	/// Bytes the buffers hold allocated.
	pub const fn heap_bytes(&self) -> usize {
		self.text.capacity()
			+ self.nodes.capacity() * core::mem::size_of::<Node>()
			+ (self.kids.capacity() + self.scratch.capacity()) * core::mem::size_of::<u32>()
	}

	/// Append a node; its index.
	fn push(&mut self, node: Node) -> u32 {
		let i = self.nodes.len() as u32;
		self.nodes.push(node);
		i
	}

	/// Append node `n` with children `kids`; its index.
	fn push_with(&mut self, mut n: Node, kids: &[u32]) -> u32 {
		n.a = self.kids.len() as u32;
		n.b = kids.len() as u32;
		self.kids.extend_from_slice(kids);
		self.push(n)
	}

	/// Append node `n` over the children of `run`; its index.
	fn push_over<S>(&mut self, mut n: Node, run: Run<S>) -> u32 {
		(n.a, n.b) = (run.0, run.1);
		self.push(n)
	}

	/// Commit the children collected since `mark` to node `n`; its index.
	fn close<S>(&mut self, n: Node, mark: Mark<S>) -> u32 {
		let run = self.close_run(mark);
		self.push_over(n, run)
	}

	/// Children `ids` as one run.
	pub fn run<S>(&mut self, ids: &[Id<S>]) -> Run<S> {
		let a = self.kids.len() as u32;
		self.kids.extend(ids.iter().map(|i| i.0));
		Run(a, ids.len() as u32, PhantomData)
	}

	/// Move the start of node `i`'s span to `lo`.
	pub fn set_start<S>(&mut self, i: Id<S>, lo: u32) {
		self.nodes[i.0 as usize].lo = lo;
	}

	/// Start collecting children of shape `S` on the scratch stack.
	pub const fn open<S>(&self) -> Mark<S> {
		Mark(self.scratch.len(), PhantomData)
	}

	/// Collect child `i` at `mark`.
	pub fn kid<S>(&mut self, mark: Mark<S>, i: impl Into<Id<S>>) {
		debug_assert!(mark.0 <= self.scratch.len(), "a mark above the scratch stack");
		self.scratch.push(i.into().0);
	}

	/// Collect the children of `run` at `mark`.
	pub fn kid_run<S>(&mut self, mark: Mark<S>, run: Run<S>) {
		debug_assert!(mark.0 <= self.scratch.len(), "a mark above the scratch stack");
		self
			.scratch
			.extend_from_slice(&self.kids[run.0 as usize..(run.0 + run.1) as usize]);
	}

	/// Collect the children of node `i` from child `from` on at `mark`.
	fn kid_children<S>(&mut self, mark: Mark<S>, i: u32, from: usize) {
		debug_assert!(mark.0 <= self.scratch.len(), "a mark above the scratch stack");
		let n = &self.nodes[i as usize];
		let (a, b) = (n.a as usize, (n.a + n.b) as usize);
		self
			.scratch
			.extend_from_slice(self.kids.get(a + from..b).unwrap_or_default());
	}

	/// How many children were collected since `mark`.
	pub const fn opened_len<S>(&self, mark: Mark<S>) -> usize {
		self.scratch.len() - mark.0
	}

	/// Child `k` of those collected since `mark`.
	pub fn opened<S>(&self, mark: Mark<S>, k: usize) -> Option<Id<S>> {
		self.scratch[mark.0..].get(k).map(|&i| Id::new(i))
	}

	/// The last child collected since `mark`.
	pub fn opened_last<S>(&self, mark: Mark<S>) -> Option<Id<S>> {
		self.scratch[mark.0..].last().map(|&i| Id::new(i))
	}

	/// Drop the children collected since `mark`.
	pub fn drop_opened<S>(&mut self, mark: Mark<S>) {
		self.scratch.truncate(mark.0);
	}

	/// Put child `i` first among those collected since `mark`.
	fn kid_first<S>(&mut self, mark: Mark<S>, i: u32) {
		self.scratch.insert(mark.0, i);
	}

	/// Commit the children collected since `mark` as a run of their own.
	pub fn close_run<S>(&mut self, mark: Mark<S>) -> Run<S> {
		let a = self.kids.len() as u32;
		self.kids.extend_from_slice(&self.scratch[mark.0..]);
		self.scratch.truncate(mark.0);
		Run(a, self.kids.len() as u32 - a, PhantomData)
	}

	/// The children of `run` as views of type `V`.
	pub fn seq<S, V>(&self, run: Run<S>) -> Seq<'_, V> {
		Seq::over(self, &self.kids[run.0 as usize..(run.0 + run.1) as usize])
	}

	/// How deep the scratch stack is (zero between commands).
	pub(crate) const fn scratch_len(&self) -> usize {
		self.scratch.len()
	}

	/// Nodes, children and the scratch stack, borrowed apart (for walks).
	fn walk_parts(&mut self) -> (&mut [Node], &[u32], &mut Vec<u32>) {
		(&mut self.nodes, &self.kids, &mut self.scratch)
	}

	/// A node of `kind` holding `bytes`.
	fn text_node(&mut self, kind: K, x: u16, bytes: &[u8]) -> u32 {
		let lo = self.text.len() as u32;
		self.text.extend_from_slice(bytes);
		self.push(Node { x, lo, hi: self.text.len() as u32, ..Node::new(kind) })
	}

	/// A text node holding `bytes`.
	pub fn text(&mut self, bytes: &[u8]) -> Id<shape::Text> {
		Id::new(self.text_node(K::Text, 0, bytes))
	}

	/// Replace the text of text node `i` with `bytes`.
	pub fn set_text(&mut self, i: Id<shape::Text>, bytes: &[u8]) {
		let lo = self.text.len() as u32;
		self.text.extend_from_slice(bytes);
		let n = &mut self.nodes[i.0 as usize];
		(n.lo, n.hi) = (lo, self.text.len() as u32);
	}

	/// The bytes of a text-carrying node `n`.
	pub fn bytes_of(&self, n: &Node) -> &[u8] {
		&self.text[n.lo as usize..n.hi as usize]
	}

	/// The node at `i`.
	pub fn node(&self, i: u32) -> &Node {
		&self.nodes[i as usize]
	}

	/// The children of node `i`.
	pub fn kids_of(&self, i: u32) -> &[u32] {
		let n = &self.nodes[i as usize];
		&self.kids[n.a as usize..(n.a + n.b) as usize]
	}

	/// A copy of the subtree rooted at `root` as a tree of its own, holding
	/// only its own text (node indices are renumbered, the root becomes the
	/// last node). A function's syntax is stored this way, so it must not
	/// carry the text of the command around it.
	pub fn subtree(&self, root: u32) -> (Self, u32) {
		let mut out = Self::default();
		let r = out.copy_compact(self, root);
		(out, r)
	}

	/// [`Tree::copy_from`] for a tree with a text buffer of its own: each
	/// text-carrying node's bytes are appended to this tree's text.
	fn copy_compact(&mut self, t: &Self, i: u32) -> u32 {
		if i == NONE {
			return NONE;
		}
		let mark = self.open::<()>();
		for &k in t.kids_of(i) {
			let c = self.copy_compact(t, k);
			self.scratch.push(c);
		}
		let mut n = *t.node(i);
		if n.carries_text() {
			let lo = self.text.len() as u32;
			self.text.extend_from_slice(t.bytes_of(&n));
			(n.lo, n.hi) = (lo, self.text.len() as u32);
		}
		self.close(n, mark)
	}

	/// An empty tree with this tree's text, so text nodes copied from it
	/// keep their ranges.
	pub fn sharing_text(&self) -> Self {
		Self { text: self.text.clone(), ..Self::default() }
	}

	/// Copy the subtree of `t` rooted at `i` into this tree, which shares
	/// `t`'s text; the copy's root.
	pub fn copy_from(&mut self, t: &Self, i: u32) -> u32 {
		if i == NONE {
			return NONE;
		}
		let mark = self.open::<()>();
		for &k in t.kids_of(i) {
			let c = self.copy_from(t, k);
			self.scratch.push(c);
		}
		self.close(*t.node(i), mark)
	}

	/// A copy of node `i` of `t` (which shares this tree's text) over
	/// children `kids` of this tree: a node rebuilt with some children
	/// replaced keeps its own fields.
	pub fn copy_over(&mut self, t: &Self, i: u32, kids: &[u32]) -> u32 {
		self.push_with(*t.node(i), kids)
	}

	/// Copy node `i` of `t` (which shares this tree's text) and its subtree.
	pub fn copy<S>(&mut self, t: &Self, i: Id<S>) -> Id<S> {
		Id::new(self.copy_from(t, i.0))
	}
}

// ─── views ─────────────────────────────────────────────────────────────

/// A node of a tree.
#[derive(Clone, Copy)]
pub struct At<'t> {
	pub t: &'t Tree,
	pub i: u32,
}

impl<'t> At<'t> {
	pub const fn new(t: &'t Tree, i: u32) -> Self {
		Self { t, i }
	}

	pub fn n(self) -> &'t Node {
		&self.t.nodes[self.i as usize]
	}

	pub fn kids(self) -> &'t [u32] {
		self.t.kids_of(self.i)
	}

	/// Child `k`, absent when [`NONE`].
	pub fn kid(self, k: usize) -> Option<Self> {
		match self.kids().get(k) {
			Some(&i) if i != NONE => Some(Self::new(self.t, i)),
			_ => None,
		}
	}

	/// Child `k`, which the layout says is present.
	fn must(self, k: usize, what: &str) -> Self {
		self
			.kid(k)
			.unwrap_or_else(|| panic!("{:?} has no {what}", self.n().kind))
	}

	pub fn span(self) -> Span {
		let n = self.n();
		Span::new(n.lo, n.hi)
	}

	pub fn id(self) -> NodeId {
		NodeId(self.n().id)
	}

	pub fn flag(self, bit: u8) -> bool {
		self.n().flags & bit != 0
	}

	/// The text of a text-range node.
	pub fn bytes(self) -> &'t [u8] {
		self.t.bytes_of(self.n())
	}

	/// The children from `from` on, as views of type `V`.
	pub fn seq<V>(self, from: usize) -> Seq<'t, V> {
		Seq::over(self.t, self.kids().get(from..).unwrap_or_default())
	}
}

impl fmt::Debug for At<'_> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{:?}#{}", self.n().kind, self.i)
	}
}

/// A run of children read as views of type `V`.
pub struct Seq<'t, V> {
	t:   &'t Tree,
	ids: &'t [u32],
	_v:  PhantomData<fn() -> V>,
}

impl<V> Clone for Seq<'_, V> {
	fn clone(&self) -> Self {
		*self
	}
}

impl<V> Copy for Seq<'_, V> {}

impl<'t, V> Seq<'t, V> {
	/// Nodes `ids` of `t` as a run.
	pub const fn over(t: &'t Tree, ids: &'t [u32]) -> Self {
		Self { t, ids, _v: PhantomData }
	}

	pub const fn len(&self) -> usize {
		self.ids.len()
	}

	pub const fn is_empty(&self) -> bool {
		self.ids.is_empty()
	}

	/// The elements from `k` on.
	pub fn skip(&self, k: usize) -> Self {
		Self::over(self.t, self.ids.get(k..).unwrap_or_default())
	}

	/// The first `k` elements.
	pub fn take(&self, k: usize) -> Self {
		Self::over(self.t, &self.ids[..k.min(self.ids.len())])
	}
}

impl<'t, V: From<At<'t>>> Seq<'t, V> {
	pub fn get(&self, k: usize) -> Option<V> {
		self.ids.get(k).map(|&i| V::from(At::new(self.t, i)))
	}

	pub fn first(&self) -> Option<V> {
		self.get(0)
	}

	pub fn last(&self) -> Option<V> {
		self.ids.len().checked_sub(1).and_then(|k| self.get(k))
	}

	/// The only element, when there is exactly one.
	pub fn one(&self) -> Option<V> {
		if self.ids.len() == 1 {
			self.get(0)
		} else {
			None
		}
	}

	pub fn iter(&self) -> SeqIter<'t, V> {
		SeqIter { t: self.t, ids: self.ids.iter(), _v: PhantomData }
	}
}

impl<'t, V: From<At<'t>>> IntoIterator for Seq<'t, V> {
	type IntoIter = SeqIter<'t, V>;
	type Item = V;

	fn into_iter(self) -> SeqIter<'t, V> {
		self.iter()
	}
}

impl<'t, V: From<At<'t>>> IntoIterator for &Seq<'t, V> {
	type IntoIter = SeqIter<'t, V>;
	type Item = V;

	fn into_iter(self) -> SeqIter<'t, V> {
		self.iter()
	}
}

/// Iterator over a [`Seq`].
pub struct SeqIter<'t, V> {
	t:   &'t Tree,
	ids: core::slice::Iter<'t, u32>,
	_v:  PhantomData<fn() -> V>,
}

impl<V> Clone for SeqIter<'_, V> {
	fn clone(&self) -> Self {
		Self { t: self.t, ids: self.ids.clone(), _v: PhantomData }
	}
}

impl<'t, V: From<At<'t>>> Iterator for SeqIter<'t, V> {
	type Item = V;

	fn next(&mut self) -> Option<V> {
		self.ids.next().map(|&i| V::from(At::new(self.t, i)))
	}

	fn size_hint(&self) -> (usize, Option<usize>) {
		self.ids.size_hint()
	}
}

impl<'t, V: From<At<'t>>> DoubleEndedIterator for SeqIter<'t, V> {
	fn next_back(&mut self) -> Option<V> {
		self.ids.next_back().map(|&i| V::from(At::new(self.t, i)))
	}
}

impl<'t, V: From<At<'t>>> ExactSizeIterator for SeqIter<'t, V> {}

impl<V> fmt::Debug for Seq<'_, V> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_list().entries(self.ids).finish()
	}
}

/// View types over nodes of one shape: `View::at(tree, index)`.
macro_rules! view {
	($($(#[$m:meta])* $name:ident: $shape:ident),* $(,)?) => {$(
		$(#[$m])*
		#[derive(Clone, Copy, Debug)]
		pub struct $name<'t>(pub $crate::bash::syntax::tree::At<'t>);

		impl<'t> From<$crate::bash::syntax::tree::At<'t>> for $name<'t> {
			fn from(at: $crate::bash::syntax::tree::At<'t>) -> Self {
				Self(at)
			}
		}

		impl<'t> $name<'t> {
			/// The view of node `i` of `t`.
			pub const fn at(t: &'t $crate::bash::syntax::tree::Tree, i: u32) -> Self {
				Self($crate::bash::syntax::tree::At::new(t, i))
			}

			/// The view of node `id` of `t`.
			pub const fn of(
				t: &'t $crate::bash::syntax::tree::Tree,
				id: $crate::bash::syntax::tree::Id<$crate::bash::syntax::tree::shape::$shape>,
			) -> Self {
				Self($crate::bash::syntax::tree::At::new(t, id.index()))
			}

			/// The node index in its tree.
			pub const fn node(self) -> u32 {
				self.0.i
			}

			/// The node's typed handle.
			pub const fn handle(
				self,
			) -> $crate::bash::syntax::tree::Id<$crate::bash::syntax::tree::shape::$shape> {
				$crate::bash::syntax::tree::Id::new(self.0.i)
			}

			/// The tree.
			pub const fn tree(self) -> &'t $crate::bash::syntax::tree::Tree {
				self.0.t
			}
		}
	)*};
}
use view;
