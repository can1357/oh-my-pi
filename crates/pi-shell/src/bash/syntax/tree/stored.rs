//! The stored form of a [`Tree`] (a deferred function body, a parsed
//! definition, a trace archive): the text, then each node with its
//! children inline. A node's children start where the previous nodes'
//! ended, so their offset into [`Tree::kids`] is not stored; loading lays
//! the children out in node order.
//!
//! A node is a head byte (its kind, and which of `flags`, `x` and `c` are
//! not zero: they rarely are, so zeros are left out), `id`, `lo`, its span
//! length, the non-zero fields, then each child as its distance back from
//! the node (zigzag; 0 is [`NONE`]), which stays small where a child's
//! index would not.

use core::fmt;

use serde::{
	Deserialize, Deserializer, Serialize, Serializer,
	de::{self, DeserializeSeed, SeqAccess, Visitor, value::U32Deserializer},
	ser::{SerializeSeq, SerializeTuple},
};

use super::{K, NONE, Node, Tree};

/// Head bits above the kind: `flags`, `x` and `c` follow.
const FLAGS: u8 = 1 << 5;
const X: u8 = 1 << 6;
const C: u8 = 1 << 7;
const KIND: u8 = FLAGS - 1;
const _: () = assert!(K::Text as u8 <= KIND, "node kinds outgrew the head byte");

/// Fields of a stored node besides the optional ones: head, `id`, `lo`,
/// length and children.
const NODE_FIELDS: usize = 5;

/// Child `kid` of node `at`, stored.
fn kid_code(at: usize, kid: u32) -> u64 {
	if kid == NONE {
		return 0;
	}
	let d = at as i64 - i64::from(kid);
	((d << 1) ^ (d >> 63)) as u64
}

/// [`kid_code`] reversed; `None` for a code naming no node.
fn kid_of(at: usize, code: u64) -> Option<u32> {
	if code == 0 {
		return Some(NONE);
	}
	let d = (code >> 1) as i64 ^ -((code & 1) as i64);
	u32::try_from(at as i64 - d).ok()
}

impl Serialize for Tree {
	fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
		let mut t = s.serialize_tuple(2)?;
		t.serialize_element(&self.text)?;
		t.serialize_element(&Nodes(self))?;
		t.end()
	}
}

/// The nodes of a tree, each with its children.
struct Nodes<'a>(&'a Tree);

impl Serialize for Nodes<'_> {
	fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
		let mut seq = s.serialize_seq(Some(self.0.nodes.len()))?;
		for at in 0..self.0.nodes.len() {
			seq.serialize_element(&Stored(self.0, at))?;
		}
		seq.end()
	}
}

/// Node `.1` of tree `.0`.
struct Stored<'a>(&'a Tree, usize);

impl Serialize for Stored<'_> {
	fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
		let n = &self.0.nodes[self.1];
		let head = n.kind as u8
			| if n.flags != 0 { FLAGS } else { 0 }
			| if n.x != 0 { X } else { 0 }
			| if n.c != 0 { C } else { 0 };
		let mut t = s.serialize_tuple(NODE_FIELDS + (head & !KIND).count_ones() as usize)?;
		t.serialize_element(&head)?;
		t.serialize_element(&n.id)?;
		t.serialize_element(&n.lo)?;
		t.serialize_element(&n.hi.wrapping_sub(n.lo))?;
		if head & FLAGS != 0 {
			t.serialize_element(&n.flags)?;
		}
		if head & X != 0 {
			t.serialize_element(&n.x)?;
		}
		if head & C != 0 {
			t.serialize_element(&n.c)?;
		}
		t.serialize_element(&Kids(self.0, self.1))?;
		t.end()
	}
}

/// The children of node `.1` of tree `.0`.
struct Kids<'a>(&'a Tree, usize);

impl Serialize for Kids<'_> {
	fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
		let n = &self.0.nodes[self.1];
		let kids = &self.0.kids[n.a as usize..(n.a + n.b) as usize];
		let mut seq = s.serialize_seq(Some(kids.len()))?;
		for &k in kids {
			seq.serialize_element(&kid_code(self.1, k))?;
		}
		seq.end()
	}
}

impl<'de> Deserialize<'de> for Tree {
	fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
		d.deserialize_tuple(2, TreeVisitor)
	}
}

struct TreeVisitor;

impl<'de> Visitor<'de> for TreeVisitor {
	type Value = Tree;

	fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("a stored syntax tree")
	}

	fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Tree, A::Error> {
		let text = seq
			.next_element()?
			.ok_or_else(|| de::Error::invalid_length(0, &self))?;
		let mut tree = Tree { text, ..Tree::default() };
		seq.next_element_seed(NodesSeed(&mut tree))?
			.ok_or_else(|| de::Error::invalid_length(1, &self))?;
		// A child may follow its parent, so indices are checked once all
		// nodes are in: a corrupt tree is an error here, not a panic on use.
		let n = tree.nodes.len() as u32;
		if tree.kids.iter().any(|&k| k != NONE && k >= n) {
			return Err(de::Error::custom("a stored syntax node's child is out of range"));
		}
		Ok(tree)
	}
}

/// Loads the nodes into a tree, appending each one's children to its kids.
struct NodesSeed<'a>(&'a mut Tree);

impl<'de> DeserializeSeed<'de> for NodesSeed<'_> {
	type Value = ();

	fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
		d.deserialize_seq(self)
	}
}

impl<'de> Visitor<'de> for NodesSeed<'_> {
	type Value = ();

	fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("the nodes of a stored syntax tree")
	}

	fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
		if let Some(n) = seq.size_hint() {
			self.0.nodes.reserve(n);
		}
		while seq.next_element_seed(NodeSeed(&mut *self.0))?.is_some() {}
		Ok(())
	}
}

/// One node and its children.
struct NodeSeed<'a>(&'a mut Tree);

impl<'de> DeserializeSeed<'de> for NodeSeed<'_> {
	type Value = ();

	fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
		// At most: every optional field present.
		d.deserialize_tuple(NODE_FIELDS + 3, self)
	}
}

impl<'de> Visitor<'de> for NodeSeed<'_> {
	type Value = ();

	fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("a stored syntax node")
	}

	fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
		let mut i = 0;
		macro_rules! next {
			() => {{
				i += 1;
				seq.next_element()?
					.ok_or_else(|| de::Error::invalid_length(i - 1, &"a stored syntax node"))?
			}};
			($bit:expr, $head:expr) => {
				if $head & $bit != 0 {
					next!()
				} else {
					0
				}
			};
		}
		let head: u8 = next!();
		let kind = K::deserialize(U32Deserializer::<A::Error>::new(u32::from(head & KIND)))?;
		let id: u32 = next!();
		let lo: u32 = next!();
		let len: u32 = next!();
		let flags: u8 = next!(FLAGS, head);
		let x: u16 = next!(X, head);
		let c: u32 = next!(C, head);
		let tree = self.0;
		let at = tree.nodes.len();
		let a = tree.kids.len() as u32;
		seq.next_element_seed(KidsSeed { kids: &mut tree.kids, at })?
			.ok_or_else(|| de::Error::invalid_length(i, &"a stored syntax node"))?;
		let b = tree.kids.len() as u32 - a;
		tree
			.nodes
			.push(Node { kind, flags, x, id, lo, hi: lo.wrapping_add(len), a, b, c });
		Ok(())
	}
}

/// The children of node `at`, appended to the tree's kids.
struct KidsSeed<'a> {
	kids: &'a mut Vec<u32>,
	at:   usize,
}

impl<'de> DeserializeSeed<'de> for KidsSeed<'_> {
	type Value = ();

	fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
		d.deserialize_seq(self)
	}
}

impl<'de> Visitor<'de> for KidsSeed<'_> {
	type Value = ();

	fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("the children of a stored syntax node")
	}

	fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
		while let Some(code) = seq.next_element::<u64>()? {
			let kid = kid_of(self.at, code)
				.ok_or_else(|| de::Error::custom("a stored syntax node's child is not a node index"))?;
			self.kids.push(kid);
		}
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::{K, Tree};

	#[test]
	fn a_child_past_the_last_node_is_a_load_error() {
		// One `Word` node (head: kind, no optional fields; id, lo, length)
		// whose child code is zigzag(0 - 7): node 7 of a one-node tree.
		let node = (K::Word as u8, 0u32, 0u32, 0u32, vec![13u64]);
		let bytes = postcard::to_stdvec(&(Vec::<u8>::new(), vec![node])).unwrap();
		assert!(postcard::from_bytes::<Tree>(&bytes).is_err());
		// Without that child the same node loads.
		let ok = (K::Word as u8, 0u32, 0u32, 0u32, Vec::<u64>::new());
		let bytes = postcard::to_stdvec(&(Vec::<u8>::new(), vec![ok])).unwrap();
		assert_eq!(postcard::from_bytes::<Tree>(&bytes).unwrap().nodes.len(), 1);
	}
}
