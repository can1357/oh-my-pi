//! `MemStore`: the reference [`StateStore`], in memory.
//!
//! Used by `obash`, the testkit and the store conformance suite. Its maps are
//! the shell's state (the engine keeps no copy): variables by name, the root
//! shell's scopes as a stack of maps, every other record by key. Lookups
//! borrow the key, so a hit allocates nothing, and [`Change::SetScalar`]
//! reuses the value's buffer.
//!
//! Its image ([`MemStore::to_bytes`]) stands in for a heap snapshot: the
//! fault injector serializes it, drops the shell, and restores into a fresh
//! store built from the bytes, as a new process would.
//! Deferred host scalar defaults are memoized on observation. Scans and
//! images force them into ordinary variable records, so snapshots contain
//! values rather than process-local initializer functions.

use std::sync::{Arc, OnceLock};

use bstr::{BStr, BString};
use hashbrown::{HashMap, hash_map::EntryRef};
use serde::{Deserialize, Serialize};

use crate::bash::store::{
	Attrs, BlobSlot, Change, Elem, Key, KeyBuf, Record, StateStore, StoreError, Table, Var, VarValue,
};

/// One root scope: its [`Record::Scope`] and its locals by name.
type ScopeEntry = (Record, HashMap<BString, Record>);

/// In-memory [`StateStore`].
#[derive(Clone, Debug, Default)]
pub struct MemStore {
	/// Global variables ([`Key::Var`]).
	vars:     HashMap<BString, Record>,
	/// Host defaults not yet observed. Resolved records use the ordinary
	/// representation, including in images and scans.
	deferred: HashMap<BString, Arc<DeferredScalar>>,
	/// The root shell's scopes, outermost first ([`Key::Scope`],
	/// [`Key::Local`]).
	scopes:   Vec<ScopeEntry>,
	/// Every other record.
	records:  HashMap<KeyBuf, Record>,
	blobs:    HashMap<BlobSlot, Vec<u8>>,
	epoch:    u64,
}

/// The serialized form of a [`MemStore`]: records sorted by key (scopes
/// before their locals), blobs sorted by slot.
#[derive(Serialize, Deserialize)]
struct Image {
	records: Vec<(KeyBuf, Record)>,
	blobs:   Vec<(BlobSlot, Vec<u8>)>,
	epoch:   u64,
}

/// The shape error of `key`'s table.
const fn shape(key: Key<'_>) -> StoreError {
	StoreError::Shape { table: key.table() }
}

#[derive(Debug)]
struct DeferredScalar {
	initializer: fn() -> Option<BString>,
	attrs:       Attrs,
	record:      OnceLock<Option<Record>>,
}

impl DeferredScalar {
	fn record(&self) -> Option<&Record> {
		self
			.record
			.get_or_init(|| {
				(self.initializer)()
					.map(|value| Record::Var(Var { attrs: self.attrs, value: VarValue::Str(value) }))
			})
			.as_ref()
	}
}

impl PartialEq for MemStore {
	fn eq(&self, other: &Self) -> bool {
		if self.scopes != other.scopes
			|| self.records != other.records
			|| self.blobs != other.blobs
			|| self.epoch != other.epoch
			|| self.len() != other.len()
		{
			return false;
		}
		self
			.vars
			.iter()
			.all(|(name, record)| other.record(Key::Var(BStr::new(name))) == Some(record))
			&& self
				.deferred
				.iter()
				.all(|(name, value)| other.record(Key::Var(BStr::new(name))) == value.record())
	}
}

