//! zsh's associative-array iteration order: the order of
//! zsh's parameter hash tables (`hashtable.c`), kept by every zsh-dialect
//! writer in the stored `Vec` so that `${(k)h}`, `${(kv)h}` and `typeset
//! -p` list entries as zsh 5.9 does.
//!
//! A table starts with 17 buckets (`newparamtable(17, …)`); a key goes to
//! bucket `hasher(key) % hsize`; a new key is linked at the front of its
//! bucket's chain, a known one replaced in place; when the count reaches
//! twice the buckets the table grows fourfold, re-adding every node
//! bucket by bucket, chain front to back (`expandhashtable`). Iteration
//! walks buckets in order, each chain front to back (`scanhashtable`).
//!
//! The stored `Vec` *is* that iteration order, and the bucket count is
//! recorded in the variable's base field ([`Attrs::base`]: the table has
//! `17 · 4^base` buckets), so the table is rebuilt exactly from the
//! stored value: an entry's bucket is its key's hash, and entries of one
//! bucket appear in chain order.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::BString;

use crate::bash::store::{Attrs, zsh_bucket as bucket};

/// Initial buckets of a parameter hash table (zsh `newparamtable(17, …)`).
const INITIAL_BUCKETS: usize = 17;

/// A zsh parameter hash table rebuilt from a stored associative array.
#[derive(Clone, Debug)]
pub struct ZHash {
	/// Chains, front first.
	buckets: Vec<Vec<(BString, BString)>>,
	/// Entries (zsh `ct`).
	count:   usize,
	/// Growth steps since creation (`hsize = 17 · 4^grown`).
	grown:   u8,
}

impl Default for ZHash {
	fn default() -> Self {
		Self::new()
	}
}

impl ZHash {
	/// An empty table of 17 buckets (zsh `newparamtable(17, …)`).
	pub fn new() -> Self {
		Self { buckets: vec![Vec::new(); INITIAL_BUCKETS], count: 0, grown: 0 }
	}

	/// The table a stored associative array stands for: `items` in zsh
	/// iteration order, the bucket count from `attrs` ([`Attrs::base`]).
	pub fn from_stored(items: &[(BString, BString)], attrs: Attrs) -> Self {
		Self::from_items(items.iter().cloned(), INITIAL_BUCKETS, attrs.base())
	}

	/// Rebuild a stored associative array by moving its owned entries.
	pub fn from_owned(items: Vec<(BString, BString)>, attrs: Attrs) -> Self {
		Self::from_items(items, INITIAL_BUCKETS, attrs.base())
	}

	/// An empty table of `initial` buckets (zsh `newhashtable(initial, …)`).
	pub fn with_buckets(initial: usize) -> Self {
		Self { buckets: vec![Vec::new(); initial.max(1)], count: 0, grown: 0 }
	}

	/// The table of a hash table created with `initial` buckets that grew
	/// `grown` times, `items` being its entries in iteration order.
	pub fn from_items(
		items: impl IntoIterator<Item = (BString, BString)>,
		initial: usize,
		grown: u8,
	) -> Self {
		let grown = grown.min(8);
		let hsize = initial.max(1) << (2 * u32::from(grown));
		let mut buckets = vec![Vec::new(); hsize];
		let mut count = 0;
		for (k, v) in items {
			if let Some(chain) = buckets.get_mut(bucket(&k, hsize)) {
				chain.push((k, v));
				count += 1;
			}
		}
		Self { buckets, count, grown }
	}

	/// Growth steps since creation (the bucket count is the initial one
	/// times `4^grown`).
	pub const fn grown(&self) -> u8 {
		self.grown
	}

	/// The entries in zsh iteration order (`scanhashtable`, unsorted).
	pub fn iter(&self) -> impl Iterator<Item = &(BString, BString)> {
		self.buckets.iter().flatten()
	}

	/// zsh `emptyhashtable`: every entry removed, the bucket count kept.
	pub fn clear(&mut self) {
		for chain in &mut self.buckets {
			chain.clear();
		}
		self.count = 0;
	}

	/// Number of entries.
	pub const fn len(&self) -> usize {
		self.count
	}

	/// Whether the table has no entries.
	pub const fn is_empty(&self) -> bool {
		self.count == 0
	}

	/// zsh `addhashnode2`: replace the value of a known key in place, link
	/// a new one at the front of its chain (and grow the table when the
	/// count reaches twice the buckets).
	pub fn insert(&mut self, key: BString, value: BString) {
		let hsize = self.buckets.len();
		let Some(chain) = self.buckets.get_mut(bucket(&key, hsize)) else {
			return;
		};
		if let Some(e) = chain.iter_mut().find(|e| e.0 == key) {
			e.1 = value;
			return;
		}
		chain.insert(0, (key, value));
		self.count += 1;
		if self.count >= hsize * 2 {
			self.expand();
		}
	}

	/// zsh `expandhashtable`: four times the buckets, every node re-added
	/// bucket by bucket, chain front to back.
	fn expand(&mut self) {
		let hsize = self.buckets.len() * 4;
		let old = std::mem::replace(&mut self.buckets, vec![Vec::new(); hsize]);
		for chain in old {
			for (k, v) in chain {
				let b = bucket(&k, hsize);
				if let Some(chain) = self.buckets.get_mut(b) {
					chain.insert(0, (k, v));
				}
			}
		}
		self.grown = self.grown.saturating_add(1);
	}

