//! `MemStore`: the reference [`StateStore`], in memory.
//!
//! Used by `obash`, the testkit and the store conformance suite. Its maps are
//! the shell's state (the engine keeps no copy): global variables and every
//! other record in an [`Image`] of persistent maps, the root shell's scopes
//! as a stack of maps. Lookups borrow the key, so a hit allocates nothing,
//! and [`Change::SetScalar`] reuses the value's buffer. Cloning the store,
//! and [`StateStore::snapshot`], cost O(1): the copies share every record
//! until one side writes it.
//!
//! Its image ([`MemStore::to_bytes`]) stands in for a heap snapshot: the
//! fault injector serializes it, drops the shell, and restores into a fresh
//! store built from the bytes, as a new process would.
//! Deferred host scalar defaults are memoized on observation. Scans and
//! images force them into ordinary variable records, so snapshots contain
//! values rather than process-local initializer functions.

use bstr::{BStr, BString};
use hashbrown::HashMap;
use serde::{Deserialize, Serialize};

use crate::bash::{
	cow_map::CowMap,
	image::Image,
	store::{
		Attrs, BlobSlot, Change, Elem, Key, KeyBuf, Record, StateStore, StoreError, Table, VarValue,
	},
};

/// One root scope: its [`Record::Scope`] and its locals by name.
type ScopeEntry = (Record, HashMap<BString, Record>);

/// In-memory [`StateStore`]. Cloning it costs O(1) in its records and
/// blobs: the clones share them until one writes ([`Image`]).
#[derive(Clone, Debug, Default)]
pub struct MemStore {
	/// The root's process records ([`Key::forked`]): global variables,
	/// functions, options, …, shared with the forks that cloned them.
	image:       Image,
	/// The records outside the image: kernel state and the root vproc's
	/// own fields (job table, process table, `$?`, counters, …). Written
	/// often while forks live, and never part of one.
	other:       HashMap<KeyBuf, Record>,
	/// The root shell's scopes, outermost first ([`Key::Scope`],
	/// [`Key::Local`]).
	scopes:      Vec<ScopeEntry>,
	/// `local_bloom[d]`: the [`local_bits`] of every local in scopes `0..=d`
	/// ([`StateStore::may_have_local`]), one entry per scope. Deleting a
	/// local leaves its bits until its scope pops: a false positive (a scope
	/// walk), never a false negative.
	local_bloom: Vec<[u64; 5]>,
	blobs:       CowMap<BlobSlot, Vec<u8>>,
	epoch:       u64,
}

/// The serialized form of a [`MemStore`]: records sorted by key (scopes
/// before their locals), blobs sorted by slot.
#[derive(Serialize, Deserialize)]
struct StoreImage {
	records: Vec<(KeyBuf, Record)>,
	blobs:   Vec<(BlobSlot, Vec<u8>)>,
	epoch:   u64,
}

/// Equal stores hold the same records, blobs and epoch; the local-name
/// bloom is an index (a deleted local leaves its bits) and does not count.
impl PartialEq for MemStore {
	fn eq(&self, other: &Self) -> bool {
		self.image == other.image
			&& self.other == other.other
			&& self.scopes == other.scopes
			&& self.blobs == other.blobs
			&& self.epoch == other.epoch
	}
}

impl Eq for MemStore {}

/// The shape error of `key`'s table.
const fn shape(key: Key<'_>) -> StoreError {
	StoreError::Shape { table: key.table() }
}

impl MemStore {
	/// Empty store.
	pub fn new() -> Self {
		Self::default()
	}

	/// Serialized image (records, blobs, epoch), deterministic for equal
	/// contents.
	pub fn to_bytes(&self) -> Vec<u8> {
		let mut records = Vec::with_capacity(self.len());
		self.each(&mut |k, r| records.push((k.to_buf(), r.clone())));
		records.sort_unstable_by(|a, b| a.0.cmp(&b.0));
		let mut blobs: Vec<(BlobSlot, Vec<u8>)> =
			self.blobs.iter().map(|(s, b)| (*s, b.clone())).collect();
		blobs.sort_unstable_by_key(|(s, _)| *s);
		postcard::to_stdvec(&StoreImage { records, blobs, epoch: self.epoch })
			.expect("MemStore serialization is infallible")
	}

