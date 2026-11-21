//! The tree laid out as glibc's NFA.
//!
//! glibc numbers nodes in post-order (`calc_first`), links every node to the
//! node that follows it (`calc_next`), and stores the two targets of an
//! alternation or star sorted by node number (`re_node_set_init_2`). That
//! order is the priority the submatch walk prefers, so it is reproduced
//! here exactly: `a|b` tries `a` first, `X*` and `X?` try `X` first, and an
//! empty alternative always comes last (`(|a)` prefers `a`).

use crate::bash::pattern::ere::{
	parse::{Anchor, Id, Kind, Leaf, Tree},
	set::Set,
	unit::Mode,
};

/// What an NFA node does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
	/// Consume this (folded) unit.
	Unit(u32),
	/// Consume a unit of the given bracket expression of [`Prog::sets`].
	Set(usize),
	/// Consume any unit but NUL.
	Any,
	/// Consume the text group `n` matched (1-based).
	BackRef(usize),
	/// Continue only where the assertion holds.
	Anchor(Anchor),
	/// Group `sub` starts here.
	Open {
		/// 1-based group number.
		sub: usize,
	},
	/// Group `sub` ends here; `opt` as glibc's `opt_subexp`.
	Close {
		/// 1-based group number.
		sub: usize,
		/// The group is the operand of an optional repetition.
		opt: bool,
	},
	/// Continue at `next`, or failing that at `alt`.
	Split,
	/// The match is complete.
	End,
}

impl Op {
	/// Whether the node moves on without consuming input.
	pub const fn is_epsilon(self) -> bool {
		matches!(self, Self::Anchor(_) | Self::Open { .. } | Self::Close { .. } | Self::Split)
	}
}

/// An NFA node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Node {
	/// What the node does.
	pub op:   Op,
	/// The successor; for [`Op::Split`] the preferred one.
	pub next: usize,
	/// [`Op::Split`]'s second successor, when distinct from `next`.
	pub alt:  Option<usize>,
}

/// A compiled pattern.
#[derive(Clone, Debug)]
pub struct Prog {
	/// Nodes in glibc's numbering.
	pub nodes:    Vec<Node>,
	/// Where matching starts.
	pub init:     usize,
	/// The [`Op::End`] node.
	pub end:      usize,
	/// Bracket expressions.
	pub sets:     Vec<Set>,
	/// Number of groups.
	pub groups:   usize,
	/// Whether any back-reference occurs.
	pub backrefs: bool,
	/// Epsilon predecessors of node `n`: `preds[pred_at[n]..pred_at[n + 1]]`.
	pred_at:      Vec<usize>,
	preds:        Vec<usize>,
}

