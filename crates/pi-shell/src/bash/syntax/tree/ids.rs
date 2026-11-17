//! Node ids ([`NodeId`](crate::bash::syntax::span::NodeId)): numbered once
//! a command is complete, since the lexer's lookahead builds words before
//! the command that holds them.

use super::{
	K, NONE, Node, Tree,
	command::{ARM_BODY, ARM_PATTERNS, CMD_PAYLOAD, CMD_REDIRS, FOR_BODY, FOR_WORDS, HAS_WORDS},
};

impl Tree {
	/// Number the id-carrying nodes under `root` in preorder (and-or lists,
	/// pipelines, commands, assignments, words; `for` words before the
	/// body, `case` patterns before the arm's body); the count.
	pub fn assign_ids(&mut self, root: u32) -> u32 {
		let (nodes, kids, _) = self.walk_parts();
		let mut w = Ids { nodes, kids, next: 0 };
		w.any(root);
		w.next
	}
}

/// The id walk of [`Tree::assign_ids`]: the common shapes (lists down to
/// words and literal parts) by kind, so the walk's branches stay
/// predictable; any other node through [`Ids::any`].
struct Ids<'a> {
	nodes: &'a mut [Node],
	kids:  &'a [u32],
	next:  u32,
}

impl<'a> Ids<'a> {
	/// The children of `i` (borrowed from the tree, not from the walk).
	fn run(&self, i: u32) -> &'a [u32] {
		let kids: &'a [u32] = self.kids;
		let n = &self.nodes[i as usize];
		&kids[n.a as usize..(n.a + n.b) as usize]
	}

	const fn number(&mut self, i: u32) {
		self.nodes[i as usize].id = self.next;
		self.next += 1;
	}

	fn list(&mut self, l: u32) {
		for &item in self.run(l) {
			let ao = self.run(item)[0];
			self.and_or(ao);
		}
	}

	fn and_or(&mut self, ao: u32) {
		self.number(ao);
		for &p in self.run(ao) {
			self.number(p);
			for &c in self.run(p) {
				self.command(c);
			}
		}
	}

	fn command(&mut self, c: u32) {
		self.number(c);
		let run = self.run(c);
		let payload = run[CMD_PAYLOAD];
		if self.nodes[payload as usize].kind == K::Simple {
			for &x in self.run(payload) {
				if self.nodes[x as usize].kind == K::Word {
					self.word(x);
				} else {
					self.any(x);
				}
			}
		} else {
			self.any(payload);
		}
		for &r in &run[CMD_REDIRS..] {
			self.any(r);
		}
	}

	fn word(&mut self, w: u32) {
		self.number(w);
		for &p in self.run(w) {
			// Literal parts have no children.
			if self.nodes[p as usize].b != 0 {
				self.any(p);
			}
		}
	}

	/// Any node: number it if it carries an id, then its children in walk
	/// order.
	fn any(&mut self, i: u32) {
		if i == NONE {
			return;
		}
		let n = self.nodes[i as usize];
		match n.kind {
			K::List => return self.list(i),
			K::AndOr => return self.and_or(i),
			K::Command => return self.command(i),
			K::Word => return self.word(i),
			K::Pipeline | K::Assign => self.number(i),
			// Texts, names and arithmetic carry no ids.
			K::Text | K::Name | K::Arith => return,
			_ => {},
		}
		let run = self.run(i);
		match n.kind {
			K::For => {
				if n.flags & HAS_WORDS != 0 {
					self.any(run[FOR_WORDS]);
				}
				self.any(run[FOR_BODY]);
			},
			K::CaseArm => {
				for &p in &run[ARM_PATTERNS..] {
					self.any(p);
				}
				self.any(run[ARM_BODY]);
			},
			_ => {
				for &k in run {
					self.any(k);
				}
			},
		}
	}
}