	/// Store from an image produced by [`MemStore::to_bytes`].
	///
	/// # Errors
	/// [`StoreError::Image`] when the bytes do not decode,
	/// [`StoreError::Shape`] when a record does not fit its key.
	pub fn from_bytes(bytes: &[u8]) -> Result<Self, StoreError> {
		let image: StoreImage = postcard::from_bytes(bytes).map_err(StoreError::Image)?;
		let mut store = Self::new();
		for (key, record) in image.records {
			store.put(key.as_key(), record)?;
		}
		store.blobs = image.blobs.into_iter().collect();
		store.epoch = image.epoch;
		Ok(store)
	}

	/// Write a record out of band, as an embedder would (a TS tool setting a
	/// variable); bumps the epoch.
	///
	/// # Errors
	/// [`StoreError::Shape`] when the record does not fit its key.
	pub fn put_out_of_band(&mut self, key: Key<'_>, record: Record) -> Result<(), StoreError> {
		self.put(key, record)?;
		self.epoch += 1;
		Ok(())
	}

	/// What an embedder does after writing through [`StateStore::apply`]
	/// itself: bump the epoch, so the engine drops what it derived.
	pub const fn bump_epoch(&mut self) {
		self.epoch += 1;
	}

	/// Delete a record out of band; bumps the epoch.
	pub fn del_out_of_band(&mut self, key: Key<'_>) {
		self.del(key);
		self.epoch += 1;
	}

	/// Read a record without the trait's `&mut` (tests, `obash`).
	#[inline]
	pub fn record(&self, key: Key<'_>) -> Option<&Record> {
		match key {
			Key::Scope(depth) => self.scopes.get(depth as usize).map(|(r, _)| r),
			Key::Local { depth, name } => self
				.scopes
				.get(depth as usize)
				.and_then(|(_, vars)| vars.get(bytes(name))),
			_ if key.forked() => self.image.get(key),
			_ => self.other.get(&key),
		}
	}

	/// Number of records.
	pub fn len(&self) -> usize {
		self.image.len()
			+ self.other.len()
			+ self
				.scopes
				.iter()
				.map(|(_, vars)| 1 + vars.len())
				.sum::<usize>()
	}

	/// Whether the store holds no records.
	pub fn is_empty(&self) -> bool {
		self.len() == 0
	}

