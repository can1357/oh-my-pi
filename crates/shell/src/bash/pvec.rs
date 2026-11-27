//! Persistent vector for forked shell images: a thread-safe, structurally
//! shared sequence.
//!
//! [`Vector`] is a 32-way bitmapped trie with a tail buffer, the same shape as
//! `rpds::VectorSync`. Cloning copies two pointers; a mutation on a shared
//! vector copies only the root-to-leaf path it touches (at most `log32 n`
//! nodes of 32 pointers, plus one 32-pointer leaf), so forks share every
//! untouched element.
//!
//! Each element sits behind its own `Arc`, as in rpds, so copying a shared
//! leaf copies pointers and never an element: an element keeps its address
//! across forks. `T: Clone` is needed only to write an element that another
//! vector still holds (`get_mut`) or to move one out by value (`pop`).
//!
//! The trie does not support inserting or removing in the middle; use
//! `push`/`pop` at the end and `get_mut`/`IndexMut` in place.

#![allow(dead_code, reason = "a general-purpose API; the shell uses a subset")]

use std::{
	fmt,
	iter::FusedIterator,
	ops::{Index, IndexMut},
	sync::Arc,
};

const BITS: u32 = 5;
const WIDTH: usize = 1 << BITS;
const MASK: usize = WIDTH - 1;

enum Node<T> {
	/// Interior node; children sit one level (`BITS`) lower. Level 0 is a leaf.
	Branch(Vec<Arc<Self>>),
	/// Up to `WIDTH` elements; every leaf inside the trie is full.
	Leaf(Vec<Arc<T>>),
}

impl<T> Clone for Node<T> {
	fn clone(&self) -> Self {
		match self {
			Self::Branch(kids) => Self::Branch(kids.clone()),
			Self::Leaf(items) => Self::Leaf(items.clone()),
		}
	}
}

impl<T> Node<T> {
	fn branch(&self) -> &[Arc<Self>] {
		match self {
			Self::Branch(kids) => kids,
			Self::Leaf(_) => unreachable!("leaf where a branch was expected"),
		}
	}

	fn branch_mut(&mut self) -> &mut Vec<Arc<Self>> {
		match self {
			Self::Branch(kids) => kids,
			Self::Leaf(_) => unreachable!("leaf where a branch was expected"),
		}
	}

	fn leaf(&self) -> &[Arc<T>] {
		match self {
			Self::Leaf(items) => items,
			Self::Branch(_) => unreachable!("branch where a leaf was expected"),
		}
	}

	fn leaf_mut(&mut self) -> &mut Vec<Arc<T>> {
		match self {
			Self::Leaf(items) => items,
			Self::Branch(_) => unreachable!("branch where a leaf was expected"),
		}
	}
}

/// Wrap `leaf` in single-child branches until it sits at `level`.
fn new_path<T>(level: u32, leaf: Arc<Node<T>>) -> Arc<Node<T>> {
	if level == 0 {
		leaf
	} else {
		Arc::new(Node::Branch(vec![new_path(level - BITS, leaf)]))
	}
}

/// Attach a full leaf as the rightmost leaf below `node`. `len` is the element
/// count including that leaf.
fn push_leaf<T>(node: &mut Arc<Node<T>>, level: u32, len: usize, leaf: Arc<Node<T>>) {
	let kids = Arc::make_mut(node).branch_mut();
	if level == BITS {
		kids.push(leaf);
		return;
	}
	let sub = ((len - 1) >> level) & MASK;
	if sub < kids.len() {
		push_leaf(&mut kids[sub], level - BITS, len, leaf);
	} else {
		kids.push(new_path(level - BITS, leaf));
	}
}

/// Detach the rightmost leaf below `node`, pruning branches left empty.
fn pop_leaf<T>(node: &mut Arc<Node<T>>, level: u32) -> Arc<Node<T>> {
	let kids = Arc::make_mut(node).branch_mut();
	if level == BITS {
		return kids.pop().expect("non-empty branch");
	}
	let last = kids.last_mut().expect("non-empty branch");
	let leaf = pop_leaf(last, level - BITS);
	if last.branch().is_empty() {
		kids.pop();
	}
	leaf
}

fn get_mut_in<T>(node: &mut Arc<Node<T>>, level: u32, index: usize) -> &mut Arc<T> {
	let node = Arc::make_mut(node);
	if level == 0 {
		&mut node.leaf_mut()[index & MASK]
	} else {
		get_mut_in(&mut node.branch_mut()[(index >> level) & MASK], level - BITS, index)
	}
}

