//! A persistent hash map: cloning costs O(1) and the clones share their
//! entries until one of them writes.
//!
//! Entries live in `2^bits` hashbrown shards picked by hash, each shard and
//! each entry behind an [`Arc`]. A write copies what the writer shares with
//! another clone along its path: the shard list (one pointer per shard), the
//! shard (one pointer per entry) and the entry. The shard count grows with
//! the map, keeping both copies near `√len` pointers, and a lookup is two
//! pointer hops more than a plain hashbrown probe. A process image
//! ([`crate::bash::Image`]) is a few of these maps, so forking a virtual
//! process clones the parent's state without copying it.

use std::{
	fmt,
	hash::{BuildHasher, Hash},
	sync::{Arc, LazyLock, Weak},
};

use hashbrown::{DefaultHashBuilder, Equivalent, HashTable};

/// Entries of one shard.
type Shard<K, V> = HashTable<Arc<(K, V)>>;

/// The shard list of a map, a power of two of them.
type ShardList<K, V> = [Arc<Shard<K, V>>];

/// The shards of a map.
type Shards<K, V> = Arc<ShardList<K, V>>;

/// Persistent hash map (see the module docs).
pub struct CowMap<K, V> {
	/// `None` until the first insert: an empty map allocates nothing.
	shards: Option<Shards<K, V>>,
	len:    usize,
}

/// A handle on a [`CowMap`] that does not keep its entries shared
/// ([`CowMap::downgrade`]): it recognises the map while it is untouched and
/// gives it back while a clone of it lives.
pub struct WeakCowMap<K, V> {
	shards: Option<Weak<ShardList<K, V>>>,
	len:    usize,
}

impl<K, V> Clone for WeakCowMap<K, V> {
	fn clone(&self) -> Self {
		Self { shards: self.shards.clone(), len: self.len }
	}
}

impl<K, V> fmt::Debug for WeakCowMap<K, V> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("WeakCowMap")
			.field("len", &self.len)
			.finish_non_exhaustive()
	}
}

impl<K, V> WeakCowMap<K, V> {
	/// The map, while a clone of it lives untouched.
	pub fn upgrade(&self) -> Option<CowMap<K, V>> {
		match &self.shards {
			Some(weak) => Some(CowMap { shards: Some(weak.upgrade()?), len: self.len }),
			None => Some(CowMap::default()),
		}
	}
}

/// The hasher of every map: one per process, so two maps place a key in
/// the same shard whenever they have as many ([`CowMap::diff`]).
static HASHER: LazyLock<DefaultHashBuilder> = LazyLock::new(DefaultHashBuilder::default);

fn hash_of<Q: Hash + ?Sized>(key: &Q) -> u64 {
	HASHER.hash_one(key)
}

/// Bit offset of the shard index in a hash: past the low bits hashbrown
/// places entries by and clear of the top seven it tags them with.
const SHARD_SHIFT: u32 = 32;

/// Largest shard-count exponent (4096 shards).
const MAX_BITS: u32 = 12;

/// Whether a map of `len` entries outgrows `2^bits` shards: the average
/// shard holds more than twice the shard count.
const fn outgrows(len: usize, bits: u32) -> bool {
	bits < MAX_BITS && len > (2_usize << (2 * bits))
}

/// The shard of `hash` among `count` (a power of two).
const fn index(count: usize, hash: u64) -> usize {
	((hash >> SHARD_SHIFT) as usize) & (count - 1)
}

impl<K, V> Clone for CowMap<K, V> {
	fn clone(&self) -> Self {
		Self { shards: self.shards.clone(), len: self.len }
	}
}

impl<K, V> Default for CowMap<K, V> {
	fn default() -> Self {
		Self { shards: None, len: 0 }
	}
}

impl<K: fmt::Debug, V: fmt::Debug> fmt::Debug for CowMap<K, V> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_map().entries(self.iter()).finish()
	}
}

impl<K: Hash + Eq, V: PartialEq> PartialEq for CowMap<K, V> {
	fn eq(&self, other: &Self) -> bool {
		self.len == other.len
			&& (self.same_as(other) || self.iter().all(|(k, v)| other.get(k) == Some(v)))
	}
}

impl<K: Hash + Eq, V: Eq> Eq for CowMap<K, V> {}

