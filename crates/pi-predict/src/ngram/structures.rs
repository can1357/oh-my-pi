//! Data structures behind prefix-constrained ranking.
//!
//! Base word ids are lexicographic ranks, so "every word starting with
//! `prefix`" is one contiguous id range `[lo, hi)`. Range sums ([`Fenwick`]),
//! range top-k ([`MaxTree`]) and id-sorted follower lists ([`Followers`])
//! then answer prefix queries in O(log n) without per-prefix tables.

use std::hash::{BuildHasherDefault, Hasher};

/// Multiply-rotate hasher (`FxHash`) for small integer and string keys.
#[derive(Clone, Copy, Default)]
pub struct FxHasher {
	hash: u64,
}

const FX_SEED: u64 = 0x51_7c_c1_b7_27_22_0a_95;

impl FxHasher {
	#[inline]
	const fn mix(&mut self, word: u64) {
		self.hash = (self.hash.rotate_left(5) ^ word).wrapping_mul(FX_SEED);
	}
}

impl Hasher for FxHasher {
	#[inline]
	fn write(&mut self, bytes: &[u8]) {
		let (chunks, rest) = bytes.as_chunks::<8>();
		for chunk in chunks {
			self.mix(u64::from_le_bytes(*chunk));
		}
		if !rest.is_empty() {
			let mut word = [0u8; 8];
			word[..rest.len()].copy_from_slice(rest);
			self.mix(u64::from_le_bytes(word));
		}
	}

	#[inline]
	fn write_u8(&mut self, value: u8) {
		self.mix(u64::from(value));
	}

	#[inline]
	fn write_u32(&mut self, value: u32) {
		self.mix(u64::from(value));
	}

	#[inline]
	fn write_u64(&mut self, value: u64) {
		self.mix(value);
	}

	#[inline]
	fn write_usize(&mut self, value: usize) {
		self.mix(value as u64);
	}

	#[inline]
	fn finish(&self) -> u64 {
		self.hash
	}
}

/// `HashMap` with [`FxHasher`].
pub type FastMap<K, V> = std::collections::HashMap<K, V, BuildHasherDefault<FxHasher>>;

/// `FxHash` of a string (used by the vocabulary's open-addressing index).
#[inline]
pub fn hash_str(text: &str) -> u64 {
	let mut hasher = FxHasher::default();
	hasher.write(text.as_bytes());
	hasher.mix(text.len() as u64);
	hasher.finish()
}

/// Open-addressing hash table from `u64` keys to small `Copy` values
/// (linear probing, load ≤ 3/4, no deletion: rebuild to prune). 8 bytes of
/// key plus the value per slot instead of a boxed map entry.
#[derive(Clone)]
pub struct IdTable<V: Copy + Default> {
	keys:   Vec<u64>,
	values: Vec<V>,
	shift:  u32,
	len:    usize,
}

const EMPTY_KEY: u64 = u64::MAX;

impl<V: Copy + Default> IdTable<V> {
	/// Table sized for about `capacity` entries.
	pub fn with_capacity(capacity: usize) -> Self {
		let mut slots = 16usize;
		while slots * 3 < capacity * 4 {
			slots <<= 1;
		}
		Self {
			keys:   vec![EMPTY_KEY; slots],
			values: vec![V::default(); slots],
			shift:  64 - slots.trailing_zeros(),
			len:    0,
		}
	}

	/// Number of stored keys.
	pub const fn len(&self) -> usize {
		self.len
	}

	/// Heap bytes held by the table.
	pub const fn heap_bytes(&self) -> usize {
		self.keys.capacity() * 8 + self.values.capacity() * size_of::<V>()
	}

	#[inline]
	fn slot(&self, key: u64) -> usize {
		let mask = self.keys.len() - 1;
		let mut at = (key.wrapping_mul(0x9e37_79b9_7f4a_7c15) >> self.shift) as usize;
		loop {
			let stored = self.keys[at];
			if stored == key || stored == EMPTY_KEY {
				return at;
			}
			at = (at + 1) & mask;
		}
	}

	/// Value stored at `key`.
	#[inline]
	pub fn get(&self, key: u64) -> Option<V> {
		let at = self.slot(key);
		(self.keys[at] == key).then(|| self.values[at])
	}