impl Eq for MemStore {}

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
		postcard::to_stdvec(&Image { records, blobs, epoch: self.epoch })
			.expect("MemStore serialization is infallible")
	}

	/// Store from an image produced by [`MemStore::to_bytes`].
	///
	/// # Errors
	/// [`StoreError::Image`] when the bytes do not decode,
	/// [`StoreError::Shape`] when a record does not fit its key.
	pub fn from_bytes(bytes: &[u8]) -> Result<Self, StoreError> {
		let image: Image = postcard::from_bytes(bytes).map_err(StoreError::Image)?;
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
			Key::Var(name) => self.vars.get(bytes(name)).or_else(|| {
				self
					.deferred
					.get(bytes(name))
					.and_then(|value| value.record())
			}),
			Key::Scope(depth) => self.scopes.get(depth as usize).map(|(r, _)| r),
			Key::Local { depth, name } => self
				.scopes
				.get(depth as usize)
				.and_then(|(_, vars)| vars.get(bytes(name))),
			_ => self.records.get(&key),
		}
	}

	/// Number of records.
	pub fn len(&self) -> usize {
		self.vars.len()
			+ self
				.deferred
				.values()
				.filter(|value| value.record().is_some())
				.count()
			+ self.records.len()
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
		for (name, r) in &self.vars {
			f(Key::Var(BStr::new(name)), r);
		}
		self.each_deferred(f);
		for (depth, (scope, vars)) in (0_u32..).zip(&self.scopes) {
			f(Key::Scope(depth), scope);
			for (name, r) in vars {
				f(Key::Local { depth, name: BStr::new(name) }, r);
			}
		}
		for (k, r) in &self.records {
			f(k.as_key(), r);
		}
	}

	fn each_deferred(&self, f: &mut dyn FnMut(Key<'_>, &Record)) {
		for (name, value) in &self.deferred {
			if let Some(record) = value.record() {
				f(Key::Var(BStr::new(name)), record);
			}
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
			Key::Var(name) => {
				let name: &[u8] = name;
				self.deferred.remove(name);
				match self.vars.get_mut(name) {
					Some(slot) => *slot = record,
					None => {
						self.vars.insert(BString::from(name), record);
					},
				}
			},
			Key::Scope(depth) => {
				let depth = depth as usize;
				if depth == self.scopes.len() {
					self.scopes.push((record, HashMap::new()));
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
				let name: &[u8] = name;
				match vars.get_mut(name) {
					Some(slot) => *slot = record,
					None => {
						vars.insert(BString::from(name), record);
					},
				}
			},
			_ => match self.records.get_mut(&key) {
				Some(slot) => *slot = record,
				None => {
					self.records.insert(key.to_buf(), record);
				},
			},
		}
		Ok(())
	}

	/// Delete the record at `key` ([`Change::Del`]).
	fn del(&mut self, key: Key<'_>) {
		match key {
			Key::Var(name) => {
				self.vars.remove(bytes(name));
				self.deferred.remove(bytes(name));
			},
			Key::Scope(depth) => self.scopes.truncate(depth as usize),
			Key::Local { depth, name } => {
				if let Some((_, vars)) = self.scopes.get_mut(depth as usize) {
					vars.remove(bytes(name));
				}
			},
			_ => {
				self.records.remove(&key);
			},
		}
	}

	/// The variable record at `key` ([`Key::Var`] or [`Key::Local`]), for
	/// an in-place change.
	#[inline]
	fn var_mut(&mut self, key: Key<'_>) -> Option<&mut VarValue> {
		let record = match key {
			Key::Var(name) => match self.vars.entry_ref(name) {
				EntryRef::Occupied(slot) => Some(slot.into_mut()),
				EntryRef::Vacant(slot) => {
					let record = self.deferred.remove(bytes(name))?.record()?.clone();
					Some(slot.insert(record))
				},
			},
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
	fn defer_scalar(
		&mut self,
		name: &[u8],
		attrs: Attrs,
		initializer: fn() -> Option<BString>,
	) -> Result<bool, StoreError> {
		self.vars.remove(name);
		self.deferred.insert(
			BString::from(name),
			Arc::new(DeferredScalar { initializer, attrs, record: OnceLock::new() }),
		);
		Ok(true)
	}

	fn get(&mut self, key: Key<'_>) -> Result<Option<&Record>, StoreError> {
		Ok(self.record(key))
	}

	fn scan(&mut self, table: Table, f: &mut dyn FnMut(Key<'_>, &Record)) -> Result<(), StoreError> {
		match table {
			Table::Var => {
				for (name, r) in &self.vars {
					f(Key::Var(BStr::new(name)), r);
				}
				self.each_deferred(f);
			},
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
				for (k, r) in self
					.records
					.iter()
					.filter(|(k, _)| k.as_key().table() == table)
				{
					f(k.as_key(), r);
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
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::{AtomicUsize, Ordering};

	use super::*;

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