impl<K: Hash + Eq, V> FromIterator<(K, V)> for CowMap<K, V> {
	fn from_iter<I: IntoIterator<Item = (K, V)>>(iter: I) -> Self {
		let mut map = Self::default();
		for (k, v) in iter {
			map.insert(k, v);
		}
		map
	}
}

impl<K, V> CowMap<K, V> {
	/// Number of entries.
	pub const fn len(&self) -> usize {
		self.len
	}

	/// Whether `self` and `other` are the same clone, untouched since: equal
	/// without looking at an entry.
	pub fn same_as(&self, other: &Self) -> bool {
		match (&self.shards, &other.shards) {
			(Some(a), Some(b)) => Arc::ptr_eq(a, b),
			(None, None) => true,
			_ => false,
		}
	}

	/// A handle that recognises this map while it is untouched
	/// ([`Self::same_as_weak`]) without sharing it: a write through any
	/// clone that would have copied the path still moves it, so the handle
	/// stops matching.
	pub fn downgrade(&self) -> WeakCowMap<K, V> {
		WeakCowMap { shards: self.shards.as_ref().map(Arc::downgrade), len: self.len }
	}

	/// [`Self::same_as`] against a [`WeakCowMap`]. The handle keeps the
	/// shard list's allocation, so another map cannot take its address.
	pub fn same_as_weak(&self, other: &WeakCowMap<K, V>) -> bool {
		match (&self.shards, &other.shards) {
			(Some(a), Some(b)) => std::ptr::addr_eq(Arc::as_ptr(a), b.as_ptr()),
			(None, None) => true,
			_ => false,
		}
	}

	/// Every entry, in no particular order.
	pub fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
		self
			.shards
			.iter()
			.flat_map(|s| s.iter())
			.flat_map(|t| t.iter())
			.map(|e| (&e.0, &e.1))
	}
}

impl<K: Hash + Eq, V> CowMap<K, V> {
	/// The value at `key`.
	#[inline]
	pub fn get<Q: Hash + Equivalent<K> + ?Sized>(&self, key: &Q) -> Option<&V> {
		self.entry(key).map(|e| &e.1)
	}

	/// Whether `key` has an entry.
	#[inline]
	pub fn contains_key<Q: Hash + Equivalent<K> + ?Sized>(&self, key: &Q) -> bool {
		self.entry(key).is_some()
	}

	#[inline]
	fn entry<Q: Hash + Equivalent<K> + ?Sized>(&self, key: &Q) -> Option<&Arc<(K, V)>> {
		let shards = self.shards.as_deref()?;
		let hash = hash_of(key);
		shards[index(shards.len(), hash)].find(hash, |e| key.equivalent(&e.0))
	}

	/// The shard `hash` falls in, unshared (copied along the path when
	/// another clone holds it).
	fn shard_mut(&mut self, hash: u64) -> Option<&mut Shard<K, V>> {
		let shards = Arc::make_mut(self.shards.as_mut()?);
		let i = index(shards.len(), hash);
		Some(Arc::make_mut(&mut shards[i]))
	}

	/// The value at `key` for an in-place change: the entry, and the path
	/// to it, are copied first when another clone shares them. A miss
	/// unshares the path too (callers insert next).
	#[inline]
	pub fn get_mut<Q: Hash + Equivalent<K> + ?Sized>(&mut self, key: &Q) -> Option<&mut V>
	where
		K: Clone,
		V: Clone,
	{
		let hash = hash_of(key);
		let entry = self
			.shard_mut(hash)?
			.find_mut(hash, |e| key.equivalent(&e.0))?;
		Some(&mut Arc::make_mut(entry).1)
	}

	/// Insert or replace the value at `key`. A replaced entry is changed in
	/// place when no other clone shares it, else swapped for a new one: the
	/// old value is never copied.
	pub fn insert(&mut self, key: K, value: V) {
		let hash = hash_of(&key);
		let (shard, bits) = self.shard_for_insert(hash);
		if let Some(slot) = shard.find_mut(hash, |e| e.0 == key) {
			match Arc::get_mut(slot) {
				Some(entry) => entry.1 = value,
				None => *slot = Arc::new((key, value)),
			}
			return;
		}
		shard.insert_unique(hash, Arc::new((key, value)), |e| hash_of(&e.0));
		self.grew(bits);
	}