	/// Mutable value at `key`, inserting `V::default()` first when absent.
	/// The flag is true when the key was inserted.
	pub fn entry(&mut self, key: u64) -> (&mut V, bool) {
		debug_assert_ne!(key, EMPTY_KEY);
		let mut at = self.slot(key);
		let fresh = self.keys[at] != key;
		if fresh {
			if (self.len + 1) * 4 > self.keys.len() * 3 {
				self.grow();
				at = self.slot(key);
			}
			self.keys[at] = key;
			self.values[at] = V::default();
			self.len += 1;
		}
		(&mut self.values[at], fresh)
	}

	/// Every `(key, value)` pair, in slot order.
	pub fn iter(&self) -> impl Iterator<Item = (u64, V)> + '_ {
		self
			.keys
			.iter()
			.zip(&self.values)
			.filter(|&(&key, _)| key != EMPTY_KEY)
			.map(|(&key, &value)| (key, value))
	}

	fn grow(&mut self) {
		let keys = std::mem::take(&mut self.keys);
		let values = std::mem::take(&mut self.values);
		let slots = keys.len() * 2;
		self.keys = vec![EMPTY_KEY; slots];
		self.values = vec![V::default(); slots];
		self.shift = 64 - slots.trailing_zeros();
		for (key, value) in keys.into_iter().zip(values) {
			if key != EMPTY_KEY {
				let at = self.slot(key);
				self.keys[at] = key;
				self.values[at] = value;
			}
		}
	}
}

/// Fenwick tree of float counts over base ids (prefix sums with point updates).
#[derive(Clone, Default)]
pub struct Fenwick {
	tree: Vec<f64>,
}

impl Fenwick {
	/// Build over `values` in O(n).
	pub fn new(values: impl ExactSizeIterator<Item = f64>) -> Self {
		let mut tree = Vec::with_capacity(values.len() + 1);
		tree.push(0.0);
		tree.extend(values);
		let n = tree.len() - 1;
		for i in 1..=n {
			let parent = i + i.isolate_lowest_one();
			if parent <= n {
				tree[parent] += tree[i];
			}
		}
		Self { tree }
	}

	/// Add `delta` at index `i`.
	pub fn add(&mut self, i: usize, delta: f64) {
		let mut j = i + 1;
		while j < self.tree.len() {
			self.tree[j] += delta;
			j += j.isolate_lowest_one();
		}
	}

	/// Sum over `[0, end)`.
	pub fn prefix(&self, end: usize) -> f64 {
		let mut sum = 0.0;
		let mut j = end;
		while j > 0 {
			sum += self.tree[j];
			j -= j.isolate_lowest_one();
		}
		sum
	}

	/// Heap bytes held by the tree.
	pub const fn heap_bytes(&self) -> usize {
		self.tree.capacity() * 8
	}
}

const NO_LEAF: u32 = u32::MAX;

/// Max segment tree over base ids: point updates and top-k inside a range.
#[derive(Clone, Default)]
pub struct MaxTree {
	values: Vec<f32>,
	size:   usize,
	/// Leaf id holding each subtree's max (`NO_LEAF` when empty).
	best:   Vec<u32>,
}

impl MaxTree {
	/// Build over `values` in O(n).
	pub fn new(values: Vec<f32>) -> Self {
		let size = values.len().next_power_of_two().max(1);
		let mut best = vec![NO_LEAF; 2 * size];
		for i in 0..values.len() {
			best[size + i] = i as u32;
		}
		let mut tree = Self { values, size, best };
		for node in (1..size).rev() {
			tree.best[node] = tree.pick(tree.best[2 * node], tree.best[2 * node + 1]);
		}
		tree
	}

	#[inline]
	fn pick(&self, a: u32, b: u32) -> u32 {
		if a == NO_LEAF {
			return b;
		}
		if b == NO_LEAF {
			return a;
		}
		if self.values[b as usize] > self.values[a as usize] {
			b
		} else {
			a
		}
	}

