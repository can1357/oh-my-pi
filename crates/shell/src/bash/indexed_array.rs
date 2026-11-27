//! Sparse indexed shell arrays shared across forked process images.
//!
//! The persistent vector shares unchanged elements when an image is cloned. An
//! append or in-place write copies only the path to its element; uncommon
//! middle inserts and removals rebuild the sequence after the edit position.

use std::{
	ops::{Index, IndexMut},
	sync::Arc,
};

use bstr::BString;
use serde::{Deserialize, Serialize};

use super::pvec::{self, Vector};

/// Sorted, sparse indexed elements; cloning shares the existing elements.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct IndexedArray(Vector<(i64, BString)>);

impl IndexedArray {
	/// Number of set elements.
	pub fn len(&self) -> usize {
		self.0.len()
	}

	/// Whether there are no set elements.
	pub const fn is_empty(&self) -> bool {
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
	pub fn iter(&self) -> pvec::Iter<'_, (i64, BString)> {
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
		self.0.push(item);
	}

	/// Insert at a sorted position, appending when it is the end.
	///
	/// # Panics
	/// `position` exceeds the number of elements.
	pub fn insert(&mut self, position: usize, item: (i64, BString)) {
		assert!(position <= self.len(), "insert position out of bounds");
		let rest = self.split_off(position);
		self.0.push(item);
		for item in rest {
			self.0.push_arc(item);
		}
	}

	/// Remove an element, preserving sorted order.
	///
	/// # Panics
	/// `position` does not name an element.
	pub fn remove(&mut self, position: usize) {
		assert!(position < self.len(), "remove position out of bounds");
		let rest = self.split_off(position);
		for item in rest.into_iter().skip(1) {
			self.0.push_arc(item);
		}
	}

	/// Detach the elements from `position` on, still shared with their copies.
	fn split_off(&mut self, position: usize) -> Vec<Arc<(i64, BString)>> {
		let rest: Vec<_> = (position..self.len())
			.filter_map(|at| self.0.get_arc(at).cloned())
			.collect();
		self.0.truncate(position);
		rest
	}

	/// Remove every element.
	pub fn clear(&mut self) {
		self.0.clear();
	}
}

impl From<Vec<(i64, BString)>> for IndexedArray {
	fn from(value: Vec<(i64, BString)>) -> Self {
		Self(value.into())
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

impl<'a> IntoIterator for &'a IndexedArray {
	type IntoIter = pvec::Iter<'a, (i64, BString)>;
	type Item = &'a (i64, BString);

	fn into_iter(self) -> Self::IntoIter {
		self.iter()
	}
}