/// Header of a non-empty [`Vector`]; kept behind one pointer so the vector
/// itself is pointer-sized (and `None` when empty).
/// Invariants: `tail` is `Some` and non-empty
/// exactly when `len > 0`; `root` is `Some` exactly when `len > WIDTH`.
struct Trie<T> {
	len:   usize,
	/// Level of `root`; at least `BITS`.
	shift: u32,
	root:  Option<Arc<Node<T>>>,
	tail:  Option<Arc<Node<T>>>,
}

impl<T> Trie<T> {
	const fn new() -> Self {
		Self { len: 0, shift: BITS, root: None, tail: None }
	}

	/// Number of elements.
	const fn len(&self) -> usize {
		self.len
	}

	/// Whether there are no elements.
	const fn is_empty(&self) -> bool {
		self.len == 0
	}

	/// Remove every element.
	fn clear(&mut self) {
		*self = Self::new();
	}

	const fn tail_offset(&self) -> usize {
		if self.len == 0 {
			0
		} else {
			((self.len - 1) >> BITS) << BITS
		}
	}

	/// Element at `index`.
	fn get(&self, index: usize) -> Option<&Arc<T>> {
		if index >= self.len {
			return None;
		}
		if index >= self.tail_offset() {
			return self.tail.as_deref()?.leaf().get(index & MASK);
		}
		let mut node = self.root.as_deref()?;
		let mut level = self.shift;
		while level > 0 {
			node = node.branch().get((index >> level) & MASK)?;
			level -= BITS;
		}
		node.leaf().get(index & MASK)
	}
}

impl<T> Trie<T> {
	/// Mutable element at `index`; copies the shared path leading to it.
	fn get_mut(&mut self, index: usize) -> Option<&mut Arc<T>> {
		if index >= self.len {
			return None;
		}
		if index >= self.tail_offset() {
			let tail = self.tail.as_mut()?;
			return Arc::make_mut(tail).leaf_mut().get_mut(index & MASK);
		}
		let root = self.root.as_mut()?;
		Some(get_mut_in(root, self.shift, index))
	}

	/// Append an element.
	fn push(&mut self, value: Arc<T>) {
		if let Some(tail) = &mut self.tail
			&& tail.leaf().len() < WIDTH
		{
			Arc::make_mut(tail).leaf_mut().push(value);
		} else {
			self.flush_tail();
			let mut leaf = Vec::with_capacity(WIDTH);
			leaf.push(value);
			self.tail = Some(Arc::new(Node::Leaf(leaf)));
		}
		self.len += 1;
	}

	/// Move the full tail into the trie, growing it a level when it is full.
	fn flush_tail(&mut self) {
		let Some(tail) = self.tail.take() else { return };
		let Some(mut root) = self.root.take() else {
			self.root = Some(Arc::new(Node::Branch(vec![tail])));
			self.shift = BITS;
			return;
		};
		if (self.len >> BITS) > (1 << self.shift) {
			root = Arc::new(Node::Branch(vec![root, new_path(self.shift, tail)]));
			self.shift += BITS;
		} else {
			push_leaf(&mut root, self.shift, self.len, tail);
		}
		self.root = Some(root);
	}

	/// Remove and return the last element.
	fn pop(&mut self) -> Option<Arc<T>> {
		let tail = self.tail.as_mut()?;
		let value = Arc::make_mut(tail).leaf_mut().pop()?;
		self.len -= 1;
		if tail.leaf().is_empty() {
			self.tail = self.take_last_leaf();
		}
		Some(value)
	}

	/// Detach the trie's rightmost leaf so it becomes the new tail.
	fn take_last_leaf(&mut self) -> Option<Arc<Node<T>>> {
		let root = self.root.as_mut()?;
		let leaf = pop_leaf(root, self.shift);
		let kids = root.branch();
		if kids.is_empty() {
			self.root = None;
			self.shift = BITS;
		} else if self.shift > BITS && kids.len() == 1 {
			let only = Arc::clone(&kids[0]);
			*root = only;
			self.shift -= BITS;
		}
		Some(leaf)
	}
}

impl<T> Clone for Trie<T> {
	fn clone(&self) -> Self {
		Self {
			len:   self.len,
			shift: self.shift,
			root:  self.root.clone(),
			tail:  self.tail.clone(),
		}
	}
}

/// Persistent vector with O(1) clone and copy-on-write mutation.
///
/// Pointer-sized; an empty vector allocates nothing.
pub struct Vector<T>(Option<Arc<Trie<T>>>);

impl<T> Vector<T> {
	/// Empty vector.
	pub const fn new() -> Self {
		Self(None)
	}

	/// Number of elements.
	pub fn len(&self) -> usize {
		self.0.as_deref().map_or(0, |trie| trie.len)
	}