	/// Visit every record.
	fn each(&self, f: &mut dyn FnMut(Key<'_>, &Record)) {
		self.image.each_var(&mut |name, r| f(Key::Var(name), r));
		for (depth, (scope, vars)) in (0_u32..).zip(&self.scopes) {
			f(Key::Scope(depth), scope);
			for (name, r) in vars {
				f(Key::Local { depth, name: BStr::new(name) }, r);
			}
		}
		self.image.each_other(f);
		for (k, r) in &self.other {
			f(k.as_key(), r);
		}
	}

	/// Insert or replace `record` at `key` ([`Change::Put`]).
	fn put(&mut self, key: Key<'_>, record: Record) -> Result<(), StoreError> {
		let fits = match key {
			Key::Var(_) => matches!(record, Record::Var(_)),
			Key::Local { .. } => matches!(record, Record::Var(_) | Record::Unset),
			Key::Scope(_) => matches!(record, Record::Scope { .. }),
			// The env options live in `Table::Opt` only (`ZshOpt::env_twin`).
			Key::ZshOpt(opt) => matches!(record, Record::Opt(_)) && opt.env_twin().is_none(),
			Key::ZshAlias { .. } => matches!(record, Record::Alias(_)),
			_ => !matches!(record, Record::Var(_) | Record::Unset | Record::Scope { .. }),
		};
		if !fits {
			return Err(shape(key));
		}
		match key {
			Key::Var(name) => self.image.put_var(name, record),
			Key::Scope(depth) => {
				let depth = depth as usize;
				if depth == self.scopes.len() {
					self.scopes.push((record, HashMap::new()));
					let outer = self.local_bloom.last().copied().unwrap_or_default();
					self.local_bloom.push(outer);
				} else if let Some((scope, _)) = self.scopes.get_mut(depth) {
					*scope = record;
				} else {
					return Err(shape(key));
				}
			},
			Key::Local { depth, name } => {
				let Some((_, vars)) = self.scopes.get_mut(depth as usize) else {
					return Err(shape(key));
				};
				if let Some(slot) = vars.get_mut(bytes(name)) {
					*slot = record;
				} else {
					vars.insert(BString::from(bytes(name)), record);
					let bits = local_bits(name);
					for words in &mut self.local_bloom[depth as usize..] {
						for (w, b) in bits {
							words[w] |= b;
						}
					}
				}
			},
			_ if key.forked() => self.image.put(key, record),
			_ => match self.other.get_mut(&key) {
				Some(slot) => *slot = record,
				None => {
					self.other.insert(key.to_buf(), record);
				},
			},
		}
		Ok(())
	}

	/// Delete the record at `key` ([`Change::Del`]).
	fn del(&mut self, key: Key<'_>) {
		match key {
			Key::Var(name) => {
				self.image.del_var(name);
			},
			Key::Scope(depth) => {
				self.scopes.truncate(depth as usize);
				self.local_bloom.truncate(depth as usize);
			},
			Key::Local { depth, name } => {
				if let Some((_, vars)) = self.scopes.get_mut(depth as usize) {
					vars.remove(bytes(name));
				}
			},
			_ if key.forked() => {
				self.image.del(key);
			},
			_ => {
				self.other.remove(&key);
			},
		}
	}

	/// The variable record at `key` ([`Key::Var`] or [`Key::Local`]), for
	/// an in-place change.
	#[inline]
	fn var_mut(&mut self, key: Key<'_>) -> Option<&mut VarValue> {
		let record = match key {
			Key::Var(name) => self.image.var_mut(name),
			Key::Local { depth, name } => self
				.scopes
				.get_mut(depth as usize)
				.and_then(|(_, vars)| vars.get_mut(bytes(name))),
			_ => None,
		};
		match record {
			Some(Record::Var(var)) => Some(&mut var.value),
			_ => None,
		}
	}
}

/// `(word, bit)` pairs of local `name` in a [`MemStore::local_bloom`]
/// entry. Word 0 is exact for one-byte names (bit `c & 63`: `[A-Za-z_]`
/// never share one); words 1 to 4 are a 256-bit bloom with two bits per
/// longer name, keyed by its length and its first and last two bytes. Per
/// recursive call (scope push, two locals, lookups, pop) it costs about a
/// third of a refcounted name map, which allocates each new name.
#[inline]
fn local_bits(name: &[u8]) -> [(usize, u64); 2] {
	let key = match name {
		[c] => return [(0, 1 << (c & 63)); 2],
		[a, b, .., y, z] => {
			name.len() as u64
				| u64::from(u16::from_le_bytes([*a, *b])) << 8
				| u64::from(u16::from_le_bytes([*y, *z])) << 24
		},
		[first, .., last] => name.len() as u64 | u64::from(*first) << 8 | u64::from(*last) << 16,
		[] => 0,
	};
	let h = key.wrapping_mul(0x9e37_79b9_7f4a_7c15);
	let (p, q) = ((h >> 56) as usize, (h >> 48) as usize & 255);
	[(1 + (p >> 6), 1 << (p & 63)), (1 + (q >> 6), 1 << (q & 63))]
}

/// The bytes of a name, for map lookups by `[u8]`.
fn bytes(name: &BStr) -> &[u8] {
	name
}

/// Replace `dst`'s bytes with `src`, reusing its buffer.
fn assign(dst: &mut BString, src: &[u8]) {
	dst.clear();
	dst.extend_from_slice(src);
}

impl StateStore for MemStore {
	fn may_have_local(&mut self, name: &[u8]) -> bool {
		self
			.local_bloom
			.last()
			.is_some_and(|top| local_bits(name).iter().all(|&(w, b)| top[w] & b != 0))
	}

