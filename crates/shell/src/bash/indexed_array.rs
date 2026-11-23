//! Sparse indexed shell arrays shared across forked process images.
//!
//! The vector trie shares unchanged elements when an image is cloned. An
//! append copies only the path to its new element; uncommon middle inserts
//! and removals rebuild the sorted sequence.

use std::ops::{Index, IndexMut};

use bstr::BString;
use rpds::VectorSync;
use serde::{Deserialize, Serialize};

/// Sorted, sparse indexed elements; cloning shares the existing elements.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct IndexedArray(VectorSync<(i64, BString)>);

impl IndexedArray {
	/// Number of set elements.
	pub fn len(&self) -> usize {
		self.0.len()
	}

	/// Whether there are no set elements.
	pub fn is_empty(&self) -> bool {
		self.0.is_empty()
	}

	/// First set element.
	pub fn first(&self) -> Option<&(i64, BString)> {
		self.0.first()
	}

	/// Last set element.
	pub fn last(&self) -> Option<&(i64, BString)> {
		self.0.last()
	}

	/// Element at a position in index order.
	pub fn get(&self, position: usize) -> Option<&(i64, BString)> {
		self.0.get(position)
	}

	/// Elements in ascending index order.
	pub fn iter(&self) -> impl DoubleEndedIterator<Item = &(i64, BString)> + ExactSizeIterator {
		self.0.iter()
	}

	/// Locate an index in the sorted sequence.
	pub fn position(&self, index: i64) -> Result<usize, usize> {
		let (mut lo, mut hi) = (0, self.len());
		while lo < hi {
			let mid = lo.midpoint(hi);
			if self.0[mid].0 < index {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		if lo < self.len() && self.0[lo].0 == index {
			Ok(lo)
		} else {
			Err(lo)
		}
	}

	/// Append an element greater than every current index.
	pub fn push(&mut self, item: (i64, BString)) {
		self.0.push_back_mut(item);
	}

	/// Insert at a sorted position, appending when it is the end.
	///
	/// # Panics
	/// `position` exceeds the number of elements.
	pub fn insert(&mut self, position: usize, item: (i64, BString)) {
		if position == self.len() {
			self.push(item);
		} else {
			let mut values: Vec<_> = self.iter().cloned().collect();
			values.insert(position, item);
			*self = values.into();
		}
	}

	/// Remove an element, preserving sorted order.
	///
	/// # Panics
	/// `position` does not name an element.
	pub fn remove(&mut self, position: usize) {
		if position == self.len() - 1 {
			self.0.drop_last_mut();
		} else {
			let mut values: Vec<_> = self.iter().cloned().collect();
			values.remove(position);
			*self = values.into();
		}
	}

	/// Remove every element.
	pub fn clear(&mut self) {
		*self = Self::default();
	}
}

impl From<Vec<(i64, BString)>> for IndexedArray {
	fn from(value: Vec<(i64, BString)>) -> Self {
		Self(value.into_iter().collect())
	}
}

impl FromIterator<(i64, BString)> for IndexedArray {
	fn from_iter<I: IntoIterator<Item = (i64, BString)>>(iter: I) -> Self {
		Self(iter.into_iter().collect())
	}
}

impl Extend<(i64, BString)> for IndexedArray {
	fn extend<I: IntoIterator<Item = (i64, BString)>>(&mut self, iter: I) {
		self.0.extend(iter);
	}
}

impl Index<usize> for IndexedArray {
	type Output = (i64, BString);

	fn index(&self, index: usize) -> &Self::Output {
		&self.0[index]
	}
}

impl IndexMut<usize> for IndexedArray {
	fn index_mut(&mut self, index: usize) -> &mut Self::Output {
		&mut self.0[index]
	}
}