	/// Whether there are no elements.
	pub const fn is_empty(&self) -> bool {
		self.0.is_none()
	}

	/// Remove every element.
	pub fn clear(&mut self) {
		self.0 = None;
	}

	/// Element at `index`.
	pub fn get(&self, index: usize) -> Option<&T> {
		self.get_arc(index).map(|item| &**item)
	}

	/// Shared handle to the element at `index`; lets callers move an element
	/// into another vector without copying it.
	pub fn get_arc(&self, index: usize) -> Option<&Arc<T>> {
		self.0.as_deref()?.get(index)
	}

	/// First element.
	pub fn first(&self) -> Option<&T> {
		self.get(0)
	}

	/// Last element.
	pub fn last(&self) -> Option<&T> {
		self.len().checked_sub(1).and_then(|index| self.get(index))
	}

	/// Elements in order.
	pub fn iter(&self) -> Iter<'_, T> {
		Iter { vec: self, front: 0, back: self.len() }
	}
}

impl<T> Vector<T> {
	/// Append an element.
	pub fn push(&mut self, value: T) {
		self.push_arc(Arc::new(value));
	}

	/// Append an already shared element.
	pub fn push_arc(&mut self, value: Arc<T>) {
		Arc::make_mut(self.0.get_or_insert_with(|| Arc::new(Trie::new()))).push(value);
	}

	/// Remove and return the shared handle to the last element.
	pub fn pop_arc(&mut self) -> Option<Arc<T>> {
		let trie = Arc::make_mut(self.0.as_mut()?);
		let value = trie.pop();
		if trie.len == 0 {
			self.0 = None;
		}
		value
	}

	/// Shorten to `len` elements; does nothing when already shorter.
	pub fn truncate(&mut self, len: usize) {
		while self.len() > len {
			self.pop_arc();
		}
	}
}

impl<T: Clone> Vector<T> {
	/// Mutable element at `index`. Copies the shared path leading to it, and
	/// the element itself when another vector still holds it.
	pub fn get_mut(&mut self, index: usize) -> Option<&mut T> {
		let item = Arc::make_mut(self.0.as_mut()?).get_mut(index)?;
		Some(Arc::make_mut(item))
	}

	/// Remove and return the last element.
	pub fn pop(&mut self) -> Option<T> {
		self.pop_arc().map(Arc::unwrap_or_clone)
	}
}

impl<T> Default for Vector<T> {
	fn default() -> Self {
		Self::new()
	}
}

impl<T> Clone for Vector<T> {
	fn clone(&self) -> Self {
		Self(self.0.clone())
	}
}

impl<T: fmt::Debug> fmt::Debug for Vector<T> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_list().entries(self).finish()
	}
}

impl<T: PartialEq> PartialEq for Vector<T> {
	fn eq(&self, other: &Self) -> bool {
		self.len() == other.len() && self.iter().eq(other.iter())
	}
}

impl<T: Eq> Eq for Vector<T> {}

impl<T> Index<usize> for Vector<T> {
	type Output = T;

	fn index(&self, index: usize) -> &T {
		self.get(index).expect("index out of bounds")
	}
}

impl<T: Clone> IndexMut<usize> for Vector<T> {
	fn index_mut(&mut self, index: usize) -> &mut T {
		self.get_mut(index).expect("index out of bounds")
	}
}

impl<T> FromIterator<T> for Vector<T> {
	fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Self {
		let mut vec = Self::new();
		vec.extend(iter);
		vec
	}
}

impl<T> From<Vec<T>> for Vector<T> {
	fn from(value: Vec<T>) -> Self {
		value.into_iter().collect()
	}
}

impl<T> Extend<T> for Vector<T> {
	fn extend<I: IntoIterator<Item = T>>(&mut self, iter: I) {
		for value in iter {
			self.push(value);
		}
	}
}

impl<'a, T> IntoIterator for &'a Vector<T> {
	type IntoIter = Iter<'a, T>;
	type Item = &'a T;

	fn into_iter(self) -> Iter<'a, T> {
		self.iter()
	}
}

/// Borrowing iterator over a [`Vector`].
pub struct Iter<'a, T> {
	vec:   &'a Vector<T>,
	front: usize,
	back:  usize,
}

impl<T> Clone for Iter<'_, T> {
	fn clone(&self) -> Self {
		Self { vec: self.vec, front: self.front, back: self.back }
	}
}

impl<'a, T> Iterator for Iter<'a, T> {
	type Item = &'a T;

	fn next(&mut self) -> Option<&'a T> {
		if self.front >= self.back {
			return None;
		}
		let item = self.vec.get(self.front);
		self.front += 1;
		item
	}

	fn size_hint(&self) -> (usize, Option<usize>) {
		let left = self.back - self.front;
		(left, Some(left))
	}
}