	/// [`Self::insert`] by a borrowed key: `owned` makes the key only when
	/// `key` is new to the map, or its entry is shared with another clone.
	pub fn set<Q: Hash + Equivalent<K> + ?Sized>(
		&mut self,
		key: &Q,
		value: V,
		owned: impl FnOnce(&Q) -> K,
	) where
		K: Clone,
	{
		let hash = hash_of(key);
		let (shard, bits) = self.shard_for_insert(hash);
		if let Some(slot) = shard.find_mut(hash, |e| key.equivalent(&e.0)) {
			match Arc::get_mut(slot) {
				Some(entry) => entry.1 = value,
				None => *slot = Arc::new((slot.0.clone(), value)),
			}
			return;
		}
		shard.insert_unique(hash, Arc::new((owned(key), value)), |e| hash_of(&e.0));
		self.grew(bits);
	}

	/// The shard `hash` falls in, unshared, creating the first one; and the
	/// shard-count exponent.
	fn shard_for_insert(&mut self, hash: u64) -> (&mut Shard<K, V>, u32) {
		let shards = Arc::make_mut(
			self
				.shards
				.get_or_insert_with(|| Arc::from([Arc::new(HashTable::new())])),
		);
		let bits = shards.len().trailing_zeros();
		(Arc::make_mut(&mut shards[index(shards.len(), hash)]), bits)
	}

	/// Count an inserted entry, spreading the entries over more shards once
	/// the map outgrows `2^bits` of them.
	fn grew(&mut self, bits: u32) {
		self.len += 1;
		if outgrows(self.len, bits) {
			self.regrow(bits);
		}
	}

	/// Remove the entry at `key`; whether there was one.
	pub fn remove<Q: Hash + Equivalent<K> + ?Sized>(&mut self, key: &Q) -> bool {
		let Some(shards) = self.shards.as_deref() else {
			return false;
		};
		let hash = hash_of(key);
		// Look first: a miss must not unshare anything.
		if shards[index(shards.len(), hash)]
			.find(hash, |e| key.equivalent(&e.0))
			.is_none()
		{
			return false;
		}
		let Some(shard) = self.shard_mut(hash) else {
			return false;
		};
		let Ok(entry) = shard.find_entry(hash, |e| key.equivalent(&e.0)) else {
			return false;
		};
		entry.remove();
		self.len -= 1;
		true
	}

	/// Redistribute the entries over more shards (entries are shared, not
	/// copied).
	fn regrow(&mut self, mut bits: u32) {
		let Some(old) = self.shards.take() else {
			return;
		};
		while outgrows(self.len, bits) {
			bits += 1;
		}
		let count = 1_usize << bits;
		let mut next: Vec<Shard<K, V>> = (0..count).map(|_| HashTable::new()).collect();
		for entry in old.iter().flat_map(|t| t.iter()) {
			let hash = hash_of(&entry.0);
			next[index(count, hash)].insert_unique(hash, Arc::clone(entry), |e| hash_of(&e.0));
		}
		self.shards = Some(next.into_iter().map(Arc::new).collect());
	}

