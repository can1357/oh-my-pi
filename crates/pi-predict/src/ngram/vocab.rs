//! Word ↔ id interning with lexicographic base ids.
//!
//! Ids `< base_len()` are byte-order ranks, so a prefix is one contiguous id
//! range. Words interned later get appended "overflow" ids, kept in a sorted
//! side list so prefix lookups stay binary searches;
//! [`Vocab::compacted`] folds them back into the sorted base.

use super::structures::hash_str;

const NO_ID: u32 = u32::MAX;

/// Interned words with an open-addressing string index.
#[derive(Clone)]
pub struct Vocab {
	text:     String,
	ends:     Vec<u32>,
	base:     usize,
	/// Overflow ids sorted by word.
	overflow: Vec<u32>,
	/// Hash slots holding ids (`NO_ID` = empty).
	index:    Vec<u32>,
	shift:    u32,
}

impl Vocab {
	/// Vocabulary whose base is `sorted` (byte order, deduplicated).
	pub fn from_sorted<'a>(sorted: impl IntoIterator<Item = &'a str>) -> Self {
		let mut vocab = Self {
			text:     String::new(),
			ends:     Vec::new(),
			base:     0,
			overflow: Vec::new(),
			index:    vec![NO_ID; 16],
			shift:    60,
		};
		for word in sorted {
			debug_assert!(vocab.ends.is_empty() || vocab.word(vocab.ends.len() as u32 - 1) < word);
			vocab.push(word);
		}
		vocab.base = vocab.ends.len();
		vocab
	}

	fn push(&mut self, word: &str) -> u32 {
		let id = self.ends.len() as u32;
		self.text.push_str(word);
		self.ends.push(self.text.len() as u32);
		if (self.ends.len() + 1) * 4 > self.index.len() * 3 {
			self.rehash(self.index.len() * 2);
		} else {
			let slot = self.slot(word);
			self.index[slot] = id;
		}
		id
	}

	fn rehash(&mut self, slots: usize) {
		self.index = vec![NO_ID; slots];
		self.shift = 64 - slots.trailing_zeros();
		for id in 0..self.ends.len() as u32 {
			let slot = self.slot(self.word(id));
			self.index[slot] = id;
		}
	}

	/// Slot holding `word`, or the empty slot where it would go.
	#[inline]
	fn slot(&self, word: &str) -> usize {
		let mask = self.index.len() - 1;
		let mut at = (hash_str(word) >> self.shift) as usize;
		loop {
			let id = self.index[at];
			if id == NO_ID || self.word(id) == word {
				return at;
			}
			at = (at + 1) & mask;
		}
	}

	/// Number of words.
	pub const fn len(&self) -> usize {
		self.ends.len()
	}

	/// Number of sorted base words.
	pub const fn base_len(&self) -> usize {
		self.base
	}

	/// Number of overflow words.
	pub const fn overflow_len(&self) -> usize {
		self.overflow.len()
	}

	/// Word of `id`.
	#[inline]
	pub fn word(&self, id: u32) -> &str {
		let id = id as usize;
		let start = if id == 0 {
			0
		} else {
			self.ends[id - 1] as usize
		};
		&self.text[start..self.ends[id] as usize]
	}

	/// Id of `word`.
	#[inline]
	pub fn find(&self, word: &str) -> Option<u32> {
		let id = self.index[self.slot(word)];
		(id != NO_ID).then_some(id)
	}

	/// Id of `word`, appending it to the overflow region when new. The flag
	/// is true for a new word.
	pub fn intern(&mut self, word: &str) -> (u32, bool) {
		if let Some(id) = self.find(word) {
			return (id, false);
		}
		let id = self.push(word);
		let at = self
			.overflow
			.partition_point(|&other| self.word(other) < word);
		self.overflow.insert(at, id);
		(id, true)
	}

	/// Base id range `[lo, hi)` of the words starting with `prefix`.
	pub fn base_range(&self, prefix: &str) -> (usize, usize) {
		let (mut lo, mut hi) = (0, self.base);
		while lo < hi {
			let mid = usize::midpoint(lo, hi);
			if self.word(mid as u32) < prefix {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		let (mut a, mut b) = (lo, self.base);
		while a < b {
			let mid = usize::midpoint(a, b);
			if self.word(mid as u32).starts_with(prefix) {
				a = mid + 1;
			} else {
				b = mid;
			}
		}
		(lo, a)
	}

	/// Overflow ids of the words starting with `prefix`.
	pub fn overflow_range(&self, prefix: &str) -> &[u32] {
		let lo = self.overflow.partition_point(|&id| self.word(id) < prefix);
		let len = self.overflow[lo..].partition_point(|&id| self.word(id).starts_with(prefix));
		&self.overflow[lo..lo + len]
	}

	/// This vocabulary with every word in the sorted base, plus the
	/// old-id → new-id map.
	pub fn compacted(&self) -> (Self, Vec<u32>) {
		let mut remap = vec![0u32; self.len()];
		let mut next = Self::from_sorted(std::iter::empty());
		next.text.reserve(self.text.len());
		next.ends.reserve(self.len());
		let (mut a, mut b) = (0usize, 0usize);
		while a < self.base || b < self.overflow.len() {
			let take_base = b == self.overflow.len()
				|| (a < self.base && self.word(a as u32) < self.word(self.overflow[b]));
			let old = if take_base {
				a += 1;
				(a - 1) as u32
			} else {
				b += 1;
				self.overflow[b - 1]
			};
			remap[old as usize] = next.ends.len() as u32;
			next.text.push_str(self.word(old));
			next.ends.push(next.text.len() as u32);
		}
		next.base = next.ends.len();
		next.rehash((next.len() * 4 / 3 + 1).next_power_of_two().max(16));
		(next, remap)
	}

	/// Heap bytes held by the vocabulary.
	pub const fn heap_bytes(&self) -> usize {
		self.text.capacity()
			+ self.ends.capacity() * 4
			+ self.overflow.capacity() * 4
			+ self.index.capacity() * 4
	}
}