impl<T> DoubleEndedIterator for Iter<'_, T> {
	fn next_back(&mut self) -> Option<Self::Item> {
		if self.front >= self.back {
			return None;
		}
		self.back -= 1;
		self.vec.get(self.back)
	}
}

impl<T> ExactSizeIterator for Iter<'_, T> {}
impl<T> FusedIterator for Iter<'_, T> {}

mod serde_impl {
	use serde::{Deserialize, Deserializer, Serialize, Serializer};

	use super::Vector;

	impl<T: Serialize> Serialize for Vector<T> {
		fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
			serializer.collect_seq(self)
		}
	}

	impl<'de, T: Deserialize<'de>> Deserialize<'de> for Vector<T> {
		fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
			Vec::<T>::deserialize(deserializer).map(Self::from)
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	impl<T> Vector<T> {
		fn root(&self) -> &Arc<Node<T>> {
			self.0.as_ref().unwrap().root.as_ref().unwrap()
		}
	}

	fn assert_matches(vec: &Vector<u64>, model: &[u64]) {
		assert_eq!(vec.len(), model.len());
		assert!(vec.iter().eq(model.iter()));
		assert!(vec.iter().rev().eq(model.iter().rev()));
		assert_eq!(vec.first(), model.first());
		assert_eq!(vec.last(), model.last());
		assert_eq!(vec.get(model.len()), None);
	}

	/// Walks past every depth change (1024, 32768 elements) in both
	/// directions; a wrong trie index shows up as a wrong element.
	#[test]
	fn push_pop_cross_every_depth_boundary() {
		const N: u64 = 40_000;
		let mut vec = Vector::new();
		for i in 0..N {
			vec.push(i * 7);
			if i % 1024 == 0 || i % 1024 == 1023 || i % 32 == 0 {
				assert_eq!(vec[i as usize], i * 7);
				assert_eq!(vec[0], 0);
			}
		}
		assert_eq!(vec.len(), N as usize);
		assert!(vec.iter().copied().eq((0..N).map(|i| i * 7)));
		for i in (0..N).rev() {
			assert_eq!(vec.pop(), Some(i * 7));
			if i % 1024 == 0 || i % 1024 == 1023 {
				assert_eq!(vec.last().copied(), i.checked_sub(1).map(|j| j * 7));
			}
		}
		assert_eq!(vec.pop(), None);
		assert!(vec.0.is_none());
	}

	/// Forks must never observe each other's pushes, pops or in-place writes,
	/// while an untouched fork keeps sharing its leaves with the original.
	#[test]
	fn forks_are_isolated_under_random_edits() {
		let mut state = 0x9e37_79b9_7f4a_7c15_u64;
		let mut next = move || {
			state ^= state << 13;
			state ^= state >> 7;
			state ^= state << 17;
			state
		};
		let mut vec = Vector::new();
		let mut model: Vec<u64> = Vec::new();
		let mut snapshots: Vec<(Vector<u64>, Vec<u64>)> = Vec::new();
		for step in 0..30_000_u64 {
			match next() % 8 {
				0..=3 => {
					vec.push(step);
					model.push(step);
				},
				4 | 5 => assert_eq!(vec.pop(), model.pop()),
				_ if !model.is_empty() => {
					let at = next() as usize % model.len();
					vec[at] = step;
					model[at] = step;
				},
				_ => {},
			}
			if step % 997 == 0 {
				snapshots.push((vec.clone(), model.clone()));
			}
			// Grow so the run reaches multi-level tries before shrinking.
			if step == 15_000 {
				for i in 0..20_000 {
					vec.push(i);
					model.push(i);
				}
			}
		}
		assert_matches(&vec, &model);
		for (snap, expected) in &snapshots {
			assert_matches(snap, expected);
		}
	}

	#[test]
	fn clone_shares_leaves_until_written() {
		let a: Vector<u64> = (0..100).collect();
		let mut b = a.clone();
		assert!(Arc::ptr_eq(a.root(), b.root()));
		b[3] = 999;
		assert_eq!(a[3], 3);
		assert_eq!(b[3], 999);
		// Only the written path was copied.
		let (ra, rb) = (a.root(), b.root());
		assert!(!Arc::ptr_eq(ra, rb));
		assert!(Arc::ptr_eq(&ra.branch()[1], &rb.branch()[1]));
	}

	#[test]
	fn truncate_and_eq() {
		let mut vec: Vector<u64> = (0..2000).collect();
		vec.truncate(33);
		assert_eq!(vec, (0..33).collect());
		vec.truncate(500);
		assert_eq!(vec.len(), 33);
	}
}
