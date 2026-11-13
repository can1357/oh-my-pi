//! [`Image`]: the state a fork copies, as persistent maps.
//!
//! A virtual process's global variables and every other record it owns
//! (functions, aliases, options, traps, the directory stack, `hash`
//! entries, the process-owned miscellaneous values). [`MemStore`] keeps the
//! root shell's records in one, so [`StateStore::snapshot`] hands a child
//! the root's state in O(1); a child vproc owns its own and writes to it.
//! Clones share their entries until one writes (see [`CowMap`]).
//!
//! [`MemStore`]: crate::bash::MemStore
//! [`StateStore::snapshot`]: crate::bash::store::StateStore::snapshot

use std::sync::{Arc, OnceLock};

use bstr::{BStr, BString};
use serde::{Deserialize, Serialize};

use crate::bash::{
	cow_map::{CowMap, WeakCowMap},
	store::{Attrs, Key, KeyBuf, Record, Table, Var, VarValue},
};

/// A host default whose lookup waits until a reader observes it
/// ([`crate::bash::store::StateStore::defer_scalar`]); memoized, and shared
/// by every image cloned while it waits.
#[derive(Debug)]
struct Deferred {
	initializer: fn() -> Option<BString>,
	attrs:       Attrs,
	record:      OnceLock<Option<Record>>,
}

impl Deferred {
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

/// A global variable's slot.
#[derive(Clone, Debug)]
enum Slot {
	Set(Record),
	Deferred(Arc<Deferred>),
}

impl Slot {
	fn record(&self) -> Option<&Record> {
		match self {
			Self::Set(r) => Some(r),
			Self::Deferred(d) => d.record(),
		}
	}
}

/// Global variables and other records (see the module docs).
#[derive(Clone, Debug, Default)]
pub struct Image {
	vars:    CowMap<BString, Slot>,
	records: CowMap<KeyBuf, Record>,
}

impl PartialEq for Image {
	fn eq(&self, other: &Self) -> bool {
		self.records == other.records
			&& (self.vars.same_as(&other.vars) || {
				let mut a = 0;
				self.each_var(&mut |_, _| a += 1);
				let mut b = 0;
				other.each_var(&mut |_, _| b += 1);
				a == b && {
					let mut same = true;
					self.each_var(&mut |name, r| same &= other.var_record(name) == Some(r));
					same
				}
			})
	}
}

impl Eq for Image {}

impl Image {
	/// Global variable `name`'s record.
	#[inline]
	pub fn var_record(&self, name: &[u8]) -> Option<&Record> {
		self.vars.get(name)?.record()
	}

	/// Global variable `name`.
	#[inline]
	pub fn var(&self, name: &[u8]) -> Option<&Var> {
		match self.var_record(name)? {
			Record::Var(v) => Some(v),
			_ => None,
		}
	}

	/// The record at `key`: a global variable or another record. Scopes and
	/// their locals are not in an image.
	#[inline]
	pub fn get(&self, key: Key<'_>) -> Option<&Record> {
		match key {
			Key::Var(name) => self.var_record(name),
			Key::Scope(_) | Key::Local { .. } => None,
			_ => self.records.get(&key),
		}
	}

	/// Insert or replace global variable `name`.
	pub fn put_var(&mut self, name: &[u8], record: Record) {
		self
			.vars
			.set(name, Slot::Set(record), |name| BString::from(name));
	}

	/// Global variable `name`, set by `initializer` when first observed.
	pub fn defer_var(&mut self, name: &[u8], attrs: Attrs, initializer: fn() -> Option<BString>) {
		let slot = Slot::Deferred(Arc::new(Deferred { initializer, attrs, record: OnceLock::new() }));
		self.vars.insert(BString::from(name), slot);
	}

	/// Remove every global variable (a new shell's image keeps none of its
	/// parent's).
	pub fn clear_vars(&mut self) {
		self.vars = CowMap::default();
	}

	/// Remove global variable `name`; whether it was there.
	pub fn del_var(&mut self, name: &[u8]) -> bool {
		self.vars.remove(name)
	}