	/// Visit the keys whose entries differ between `self` and `base`, with
	/// `self`'s value (`None`: `self` has no entry). Shards and entries the
	/// two share are skipped without a look, so diffing a clone against the
	/// map it was cloned from costs what changed since.
	pub fn diff(&self, base: &Self, mut f: impl FnMut(&K, Option<&V>)) {
		if self.same_as(base) {
			return;
		}
		// Same shard count: a key is in the same shard of both.
		if let (Some(a), Some(b)) = (&self.shards, &base.shards)
			&& a.len() == b.len()
		{
			let find = |t: &'_ Shard<K, V>, k: &K| t.find(hash_of(k), |e| e.0 == *k).cloned();
			for (ta, tb) in a.iter().zip(b.iter()) {
				if Arc::ptr_eq(ta, tb) {
					continue;
				}
				for entry in ta.iter() {
					if !find(tb, &entry.0).is_some_and(|theirs| Arc::ptr_eq(&theirs, entry)) {
						f(&entry.0, Some(&entry.1));
					}
				}
				for entry in tb.iter() {
					if find(ta, &entry.0).is_none() {
						f(&entry.0, None);
					}
				}
			}
			return;
		}
		for (k, v) in self.iter() {
			let own = self.entry(k);
			if !base
				.entry(k)
				.zip(own)
				.is_some_and(|(theirs, own)| Arc::ptr_eq(theirs, own))
			{
				f(k, Some(v));
			}
		}
		for (k, _) in base.iter() {
			if !self.contains_key(k) {
				f(k, None);
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn map(n: u32) -> CowMap<u32, String> {
		(0..n).map(|i| (i, i.to_string())).collect()
	}

	#[test]
	fn clones_are_independent_after_writes_on_either_side() {
		let mut parent = map(5_000);
		let mut child = parent.clone();
		child.insert(1, "child".into());
		child.remove(&2);
		*child.get_mut(&3).unwrap() = "edited".into();
		parent.insert(4, "parent".into());
		parent.insert(9_999, "new".into());
		assert_eq!(parent.get(&1).map(String::as_str), Some("1"));
		assert_eq!(parent.get(&2).map(String::as_str), Some("2"));
		assert_eq!(parent.get(&3).map(String::as_str), Some("3"));
		assert_eq!(child.get(&4).map(String::as_str), Some("4"));
		assert_eq!(child.get(&9_999), None);
		assert_eq!(child.get(&1).map(String::as_str), Some("child"));
		assert_eq!(child.get(&2), None);
		assert_eq!(child.get(&3).map(String::as_str), Some("edited"));
		assert_eq!((parent.len(), child.len()), (5_001, 4_999));
		assert_eq!(parent.iter().count(), parent.len());
	}

	/// Replacing a value another clone shares swaps the entry: the old value
	/// (a large array or function body in an image) is never copied.
	#[test]
	fn replacing_a_shared_value_does_not_copy_it() {
		use std::sync::atomic::{AtomicUsize, Ordering};
		static CLONES: AtomicUsize = AtomicUsize::new(0);
		#[derive(Debug, PartialEq)]
		struct Counted(u32);
		impl Clone for Counted {
			fn clone(&self) -> Self {
				CLONES.fetch_add(1, Ordering::Relaxed);
				Self(self.0)
			}
		}
		let mut parent: CowMap<String, Counted> = CowMap::default();
		parent.insert("a".into(), Counted(1));
		parent.insert("b".into(), Counted(2));
		let mut child = parent.clone();
		child.set("a", Counted(3), str::to_owned);
		child.insert("b".into(), Counted(4));
		assert_eq!(CLONES.load(Ordering::Relaxed), 0);
		assert_eq!((child.get("a"), child.get("b")), (Some(&Counted(3)), Some(&Counted(4))));
		assert_eq!((parent.get("a"), parent.get("b")), (Some(&Counted(1)), Some(&Counted(2))));
	}

	#[test]
	fn diff_reports_exactly_the_changes_across_regrowth() {
		for (n, extra) in [(100, 3), (100, 2_000)] {
			let base = map(n);
			let mut child = base.clone();
			// Built apart, same contents: nothing differs but entry identity.
			let mut apart = Vec::new();
			map(n).diff(&base, |k, v| apart.push((*k, v.is_some())));
			assert!(apart.iter().all(|&(_, present)| present) && apart.len() == n as usize);
			child.insert(5, "five".into());
			child.remove(&7);
			for i in 0..extra {
				child.insert(10_000 + i, String::new());
			}
			let mut changed = Vec::new();
			child.diff(&base, |k, v| changed.push((*k, v.cloned())));
			changed.sort();
			let mut want = vec![(5, Some("five".to_owned())), (7, None)];
			want.extend((0..extra).map(|i| (10_000 + i, Some(String::new()))));
			want.sort();
			assert_eq!(changed, want, "n={n} extra={extra}");
		}
	}

	/// A weak handle never hands back a map written since, nor keeps one
	/// alive: it matches and upgrades only while a clone holds the map
	/// untouched.
	#[test]
	fn weak_handle_matches_only_the_untouched_live_map() {
		let mut shared = map(100);
		let weak = shared.downgrade();
		assert!(shared.same_as_weak(&weak));
		let held = shared.clone();
		shared.insert(1, "changed".into());
		assert!(!shared.same_as_weak(&weak));
		assert_eq!(weak.upgrade().and_then(|m| m.get(&1).cloned()).as_deref(), Some("1"));
		drop(held);
		assert!(weak.upgrade().is_none());
		// Written in place by its only holder: no longer the map it was.
		let mut alone = map(10);
		let weak = alone.downgrade();
		alone.insert(1, "changed".into());
		assert!(!alone.same_as_weak(&weak) && weak.upgrade().is_none());
	}
}