	fn defer_scalar(
		&mut self,
		name: &[u8],
		attrs: Attrs,
		initializer: fn() -> Option<BString>,
	) -> Result<bool, StoreError> {
		self.image.defer_var(name, attrs, initializer);
		Ok(true)
	}

	fn get(&mut self, key: Key<'_>) -> Result<Option<&Record>, StoreError> {
		Ok(self.record(key))
	}

	fn scan(&mut self, table: Table, f: &mut dyn FnMut(Key<'_>, &Record)) -> Result<(), StoreError> {
		match table {
			Table::Var => self.image.each_var(&mut |name, r| f(Key::Var(name), r)),
			Table::Scope => {
				for (depth, (scope, _)) in (0_u32..).zip(&self.scopes) {
					f(Key::Scope(depth), scope);
				}
			},
			Table::Local => {
				for (depth, (_, vars)) in (0_u32..).zip(&self.scopes) {
					for (name, r) in vars {
						f(Key::Local { depth, name: BStr::new(name) }, r);
					}
				}
			},
			_ => {
				self.image.each_record(table, f);
				for (k, r) in &self.other {
					let key = k.as_key();
					if key.table() == table {
						f(key, r);
					}
				}
			},
		}
		Ok(())
	}

	fn apply(&mut self, change: Change<'_>) -> Result<(), StoreError> {
		match change {
			Change::Put(key, record) => self.put(key, record)?,
			Change::Del(key) => self.del(key),
			Change::SetScalar(key, value) => match self.var_mut(key) {
				Some(VarValue::Str(s)) => assign(s, value),
				_ => return Err(shape(key)),
			},
			Change::AppendScalar(key, value) => match self.var_mut(key) {
				Some(VarValue::Str(s)) => s.extend_from_slice(value),
				_ => return Err(shape(key)),
			},
			change @ (Change::SetElem(key, elem, value) | Change::AppendElem(key, elem, value)) => {
				let append = matches!(change, Change::AppendElem(..));
				match (self.var_mut(key), elem) {
					// An append (`a+=(x)`) goes past the last index: no search.
					(Some(VarValue::Indexed(items)), Elem::Index(i))
						if items.last().is_none_or(|(last, _)| *last < i) =>
					{
						items.push((i, BString::from(value)));
					},
					(Some(VarValue::Indexed(items)), Elem::Index(i)) => {
						match items.binary_search_by_key(&i, |(k, _)| *k) {
							Ok(p) => {
								let dst = &mut items[p].1;
								if !append {
									dst.clear();
								}
								dst.extend_from_slice(value);
							},
							Err(p) => items.insert(p, (i, BString::from(value))),
						}
					},
					(Some(VarValue::Assoc(items)), Elem::Key(k)) => {
						let dst = items.value_mut(bytes(k));
						if !append {
							dst.clear();
						}
						dst.extend_from_slice(value);
					},
					_ => return Err(shape(key)),
				}
			},
			Change::InsertElem(key, buckets, k, value) => match self.var_mut(key) {
				Some(VarValue::Assoc(items)) => {
					items.insert_front(buckets, BString::from(bytes(k)), BString::from(value));
				},
				_ => return Err(shape(key)),
			},
			Change::DelElem(key, elem) => match (self.var_mut(key), elem) {
				(Some(VarValue::Indexed(items)), Elem::Index(i)) => {
					if let Ok(p) = items.binary_search_by_key(&i, |(k, _)| *k) {
						items.remove(p);
					}
				},
				(Some(VarValue::Assoc(items)), Elem::Key(k)) => {
					items.remove(bytes(k));
				},
				_ => return Err(shape(key)),
			},
		}
		Ok(())
	}

	fn put_blob(&mut self, slot: BlobSlot, bytes: &[u8]) -> Result<(), StoreError> {
		self.blobs.insert(slot, bytes.to_vec());
		Ok(())
	}

	fn get_blob(&mut self, slot: BlobSlot) -> Result<Option<Vec<u8>>, StoreError> {
		Ok(self.blobs.get(&slot).cloned())
	}

	fn del_blob(&mut self, slot: BlobSlot) -> Result<(), StoreError> {
		self.blobs.remove(&slot);
		Ok(())
	}

	fn epoch(&self) -> u64 {
		self.epoch
	}

	fn snapshot(&mut self) -> Result<Image, StoreError> {
		Ok(self.image.clone())
	}
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::{AtomicUsize, Ordering};

	use super::*;
	use crate::bash::store::Var;

	#[test]
	fn deferred_scalars_observe_and_snapshot_as_ordinary_records() {
		static CALLS: AtomicUsize = AtomicUsize::new(0);
		let initialize: fn() -> Option<BString> = || {
			CALLS.fetch_add(1, Ordering::Relaxed);
			Some(BString::from("value"))
		};
		let key = Key::Var(BStr::new(b"DEFAULT"));
		let mut store = MemStore::new();
		store
			.defer_scalar(b"DEFAULT", Attrs::EXPORT, initialize)
			.unwrap();
		assert_eq!(CALLS.load(Ordering::Relaxed), 0);
		let clone = store.clone();
		let record = Record::Var(Var { attrs: Attrs::EXPORT, value: VarValue::Str("value".into()) });
		assert_eq!(store.get(key).unwrap(), Some(&record));
		assert_eq!(clone.record(key), Some(&record));
		assert_eq!(CALLS.load(Ordering::Relaxed), 1);
		let mut scanned = Vec::new();
		store
			.scan(Table::Var, &mut |_, value| scanned.push(value.clone()))
			.unwrap();
		assert_eq!(scanned, [record]);
		let restored = MemStore::from_bytes(&store.to_bytes()).unwrap();
		assert_eq!(store, restored);
		store
			.apply(Change::SetScalar(key, BStr::new(b"changed")))
			.unwrap();
		assert_eq!(
			store.get(key).unwrap(),
			Some(&Record::Var(Var { attrs: Attrs::EXPORT, value: VarValue::Str("changed".into()) }))
		);
		assert_eq!(CALLS.load(Ordering::Relaxed), 1);

		store
			.defer_scalar(b"DEFAULT", Attrs::NONE, initialize)
			.unwrap();
		store.apply(Change::Del(key)).unwrap();
		assert!(store.get(key).unwrap().is_none());
		store
			.defer_scalar(b"DEFAULT", Attrs::NONE, initialize)
			.unwrap();
		store
			.apply(Change::Put(
				key,
				Record::Var(Var { attrs: Attrs::NONE, value: VarValue::Str("replacement".into()) }),
			))
			.unwrap();
		assert_eq!(CALLS.load(Ordering::Relaxed), 1);

		store
			.defer_scalar(b"DEFAULT", Attrs::NONE, || None)
			.unwrap();
		assert!(store.get(key).unwrap().is_none());
		assert_eq!(store.len(), 0);
		let restored = MemStore::from_bytes(&store.to_bytes()).unwrap();
		assert_eq!(store, restored);
	}

	#[test]
	fn deferred_scalar_image_forces_unobserved_defaults() {
		let mut store = MemStore::new();
		store
			.defer_scalar(b"DEFAULT", Attrs::READONLY, || Some("saved".into()))
			.unwrap();
		let restored = MemStore::from_bytes(&store.to_bytes()).unwrap();
		assert_eq!(
			restored.record(Key::Var(BStr::new(b"DEFAULT"))),
			Some(&Record::Var(Var { attrs: Attrs::READONLY, value: VarValue::Str("saved".into()) }))
		);
	}
}