	/// zsh `removehashnode`: unlink `key`; its value.
	pub fn remove(&mut self, key: &[u8]) -> Option<BString> {
		let hsize = self.buckets.len();
		let chain = self.buckets.get_mut(bucket(key, hsize))?;
		let at = chain.iter().position(|e| e.0.as_slice() == key)?;
		self.count -= 1;
		Some(chain.remove(at).1)
	}

	/// The value of `key`.
	pub fn get(&self, key: &[u8]) -> Option<&BString> {
		let hsize = self.buckets.len();
		self
			.buckets
			.get(bucket(key, hsize))?
			.iter()
			.find(|e| e.0.as_slice() == key)
			.map(|e| &e.1)
	}

	/// The entries in zsh iteration order, and `attrs` with the bucket
	/// count recorded: what the store keeps.
	pub fn into_stored(self, attrs: Attrs) -> (Vec<(BString, BString)>, Attrs) {
		let mut out = Vec::with_capacity(self.count);
		for chain in self.buckets {
			out.extend(chain);
		}
		(out, attrs.with_base(self.grown))
	}
}

/// The bucket count of the stored table (`attrs`, [`Attrs::base`]) of
/// `len` entries a new key is added to, at the front of its bucket's chain
/// ([`AssocArray::insert_front`](crate::bash::store::AssocArray::insert_front)).
/// `None` when adding it grows the table, which reorders every entry
/// ([`ZHash::insert`] then rebuilds it).
pub const fn insert_buckets(len: usize, attrs: Attrs) -> Option<usize> {
	let base = if attrs.base() > 8 { 8 } else { attrs.base() };
	let hsize = INITIAL_BUCKETS << (2 * base as u32);
	if len + 1 >= hsize * 2 {
		None
	} else {
		Some(hsize)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn order(keys: &[&str]) -> Vec<String> {
		let mut h = ZHash::new();
		for k in keys {
			h.insert(BString::from(*k), BString::from("v"));
		}
		let (items, _) = h.into_stored(Attrs::NONE);
		items.into_iter().map(|(k, _)| k.to_string()).collect()
	}

	#[test]
	fn keys_iterate_in_zsh_bucket_order() {
		// zsh -f -c 'typeset -A h; h=(a 1 b 2 c 3 d 4); print -r ${(k)h}'
		assert_eq!(order(&["a", "b", "c", "d"]), ["a", "b", "c", "d"]);
		// zsh -f -c 'typeset -A h; h=(one 1 two 2 three 3); print -r ${(k)h}'
		// (buckets 0, 6, 7 of 17)
		assert_eq!(order(&["one", "two", "three"]), ["one", "two", "three"]);
		// zsh -f -c 'typeset -A h; h=(zz 1 y 2); print -r ${(k)h}'
		// (buckets 0, 2 of 17: insertion order is irrelevant)
		assert_eq!(order(&["y", "zz"]), ["zz", "y"]);
	}

	#[test]
	fn rebuilding_from_the_stored_order_keeps_it() {
		let keys: Vec<String> = (0..60).map(|i| format!("key{i}")).collect();
		let mut h = ZHash::new();
		for k in &keys {
			h.insert(BString::from(k.as_str()), BString::from("x"));
		}
		let (items, attrs) = h.into_stored(Attrs::NONE);
		assert_eq!(attrs.base(), 1, "60 entries grow 17 buckets once");
		let mut again = ZHash::from_stored(&items, attrs);
		again.insert(BString::from("key5"), BString::from("y"));
		let (items2, _) = again.into_stored(attrs);
		let k1: Vec<_> = items.iter().map(|e| &e.0).collect();
		let k2: Vec<_> = items2.iter().map(|e| &e.0).collect();
		assert_eq!(k1, k2, "replacing a value keeps the order");
	}

	/// Adding each new key at the front of its bucket in place
	/// ([`insert_buckets`], `AssocArray::insert_front`; rebuilding only when
	/// the table grows) keeps exactly the order zsh's table iterates in.
	#[test]
	fn front_inserts_follow_the_table() {
		let mut items = crate::bash::store::AssocArray::default();
		let mut attrs = Attrs::NONE;
		let mut table = ZHash::new();
		for i in 0..2000 {
			let key = BString::from(format!("k{i}"));
			table.insert(key.clone(), BString::from("v"));
			if let Some(buckets) = insert_buckets(items.len(), attrs) {
				items.insert_front(buckets, key, BString::from("v"));
			} else {
				let mut h = ZHash::from_stored(&items, attrs);
				h.insert(key, BString::from("v"));
				let (stored, grown) = h.into_stored(attrs);
				(items, attrs) = (stored.into(), grown);
			}
		}
		let (want, want_attrs) = table.into_stored(Attrs::NONE);
		assert_eq!(&*items, want.as_slice());
		assert_eq!(attrs.base(), want_attrs.base());
	}
}