	/// Global variable `name`'s record for an in-place change (a deferred
	/// default is resolved first; `None` when it resolved to nothing).
	pub fn var_mut(&mut self, name: &[u8]) -> Option<&mut Record> {
		let slot = self.vars.get_mut(name)?;
		if let Slot::Deferred(d) = slot {
			*slot = Slot::Set(d.record()?.clone());
		}
		match slot {
			Slot::Set(r) => Some(r),
			Slot::Deferred(_) => None,
		}
	}

	/// Insert or replace the record at `key` (not a variable or scope).
	pub fn put(&mut self, key: Key<'_>, record: Record) {
		self.records.set(&key, record, Key::to_buf);
	}

	/// Remove the record at `key` (not a variable or scope).
	pub fn del(&mut self, key: Key<'_>) -> bool {
		self.records.remove(&key)
	}

	/// Visit every global variable (deferred ones resolved).
	pub fn each_var(&self, f: &mut dyn FnMut(&BStr, &Record)) {
		for (name, slot) in self.vars.iter() {
			if let Some(r) = slot.record() {
				f(BStr::new(name), r);
			}
		}
	}

	/// Visit every record of `table` (not variables or scopes).
	pub fn each_record(&self, table: Table, f: &mut dyn FnMut(Key<'_>, &Record)) {
		for (k, r) in self.records.iter() {
			let key = k.as_key();
			if key.table() == table {
				f(key, r);
			}
		}
	}

	/// Visit every record other than a variable.
	pub fn each_other(&self, f: &mut dyn FnMut(Key<'_>, &Record)) {
		for (k, r) in self.records.iter() {
			f(k.as_key(), r);
		}
	}

	/// Set global variable `name` to `var`, or remove it (`None`).
	pub fn set_var(&mut self, name: &[u8], var: Option<Var>) {
		match var {
			Some(v) => self.put_var(name, Record::Var(v)),
			None => {
				self.del_var(name);
			},
		}
	}

	/// Set the record at `key` (not a variable or scope), or remove it
	/// (`None`).
	pub fn set(&mut self, key: Key<'_>, record: Option<Record>) {
		match record {
			Some(r) => self.put(key, r),
			None => {
				self.del(key);
			},
		}
	}

	/// What `self` changed relative to `base` (the image it was cloned
	/// from, or another clone of that lineage), in its forked records
	/// ([`Key::forked`]) only: what a restore needs to rebuild `self` from
	/// `base`. Shared entries cost nothing to skip ([`CowMap::diff`]); an
	/// entry written since but holding `base`'s value (a run's environment
	/// put back) is no change either.
	pub fn diff(&self, base: &Self) -> ImageDiff {
		let mut vars = Vec::new();
		self.vars.diff(&base.vars, |name, slot| {
			let record = slot.and_then(Slot::record);
			if record != base.var_record(name) {
				vars.push((name.clone(), record.cloned()));
			}
		});
		let mut records = Vec::new();
		self.records.diff(&base.records, |key, rec| {
			if key.as_key().forked() && rec != base.records.get(key) {
				records.push((key.clone(), rec.cloned()));
			}
		});
		vars.sort_unstable_by(|a, b| a.0.cmp(&b.0));
		records.sort_unstable_by(|a, b| a.0.cmp(&b.0));
		ImageDiff { vars, records }
	}

	/// `base` with `diff` applied ([`Self::diff`] backwards).
	pub fn patched(mut base: Self, diff: ImageDiff) -> Self {
		for (name, rec) in diff.vars {
			match rec {
				Some(r) => base.put_var(&name, r),
				None => {
					base.del_var(&name);
				},
			}
		}
		for (key, rec) in diff.records {
			base.set(key.as_key(), rec);
		}
		base
	}

	/// A handle on the image's records other than variables (O(1)), to
	/// recognise and reuse them ([`Self::shares_records`],
	/// [`Self::set_records`]). It does not keep them shared: once no image
	/// holds them, it neither matches nor gives them back.
	pub fn records(&self) -> Records {
		Records(self.records.downgrade())
	}

	/// Whether the image's records other than variables are `records`,
	/// untouched since.
	pub fn shares_records(&self, records: &Records) -> bool {
		self.records.same_as_weak(&records.0)
	}

	/// Replace the image's records other than variables with `records`;
	/// `false` (and no change) when no image holds them any more.
	pub fn set_records(&mut self, records: &Records) -> bool {
		match records.0.upgrade() {
			Some(map) => {
				self.records = map;
				true
			},
			None => false,
		}
	}

	/// Number of records (deferred variables counted once observed).
	pub fn len(&self) -> usize {
		let mut vars = 0;
		self.each_var(&mut |_, _| vars += 1);
		vars + self.records.len()
	}

	/// Whether the image holds nothing.
	pub fn is_empty(&self) -> bool {
		self.len() == 0
	}
}

/// An [`Image`]'s records other than variables ([`Image::records`]), held
/// weakly.
#[derive(Clone, Debug)]
pub struct Records(WeakCowMap<KeyBuf, Record>);

/// An [`Image`] relative to another ([`Image::diff`]): the serialized form
/// of a forked vproc's image, against the root's when it was saved.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageDiff {
	/// Global variables changed (`None`: removed).
	vars:    Vec<(BString, Option<Record>)>,
	/// Other forked records changed (`None`: removed).
	records: Vec<(KeyBuf, Option<Record>)>,
}

impl ImageDiff {
	/// The records the diff sets (to find the compiled units of the
	/// functions it holds).
	pub fn records(&self) -> impl Iterator<Item = &Record> {
		self.records.iter().filter_map(|(_, r)| r.as_ref())
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::store::MiscKey;

	fn scalar(v: &str) -> Record {
		Record::Var(Var::scalar(v, Attrs::NONE))
	}

	/// A child's image survives a save against the root's changed image:
	/// its own writes, removals and the fork-time values the root has since
	/// overwritten all come back; kernel records are not the child's.
	#[test]
	fn diff_against_a_changed_root_rebuilds_the_child() {
		let mut root = Image::default();
		for i in 0..300 {
			root.put_var(format!("v{i}").as_bytes(), scalar("root"));
		}
		root.put(Key::Misc(MiscKey::Umask), Record::Misc("022".into()));
		let mut child = root.clone();
		child.put_var(b"v1", scalar("child"));
		child.del_var(b"v2");
		child.put(Key::Misc(MiscKey::Umask), Record::Misc("077".into()));
		child.put(Key::Misc(MiscKey::NextVpid), Record::Misc("99".into()));
		root.put_var(b"v3", scalar("later"));
		root.put_var(b"new", scalar("later"));
		let rebuilt = Image::patched(root.clone(), child.diff(&root));
		assert_eq!(rebuilt.var_record(b"v1"), Some(&scalar("child")));
		assert_eq!(rebuilt.var_record(b"v2"), None);
		assert_eq!(rebuilt.var_record(b"v3"), Some(&scalar("root")));
		assert_eq!(rebuilt.var_record(b"new"), None);
		assert_eq!(rebuilt.get(Key::Misc(MiscKey::Umask)), Some(&Record::Misc("077".into())));
		assert_eq!(rebuilt.get(Key::Misc(MiscKey::NextVpid)), None);
		assert_eq!(rebuilt.len(), child.len() - 1);
	}

	/// A record written back with the value it had (a run's environment
	/// put back, a `PWD` set again) is no change: a diff leaves it out, so
	/// a saved image never carries the base's values as the child's own.
	#[test]
	fn diff_leaves_out_values_written_back_unchanged() {
		let mut base = Image::default();
		base.put_var(b"v", scalar("same"));
		base.put(Key::Misc(MiscKey::Umask), Record::Misc("022".into()));
		let mut child = base.clone();
		child.put_var(b"v", scalar("other"));
		child.put_var(b"v", scalar("same"));
		child.put(Key::Misc(MiscKey::Umask), Record::Misc("022".into()));
		child.put_var(b"w", scalar("new"));
		let diff = child.diff(&base);
		assert_eq!(diff.vars, vec![(BString::from("w"), Some(scalar("new")))]);
		assert!(diff.records.is_empty());
	}
}