impl Prog {
	/// Lay out a parsed pattern.
	pub fn new(tree: Tree) -> Self {
		let Tree { nodes: tnodes, root, sets, groups, backrefs } = tree;
		let count = tnodes.len();
		// `first[id]`: the node a subtree starts at; `idx[id]`: the node a
		// non-concatenation tree node became (a group's open node);
		// `close[id]`: a group's close node.
		let mut first = vec![0; count];
		let mut idx = vec![0; count];
		let mut close = vec![0; count];
		let mut nodes = Vec::with_capacity(count + 1);
		let blank = |op| Node { op, next: 0, alt: None };

		// Post-order numbering (a group lowers to `open body close`).
		let mut stack: Vec<(Id, bool)> = root.into_iter().map(|r| (r, false)).collect();
		while let Some((id, visited)) = stack.pop() {
			let node = tnodes[id];
			if !visited {
				if let Kind::Group { sub, .. } = node.kind {
					idx[id] = nodes.len();
					nodes.push(blank(Op::Open { sub }));
				}
				stack.push((id, true));
				if let Some(right) = node.right {
					stack.push((right, false));
				}
				if let Some(left) = node.left {
					stack.push((left, false));
				}
				continue;
			}
			let op = match node.kind {
				Kind::Concat => {
					first[id] = node.left.map_or(0, |left| first[left]);
					continue;
				},
				Kind::Group { sub, opt } => {
					first[id] = idx[id];
					close[id] = nodes.len();
					nodes.push(blank(Op::Close { sub, opt }));
					continue;
				},
				Kind::Alt | Kind::Star => Op::Split,
				Kind::Leaf(Leaf::Unit(u)) => Op::Unit(u),
				Kind::Leaf(Leaf::Set(set)) => Op::Set(set),
				Kind::Leaf(Leaf::Any) => Op::Any,
				Kind::Leaf(Leaf::Anchor(anchor)) => Op::Anchor(anchor),
				Kind::Leaf(Leaf::BackRef(sub)) => Op::BackRef(sub),
			};
			idx[id] = nodes.len();
			first[id] = idx[id];
			nodes.push(blank(op));
		}
		let end = nodes.len();
		nodes.push(blank(Op::End));
		let init = root.map_or(end, |root| first[root]);

		// Successors, top-down (glibc's `calc_next` and `link_nfa_nodes`).
		let mut stack: Vec<(Id, usize)> = root.into_iter().map(|r| (r, end)).collect();
		while let Some((id, next)) = stack.pop() {
			let node = tnodes[id];
			let first_or = |child: Option<Id>| child.map_or(next, |child| first[child]);
			match node.kind {
				Kind::Concat => {
					if let (Some(left), Some(right)) = (node.left, node.right) {
						stack.push((left, first[right]));
						stack.push((right, next));
					}
				},
				Kind::Group { .. } => {
					nodes[idx[id]].next = node.left.map_or(close[id], |body| first[body]);
					nodes[close[id]].next = next;
					if let Some(body) = node.left {
						stack.push((body, close[id]));
					}
				},
				Kind::Alt | Kind::Star => {
					let (a, b) = if node.kind == Kind::Star {
						(first_or(node.left), next)
					} else {
						(first_or(node.left), first_or(node.right))
					};
					let inner = if node.kind == Kind::Star {
						idx[id]
					} else {
						next
					};
					for child in [node.left, node.right].into_iter().flatten() {
						stack.push((child, inner));
					}
					let n = &mut nodes[idx[id]];
					n.next = a.min(b);
					n.alt = (a != b).then_some(a.max(b));
				},
				Kind::Leaf(_) => nodes[idx[id]].next = next,
			}
		}

		let (pred_at, preds) = epsilon_preds(&nodes);
		Self { nodes, init, end, sets, groups, backrefs, pred_at, preds }
	}

	/// Nodes with an epsilon edge to `n` (back-references count: they may
	/// match the empty string).
	pub fn preds(&self, n: usize) -> &[usize] {
		&self.preds[self.pred_at[n]..self.pred_at[n + 1]]
	}

	/// Whether consuming node `op` accepts the folded unit `u`.
	pub fn accepts(&self, mode: Mode, op: Op, u: u32) -> bool {
		match op {
			Op::Unit(c) => c == u,
			Op::Set(set) => self.sets[set].matches(mode, u),
			Op::Any => u != 0,
			_ => false,
		}
	}
}

/// Reverse epsilon adjacency in compressed form.
fn epsilon_preds(nodes: &[Node]) -> (Vec<usize>, Vec<usize>) {
	let edges = |node: &Node| {
		let eps = node.op.is_epsilon() || matches!(node.op, Op::BackRef(_));
		let alt = if node.op == Op::Split { node.alt } else { None };
		eps.then_some(node.next).into_iter().chain(alt)
	};
	let mut pred_at = vec![0; nodes.len() + 1];
	for node in nodes {
		for to in edges(node) {
			pred_at[to + 1] += 1;
		}
	}
	for i in 0..nodes.len() {
		pred_at[i + 1] += pred_at[i];
	}
	let mut fill = pred_at.clone();
	let mut preds = vec![0; pred_at[nodes.len()]];
	for (from, node) in nodes.iter().enumerate() {
		for to in edges(node) {
			preds[fill[to]] = from;
			fill[to] += 1;
		}
	}
	(pred_at, preds)
}