	/// Set leaf `i` to `value`.
	pub fn set(&mut self, i: usize, value: f32) {
		self.values[i] = value;
		let mut node = usize::midpoint(i, self.size);
		while node >= 1 {
			self.best[node] = self.pick(self.best[2 * node], self.best[2 * node + 1]);
			node >>= 1;
		}
	}

	#[inline]
	fn key(&self, node: u32) -> f32 {
		self.values[self.best[node as usize] as usize]
	}

	/// Append up to `k` ids of `[lo, hi)` to `out`, best first: best-first
	/// expansion from the O(log n) canonical nodes covering the range.
	pub fn top_k(&self, lo: usize, hi: usize, k: usize, heap: &mut Vec<u32>, out: &mut Vec<u32>) {
		if lo >= hi || k == 0 {
			return;
		}
		heap.clear();
		let (mut l, mut r) = (lo + self.size, hi + self.size);
		while l < r {
			if l & 1 == 1 {
				self.push(heap, l as u32);
				l += 1;
			}
			if r & 1 == 1 {
				r -= 1;
				self.push(heap, r as u32);
			}
			l >>= 1;
			r >>= 1;
		}
		let mut emitted = 0;
		while emitted < k {
			let Some(node) = self.pop(heap) else { break };
			if node as usize >= self.size {
				out.push(node - self.size as u32);
				emitted += 1;
			} else {
				self.push(heap, 2 * node);
				self.push(heap, 2 * node + 1);
			}
		}
	}

	fn push(&self, heap: &mut Vec<u32>, node: u32) {
		if self.best[node as usize] == NO_LEAF {
			return;
		}
		let value = self.key(node);
		let mut i = heap.len();
		heap.push(node);
		while i > 0 {
			let parent = (i - 1) / 2;
			if self.key(heap[parent]) >= value {
				break;
			}
			heap[i] = heap[parent];
			i = parent;
		}
		heap[i] = node;
	}

	fn pop(&self, heap: &mut Vec<u32>) -> Option<u32> {
		let top = *heap.first()?;
		let last = heap.pop()?;
		if heap.is_empty() {
			return Some(top);
		}
		let value = self.key(last);
		let mut i = 0;
		loop {
			let mut child = 2 * i + 1;
			if child >= heap.len() {
				break;
			}
			if child + 1 < heap.len() && self.key(heap[child + 1]) > self.key(heap[child]) {
				child += 1;
			}
			if self.key(heap[child]) <= value {
				break;
			}
			heap[i] = heap[child];
			i = child;
		}
		heap[i] = last;
		Some(top)
	}

	/// Heap bytes held by the tree.
	pub const fn heap_bytes(&self) -> usize {
		self.values.capacity() * 4 + self.best.capacity() * 4
	}
}

/// Growable follower list of one context word, sorted by word id so a
/// prefix maps to a contiguous slice.
#[derive(Clone, Default)]
pub struct Followers {
	/// Follower word ids, ascending.
	pub ids:    Vec<u32>,
	/// Weighted counts, parallel to `ids`.
	pub counts: Vec<f32>,
	/// Sum of `counts`.
	pub total:  f64,
}

impl Followers {
	/// First index whose id is `>= id`.
	#[inline]
	pub fn lower_bound(&self, id: u32) -> usize {
		self.ids.partition_point(|&x| x < id)
	}

	/// Add `weight` to `id`; true when `id` is a new follower.
	pub fn add(&mut self, id: u32, weight: f32) -> bool {
		let at = self.lower_bound(id);
		self.total += f64::from(weight);
		if self.ids.get(at) == Some(&id) {
			self.counts[at] += weight;
			false
		} else {
			self.ids.insert(at, id);
			self.counts.insert(at, weight);
			true
		}
	}

	/// Count of `id` (0 when absent).
	#[inline]
	pub fn count(&self, id: u32) -> f32 {
		let at = self.lower_bound(id);
		if self.ids.get(at) == Some(&id) {
			self.counts[at]
		} else {
			0.0
		}
	}

	/// Number of distinct followers.
	pub const fn types(&self) -> usize {
		self.ids.len()
	}

	/// Heap bytes held by the list.
	pub const fn heap_bytes(&self) -> usize {
		self.ids.capacity() * 4 + self.counts.capacity() * 4
	}
}
