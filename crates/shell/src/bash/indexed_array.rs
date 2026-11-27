//! Sparse indexed shell arrays shared across forked process images.
//!
//! Cloning an image shares the element list; the first write to a shared copy
//! clones the list of element pointers (copy-on-write), never the elements,
//! so a fork keeps the very elements its parent appends after.

use std::{
	ops::{Index, IndexMut},
	sync::Arc,
};

use bstr::BString;
use serde::{Deserialize, Serialize};

/// Sorted, sparse indexed elements; cloning shares the existing elements.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct IndexedArray(Arc<Vec<Arc<(i64, BString)>>>);

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
		self.0.first().map(|item| &**item)
	}

	/// Last set element.
	pub fn last(&self) -> Option<&(i64, BString)> {
		self.0.last().map(|item| &**item)
	}

	/// Element at a position in index order.
	pub fn get(&self, position: usize) -> Option<&(i64, BString)> {
		self.0.get(position).map(|item| &**item)
	}

	/// Elements in ascending index order.
	pub fn iter(&self) -> impl DoubleEndedIterator<Item = &(i64, BString)> + ExactSizeIterator {
		self.0.iter().map(|item| &**item)
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
		Arc::make_mut(&mut self.0).push(Arc::new(item));
	}

	/// Insert at a sorted position, appending when it is the end.
	///
	/// # Panics
	/// `position` exceeds the number of elements.
	pub fn insert(&mut self, position: usize, item: (i64, BString)) {
		if position == self.len() {
			self.push(item);
		} else {
			Arc::make_mut(&mut self.0).insert(position, Arc::new(item));
		}
	}

	/// Remove an element, preserving sorted order.
	///
	/// # Panics
	/// `position` does not name an element.
	pub fn remove(&mut self, position: usize) {
		if position == self.len() - 1 {
			Arc::make_mut(&mut self.0).pop();
		} else {
			Arc::make_mut(&mut self.0).remove(position);
		}
	}

	/// Remove every element.
	pub fn clear(&mut self) {
		*self = Self::default();
	}
}

impl From<Vec<(i64, BString)>> for IndexedArray {
	fn from(value: Vec<(i64, BString)>) -> Self {
		Self(Arc::new(value.into_iter().map(Arc::new).collect()))
	}
}

impl FromIterator<(i64, BString)> for IndexedArray {
	fn from_iter<I: IntoIterator<Item = (i64, BString)>>(iter: I) -> Self {
		Self(Arc::new(iter.into_iter().map(Arc::new).collect()))
	}
}

impl Extend<(i64, BString)> for IndexedArray {
	fn extend<I: IntoIterator<Item = (i64, BString)>>(&mut self, iter: I) {
		Arc::make_mut(&mut self.0).extend(iter.into_iter().map(Arc::new));
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
		Arc::make_mut(&mut Arc::make_mut(&mut self.0)[index])
	}
}
