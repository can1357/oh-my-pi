//! Shell state as one virtual process sees it: its function-local scopes,
//! then its subshell overlay, then the root state in the [`StateStore`].
//!
//! The store is the root state: reads go to it and every
//! write is applied to it when the engine makes it. The root vproc's scopes
//! are store records too ([`Key::Scope`], [`Key::Local`]); a subshell vproc
//! keeps its own (`Vproc::scopes`) and its overlay, which reach the store
//! only inside the `Frames` blob. The engine keeps only facts derived from
//! the store ([`Root`]), kept exact by its own writes and dropped when the
//! store's epoch says another writer changed it.

use std::collections::HashMap;

use bstr::{BStr, BString};
use hashbrown::DefaultHashBuilder;
use serde::{Deserialize, Serialize};

use super::proc::{GetoptsState, JobTable, LastBg, Vproc};
pub use crate::bash::store::Var;
use crate::bash::{
	host::Rlimit,
	ids::{JobId, Vpid},
	store::{
		Attrs, Change, Elem, Key, KeyBuf, MiscKey, OptId, Record, StateStore, StoreError, Table,
		VarValue, ZshScope,
	},
	zshopt::{ZshOpt, ZshOpts},
};

/// bash's `$RANDOM` generator (`lib/sh/random.c`): the Park–Miller
/// minimal standard generator, folded to 15 bits, never repeating the
/// previous value.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Random {
	seed: u32,
	last: u32,
}

impl Random {
	/// A generator seeded with `seed`.
	pub const fn new(seed: u32) -> Self {
		Self { seed, last: 0 }
	}

	/// Reseed (`RANDOM=value`; bash's `sbrand`, which keeps the low 32
	/// bits).
	pub const fn seed(&mut self, seed: i64) {
		self.seed = seed as u32;
		self.last = 0;
	}

	/// bash's `intrand32`: 16807·x mod (2³¹−1), zero replaced.
	const fn step(last: u32) -> u32 {
		let x = if last == 0 { 123_459_876 } else { last };
		let (h, l) = ((x / 127_773) as i32, (x % 127_773) as i32);
		let t = 16807_i32
			.wrapping_mul(l)
			.wrapping_sub(2836_i32.wrapping_mul(h));
		if t < 0 {
			t.wrapping_add(0x7fff_ffff) as u32
		} else {
			t as u32
		}
	}

	/// The next `$RANDOM` value (0–32767).
	pub const fn next(&mut self) -> u32 {
		loop {
			self.seed = Self::step(self.seed);
			let v = ((self.seed >> 16) ^ (self.seed & 0xffff)) & 0x7fff;
			if v != self.last {
				self.last = v;
				return v;
			}
		}
	}
}

/// Buckets of a new associative array (bash's `ASSOC_HASH_BUCKETS`).
const ASSOC_BUCKETS: usize = 1024;

/// bash's `hash_string`: 32-bit FNV-1 (multiply, then xor).
fn fnv1(key: &[u8]) -> u32 {
	key.iter()
		.fold(2_166_136_261_u32, |h, &c| h.wrapping_mul(16_777_619) ^ u32::from(c))
}

/// The entries of an associative array, kept in insertion order, in bash's
/// iteration order: its hash table (`hashlib.c`) walked bucket by bucket,
/// each bucket newest first. The table is replayed from the entries: it
/// starts at [`ASSOC_BUCKETS`] buckets and grows fourfold, re-linking
/// every bucket's items onto the heads of the new ones, when an insertion
/// finds as many entries as twice the buckets.
///
/// Approximations: bash gives a scalar converted by `declare -A` a
/// 128-bucket table, and a table that grew before some of its entries
/// were unset keeps its size; the replay uses 1024 buckets and the
/// surviving entries only. Both only matter with bucket collisions.
/// [`Attrs::SMALL_HASH`] in `attrs` means bash's default 128-bucket table.
pub fn assoc_order_sized(items: &[(BString, BString)], attrs: Attrs) -> Vec<&(BString, BString)> {
	let buckets = if attrs.contains(Attrs::SMALL_HASH) {
		SMALL_HASH_BUCKETS
	} else {
		ASSOC_BUCKETS
	};
	hash_order(items, buckets)
}

/// bash's `DEFAULT_HASH_BUCKETS`.
const SMALL_HASH_BUCKETS: usize = 128;

/// Buckets of bash's command hash table (`FILENAME_HASH_BUCKETS`).
pub const CMD_HASH_BUCKETS: usize = 256;

/// Buckets of bash's alias table (`ALIAS_HASH_BUCKETS`); `BASH_ALIASES`
/// lists in its order.
pub const ALIAS_HASH_BUCKETS: usize = 64;

/// The order bash's hash table of `buckets` initial buckets (a power of
/// two) lists `items` (kept in insertion order) in; see [`assoc_order_sized`].
pub fn hash_order(items: &[(BString, BString)], buckets: usize) -> Vec<&(BString, BString)> {
	let hashes: Vec<u32> = items.iter().map(|(k, _)| fnv1(k)).collect();
	let bucket = |h: u32, n: usize| h as usize & (n - 1);
	if items.len() <= buckets * 2 {
		// No growth: bucket order, then newest first.
		let mut order: Vec<usize> = (0..items.len()).collect();
		order.sort_unstable_by_key(|&i| (bucket(hashes[i], buckets), std::cmp::Reverse(i)));
		return order.into_iter().map(|i| &items[i]).collect();
	}
	// Each bucket lists its items oldest-linked first, so the head is last.
	let mut n = buckets;
	let mut table: Vec<Vec<usize>> = vec![Vec::new(); n];
	for i in 0..items.len() {
		if i >= n * 2 {
			let grown = n * 4;
			let mut next: Vec<Vec<usize>> = vec![Vec::new(); grown];
			for old in &table {
				for &j in old.iter().rev() {
					next[bucket(hashes[j], grown)].push(j);
				}
			}
			table = next;
			n = grown;
		}
		table[bucket(hashes[i], n)].push(i);
	}
	table
		.iter()
		.flat_map(|b| b.iter().rev())
		.map(|&i| &items[i])
		.collect()
}

impl Var {
	/// A scalar variable.
	pub fn scalar(value: impl Into<BString>, attrs: Attrs) -> Self {
		Self { attrs, value: VarValue::Str(value.into()) }
	}

	/// The scalar view: a string, element 0 of an indexed array, key "0" of
	/// an associative one.
	pub fn as_scalar(&self) -> Option<&[u8]> {
		value_scalar(&self.value)
	}

	/// Every element value, in index (or bash iteration) order; a scalar is
	/// one element.
	pub fn values(&self) -> Vec<BString> {
		match &self.value {
			VarValue::Str(s) => vec![s.clone()],
			VarValue::Indexed(items) => items.iter().map(|(_, v)| v.clone()).collect(),
			VarValue::Assoc(items) => assoc_order_sized(items, self.attrs)
				.into_iter()
				.map(|(_, v)| v.clone())
				.collect(),
		}
	}

	/// Every key (indexes as decimal text).
	pub fn keys(&self) -> Vec<BString> {
		match &self.value {
			VarValue::Str(_) => vec![BString::from("0")],
			VarValue::Indexed(items) => items
				.iter()
				.map(|(i, _)| BString::from(i.to_string()))
				.collect(),
			VarValue::Assoc(items) => assoc_order_sized(items, self.attrs)
				.into_iter()
				.map(|(k, _)| k.clone())
				.collect(),
		}
	}

	/// Element `i` of an indexed array (a scalar is element 0).
	pub fn index(&self, i: i64) -> Option<&[u8]> {
		match &self.value {
			VarValue::Str(s) => (i == 0).then_some(s.as_slice()),
			VarValue::Indexed(items) => items
				.binary_search_by_key(&i, |(k, _)| *k)
				.ok()
				.map(|p| items[p].1.as_slice()),
			VarValue::Assoc(items) => {
				let key = i.to_string();
				items.get(key.as_bytes()).map(|v| v.as_slice())
			},
		}
	}

	/// Element with key `key` of an associative array.
	pub fn key(&self, key: &[u8]) -> Option<&[u8]> {
		match &self.value {
			VarValue::Assoc(items) => items.get(key).map(|v| v.as_slice()),
			_ => None,
		}
	}

	/// Highest index + 1 of an indexed array (0 when empty).
	pub fn next_index(&self) -> i64 {
		match &self.value {
			VarValue::Indexed(items) => items.last().map_or(0, |(i, _)| i + 1),
			VarValue::Str(_) => 1,
			VarValue::Assoc(_) => 0,
		}
	}

	/// Set element `i`, converting a scalar to an indexed array.
	pub fn set_index(&mut self, i: i64, v: BString) {
		if let VarValue::Str(s) = &self.value {
			self.value = VarValue::Indexed(vec![(0, s.clone())]);
		}
		if let VarValue::Indexed(items) = &mut self.value {
			match items.binary_search_by_key(&i, |(k, _)| *k) {
				Ok(p) => items[p].1 = v,
				Err(p) => items.insert(p, (i, v)),
			}
		}
	}

	/// Set element `key` of an associative array (insertion order kept).
	pub fn set_key(&mut self, key: BString, v: BString) {
		if let VarValue::Assoc(items) = &mut self.value {
			items.insert(key, v);
		}
	}
}

/// Variables of a function scope or subshell overlay, by name. Hashed with
/// foldhash rather than the std default: name lookups run on every expansion
/// and assignment, and the default hasher dominated the dispatch loop.
pub type VarMap = HashMap<BString, Option<Var>, DefaultHashBuilder>;

/// A subshell's copy-on-write view over its parent's state.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Overlay {
	/// Variables written (`Some`) or unset (`None`) in the subshell.
	pub vars:       VarMap,
	/// Other records (functions, aliases, options, misc) written or removed.
	pub records:    HashMap<KeyBuf, Option<Record>, DefaultHashBuilder>,
	/// The subshell's positional parameters, when they differ.
	pub positional: Option<Vec<BString>>,
}

/// A function's local scope, or the temporary environment of a builtin
/// (`IFS=: read …`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Scope {
	/// Local variables (`None`: declared local, unset).
	pub vars:       VarMap,
	/// Positional parameters of a function call (`None`: inherited).
	pub positional: Option<Vec<BString>>,
	/// Function name (`FUNCNAME`); `None` for a temporary environment.
	pub func:       Option<BString>,
	/// What a zsh-dialect or mode-switching call restores on return
	/// ([`Record::Scope`]'s `zsh`).
	pub zsh:        Option<Box<ZshScope>>,
}

impl Random {
	/// The generator as [`MiscKey::Random`] stores it: `seed:last`.
	pub fn encode(self) -> BString {
		BString::from(format!("{}:{}", self.seed, self.last))
	}

	/// A generator from [`Random::encode`]'s text.
	pub fn decode(text: &[u8]) -> Option<Self> {
		let text = std::str::from_utf8(text).ok()?;
		let (seed, last) = text.split_once(':')?;
		Some(Self { seed: seed.parse().ok()?, last: last.parse().ok()? })
	}
}

/// What the engine derives from the root state in the store. Kept exact by
/// the engine's own writes (every root write goes through [`Root::write`],
/// [`Root::set_var`] or [`Root::set_record`]) and rebuilt from the store
/// by [`Root::invalidate`] when the store's epoch says another writer
/// changed it. Holds no store data.
#[derive(Debug, Default)]
pub struct Root {
	epoch:             u64,
	/// Root scopes in the store: [`Key::Scope`] `0..depth`. Only the engine
	/// pushes and pops them; recounted on invalidation.
	depth:             u32,
	/// Root scopes below [`SCOPE_BITS`] that may bind a local (bit `d` for
	/// scope `d`): set by every [`Key::Local`] write, cleared when the scope
	/// is popped (an unset local keeps it). A name lookup reads only these
	/// scopes from the store (and every scope from [`SCOPE_BITS`] up): a
	/// function that declared nothing costs no read per variable.
	locals:            u64,
	/// Root scopes below [`SCOPE_BITS`] that belong to a function (exact).
	funcs:             u64,
	/// Root scopes below [`SCOPE_BITS`] that hold positional parameters
	/// (exact).
	params:            u64,
	/// Whether a root variable (global or scope-local) may be a name
	/// reference: set by every write of one, recomputed from the store on
	/// invalidation. While it is clear, the root vproc's lookups read a
	/// variable once and [`deref`] answers [`Deref::Plain`] without reading.
	namerefs:          bool,
	/// Empty temporary-environment scopes on top of those (every builtin
	/// runs in one, most without prefix assignments): written to the store
	/// only once something is bound in one of them or a scope is pushed
	/// above ([`Self::materialize`]), so a builtin costs no store write.
	/// They hold nothing a reader could see.
	lazy:              u32,
	/// Root option values, one bit per [`OptId`]; a bit is valid where
	/// `opts_known` has it. Kept exact by [`Self::set_record`] and
	/// [`Self::invalidate`]: option reads run several times per command
	/// (`noglob`/`extglob` per expansion, `errexit`, `functrace`).
	opts_on:           u128,
	opts_known:        u128,
	/// Root zsh option values ([`Key::ZshOpt`]), valid where `zopts_known`
	/// has the bit; read only by zsh-dialect code, so the bash paths never
	/// touch them.
	zopts_on:          ZshOpts,
	zopts_known:       ZshOpts,
	/// Bumped whenever a root option record changes or the option facts are
	/// dropped: what a cache of option-derived settings is valid for
	/// ([`Self::opts_gen`]).
	opts_gen:          u64,
	/// Whether the root `DisabledBuiltins` list is non-empty (`None`: not
	/// read since the last invalidation), for `builtins_disabled()`.
	builtins_disabled: Option<bool>,
	/// Bumped by every write of a root `LANG`/`LC_*` variable and every
	/// invalidation; see [`locale_token`].
	locale_gen:        u64,
	/// [`super::locale::charset`]'s last answer and the [`locale_token`] it
	/// was computed at (single entry; a token change misses).
	pub charset:       Option<(u64, super::locale::Charset)>,
	/// The first store call that failed since the kernel last looked
	/// ([`Self::take_fault`]).
	fault:             Option<StoreError>,
	/// The root vproc's in-place fields as last written ([`sync_root`]).
	synced:            Synced,
	/// zsh's history events as last written (mirrors their store record).
	pub hist_events:   parking_lot::Mutex<super::builtins::history::model::EventsCache>,
}

/// The root vproc's fields the interpreter updates in place (`vp.status = …`
/// at many sites), as [`sync_root`] last wrote them to the store. Only the
/// engine writes these records (the TS views of them are read-only).
#[derive(Debug, Default)]
struct Synced {
	status:     i32,
	pipestatus: Vec<i32>,
	last_bg:    LastBg,
	/// The ids of the jobs written, in table order. The jobs themselves are
	/// compared with their store records (no copy of the table).
	job_ids:    Vec<JobId>,
	/// `%+`, `%-` and the owed `SIGCHLD` runs as written.
	job_marks:  (Option<u32>, Option<u32>, u32),
	getopts:    GetoptsState,
	rlimits:    Vec<(Rlimit, Option<u64>, Option<u64>)>,
}

/// Root scopes the [`Root`] bitmasks track: `0..SCOPE_BITS`. Deeper ones
/// (recursion past 64 calls) are read from the store.
const SCOPE_BITS: u32 = u64::BITS;

/// The mask bit of root scope `depth`; `None` from [`SCOPE_BITS`] up.
const fn scope_bit(depth: u32) -> Option<u64> {
	1_u64.checked_shl(depth)
}

/// The mask bits of the root scopes below `depth`.
const fn below(depth: u32) -> u64 {
	match scope_bit(depth) {
		Some(bit) => bit - 1,
		None => u64::MAX,
	}
}

/// The innermost scope of `mask` below `depth`.
const fn top_bit(mask: u64, depth: u32) -> Option<u32> {
	(mask & below(depth)).checked_ilog2()
}

/// Set or clear `bit` of `mask`.
const fn set_bit(mask: &mut u64, bit: u64, on: bool) {
	if on {
		*mask |= bit;
	} else {
		*mask &= !bit;
	}
}

/// Whether `rec` is a name reference variable.
const fn is_nameref(rec: &Record) -> bool {
	matches!(rec, Record::Var(v) if v.attrs.contains(Attrs::NAMEREF))
}

/// Whether `name` is a locale variable [`Root`] counts writes of.
fn is_locale_name(name: &[u8]) -> bool {
	name == b"LANG" || name.starts_with(b"LC_")
}

/// The bit of `opt` in [`Root`]'s option bitset.
const fn opt_bit(opt: OptId) -> u128 {
	1 << (opt as u8)
}

/// The value an option record stands for (`None` or another shape: the
/// default), as [`option`] reads it.
const fn opt_value(opt: OptId, rec: Option<&Record>) -> bool {
	match rec {
		Some(Record::Opt(on)) => *on,
		_ => opt.default_on(),
	}
}

/// The value a zsh option record stands for (`None` or another shape: the
/// `zsh` emulation default).
const fn zsh_opt_value(opt: ZshOpt, rec: Option<&Record>) -> bool {
	match rec {
		Some(Record::Opt(on)) => *on,
		_ => opt.default_in(crate::bash::ids::ModeId::Zsh),
	}
}

/// The store key of global variable `name`.
fn var_key(name: &[u8]) -> Key<'_> {
	Key::Var(BStr::new(name))
}

/// The store key of `name` in root scope `depth`.
fn local_key(depth: u32, name: &[u8]) -> Key<'_> {
	Key::Local { depth, name: BStr::new(name) }
}

/// The record a scope binding is stored as (`None`: declared, unset).
fn binding_record(var: Option<Var>) -> Record {
	var.map_or(Record::Unset, Record::Var)
}

impl Root {
	/// Facts derived from `store` as it is (a new shell's, a restored one's).
	///
	/// # Errors
	/// [`StoreError`] when the store cannot be scanned.
	pub fn load(store: &mut dyn StateStore) -> Result<Self, StoreError> {
		let mut root = Self { epoch: store.epoch(), ..Self::default() };
		root.rescan(store)?;
		Ok(root)
	}

	/// Count the root scopes and rebuild the scope masks and the nameref
	/// flag from the store: one scan of the scopes, their locals and the
	/// global variables.
	fn rescan(&mut self, store: &mut dyn StateStore) -> Result<(), StoreError> {
		let (mut depth, mut funcs, mut params) = (0_u32, 0_u64, 0_u64);
		store.scan(Table::Scope, &mut |key, rec| {
			depth += 1;
			if let (Key::Scope(d), Record::Scope { func, positional, .. }) = (key, rec)
				&& let Some(bit) = scope_bit(d)
			{
				set_bit(&mut funcs, bit, func.is_some());
				set_bit(&mut params, bit, positional.is_some());
			}
		})?;
		let (mut locals, mut namerefs) = (0_u64, false);
		store.scan(Table::Local, &mut |key, rec| {
			if let Key::Local { depth, .. } = key
				&& let Some(bit) = scope_bit(depth)
			{
				locals |= bit;
			}
			namerefs |= is_nameref(rec);
		})?;
		store.scan(Table::Var, &mut |_, rec| namerefs |= is_nameref(rec))?;
		self.depth = depth;
		self.locals = locals;
		self.funcs = funcs;
		self.params = params;
		self.namerefs = namerefs;
		Ok(())
	}

	/// The store epoch these facts were derived at.
	pub const fn epoch(&self) -> u64 {
		self.epoch
	}

	/// Write the lazy empty scopes ([`Self::lazy`]) as store records: before
	/// a scope is pushed above them, something is bound in one, or the
	/// frames are externalized (a restored shell counts the store's).
	pub fn materialize(&mut self, store: &mut dyn StateStore) {
		while self.lazy > 0 {
			let rec = Record::Scope { func: None, positional: None, zsh: None };
			self.write(store, Change::Put(Key::Scope(self.depth), rec));
			self.depth += 1;
			self.lazy -= 1;
		}
	}

	/// Drop every root scope (a shell restored without its frames: the
	/// function calls they belonged to are gone).
	pub fn drop_scopes(&mut self, store: &mut dyn StateStore) {
		if self.depth > 0 {
			self.write(store, Change::Del(Key::Scope(0)));
		}
		self.depth = 0;
		self.lazy = 0;
	}

	/// Another writer changed the store, whose epoch is now `epoch`: drop
	/// the derived facts and rebuild the scope facts from the store.
	pub fn invalidate(&mut self, store: &mut dyn StateStore, epoch: u64) {
		self.epoch = epoch;
		self.opts_known = 0;
		self.zopts_known = ZshOpts::default();
		self.builtins_disabled = None;
		self.locale_gen += 1;
		self.opts_gen += 1;
		self.hist_events.lock().clear();
		if let Err(err) = self.rescan(store) {
			self.fail(err);
		}
	}

	/// Keep a failed store call for the kernel, which abandons the running
	/// scripts at its next turn (only the first one is kept).
	pub fn fail(&mut self, err: StoreError) {
		if self.fault.is_none() {
			self.fault = Some(err);
		}
	}

	/// Whether a store call failed since the kernel last looked.
	pub const fn has_fault(&self) -> bool {
		self.fault.is_some()
	}

	/// The failure kept by [`Self::fail`], once.
	pub const fn take_fault(&mut self) -> Option<StoreError> {
		self.fault.take()
	}

	/// Apply `change` to the store now; a failure is kept
	/// ([`Self::fail`]).
	pub fn write(&mut self, store: &mut dyn StateStore, change: Change<'_>) {
		self.note(&change);
		if let Err(err) = store.apply(change) {
			self.fail(err);
		}
	}

	/// Keep the scope masks and the nameref flag exact for `change`
	/// (variable edits keep their attributes, so only `Put` and `Del`
	/// matter).
	const fn note(&mut self, change: &Change<'_>) {
		match change {
			Change::Put(Key::Scope(depth), Record::Scope { func, positional, .. }) => {
				if let Some(bit) = scope_bit(*depth) {
					set_bit(&mut self.funcs, bit, func.is_some());
					set_bit(&mut self.params, bit, positional.is_some());
				}
			},
			Change::Put(key @ (Key::Var(_) | Key::Local { .. }), rec) => {
				if let Key::Local { depth, .. } = key
					&& let Some(bit) = scope_bit(*depth)
				{
					self.locals |= bit;
				}
				self.namerefs |= is_nameref(rec);
			},
			// Deleting a scope deletes every scope above it too.
			Change::Del(Key::Scope(depth)) => {
				let keep = below(*depth);
				self.locals &= keep;
				self.funcs &= keep;
				self.params &= keep;
			},
			_ => {},
		}
	}

	/// Write (or unset, with `None`) global variable `name`.
	pub fn set_var(&mut self, store: &mut dyn StateStore, name: &[u8], var: Option<Var>) {
		if is_locale_name(name) {
			self.locale_gen += 1;
		}
		let key = var_key(name);
		let change = match var {
			Some(v) => Change::Put(key, Record::Var(v)),
			None => Change::Del(key),
		};
		self.write(store, change);
	}

	/// Write (or remove, with `None`) a root record other than a variable
	/// or a scope.
	pub fn set_record(&mut self, store: &mut dyn StateStore, key: KeyBuf, rec: Option<Record>) {
		match &key {
			KeyBuf::Opt(opt) => {
				let bit = opt_bit(*opt);
				self.opts_known |= bit;
				if opt_value(*opt, rec.as_ref()) {
					self.opts_on |= bit;
				} else {
					self.opts_on &= !bit;
				}
				self.opts_gen += 1;
			},
			KeyBuf::ZshOpt(opt) => {
				self.zopts_known.set(*opt, true);
				self.zopts_on.set(*opt, zsh_opt_value(*opt, rec.as_ref()));
				self.opts_gen += 1;
			},
			KeyBuf::Misc(MiscKey::DisabledBuiltins) => {
				self.builtins_disabled = Some(matches!(&rec, Some(Record::Words(w)) if !w.is_empty()));
			},
			_ => {},
		}
		let change = match rec {
			Some(r) => Change::Put(key.as_key(), r),
			None => Change::Del(key.as_key()),
		};
		self.write(store, change);
	}

	/// Changes whenever a root option record does (or the option facts are
	/// dropped): settings derived from root options stay valid while it is
	/// the same.
	pub const fn opts_gen(&self) -> u64 {
		self.opts_gen
	}

	/// The root value of `opt`: a bit test once it was read or written.
	///
	/// # Errors
	/// [`StoreError`] when the option record cannot be read.
	#[inline]
	pub fn option(&mut self, store: &mut dyn StateStore, opt: OptId) -> Result<bool, StoreError> {
		let bit = opt_bit(opt);
		if self.opts_known & bit == 0 {
			let on = opt_value(opt, store.get(Key::Opt(opt))?);
			self.opts_known |= bit;
			if on {
				self.opts_on |= bit;
			} else {
				self.opts_on &= !bit;
			}
		}
		Ok(self.opts_on & bit != 0)
	}

	/// The root value of zsh mode option `opt` (not an env twin; see
	/// [`zsh_option`]): a bit test once it was read or written.
	///
	/// # Errors
	/// [`StoreError`] when the option record cannot be read.
	pub fn zsh_option(
		&mut self,
		store: &mut dyn StateStore,
		opt: ZshOpt,
	) -> Result<bool, StoreError> {
		if !self.zopts_known.get(opt) {
			let on = zsh_opt_value(opt, store.get(Key::ZshOpt(opt))?);
			self.zopts_known.set(opt, true);
			self.zopts_on.set(opt, on);
		}
		Ok(self.zopts_on.get(opt))
	}

	/// Whether the root list of `enable -n`'d builtins is non-empty: a flag
	/// test once read, so command lookup skips the list for every builtin
	/// it runs.
	///
	/// # Errors
	/// [`StoreError`] when the record cannot be read.
	pub fn builtins_disabled(&mut self, store: &mut dyn StateStore) -> Result<bool, StoreError> {
		if let Some(any) = self.builtins_disabled {
			return Ok(any);
		}
		let any = matches!(
			store.get(Key::Misc(MiscKey::DisabledBuiltins))?,
			Some(Record::Words(w)) if !w.is_empty()
		);
		self.builtins_disabled = Some(any);
		Ok(any)
	}

	/// Write a scalar `Misc` value.
	pub fn set_misc(&mut self, store: &mut dyn StateStore, key: MiscKey, value: impl Into<BString>) {
		self.set_record(store, KeyBuf::Misc(key), Some(Record::Misc(value.into())));
	}

	/// Replace the root positional parameters (outside any function).
	pub fn set_positional(&mut self, store: &mut dyn StateStore, params: Vec<BString>) {
		self.set_record(store, KeyBuf::Misc(MiscKey::Positional), Some(Record::Words(params)));
	}

	/// Set a root option.
	pub fn set_option(&mut self, store: &mut dyn StateStore, opt: OptId, on: bool) {
		self.set_record(store, KeyBuf::Opt(opt), Some(Record::Opt(on)));
	}
}

/// Global variable `name` as the store holds it (a scope or a subshell may
/// hide it; see [`lookup`]).
///
/// # Errors
/// [`StoreError`] when the store fails or the record is no variable.
#[inline]
pub fn global<'s>(
	store: &'s mut dyn StateStore,
	name: &[u8],
) -> Result<Option<&'s Var>, StoreError> {
	match store.get(var_key(name))? {
		Some(Record::Var(v)) => Ok(Some(v)),
		Some(_) => Err(StoreError::Shape { table: Table::Var }),
		None => Ok(None),
	}
}

/// A scalar root `Misc` value.
///
/// # Errors
/// [`StoreError`] when the store fails or the record is no scalar.
pub fn root_misc(store: &mut dyn StateStore, key: MiscKey) -> Result<Option<&[u8]>, StoreError> {
	match store.get(Key::Misc(key))? {
		Some(Record::Misc(v)) => Ok(Some(v.as_slice())),
		Some(_) => Err(StoreError::Shape { table: Table::Misc }),
		None => Ok(None),
	}
}

/// The root positional parameters (outside any function).
///
/// # Errors
/// [`StoreError`] when the store fails or the record is no list.
pub fn root_positional(store: &mut dyn StateStore) -> Result<&[BString], StoreError> {
	match store.get(Key::Misc(MiscKey::Positional))? {
		Some(Record::Words(w)) => Ok(w.as_slice()),
		Some(_) => Err(StoreError::Shape { table: Table::Misc }),
		None => Ok(&[]),
	}
}

/// A root scope's header, borrowed: function name, positional parameters,
/// zsh call state.
type ScopeHeader<'s> = (Option<&'s BString>, Option<&'s [BString]>, Option<&'s ZshScope>);

/// The header of root scope `depth` (none for a lazy empty scope, which
/// has no record).
fn root_scope(store: &mut dyn StateStore, depth: u32) -> Result<ScopeHeader<'_>, StoreError> {
	match store.get(Key::Scope(depth))? {
		Some(Record::Scope { func, positional, zsh }) => {
			Ok((func.as_ref(), positional.as_deref(), zsh.as_deref()))
		},
		None => Ok((None, None, None)),
		Some(_) => Err(StoreError::Shape { table: Table::Scope }),
	}
}

/// The innermost root scope binding `name`: only the scopes that may bind
/// a local are read ([`Root`]'s mask; every one from [`SCOPE_BITS`] up).
#[inline]
fn root_binding(
	root: &Root,
	store: &mut dyn StateStore,
	name: &[u8],
) -> Result<Option<u32>, StoreError> {
	// Outside every function and temporary scope, a lookup (most of a
	// script's) needs no call.
	if root.depth == 0 {
		return Ok(None);
	}
	root_binding_below(root, store, name, root.depth, true)
}

/// [`root_binding`] among the root scopes below `top`. With
/// `hide_private`, a zsh private parameter hidden from the running
/// function ([`private_hidden`]) does not count as a binding.
fn root_binding_below(
	root: &Root,
	store: &mut dyn StateStore,
	name: &[u8],
	top: u32,
	hide_private: bool,
) -> Result<Option<u32>, StoreError> {
	let top = top.min(root.depth);
	if top == 0 || !store.may_have_local(name) {
		return Ok(None);
	}
	// The innermost function scope, read once a private binding needs it.
	let mut func = FuncScope::Unread;
	for depth in (SCOPE_BITS..top).rev() {
		if root_binds(root, store, name, depth, hide_private, &mut func)? {
			return Ok(Some(depth));
		}
	}
	let mut bits = root.locals & below(top);
	while let Some(depth) = bits.checked_ilog2() {
		if root_binds(root, store, name, depth, hide_private, &mut func)? {
			return Ok(Some(depth));
		}
		bits &= !(1 << depth);
	}
	Ok(None)
}

/// [`root_binds`]' cache of the innermost function scope.
#[derive(Clone, Copy)]
enum FuncScope {
	/// Not read yet.
	Unread,
	/// [`root_func_scope`]'s answer.
	Read(Option<u32>),
}

/// Whether root scope `depth` binds `name` for [`root_binding_below`]:
/// with `hide_private`, a zsh private parameter there counts only when no
/// function scope lies above it. `func` caches the innermost function
/// scope.
fn root_binds(
	root: &Root,
	store: &mut dyn StateStore,
	name: &[u8],
	depth: u32,
	hide_private: bool,
	func: &mut FuncScope,
) -> Result<bool, StoreError> {
	let private = match store.get(local_key(depth, name))? {
		None => return Ok(false),
		Some(Record::Var(v)) => v.attrs.contains(Attrs::ZSH_PRIVATE),
		Some(_) => false,
	};
	if !private || !hide_private {
		return Ok(true);
	}
	let innermost = match *func {
		FuncScope::Read(f) => f,
		FuncScope::Unread => {
			let f = root_func_scope(root, store)?;
			*func = FuncScope::Read(f);
			f
		},
	};
	Ok(!private_hidden(depth as usize, innermost.map(|f| f as usize)))
}

/// zsh/param/private's visibility rule (`getprivatenode`): a private
/// parameter ([`Attrs::ZSH_PRIVATE`]) bound in scope `at` is hidden while a
/// function scope lies above it (`innermost` is the innermost function
/// scope): the functions its declaring function calls see the next outer
/// parameter of the name instead.
const fn private_hidden(at: usize, innermost: Option<usize>) -> bool {
	match innermost {
		Some(f) => f > at,
		None => false,
	}
}

/// The innermost of `vp`'s own scopes (a subshell's) binding `name` for a
/// dynamic lookup: a zsh private parameter hidden from the running
/// function ([`private_hidden`]) is skipped.
fn vec_binding(vp: &Vproc, name: &[u8]) -> Option<usize> {
	vp.scopes.iter().enumerate().rev().find_map(|(i, s)| {
		let entry = s.vars.get(name)?;
		let private = entry
			.as_ref()
			.is_some_and(|v| v.attrs.contains(Attrs::ZSH_PRIVATE));
		if private && vp.scopes[i + 1..].iter().any(|s| s.func.is_some()) {
			return None;
		}
		Some(i)
	})
}

/// Whether the innermost scope binding `name`, with no zsh/param/private
/// visibility applied (zsh's raw parameter table node), holds a private
/// parameter: zsh's `createparam` of a global `name` then fails (`NAME:
/// can't change parameter attribute`, the private being `PM_RO_BY_DESIGN`).
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn innermost_private(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	name: &[u8],
) -> Result<bool, StoreError> {
	if vp.overlay.is_none() {
		let Some(depth) = root_binding_below(root, store, name, root.depth, false)? else {
			return Ok(false);
		};
		return Ok(matches!(
			store.get(local_key(depth, name))?,
			Some(Record::Var(v)) if v.attrs.contains(Attrs::ZSH_PRIVATE)
		));
	}
	Ok(vp
		.scopes
		.iter()
		.rev()
		.find_map(|s| s.vars.get(name))
		.is_some_and(|e| {
			e.as_ref()
				.is_some_and(|v| v.attrs.contains(Attrs::ZSH_PRIVATE))
		}))
}

/// The innermost root function scope.
fn root_func_scope(root: &Root, store: &mut dyn StateStore) -> Result<Option<u32>, StoreError> {
	for depth in (SCOPE_BITS..root.depth).rev() {
		if root_scope(store, depth)?.0.is_some() {
			return Ok(Some(depth));
		}
	}
	Ok(top_bit(root.funcs, root.depth))
}

/// The innermost root scope holding positional parameters.
fn root_params_scope(root: &Root, store: &mut dyn StateStore) -> Result<Option<u32>, StoreError> {
	for depth in (SCOPE_BITS..root.depth).rev() {
		if root_scope(store, depth)?.1.is_some() {
			return Ok(Some(depth));
		}
	}
	Ok(top_bit(root.params, root.depth))
}

/// Whether a variable `vp` sees may be a name reference: always for a
/// subshell (its scopes and overlay are not tracked), for the root vproc
/// once one was written ([`Root`]'s flag). While `false`, every variable is
/// plain: callers skip their nameref checks.
pub const fn may_be_nameref(root: &Root, vp: &Vproc) -> bool {
	vp.overlay.is_some() || root.namerefs
}

/// A scope of a vproc: an index into `Vproc::scopes` (a subshell's) or the
/// depth of a root scope in the store.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum In {
	Vec(usize),
	Store(u32),
}

/// Where a variable binding of a vproc lives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum At {
	Scope(In),
	Overlay,
	Global,
}

/// Where `name` is bound for a dynamic lookup: the innermost scope binding
/// it, else the overlay when it has it, else the global variables.
#[inline]
fn bound_at(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	name: &[u8],
) -> Result<At, StoreError> {
	if vp.overlay.is_none() {
		return Ok(root_binding(root, store, name)?.map_or(At::Global, |d| At::Scope(In::Store(d))));
	}
	if let Some(i) = vec_binding(vp, name) {
		return Ok(At::Scope(In::Vec(i)));
	}
	if vp
		.overlay
		.as_ref()
		.is_some_and(|ov| ov.vars.contains_key(name))
	{
		return Ok(At::Overlay);
	}
	Ok(At::Global)
}

/// The variable bound at `at` (`None`: declared but unset there, or absent).
#[inline]
fn var_at<'a>(
	store: &'a mut dyn StateStore,
	vp: &'a Vproc,
	name: &[u8],
	at: At,
) -> Result<Option<&'a Var>, StoreError> {
	Ok(match at {
		At::Scope(In::Vec(i)) => vp.scopes[i].vars.get(name).and_then(Option::as_ref),
		At::Scope(In::Store(depth)) => match store.get(local_key(depth, name))? {
			Some(Record::Var(v)) => Some(v),
			Some(Record::Unset) | None => None,
			Some(_) => return Err(StoreError::Shape { table: Table::Local }),
		},
		At::Overlay => vp
			.overlay
			.as_ref()
			.and_then(|ov| ov.vars.get(name))
			.and_then(Option::as_ref),
		At::Global => global(store, name)?,
	})
}

/// Where an assignment to `name` at `level` lands among `vp`'s scopes;
/// `None`: its overlay or the root.
#[inline]
fn level_at(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	name: &[u8],
	level: Level,
) -> Result<Option<In>, StoreError> {
	if vp.overlay.is_none() {
		return Ok(match level {
			Level::Global => None,
			Level::Local => root_func_scope(root, store)?.map(In::Store),
			Level::Dynamic => root_binding(root, store, name)?.map(In::Store),
		});
	}
	Ok(match level {
		Level::Global => None,
		Level::Local => vp
			.scopes
			.iter()
			.rposition(|s| s.func.is_some())
			.map(In::Vec),
		Level::Dynamic => vec_binding(vp, name).map(In::Vec),
	})
}

/// Where an assignment lands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
	/// The innermost scope that declares the name, else global.
	Dynamic,
	/// The innermost function scope (`local`, `declare` in a function).
	Local,
	/// Global (`declare -g`, `export` of a new name outside functions).
	Global,
}

/// Where a name reference (`declare -n`) leads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Deref {
	/// `name` is no (set) nameref: use it as is.
	Plain,
	/// The variable at the end of the chain, or an element of it
	/// (`declare -n r=a[1]`).
	To {
		/// Variable name.
		name:  BString,
		/// Subscript text, for a reference to an array element.
		index: Option<BString>,
	},
	/// The chain loops (bash warns `NAME: circular name reference`).
	Circular,
}

/// Longest nameref chain followed before it counts as circular.
const MAX_DEREF: usize = 64;

/// Follow the name references starting at `name`: each nameref with a
/// value names the next variable; a value with a subscript ends the chain
/// at that element.
///
/// # Errors
/// [`StoreError`] when a variable cannot be read.
pub fn deref(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	name: &[u8],
) -> Result<Deref, StoreError> {
	if !may_be_nameref(root, vp) {
		return Ok(Deref::Plain);
	}
	let mut cur = BString::from(name);
	for hop in 0..MAX_DEREF {
		let Some(target) = lookup_declared(root, store, vp, &cur)?
			.filter(|v| v.attrs.contains(Attrs::NAMEREF) && !v.attrs.contains(Attrs::INVISIBLE))
			.and_then(Var::as_scalar)
			.filter(|t| !t.is_empty())
			.map(BString::from)
		else {
			return Ok(if hop == 0 {
				Deref::Plain
			} else {
				Deref::To { name: cur, index: None }
			});
		};
		if target == name || target == cur {
			return Ok(Deref::Circular);
		}
		if let Some(open) = target.iter().position(|&c| c == b'[')
			&& target.ends_with(b"]")
		{
			// `declare -n a=a[0]`: an element of itself.
			let base = &target.as_slice()[..open];
			if base == name || base == cur.as_slice() {
				return Ok(Deref::Circular);
			}
			return Ok(Deref::To {
				name:  BString::from(&target[..open]),
				index: Some(BString::from(&target[open + 1..target.len() - 1])),
			});
		}
		cur = target;
	}
	Ok(Deref::Circular)
}

/// A variable as `vp` sees it: its scopes first, then its overlay, then the
/// root state, through name references (a reference to an array element,
/// or a circular one, reads as unset here; see [`deref`]). A
/// declared-but-unset ([`Attrs::INVISIBLE`]) variable is `None` (it still
/// hides outer ones).
///
/// # Errors
/// [`StoreError`] when a variable cannot be read.
pub fn lookup<'a>(
	root: &Root,
	store: &'a mut dyn StateStore,
	vp: &'a Vproc,
	name: &[u8],
) -> Result<Option<&'a Var>, StoreError> {
	// The common case, a variable that is no nameref (every expansion reads
	// through here): one walk, one read when the root holds no nameref,
	// else the binding read once more to return it (a borrow returned on
	// one path only cannot be held across the other).
	let at = bound_at(root, store, vp, name)?;
	if !may_be_nameref(root, vp)
		|| !var_at(store, vp, name, at)?.is_some_and(|v| v.attrs.contains(Attrs::NAMEREF))
	{
		return Ok(var_at(store, vp, name, at)?.filter(|v| !v.attrs.contains(Attrs::INVISIBLE)));
	}
	match deref(root, store, vp, name)? {
		Deref::Plain => {
			Ok(lookup_declared(root, store, vp, name)?.filter(|v| !v.attrs.contains(Attrs::INVISIBLE)))
		},
		Deref::To { name: target, index: None } => {
			Ok(lookup_declared(root, store, vp, &target)?
				.filter(|v| !v.attrs.contains(Attrs::INVISIBLE)))
		},
		Deref::To { index: Some(_), .. } | Deref::Circular => Ok(None),
	}
}

/// [`lookup`] for assignments and `declare`: no name references followed,
/// declared-but-unset variables returned with their attributes.
///
/// # Errors
/// [`StoreError`] when a variable cannot be read.
#[inline]
pub fn lookup_declared<'a>(
	root: &Root,
	store: &'a mut dyn StateStore,
	vp: &'a Vproc,
	name: &[u8],
) -> Result<Option<&'a Var>, StoreError> {
	let at = bound_at(root, store, vp, name)?;
	var_at(store, vp, name, at)
}

/// A declared variable and its binding scope, from one dynamic lookup.
/// The scope is `None` for an overlay or global binding; name references
/// are not followed and declared-but-unset variables are returned.
///
/// # Errors
/// [`StoreError`] when a variable cannot be read.
#[inline]
pub fn lookup_declared_scoped<'a>(
	root: &Root,
	store: &'a mut dyn StateStore,
	vp: &'a Vproc,
	name: &[u8],
) -> Result<(Option<&'a Var>, Option<usize>), StoreError> {
	let at = bound_at(root, store, vp, name)?;
	let scope = match at {
		At::Scope(In::Vec(i)) => Some(i),
		At::Scope(In::Store(depth)) => Some(depth as usize),
		At::Overlay | At::Global => None,
	};
	Ok((var_at(store, vp, name, at)?, scope))
}

/// A token for a cache of something derived from the locale variables
/// `names` (each `LANG` or `LC_*`) as `vp` sees them: equal tokens mean
/// equal values. `None` when one of them is bound in `vp`'s scopes or
/// overlay (a temporary `LC_ALL=C cmd`, a `local LANG`, a subshell's own
/// value): the caller reads them then. The token is the root's count of
/// locale-variable writes ([`Root::set_var`], [`edit_var`]) and store
/// invalidations, so a root write or an out-of-band store change of any
/// locale variable changes it.
pub fn locale_token(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	names: &[&[u8]],
) -> Option<u64> {
	debug_assert!(names.iter().all(|n| is_locale_name(n)), "not a locale variable");
	let bound = |vars: &VarMap| names.iter().any(|n| vars.contains_key(*n));
	let in_vp = if vp.overlay.is_none() {
		// A failed read counts as bound: the caller then reads the values.
		names
			.iter()
			.any(|n| !matches!(root_binding(root, store, n), Ok(None)))
	} else {
		vp.scopes.iter().any(|s| bound(&s.vars))
			|| vp.overlay.as_ref().is_some_and(|ov| bound(&ov.vars))
	};
	(!in_vp).then_some(root.locale_gen)
}

/// The variable [`store_var`] at `level` would replace, borrowed;
/// declared-but-unset ones included.
///
/// # Errors
/// [`StoreError`] when a variable cannot be read.
pub fn binding<'a>(
	root: &Root,
	store: &'a mut dyn StateStore,
	vp: &'a Vproc,
	name: &[u8],
	level: Level,
) -> Result<Option<&'a Var>, StoreError> {
	let at = match level_at(root, store, vp, name, level)? {
		Some(scope) => At::Scope(scope),
		None
			if vp
				.overlay
				.as_ref()
				.is_some_and(|ov| ov.vars.contains_key(name)) =>
		{
			At::Overlay
		},
		None => At::Global,
	};
	var_at(store, vp, name, at)
}

/// An in-place change of a bound variable ([`edit_var`]): the store gets
/// the element or value that changed, not a copy of the variable (`a+=(x)`
/// must cost the element).
#[derive(Debug)]
pub enum VarEdit<'e> {
	/// Replace attributes and value.
	Replace(Var),
	/// Add attributes (`export` of a bound variable).
	AddAttrs(Attrs),
	/// An assignment done in place (`assign_in_place`): `elem` `None` is a
	/// scalar's value or element 0 of an indexed array, [`Elem::Index`]
	/// an element of an indexed array (a scalar becomes one; a
	/// declared-but-unset scalar becomes an empty one first),
	/// [`Elem::Key`] an element of an associative array; `append`
	/// concatenates to the old value. Clears [`Attrs::INVISIBLE`].
	Set {
		/// The element.
		elem:   Option<Elem<'e>>,
		/// The value.
		value:  &'e [u8],
		/// `+=`.
		append: bool,
	},
	/// An arithmetic assignment (`((x=1))`, `((a[2]=3))`): as
	/// [`VarEdit::Set`] without `append`, except that a declared-but-unset
	/// scalar given an index keeps its empty element 0.
	Number {
		/// The element.
		elem:  Option<Elem<'e>>,
		/// The number as text.
		value: &'e [u8],
	},
	/// Remove an array element, retaining the variable's attributes.
	Remove(Elem<'e>),
	/// Append unkeyed elements after the highest index of an indexed array
	/// (`a+=(x y)`); clears [`Attrs::INVISIBLE`].
	Push(Vec<BString>),
	/// Insert `key` into an associative array at the front of its bucket
	/// among `buckets` ([`AssocArray::insert_front`]: zsh's hash order);
	/// clears [`Attrs::INVISIBLE`].
	Insert {
		/// The key (absent; a present one takes the value in place).
		key:     &'e [u8],
		/// Its value.
		value:   &'e [u8],
		/// The zsh hash table's bucket count.
		buckets: usize,
	},
}

impl VarEdit<'_> {
	/// Apply the change to a variable in memory (a scope's or an
	/// overlay's); the store's fine-grained changes do the same.
	fn apply(self, var: &mut Var) {
		match self {
			Self::Replace(v) => *var = v,
			Self::Remove(elem) => match (&mut var.value, elem) {
				(VarValue::Indexed(items), Elem::Index(i)) => {
					if let Ok(p) = items.binary_search_by_key(&i, |(k, _)| *k) {
						items.remove(p);
					}
				},
				(VarValue::Assoc(items), Elem::Key(k)) => items.remove(k),
				_ => {},
			},
			Self::AddAttrs(a) => var.attrs = var.attrs.with(a),
			Self::Set { elem, value, append } => {
				if matches!(elem, Some(Elem::Index(_)))
					&& var.attrs.contains(Attrs::INVISIBLE)
					&& matches!(var.value, VarValue::Str(_))
				{
					var.value = VarValue::Indexed(Vec::new());
				}
				var.attrs = var.attrs.without(Attrs::INVISIBLE);
				set_elem(var, elem, value, append);
			},
			Self::Number { elem, value } => {
				set_elem(var, elem, value, false);
				var.attrs = var.attrs.without(Attrs::INVISIBLE);
			},
			Self::Push(elems) => {
				var.attrs = var.attrs.without(Attrs::INVISIBLE);
				if let VarValue::Indexed(items) = &mut var.value {
					let first = items.last().map_or(0, |(i, _)| i + 1);
					items.reserve(elems.len());
					items.extend((first..).zip(elems));
				}
			},
			Self::Insert { key, value, buckets } => {
				var.attrs = var.attrs.without(Attrs::INVISIBLE);
				if let VarValue::Assoc(items) = &mut var.value {
					items.insert_front(buckets, BString::from(key), BString::from(value));
				}
			},
		}
	}
}

/// Assign `value` to element `elem` of `var` in memory (see
/// [`VarEdit::Set`]).
fn set_elem(var: &mut Var, elem: Option<Elem<'_>>, value: &[u8], append: bool) {
	let elem = match (&mut var.value, elem) {
		(VarValue::Str(s), None) => {
			if !append {
				s.clear();
			}
			s.extend_from_slice(value);
			return;
		},
		(_, None) => Elem::Index(0),
		(_, Some(elem)) => elem,
	};
	if let (VarValue::Str(s), Elem::Index(_)) = (&var.value, elem) {
		var.value = VarValue::Indexed(vec![(0, s.clone())]);
	}
	match (&mut var.value, elem) {
		(VarValue::Indexed(items), Elem::Index(i)) => {
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
		(VarValue::Assoc(items), Elem::Key(k)) => {
			let dst = items.value_mut(k);
			if !append {
				dst.clear();
			}
			dst.extend_from_slice(value);
		},
		_ => {},
	}
}

/// A store change [`store_edit`] can make without rewriting the variable.
enum Fast<'e> {
	/// [`Change::SetScalar`] or [`Change::AppendScalar`].
	Scalar(&'e [u8], bool),
	/// [`Change::SetElem`] or [`Change::AppendElem`].
	Elem(Elem<'e>, &'e [u8], bool),
	/// [`Change::SetElem`] of each pushed element from this index.
	Push(i64),
	/// [`Change::InsertElem`].
	Insert(&'e [u8], &'e [u8], usize),
	/// [`Change::DelElem`].
	Remove(Elem<'e>),
	/// The change leaves the variable as it is.
	Nothing,
}

/// The fine-grained store change for `edit` of `cur`, when its attributes
/// stay and its shape fits; `None`: the whole variable is rewritten.
fn fast_edit<'e>(edit: &VarEdit<'e>, cur: &Var) -> Option<Fast<'e>> {
	if cur.attrs.contains(Attrs::INVISIBLE) {
		return None;
	}
	let (elem, value, append) = match *edit {
		VarEdit::Remove(elem) => {
			return Some(match (&cur.value, elem) {
				(VarValue::Indexed(_), Elem::Index(_)) | (VarValue::Assoc(_), Elem::Key(_)) => {
					Fast::Remove(elem)
				},
				_ => Fast::Nothing,
			});
		},
		VarEdit::Set { elem, value, append } => (elem, value, append),
		VarEdit::Number { elem, value } => (elem, value, false),
		VarEdit::Push(_) => {
			return match &cur.value {
				VarValue::Indexed(items) => Some(Fast::Push(items.last().map_or(0, |(i, _)| i + 1))),
				_ => Some(Fast::Nothing),
			};
		},
		VarEdit::Replace(_) | VarEdit::AddAttrs(_) => return None,
		VarEdit::Insert { key, value, buckets } => {
			return match &cur.value {
				VarValue::Assoc(_) => Some(Fast::Insert(key, value, buckets)),
				_ => Some(Fast::Nothing),
			};
		},
	};
	Some(match (&cur.value, elem) {
		(VarValue::Str(_), None) => Fast::Scalar(value, append),
		(VarValue::Indexed(_), None) => Fast::Elem(Elem::Index(0), value, append),
		(VarValue::Indexed(_), Some(Elem::Index(i))) => Fast::Elem(Elem::Index(i), value, append),
		(VarValue::Assoc(_), Some(Elem::Key(k))) => Fast::Elem(Elem::Key(k), value, append),
		// `set_index`/`set_key` leave an associative array (indexed) or a
		// non-associative one (keyed) as it is.
		(VarValue::Assoc(_), None | Some(Elem::Index(_)))
		| (VarValue::Indexed(_), Some(Elem::Key(_))) => Fast::Nothing,
		// A scalar becomes an array.
		(VarValue::Str(_), Some(Elem::Index(_))) => return None,
		(VarValue::Str(_), Some(Elem::Key(_))) => Fast::Nothing,
	})
}

/// What a caller saw of the variable it is about to edit, read at the
/// level it edits ([`binding`], or [`lookup_declared`] for
/// [`Level::Dynamic`]) with nothing run since: enough for [`edit_seen`] to
/// choose the store change without reading the variable again (assignments
/// read it once to check its attributes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Seen {
	/// A scalar.
	Scalar,
	/// An associative array.
	Assoc,
	/// An indexed array.
	Indexed {
		/// Its highest index + 1 ([`Var::next_index`]).
		next: i64,
	},
}

impl Seen {
	/// What `var` shows an edit; `None` when the edit cannot rely on it
	/// (declared but unset, which an edit rewrites).
	pub fn of(var: &Var) -> Option<Self> {
		if var.attrs.contains(Attrs::INVISIBLE) {
			return None;
		}
		match &var.value {
			VarValue::Str(_) => Some(Self::Scalar),
			VarValue::Indexed(_) => Some(Self::Indexed { next: var.next_index() }),
			VarValue::Assoc(_) => Some(Self::Assoc),
		}
	}
}

/// The store change for `edit` of a variable showing `seen`, when it needs
/// none of the old value (as [`fast_edit`] decides).
const fn seen_edit<'e>(edit: &VarEdit<'e>, seen: Seen) -> Option<Fast<'e>> {
	let (elem, value, append) = match *edit {
		VarEdit::Remove(elem) => {
			return match (seen, elem) {
				(Seen::Indexed { .. }, Elem::Index(_)) | (Seen::Assoc, Elem::Key(_)) => {
					Some(Fast::Remove(elem))
				},
				_ => None,
			};
		},
		VarEdit::Set { elem, value, append } => (elem, value, append),
		VarEdit::Number { elem, value } => (elem, value, false),
		VarEdit::Push(_) => {
			return match seen {
				Seen::Indexed { next } => Some(Fast::Push(next)),
				Seen::Scalar | Seen::Assoc => None,
			};
		},
		VarEdit::Replace(_) | VarEdit::AddAttrs(_) => return None,
		VarEdit::Insert { key, value, buckets } => {
			return match seen {
				Seen::Assoc => Some(Fast::Insert(key, value, buckets)),
				Seen::Scalar | Seen::Indexed { .. } => None,
			};
		},
	};
	match (seen, elem) {
		(Seen::Scalar, None) => Some(Fast::Scalar(value, append)),
		(Seen::Assoc, Some(Elem::Key(k))) => Some(Fast::Elem(Elem::Key(k), value, append)),
		(Seen::Indexed { .. }, None) => Some(Fast::Elem(Elem::Index(0), value, append)),
		(Seen::Indexed { .. }, Some(Elem::Index(i))) => {
			Some(Fast::Elem(Elem::Index(i), value, append))
		},
		_ => None,
	}
}

/// Apply `edit` to the variable stored at `key` ([`Key::Var`] or
/// [`Key::Local`]); `false` when none is bound there. With `seen`, a
/// change [`seen_edit`] can choose is written without reading the variable.
fn store_edit(
	root: &mut Root,
	store: &mut dyn StateStore,
	key: Key<'_>,
	edit: VarEdit<'_>,
	seen: Option<Seen>,
) -> Result<bool, StoreError> {
	let known = seen.and_then(|s| seen_edit(&edit, s));
	let plan = match known {
		Some(fast) => Ok(fast),
		None => match store.get(key)? {
			Some(Record::Var(cur)) => match fast_edit(&edit, cur) {
				Some(fast) => Ok(fast),
				None => Err(cur.clone()),
			},
			Some(Record::Unset) | None => return Ok(false),
			Some(_) => return Err(StoreError::Shape { table: key.table() }),
		},
	};
	match plan {
		Ok(Fast::Scalar(v, false)) => root.write(store, Change::SetScalar(key, BStr::new(v))),
		Ok(Fast::Scalar(v, true)) => root.write(store, Change::AppendScalar(key, BStr::new(v))),
		Ok(Fast::Elem(elem, v, false)) => root.write(store, Change::SetElem(key, elem, BStr::new(v))),
		Ok(Fast::Elem(elem, v, true)) => {
			root.write(store, Change::AppendElem(key, elem, BStr::new(v)));
		},
		Ok(Fast::Push(first)) => {
			if let VarEdit::Push(elems) = &edit {
				for (i, v) in (first..).zip(elems) {
					root.write(store, Change::SetElem(key, Elem::Index(i), BStr::new(v)));
				}
			}
		},
		Ok(Fast::Remove(elem)) => root.write(store, Change::DelElem(key, elem)),
		Ok(Fast::Insert(k, v, buckets)) => {
			root.write(store, Change::InsertElem(key, buckets, BStr::new(k), BStr::new(v)));
		},
		Ok(Fast::Nothing) => {},
		Err(mut var) => {
			edit.apply(&mut var);
			root.write(store, Change::Put(key, Record::Var(var)));
		},
	}
	Ok(true)
}

/// Change the variable [`store_var`] at `level` would replace, in place:
/// a scope's or an overlay's in memory (a subshell's overlay first takes a
/// copy of the variable it shadows), a root one through the store's
/// fine-grained changes. `false` when no variable is bound there (absent,
/// or declared but unset).
///
/// # Errors
/// [`StoreError`] when a variable cannot be read.
pub fn edit_var(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	name: &[u8],
	level: Level,
	edit: VarEdit<'_>,
) -> Result<bool, StoreError> {
	edit_seen(root, store, vp, name, level, edit, None)
}

/// [`edit_var`] of a variable the caller just read at `level` (`seen`,
/// see [`Seen`]): a root variable's store change is chosen without reading
/// it again.
///
/// # Errors
/// [`StoreError`] when a variable cannot be read.
pub fn edit_seen(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	name: &[u8],
	level: Level,
	edit: VarEdit<'_>,
	seen: Option<Seen>,
) -> Result<bool, StoreError> {
	match level_at(root, store, vp, name, level)? {
		Some(In::Vec(i)) => {
			return Ok(match vp.scopes[i].vars.get_mut(name).and_then(Option::as_mut) {
				Some(var) => {
					edit.apply(var);
					true
				},
				None => false,
			});
		},
		Some(In::Store(depth)) => {
			return store_edit(root, store, local_key(depth, name), edit, seen);
		},
		None => {},
	}
	if let Some(ov) = vp.overlay.as_mut() {
		if !ov.vars.contains_key(name) {
			let shadowed = global(store, name)?.cloned();
			ov.vars.insert(BString::from(name), shadowed);
		}
		return Ok(match ov.vars.get_mut(name).and_then(Option::as_mut) {
			Some(var) => {
				edit.apply(var);
				true
			},
			None => false,
		});
	}
	if is_locale_name(name) {
		root.locale_gen += 1;
	}
	store_edit(root, store, var_key(name), edit, seen)
}

/// Write `var` (or a declared-but-unset binding, `None`) into scope `at`.
fn put_scope(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	at: In,
	name: &[u8],
	var: Option<Var>,
) {
	match at {
		In::Vec(i) => {
			vp.scopes[i].vars.insert(BString::from(name), var);
		},
		In::Store(depth) => {
			root.write(store, Change::Put(local_key(depth, name), binding_record(var)));
		},
	}
}

/// Write `var` (or unset with `None`) in `vp`'s overlay, or globally for
/// the root vproc.
fn put_outer(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	name: &[u8],
	var: Option<Var>,
) {
	match &mut vp.overlay {
		Some(ov) => {
			ov.vars.insert(BString::from(name), var);
		},
		None => root.set_var(store, name, var),
	}
}

/// Store `var` where a dynamic assignment would land if the scopes from
/// `top` up did not exist: bash copying a temporary-environment variable
/// out when `export`/`readonly` gives it attributes (`x=5 export x`).
pub fn store_var_below(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	name: &[u8],
	var: Option<Var>,
	top: usize,
) {
	let found = if vp.overlay.is_none() {
		let top = u32::try_from(top).unwrap_or(u32::MAX);
		match root_binding_below(root, store, name, top, true) {
			Ok(depth) => depth.map(In::Store),
			Err(err) => {
				root.fail(err);
				return;
			},
		}
	} else {
		vp.scopes[..top.min(vp.scopes.len())]
			.iter()
			.rposition(|s| s.vars.contains_key(name))
			.map(In::Vec)
	};
	match found {
		Some(at) => put_scope(root, store, vp, at, name, var),
		None => put_outer(root, store, vp, name, var),
	}
}

/// `unset name` with bash's dynamic scoping: a variable local to the
/// running function stays declared but unset (it keeps hiding outer ones);
/// one local to a calling function is removed from that scope, revealing
/// the next outer variable, unless `keep_outer_locals` (`shopt -s
/// localvar_unset`) treats it like the running function's own.
pub fn unset_var(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	name: &[u8],
	keep_outer_locals: bool,
) {
	match unset_target(root, store, vp, name, keep_outer_locals) {
		Ok(Some((at, true, var))) => {
			// The local stays declared, unset, with its attributes
			// (`local v=x; unset v; declare -p v` → `declare -- v`).
			let kept = var.map(|v| {
				let value = match v.value {
					VarValue::Str(_) => VarValue::Str(BString::default()),
					VarValue::Indexed(_) => VarValue::Indexed(Vec::new()),
					VarValue::Assoc(_) => VarValue::Assoc(Default::default()),
				};
				Var { attrs: v.attrs.with(Attrs::INVISIBLE), value }
			});
			put_scope(root, store, vp, at, name, kept);
		},
		Ok(Some((In::Vec(i), false, _))) => {
			vp.scopes[i].vars.remove(name);
		},
		Ok(Some((In::Store(depth), false, _))) => {
			root.write(store, Change::Del(local_key(depth, name)));
		},
		Ok(None) => put_outer(root, store, vp, name, None),
		Err(err) => root.fail(err),
	}
}

/// The scope [`unset_var`] acts on, whether the binding stays declared
/// there, and its variable; `None`: no scope binds `name`.
fn unset_target(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	name: &[u8],
	keep_outer_locals: bool,
) -> Result<Option<(In, bool, Option<Var>)>, StoreError> {
	let Some(at) = level_at(root, store, vp, name, Level::Dynamic)? else {
		return Ok(None);
	};
	let current_func = level_at(root, store, vp, name, Level::Local)?;
	let temp = !scope_is_func(store, vp, at)?;
	let keep = Some(at) == current_func || keep_outer_locals || temp;
	let var = match at {
		In::Vec(i) => vp.scopes[i].vars.get(name).cloned().flatten(),
		In::Store(depth) => match store.get(local_key(depth, name))? {
			Some(Record::Var(v)) => Some(v.clone()),
			_ => None,
		},
	};
	Ok(Some((at, keep, var)))
}

/// Store `var` (or unset with `None`) at `level` for `vp`.
pub fn store_var(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	name: &[u8],
	var: Option<Var>,
	level: Level,
) {
	match level_at(root, store, vp, name, level) {
		Ok(Some(at)) => put_scope(root, store, vp, at, name, var),
		Ok(None) => put_outer(root, store, vp, name, var),
		Err(err) => root.fail(err),
	}
}

/// A non-variable record as `vp` sees it.
///
/// # Errors
/// [`StoreError`] when the store fails.
pub fn record<'a>(
	store: &'a mut dyn StateStore,
	vp: &'a Vproc,
	key: Key<'_>,
) -> Result<Option<&'a Record>, StoreError> {
	let record = match vp
		.overlay
		.as_ref()
		.and_then(|ov| ov.records.get(&key.to_buf()))
	{
		Some(entry) => entry.as_ref(),
		None => store.get(key)?,
	};
	// Caught signals are reset in a subshell, while ignored signals remain
	// ignored.
	if let Key::Trap(trap) = key
		&& inherited_trap(vp, trap, record)
	{
		return Ok(None);
	}
	Ok(record)
}

/// Whether `record` (the `key` trap as `vp`'s overlay or the root holds
/// it) is a caught-signal trap `vp` inherited instead of setting it: a
/// subshell lists it (bash 5.3, [`listed_traps`]) but does not run it.
/// Called by [`record`] and [`scan`]; the `trap` builtin drops them when a
/// subshell changes a trap.
pub fn inherited_trap(
	vp: &Vproc,
	key: crate::bash::store::TrapKey,
	record: Option<&Record>,
) -> bool {
	matches!(key, crate::bash::store::TrapKey::Signal(_))
		&& vp.parent.is_some()
		&& !vp.own_traps.has(key)
		&& matches!(record, Some(Record::Trap { action, .. }) if !action.is_empty())
}

/// The trap table as the `trap` builtin lists it: [`scan`] of
/// [`Table::Trap`] including the signal traps a subshell inherited.
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn listed_traps(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<Vec<(KeyBuf, Record)>, StoreError> {
	scan_vars(root, store, vp, Table::Trap, false)
}

/// Turn POSIX mode on or off (`set -o posix`, `POSIXLY_CORRECT`): like
/// bash's `posix_initialize`, on turns `expand_aliases` on, off sets it
/// back to the shell's default (on only when interactive).
///
/// # Errors
/// [`StoreError`] when the interactive flag cannot be read.
pub fn set_posix(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	on: bool,
) -> Result<(), StoreError> {
	let interactive = matches!(
		record(store, vp, Key::Misc(MiscKey::Interactive))?,
		Some(Record::Misc(v)) if v.as_slice() == b"1"
	);
	store_record(root, store, vp, KeyBuf::Opt(OptId::Posix), Some(Record::Opt(on)));
	store_record(
		root,
		store,
		vp,
		KeyBuf::Opt(OptId::ExpandAliases),
		Some(Record::Opt(on || interactive)),
	);
	Ok(())
}

/// Rewrite bash's readonly `SHELLOPTS` (the `set -o` options that are on)
/// and `BASHOPTS` (the `shopt` ones), colon-separated in listing order,
/// after an option change.
///
/// # Errors
/// [`StoreError`] when an option cannot be read.
pub fn sync_option_vars(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
) -> Result<(), StoreError> {
	let (set, shopt) = option_lists(|opt| option(root, store, vp, opt))?;
	for (name, value) in [(&b"SHELLOPTS"[..], set), (b"BASHOPTS", shopt)] {
		// An exported one stays exported (bash updates the value in place).
		let current = lookup(root, store, vp, name)?;
		// Unchanged (the common case: a `$( )` that found `errexit` off, a
		// `set` that changed nothing): no write, so a subshell's overlay
		// keeps reading its parent's variable.
		let unchanged = current.is_some_and(|v| {
			v.attrs.contains(Attrs::READONLY) && matches!(&v.value, VarValue::Str(s) if *s == value)
		});
		let attrs = current.map_or(Attrs::READONLY, |v| v.attrs.with(Attrs::READONLY));
		if unchanged && binding_scope(root, store, vp, name)?.is_none() {
			continue;
		}
		store_var(root, store, vp, name, Some(Var::scalar(value, attrs)), Level::Global);
	}
	Ok(())
}

/// The `set -o` options that are on, colon-separated (what `local -`
/// saves).
///
/// # Errors
/// [`StoreError`] when an option cannot be read.
pub fn set_options_on(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<BString, StoreError> {
	Ok(option_lists(|opt| option(root, store, vp, opt))?.0)
}

/// Restore the `set -o` options saved by `local -` ([`set_options_on`])
/// when the function that saved them returns.
///
/// # Errors
/// [`StoreError`] when `SHELLOPTS` cannot be refreshed.
pub fn restore_set_options(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	saved: &[u8],
) -> Result<(), StoreError> {
	use strum::IntoEnumIterator;
	for opt in OptId::iter().filter(|o| o.kind() == crate::bash::store::OptKind::Set) {
		let name: &'static str = opt.into();
		let on = saved.split(|&c| c == b':').any(|n| n == name.as_bytes());
		// bash's `set_current_options` goes through the option's setter,
		// which binds (or unbinds) its variable when the value changes.
		if option(root, store, vp, opt)? != on {
			let bound: Option<(&[u8], &str)> = match opt {
				OptId::Ignoreeof => Some((b"IGNOREEOF", "10")),
				OptId::Posix => Some((b"POSIXLY_CORRECT", "y")),
				_ => None,
			};
			if let Some((var, value)) = bound {
				let var_value = on.then(|| Var::scalar(value, Attrs::NONE));
				store_var(root, store, vp, var, var_value, Level::Dynamic);
			}
		}
		store_record(root, store, vp, KeyBuf::Opt(opt), Some(Record::Opt(on)));
	}
	sync_option_vars(root, store, vp)
}

/// [`sync_option_vars`] for a new shell, on the root state.
///
/// # Errors
/// [`StoreError`] when an option cannot be read.
pub fn init_option_vars(root: &mut Root, store: &mut dyn StateStore) -> Result<(), StoreError> {
	let (set, shopt) = option_lists(|opt| root.option(store, opt))?;
	root.set_var(store, b"SHELLOPTS", Some(Var::scalar(set, Attrs::READONLY)));
	root.set_var(store, b"BASHOPTS", Some(Var::scalar(shopt, Attrs::READONLY)));
	Ok(())
}

/// Every option in bash's listing order. Sorting the generated variant
/// names at compile time avoids allocating and sorting on every shell start.
const OPTS_BY_NAME: [OptId; <OptId as strum::VariantArray>::VARIANTS.len()] = {
	const fn before(a: &str, b: &str) -> bool {
		let (a, b) = (a.as_bytes(), b.as_bytes());
		let mut i = 0;
		while i < a.len() && i < b.len() {
			if a[i] != b[i] {
				return a[i] < b[i];
			}
			i += 1;
		}
		a.len() < b.len()
	}
	let variants = <OptId as strum::VariantArray>::VARIANTS;
	let names = <OptId as strum::VariantNames>::VARIANTS;
	let mut sorted = [OptId::Allexport; <OptId as strum::VariantArray>::VARIANTS.len()];
	let mut i = 0;
	while i < variants.len() {
		let next = variants[i];
		let mut at = i;
		while at > 0 && before(names[next as usize], names[sorted[at - 1] as usize]) {
			sorted[at] = sorted[at - 1];
			at -= 1;
		}
		sorted[at] = next;
		i += 1;
	}
	sorted
};

/// The `set -o` and `shopt` options that are on, as `a:b:c` lists in
/// listing order.
fn option_lists(
	mut on: impl FnMut(OptId) -> Result<bool, StoreError>,
) -> Result<(BString, BString), StoreError> {
	let (mut set, mut shopt) = (BString::default(), BString::default());
	for &opt in &OPTS_BY_NAME {
		if !on(opt)? {
			continue;
		}
		let out = match opt.kind() {
			crate::bash::store::OptKind::Set => &mut set,
			crate::bash::store::OptKind::Shopt => &mut shopt,
		};
		if !out.is_empty() {
			out.push(b':');
		}
		out.extend_from_slice(<&'static str>::from(opt).as_bytes());
	}
	Ok((set, shopt))
}

/// Every `set -o` and `shopt` option back to its default, as bash's
/// `initialize_subshell` does for a script run without `#!` (ENOEXEC).
/// `login_shell` and `restricted_shell` describe the process and stay.
pub fn reset_options(root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc) {
	use strum::IntoEnumIterator;
	for opt in OptId::iter() {
		if matches!(opt, OptId::LoginShell | OptId::RestrictedShell) {
			continue;
		}
		store_record(root, store, vp, KeyBuf::Opt(opt), Some(Record::Opt(opt.default_on())));
	}
}

/// `$0` as `vp` sees it: the last value assigned to `BASH_ARGV0`, else
/// `argv0`, the shell's name.
///
/// # Errors
/// [`StoreError`] when the record cannot be read.
pub fn dollar0(
	store: &mut dyn StateStore,
	vp: &Vproc,
	argv0: &[u8],
) -> Result<BString, StoreError> {
	Ok(match record(store, vp, Key::Misc(MiscKey::Dollar0))? {
		Some(Record::Misc(v)) => v.clone(),
		_ => BString::from(argv0),
	})
}

/// The file-creation mask `vp` runs with: its `umask` record (the host's at
/// startup, then the `umask` builtin's), `0o022` when it holds no octal mask.
///
/// # Errors
/// [`StoreError`] when the record cannot be read.
pub fn umask(store: &mut dyn StateStore, vp: &Vproc) -> Result<u32, StoreError> {
	Ok(match record(store, vp, Key::Misc(MiscKey::Umask))? {
		Some(Record::Misc(v)) => std::str::from_utf8(v)
			.ok()
			.and_then(|v| u32::from_str_radix(v, 8).ok())
			.unwrap_or(0o022),
		_ => 0o022,
	})
}

/// Write a non-variable record for `vp`: its overlay's, or the root's.
pub fn store_record(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	key: KeyBuf,
	rec: Option<Record>,
) {
	match &mut vp.overlay {
		Some(ov) => {
			ov.records.insert(key, rec);
		},
		None => root.set_record(store, key, rec),
	}
}

/// An option as `vp` sees it.
///
/// # Errors
/// [`StoreError`] when the option record cannot be read.
#[inline]
pub fn option(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	opt: OptId,
) -> Result<bool, StoreError> {
	if let Some(ov) = &vp.overlay
		&& let Some(entry) = ov.records.get(&KeyBuf::Opt(opt))
	{
		return Ok(opt_value(opt, entry.as_ref()));
	}
	root.option(store, opt)
}

/// A zsh option as `vp` sees it: an env option ([`ZshOpt::env_twin`])
/// reads its bash twin, a mode option its own record.
///
/// # Errors
/// [`StoreError`] when the option record cannot be read.
pub fn zsh_option(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	opt: ZshOpt,
) -> Result<bool, StoreError> {
	if let Some((twin, inverted)) = opt.env_twin() {
		return Ok(option(root, store, vp, twin)? != inverted);
	}
	if let Some(ov) = &vp.overlay
		&& let Some(entry) = ov.records.get(&KeyBuf::ZshOpt(opt))
	{
		return Ok(zsh_opt_value(opt, entry.as_ref()));
	}
	root.zsh_option(store, opt)
}

/// Set zsh option `opt` for `vp` (an env option writes its bash twin);
/// nothing is written when it already has that value.
///
/// # Errors
/// [`StoreError`] when the current value cannot be read.
pub fn set_zsh_option(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	opt: ZshOpt,
	on: bool,
) -> Result<(), StoreError> {
	if zsh_option(root, store, vp, opt)? == on {
		return Ok(());
	}
	let (key, rec) = match opt.env_twin() {
		Some((twin, inverted)) => (KeyBuf::Opt(twin), Record::Opt(on != inverted)),
		None => (KeyBuf::ZshOpt(opt), Record::Opt(on)),
	};
	store_record(root, store, vp, key, Some(rec));
	Ok(())
}

/// Every zsh option as `vp` sees it, env options included (a zsh call's
/// saved set, `setopt` listings).
///
/// # Errors
/// [`StoreError`] when an option record cannot be read.
pub fn zsh_options(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<ZshOpts, StoreError> {
	use strum::IntoEnumIterator;
	let mut set = ZshOpts::default();
	for opt in ZshOpt::iter() {
		set.set(opt, zsh_option(root, store, vp, opt)?);
	}
	Ok(set)
}

/// Make `vp`'s zsh options equal `want`, writing only those that differ
/// (a zsh call's return, `emulate`).
///
/// # Errors
/// [`StoreError`] when an option record cannot be read.
pub fn set_zsh_options(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	want: &ZshOpts,
) -> Result<(), StoreError> {
	use strum::IntoEnumIterator;
	for opt in ZshOpt::iter() {
		set_zsh_option(root, store, vp, opt, want.get(opt))?;
	}
	Ok(())
}

/// Every record of `table` as `vp` sees it, sorted by key (variables: the
/// global ones, then function-local ones shadowing them; declared-but-unset
/// ones left out).
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn scan(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	table: Table,
) -> Result<Vec<(KeyBuf, Record)>, StoreError> {
	let mut all = scan_vars(root, store, vp, table, false)?;
	if table == Table::Var {
		all.retain(|(_, r)| !matches!(r, Record::Var(v) if v.attrs.contains(Attrs::INVISIBLE)));
	}
	if table == Table::Trap {
		all.retain(|(key, r)| !matches!(key, KeyBuf::Trap(key) if inherited_trap(vp, *key, Some(r))));
	}
	Ok(all)
}

/// [`scan`] including declared-but-unset variables (`declare -p`).
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn scan_declared(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	table: Table,
) -> Result<Vec<(KeyBuf, Record)>, StoreError> {
	scan_vars(root, store, vp, table, true)
}

/// [`Var::as_scalar`] of a bare value (a store record's).
fn value_scalar(value: &VarValue) -> Option<&[u8]> {
	match value {
		VarValue::Str(s) => Some(s.as_slice()),
		VarValue::Indexed(items) => items
			.iter()
			.find(|(i, _)| *i == 0)
			.map(|(_, v)| v.as_slice()),
		VarValue::Assoc(items) => items.get(b"0").map(|v| v.as_slice()),
	}
}

/// The root scopes' variables, `(depth, name, binding)` sorted by depth
/// (outermost first).
fn root_locals(store: &mut dyn StateStore) -> Result<Vec<(u32, BString, Option<Var>)>, StoreError> {
	let mut locals = Vec::new();
	store.scan(Table::Local, &mut |key, rec| {
		if let Key::Local { depth, name } = key {
			let var = match rec {
				Record::Var(v) => Some(v.clone()),
				_ => None,
			};
			locals.push((depth, BString::from(name), var));
		}
	})?;
	locals.sort_by_key(|(depth, ..)| *depth);
	Ok(locals)
}

/// Push `(name, scalar value)` of every exported variable `vp` sees to
/// `out`, in no particular order: what [`scan`] of [`Table::Var`] gives
/// filtered to [`Attrs::EXPORT`] with a scalar view, without building and
/// sorting the whole table (the environment of every external command).
/// Like [`scan`], a declared-but-unset local does not hide an exported
/// outer variable.
///
/// # Errors
/// [`StoreError`] when the store cannot be scanned.
pub fn exported(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	out: &mut Vec<(BString, BString)>,
) -> Result<(), StoreError> {
	let locals = if vp.overlay.is_none() && root.depth > 0 {
		root_locals(store)?
	} else {
		Vec::new()
	};
	// Names decided already: by an inner level, or unset there.
	let mut seen: hashbrown::HashSet<&[u8]> = hashbrown::HashSet::new();
	for (_, name, entry) in locals.iter().rev() {
		exported_level(&mut seen, out, name.as_slice(), entry.as_ref());
	}
	for scope in vp.scopes.iter().rev() {
		for (name, entry) in &scope.vars {
			exported_level(&mut seen, out, name.as_slice(), entry.as_ref());
		}
	}
	if let Some(ov) = &vp.overlay {
		for (name, entry) in &ov.vars {
			if seen.insert(name.as_slice())
				&& let Some(v) = entry
			{
				push_exported(out, name.as_slice(), v);
			}
		}
	}
	store.scan(Table::Var, &mut |key, rec| {
		if let (Key::Var(name), Record::Var(v)) = (key, rec) {
			let name: &[u8] = name;
			if !seen.contains(name) {
				push_exported(out, name, v);
			}
		}
	})
}

/// Push `name` with `var`'s value when it is an exported, set scalar
/// (an exported array keeps the attribute but stays out of the
/// environment, in bash and zsh alike). A zsh float goes out as zsh shows
/// it, not as stored.
fn push_exported(out: &mut Vec<(BString, BString)>, name: &[u8], var: &Var) {
	if var.attrs.contains(Attrs::EXPORT)
		&& !var.attrs.contains(Attrs::INVISIBLE)
		&& let VarValue::Str(s) = &var.value
	{
		let value =
			super::zsh::params::stored_float_display(var.attrs, s).unwrap_or_else(|| s.clone());
		out.push((BString::from(name), value));
	}
}

/// One scope level of [`exported`]: an inner binding decides the name
/// (an unset one hides the outer levels), a declared-but-unset local does
/// not (bash still exports the outer variable).
fn exported_level<'n>(
	seen: &mut hashbrown::HashSet<&'n [u8]>,
	out: &mut Vec<(BString, BString)>,
	name: &'n [u8],
	entry: Option<&Var>,
) {
	match entry {
		Some(v) if v.attrs.contains(Attrs::INVISIBLE) => {},
		Some(v) => {
			if seen.insert(name) {
				push_exported(out, name, v);
			}
		},
		None => {
			seen.insert(name);
		},
	}
}

/// Push `(name, source)` of every exported function `vp` sees to `out`, in
/// no particular order: [`scan`] of [`Table::Func`] filtered to
/// [`Attrs::EXPORT`], without building and sorting the table.
///
/// # Errors
/// [`StoreError`] when the store cannot be scanned.
pub fn exported_funcs(
	store: &mut dyn StateStore,
	vp: &Vproc,
	out: &mut Vec<(BString, BString)>,
) -> Result<(), StoreError> {
	let mut seen: hashbrown::HashSet<&[u8]> = hashbrown::HashSet::new();
	let push = |out: &mut Vec<(BString, BString)>, name: &[u8], rec: &Record| {
		if let Record::Func { source, attrs, .. } = rec
			&& attrs.contains(Attrs::EXPORT)
		{
			out.push((BString::from(name), (**source).clone()));
		}
	};
	let overlay = vp.overlay.as_ref().map(|ov| ov.records.iter());
	for (key, entry) in overlay.into_iter().flatten() {
		if let KeyBuf::Func(name) = key
			&& seen.insert(name.as_slice())
			&& let Some(rec) = entry
		{
			push(out, name.as_slice(), rec);
		}
	}
	store.scan(Table::Func, &mut |key, rec| {
		if let Key::Func(name) = key {
			let name: &[u8] = name;
			if !seen.contains(name) {
				push(out, name, rec);
			}
		}
	})
}

/// The scan behind [`scan`] and [`scan_declared`]. A declared-but-unset
/// local shadows an outer variable only when `invisible_hides` (bash still
/// puts an exported outer variable in the environment of commands run
/// under `local x`).
fn scan_vars(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	table: Table,
	invisible_hides: bool,
) -> Result<Vec<(KeyBuf, Record)>, StoreError> {
	let mut all: std::collections::BTreeMap<KeyBuf, Record> = std::collections::BTreeMap::new();
	store.scan(table, &mut |k, r| {
		all.insert(k.to_buf(), r.clone());
	})?;
	if let Some(ov) = &vp.overlay {
		if table == Table::Var {
			for (name, var) in &ov.vars {
				let key = KeyBuf::Var(name.clone());
				match var {
					Some(v) => {
						all.insert(key, Record::Var(v.clone()));
					},
					None => {
						all.remove(&key);
					},
				}
			}
		} else {
			for (key, rec) in &ov.records {
				if key.as_key().table() != table {
					continue;
				}
				match rec {
					Some(r) => {
						all.insert(key.clone(), r.clone());
					},
					None => {
						all.remove(key);
					},
				}
			}
		}
	}
	if table == Table::Var {
		let mut shadow = |name: &BString, var: Option<&Var>| {
			let key = KeyBuf::Var(name.clone());
			match var {
				Some(v) if !invisible_hides && v.attrs.contains(Attrs::INVISIBLE) => {},
				Some(v) => {
					all.insert(key, Record::Var(v.clone()));
				},
				None => {
					all.remove(&key);
				},
			}
		};
		// A zsh private parameter hidden from the running function
		// ([`private_hidden`]) leaves the outer one listed.
		let private = |var: Option<&Var>| var.is_some_and(|v| v.attrs.contains(Attrs::ZSH_PRIVATE));
		if vp.overlay.is_none() && root.depth > 0 {
			let innermost = root_func_scope(root, store)?.map(|f| f as usize);
			for (depth, name, var) in &root_locals(store)? {
				if private(var.as_ref()) && private_hidden(*depth as usize, innermost) {
					continue;
				}
				shadow(name, var.as_ref());
			}
		}
		let innermost = vp.scopes.iter().rposition(|s| s.func.is_some());
		for (i, scope) in vp.scopes.iter().enumerate() {
			for (name, var) in &scope.vars {
				if private(var.as_ref()) && private_hidden(i, innermost) {
					continue;
				}
				shadow(name, var.as_ref());
			}
		}
	}
	Ok(all.into_iter().collect())
}

/// Positional parameters of `vp` (the innermost function call's, else the
/// subshell's, else the root's).
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn positional(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<Vec<BString>, StoreError> {
	Ok(positional_ref(root, store, vp)?.to_vec())
}

/// [`positional`] borrowed (`$1`, `$#`: no copy of the list).
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn positional_ref<'a>(
	root: &Root,
	store: &'a mut dyn StateStore,
	vp: &'a Vproc,
) -> Result<&'a [BString], StoreError> {
	if vp.overlay.is_none() {
		return match root_params_scope(root, store)? {
			Some(depth) => Ok(root_scope(store, depth)?.1.unwrap_or_default()),
			None => root_positional(store),
		};
	}
	if let Some(p) = vp.scopes.iter().rev().find_map(|s| s.positional.as_deref()) {
		return Ok(p);
	}
	if let Some(p) = vp.overlay.as_ref().and_then(|o| o.positional.as_deref()) {
		return Ok(p);
	}
	root_positional(store)
}

/// Replace the positional parameters of `vp`'s current level.
pub fn set_positional(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	params: Vec<BString>,
) {
	if vp.overlay.is_none() {
		let found = match root_params_scope(root, store) {
			Ok(Some(depth)) => root_scope(store, depth)
				.map(|(func, _, zsh)| Some((depth, func.cloned(), zsh.cloned().map(Box::new)))),
			Ok(None) => Ok(None),
			Err(err) => Err(err),
		};
		match found {
			Ok(Some((depth, func, zsh))) => {
				let rec = Record::Scope { func, positional: Some(params), zsh };
				root.write(store, Change::Put(Key::Scope(depth), rec));
			},
			Ok(None) => root.set_positional(store, params),
			Err(err) => root.fail(err),
		}
	} else if let Some(scope) = vp.scopes.iter_mut().rev().find(|s| s.positional.is_some()) {
		scope.positional = Some(params);
	} else if let Some(ov) = &mut vp.overlay {
		ov.positional = Some(params);
	}
}

// ---- Scopes: the root vproc's in the store, a subshell's in its `Vproc`.

/// Number of function and temporary-environment scopes of `vp`.
pub const fn scope_count(root: &Root, vp: &Vproc) -> usize {
	if vp.overlay.is_none() {
		(root.depth + root.lazy) as usize
	} else {
		vp.scopes.len()
	}
}

/// Scope `i` (0 = outermost) of `vp`.
fn scope_in(vp: &Vproc, i: usize) -> In {
	if vp.overlay.is_none() {
		In::Store(u32::try_from(i).unwrap_or(u32::MAX))
	} else {
		In::Vec(i)
	}
}

/// Whether scope `at` belongs to a function (not a temporary environment).
fn scope_is_func(store: &mut dyn StateStore, vp: &Vproc, at: In) -> Result<bool, StoreError> {
	Ok(match at {
		In::Vec(i) => vp.scopes.get(i).is_some_and(|s| s.func.is_some()),
		In::Store(depth) => root_scope(store, depth)?.0.is_some(),
	})
}

/// The function name of scope `i` of `vp` (`None`: a temporary
/// environment; `Some("")`: a `${ ;}` body).
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn scope_func(
	store: &mut dyn StateStore,
	vp: &Vproc,
	i: usize,
) -> Result<Option<BString>, StoreError> {
	Ok(match scope_in(vp, i) {
		In::Vec(i) => vp.scopes.get(i).and_then(|s| s.func.clone()),
		In::Store(depth) => root_scope(store, depth)?.0.cloned(),
	})
}

/// The zsh call state scope `i` of `vp` holds, copied.
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn scope_zsh(
	store: &mut dyn StateStore,
	vp: &Vproc,
	i: usize,
) -> Result<Option<Box<ZshScope>>, StoreError> {
	Ok(match scope_in(vp, i) {
		In::Vec(i) => vp.scopes.get(i).and_then(|s| s.zsh.clone()),
		In::Store(depth) => root_scope(store, depth)?.2.cloned().map(Box::new),
	})
}

/// Replace the zsh call state of scope `i` of `vp` (`lossy` bits, saved
/// traps).
pub fn set_scope_zsh(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	i: usize,
	zsh: Option<Box<ZshScope>>,
) {
	match scope_in(vp, i) {
		In::Vec(i) => {
			if let Some(s) = vp.scopes.get_mut(i) {
				s.zsh = zsh;
			}
		},
		In::Store(depth) => {
			if depth >= root.depth {
				return;
			}
			let header = root_scope(store, depth)
				.map(|(func, positional, _)| (func.cloned(), positional.map(<[BString]>::to_vec)));
			match header {
				Ok((func, positional)) => {
					let rec = Record::Scope { func, positional, zsh };
					root.write(store, Change::Put(Key::Scope(depth), rec));
				},
				Err(err) => root.fail(err),
			}
		},
	}
}

/// The innermost function scope of `vp` (`local`'s), by index.
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn func_scope(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<Option<usize>, StoreError> {
	Ok(match level_at(root, store, vp, b"", Level::Local)? {
		Some(In::Vec(i)) => Some(i),
		Some(In::Store(depth)) => Some(depth as usize),
		None => None,
	})
}

/// Whether `vp` runs inside a function (any function scope).
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn in_function(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<bool, StoreError> {
	Ok(func_scope(root, store, vp)?.is_some())
}

/// The name of the innermost function `vp` runs in (`FUNCNAME[0]`'s
/// scope; `Some("")` inside a `${ ;}` body).
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn func_name(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<Option<BString>, StoreError> {
	match func_scope(root, store, vp)? {
		Some(i) => scope_func(store, vp, i),
		None => Ok(None),
	}
}

/// The innermost scope of `vp` binding `name` (a local or a temporary
/// variable), by index.
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn binding_scope(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	name: &[u8],
) -> Result<Option<usize>, StoreError> {
	Ok(match level_at(root, store, vp, name, Level::Dynamic)? {
		Some(In::Vec(i)) => Some(i),
		Some(In::Store(depth)) => Some(depth as usize),
		None => None,
	})
}

/// `name` in scope `i` of `vp`: `None` unbound there, `Some(None)` declared
/// but unset, `Some(Some(var))` (a copy).
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
#[expect(
	clippy::option_option,
	reason = "a scope's `VarMap` entry (`Option<Var>`) looked up: unbound, bound unset, bound"
)]
pub fn scope_var(
	store: &mut dyn StateStore,
	vp: &Vproc,
	i: usize,
	name: &[u8],
) -> Result<Option<Option<Var>>, StoreError> {
	Ok(match scope_in(vp, i) {
		In::Vec(i) => vp.scopes.get(i).and_then(|s| s.vars.get(name).cloned()),
		In::Store(depth) => match store.get(local_key(depth, name))? {
			Some(Record::Var(v)) => Some(Some(v.clone())),
			Some(_) => Some(None),
			None => None,
		},
	})
}

/// Whether scope `i` of `vp` may bind anything: `false` only for a root
/// scope [`Root`] knows holds no local (a function that declared nothing),
/// so a caller can skip reading it.
pub const fn scope_may_bind(root: &Root, vp: &Vproc, i: usize) -> bool {
	if vp.overlay.is_some() || i >= SCOPE_BITS as usize {
		return true;
	}
	root.locals & (1 << i) != 0
}

/// Whether scope `i` of `vp` binds `name`.
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn scope_binds(
	store: &mut dyn StateStore,
	vp: &Vproc,
	i: usize,
	name: &[u8],
) -> Result<bool, StoreError> {
	Ok(match scope_in(vp, i) {
		In::Vec(i) => vp.scopes.get(i).is_some_and(|s| s.vars.contains_key(name)),
		In::Store(depth) => store.get(local_key(depth, name))?.is_some(),
	})
}

/// Every binding of scope `i` of `vp` (copies), in no particular order.
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn scope_vars(
	store: &mut dyn StateStore,
	vp: &Vproc,
	i: usize,
) -> Result<Vec<(BString, Option<Var>)>, StoreError> {
	Ok(match scope_in(vp, i) {
		In::Vec(i) => vp
			.scopes
			.get(i)
			.map_or_default(|s| s.vars.iter().map(|(n, v)| (n.clone(), v.clone())).collect()),
		In::Store(depth) => {
			let mut vars = Vec::new();
			store.scan(Table::Local, &mut |key, rec| {
				if let Key::Local { depth: d, name } = key
					&& d == depth
				{
					let var = match rec {
						Record::Var(v) => Some(v.clone()),
						_ => None,
					};
					vars.push((BString::from(name), var));
				}
			})?;
			vars
		},
	})
}

/// Bind `name` in scope `i` of `vp` (`None`: declared, unset).
pub fn scope_set(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	i: usize,
	name: &[u8],
	var: Option<Var>,
) {
	let at = scope_in(vp, i);
	if matches!(at, In::Store(depth) if depth >= root.depth) {
		root.materialize(store);
	}
	put_scope(root, store, vp, at, name, var);
}

/// Remove the binding of `name` from scope `i` of `vp` (it is no longer
/// declared there).
pub fn scope_unbind(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	i: usize,
	name: &[u8],
) {
	match scope_in(vp, i) {
		In::Vec(i) => {
			if let Some(s) = vp.scopes.get_mut(i) {
				s.vars.remove(name);
			}
		},
		In::Store(depth) => root.write(store, Change::Del(local_key(depth, name))),
	}
}

/// Remove every binding of scope `i` of `vp`.
pub fn scope_clear(root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc, i: usize) {
	match scope_in(vp, i) {
		In::Vec(i) => {
			if let Some(s) = vp.scopes.get_mut(i) {
				s.vars.clear();
			}
		},
		In::Store(depth) => match scope_vars(store, vp, i) {
			Ok(vars) => {
				for (name, _) in vars {
					root.write(store, Change::Del(local_key(depth, &name)));
				}
			},
			Err(err) => root.fail(err),
		},
	}
}

/// The positional parameters scope `i` of `vp` holds (`None`: the outer
/// ones apply).
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn scope_positional(
	store: &mut dyn StateStore,
	vp: &Vproc,
	i: usize,
) -> Result<Option<Vec<BString>>, StoreError> {
	Ok(match scope_in(vp, i) {
		In::Vec(i) => vp.scopes.get(i).and_then(|s| s.positional.clone()),
		In::Store(depth) => root_scope(store, depth)?.1.map(<[BString]>::to_vec),
	})
}

/// Replace the positional parameters scope `i` of `vp` holds.
pub fn set_scope_positional(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	i: usize,
	params: Option<Vec<BString>>,
) {
	match scope_in(vp, i) {
		In::Vec(i) => {
			if let Some(s) = vp.scopes.get_mut(i) {
				s.positional = params;
			}
		},
		In::Store(depth) => {
			if depth >= root.depth {
				if params.is_none() {
					// A lazy scope holds none already.
					return;
				}
				root.materialize(store);
			}
			match scope_func(store, vp, i).and_then(|func| Ok((func, scope_zsh(store, vp, i)?))) {
				Ok((func, zsh)) => {
					let rec = Record::Scope { func, positional: params, zsh };
					root.write(store, Change::Put(Key::Scope(depth), rec));
				},
				Err(err) => root.fail(err),
			}
		},
	}
}

/// Push a function or temporary-environment scope on `vp`.
pub fn push_scope(root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc, scope: Scope) {
	if vp.overlay.is_some() {
		vp.scopes.push(scope);
		return;
	}
	if scope.func.is_none()
		&& scope.positional.is_none()
		&& scope.vars.is_empty()
		&& scope.zsh.is_none()
	{
		root.lazy += 1;
		return;
	}
	root.materialize(store);
	let depth = root.depth;
	let rec =
		Record::Scope { func: scope.func, positional: scope.positional, zsh: scope.zsh };
	root.write(store, Change::Put(Key::Scope(depth), rec));
	root.depth += 1;
	for (name, var) in scope.vars {
		root.write(store, Change::Put(local_key(depth, &name), binding_record(var)));
	}
}

/// Pop `vp`'s innermost scope without reading it back (a function's
/// return); `false` when it has none.
pub fn drop_scope(root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc) -> bool {
	if vp.overlay.is_some() {
		return vp.scopes.pop().is_some();
	}
	if root.lazy > 0 {
		root.lazy -= 1;
		return true;
	}
	let Some(depth) = root.depth.checked_sub(1) else {
		return false;
	};
	root.write(store, Change::Del(Key::Scope(depth)));
	root.depth = depth;
	true
}

/// Pop `vp`'s innermost scope and return it.
pub fn pop_scope(root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc) -> Option<Scope> {
	if vp.overlay.is_some() {
		return vp.scopes.pop();
	}
	if root.lazy > 0 {
		root.lazy -= 1;
		return Some(Scope::default());
	}
	let depth = root.depth.checked_sub(1)?;
	let scope = match read_scope(store, vp, depth as usize) {
		Ok(scope) => scope,
		Err(err) => {
			root.fail(err);
			Scope::default()
		},
	};
	drop_scope(root, store, vp);
	Some(scope)
}

/// Scope `i` of `vp`, copied.
fn read_scope(store: &mut dyn StateStore, vp: &Vproc, i: usize) -> Result<Scope, StoreError> {
	let mut vars = VarMap::default();
	for (name, var) in scope_vars(store, vp, i)? {
		vars.insert(name, var);
	}
	Ok(Scope {
		vars,
		positional: scope_positional(store, vp, i)?,
		func: scope_func(store, vp, i)?,
		zsh: scope_zsh(store, vp, i)?,
	})
}

/// Insert `scope` at index `at` (at most the scope count) of `vp`'s
/// scopes: the temporary environment a redirection list hid comes back
/// under the scopes pushed meanwhile.
pub fn insert_scope(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	at: usize,
	scope: Scope,
) {
	if vp.overlay.is_some() {
		let at = at.min(vp.scopes.len());
		vp.scopes.insert(at, scope);
		return;
	}
	let mut above = Vec::new();
	while (root.depth + root.lazy) as usize > at {
		match pop_scope(root, store, vp) {
			Some(s) => above.push(s),
			None => break,
		}
	}
	push_scope(root, store, vp, scope);
	for s in above.into_iter().rev() {
		push_scope(root, store, vp, s);
	}
}

/// Every scope of `vp`, copied (a subshell forked from it starts with
/// them).
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn copy_scopes(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<Vec<Scope>, StoreError> {
	if vp.overlay.is_some() {
		return Ok(vp.scopes.clone());
	}
	(0..(root.depth + root.lazy) as usize)
		.map(|i| read_scope(store, vp, i))
		.collect()
}

// ---- The root vproc's in-place fields.

/// `n` as decimal text.
fn decimal(n: impl std::fmt::Display) -> BString {
	BString::from(n.to_string())
}

/// Parse decimal text.
fn parse<T: std::str::FromStr>(text: &[u8]) -> Option<T> {
	std::str::from_utf8(text).ok()?.parse().ok()
}

/// `getopts` progress as [`MiscKey::Getopts`] stores it.
fn encode_getopts(g: &GetoptsState) -> Vec<BString> {
	let field = |v: Option<BString>| {
		v.map_or_default(|v| {
			let mut s = BString::from("=");
			s.extend_from_slice(&v);
			s
		})
	};
	vec![
		field(g.optind.clone()),
		field(g.next.map(|(a, o)| BString::from(format!("{a}:{o}")))),
		field(g.at.map(decimal)),
	]
}

/// [`encode_getopts`] backwards.
fn decode_getopts(words: &[BString]) -> GetoptsState {
	let field = |i: usize| words.get(i).and_then(|w| w.strip_prefix(b"="));
	GetoptsState {
		optind: field(0).map(BString::from),
		next:   field(1).and_then(|f| {
			let text = std::str::from_utf8(f).ok()?;
			let (a, o) = text.split_once(':')?;
			Some((a.parse().ok()?, o.parse().ok()?))
		}),
		at:     field(2).and_then(parse),
	}
}

/// `ulimit` values as [`MiscKey::Rlimits`] stores them.
fn encode_rlimits(limits: &[(Rlimit, Option<u64>, Option<u64>)]) -> Vec<BString> {
	let n = |v: Option<u64>| v.map_or_else(|| String::from("-"), |v| v.to_string());
	limits
		.iter()
		.map(|(r, soft, hard)| {
			BString::from(format!("{}:{}:{}", <&'static str>::from(*r), n(*soft), n(*hard)))
		})
		.collect()
}

/// [`encode_rlimits`] backwards (malformed entries are skipped).
fn decode_rlimits(words: &[BString]) -> Vec<(Rlimit, Option<u64>, Option<u64>)> {
	use strum::IntoEnumIterator;
	let n = |v: &str| {
		if v == "-" {
			Some(None)
		} else {
			v.parse().ok().map(Some)
		}
	};
	words
		.iter()
		.filter_map(|w| {
			let text = std::str::from_utf8(w).ok()?;
			let mut parts = text.split(':');
			let (name, soft, hard) = (parts.next()?, parts.next()?, parts.next()?);
			let r = Rlimit::iter().find(|r| <&'static str>::from(*r) == name)?;
			Some((r, n(soft)?, n(hard)?))
		})
		.collect()
}

/// Write the root job table's changes since the last sync: each job is
/// compared with its store record (the store holds what was written last,
/// so the engine keeps no copy of the table), jobs gone from the table are
/// deleted.
fn write_jobs(root: &mut Root, store: &mut dyn StateStore, jobs: &JobTable) {
	let mut ids = std::mem::take(&mut root.synced.job_ids);
	let same_ids =
		ids.len() == jobs.list.len() && ids.iter().zip(&jobs.list).all(|(id, j)| *id == j.id);
	if !same_ids {
		for id in &ids {
			if !jobs.list.iter().any(|j| j.id == *id) {
				root.write(store, Change::Del(Key::Job(*id)));
			}
		}
		ids.clear();
		ids.extend(jobs.list.iter().map(|j| j.id));
	}
	root.synced.job_ids = ids;
	for job in &jobs.list {
		let written = match store.get(Key::Job(job.id)) {
			Ok(Some(Record::Job(have))) => have == job,
			Ok(_) => false,
			Err(err) => {
				root.fail(err);
				return;
			},
		};
		if !written {
			root.write(store, Change::Put(Key::Job(job.id), Record::Job(job.clone())));
		}
	}
	let (current, previous, chld) = root.synced.job_marks;
	for (key, new, was) in [
		(MiscKey::JobCurrent, jobs.current, current),
		(MiscKey::JobPrevious, jobs.previous, previous),
		(MiscKey::ChldOwed, Some(jobs.chld).filter(|&n| n > 0), Some(chld).filter(|&n| n > 0)),
	] {
		if new != was {
			root.set_record(store, KeyBuf::Misc(key), new.map(|n| Record::Misc(decimal(n))));
		}
	}
	root.synced.job_marks = (jobs.current, jobs.previous, jobs.chld);
}

/// Write the root vproc's in-place fields that changed since the last call
/// (`$?`, `PIPESTATUS`, `$!`, the job table, `getopts` progress, `ulimit`
/// values). Called at the end of every `step` (the one returning a
/// `Step::Call` included), by `externalize` and by `restore`: the store
/// contract's granularity for these fields.
pub fn sync_root(root: &mut Root, store: &mut dyn StateStore, vp: &Vproc) {
	debug_assert!(vp.overlay.is_none(), "only the root vproc's fields are in the store");
	if vp.status != root.synced.status {
		root.synced.status = vp.status;
		root.set_misc(store, MiscKey::Status, decimal(vp.status));
	}
	if vp.pipestatus != root.synced.pipestatus {
		root.synced.pipestatus.clone_from(&vp.pipestatus);
		let words = vp.pipestatus.iter().map(|s| decimal(*s)).collect();
		root.set_record(store, KeyBuf::Misc(MiscKey::PipeStatus), Some(Record::Words(words)));
	}
	if vp.last_bg != root.synced.last_bg {
		root.synced.last_bg = vp.last_bg;
		let rec = vp.last_bg.vpid().map(|v| {
			Record::Misc(match vp.last_bg.os() {
				Some(os) => BString::from(format!("{}:{os}", v.0)),
				None => decimal(v.0),
			})
		});
		root.set_record(store, KeyBuf::Misc(MiscKey::LastBg), rec);
	}
	// Jobs are compared with their records: only an empty table that was
	// written empty is skipped without a read.
	let marks = (vp.jobs.current, vp.jobs.previous, vp.jobs.chld);
	if !vp.jobs.list.is_empty() || !root.synced.job_ids.is_empty() || marks != root.synced.job_marks
	{
		write_jobs(root, store, &vp.jobs);
	}
	if vp.getopts != root.synced.getopts {
		root.synced.getopts.clone_from(&vp.getopts);
		let rec = (vp.getopts != GetoptsState::default())
			.then(|| Record::Words(encode_getopts(&vp.getopts)));
		root.set_record(store, KeyBuf::Misc(MiscKey::Getopts), rec);
	}
	if vp.rlimits != root.synced.rlimits {
		root.synced.rlimits.clone_from(&vp.rlimits);
		let rec = (!vp.rlimits.is_empty()).then(|| Record::Words(encode_rlimits(&vp.rlimits)));
		root.set_record(store, KeyBuf::Misc(MiscKey::Rlimits), rec);
	}
}

/// Load the root vproc's in-place fields from the store ([`sync_root`]'s
/// records) and note them as written: a shell restored from the store
/// alone continues with them.
///
/// # Errors
/// [`StoreError`] when the store cannot be read or a record has the wrong
/// shape.
pub fn load_root(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
) -> Result<(), StoreError> {
	let misc = |store: &mut dyn StateStore, key| -> Result<Option<BString>, StoreError> {
		Ok(root_misc(store, key)?.map(BString::from))
	};
	let words = |store: &mut dyn StateStore, key| -> Result<Vec<BString>, StoreError> {
		match store.get(Key::Misc(key))? {
			Some(Record::Words(w)) => Ok(w.clone()),
			Some(_) => Err(StoreError::Shape { table: Table::Misc }),
			None => Ok(Vec::new()),
		}
	};
	vp.status = misc(store, MiscKey::Status)?
		.and_then(|s| parse(&s))
		.unwrap_or(0);
	vp.pipestatus = words(store, MiscKey::PipeStatus)?
		.iter()
		.filter_map(|w| parse(w))
		.collect();
	vp.last_bg = misc(store, MiscKey::LastBg)?.map_or_else(LastBg::default, |s| {
		let mut parts = s.splitn(2, |&c| c == b':');
		let mut bg = parts
			.next()
			.and_then(parse)
			.map_or_else(LastBg::default, |v| LastBg::new(Vpid(v)));
		if let Some(os) = parts.next().and_then(parse) {
			bg.set_os(os);
		}
		bg
	});
	let mut list = Vec::new();
	store.scan(Table::Job, &mut |_, rec| {
		if let Record::Job(job) = rec {
			list.push(job.clone());
		}
	})?;
	list.sort_by_key(|j| j.number);
	vp.jobs = JobTable {
		list,
		current: misc(store, MiscKey::JobCurrent)?.and_then(|s| parse(&s)),
		previous: misc(store, MiscKey::JobPrevious)?.and_then(|s| parse(&s)),
		chld: misc(store, MiscKey::ChldOwed)?
			.and_then(|s| parse(&s))
			.unwrap_or(0),
		subshell: false,
	};
	vp.getopts = decode_getopts(&words(store, MiscKey::Getopts)?);
	vp.rlimits = decode_rlimits(&words(store, MiscKey::Rlimits)?);
	root.synced = Synced {
		status:     vp.status,
		pipestatus: vp.pipestatus.clone(),
		last_bg:    vp.last_bg,
		job_ids:    vp.jobs.list.iter().map(|j| j.id).collect(),
		job_marks:  (vp.jobs.current, vp.jobs.previous, vp.jobs.chld),
		getopts:    vp.getopts.clone(),
		rlimits:    vp.rlimits.clone(),
	};
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::{
		fd::FdTable,
		ids::{JobId, ModeId, UnitId},
		signal::Signal,
		store::{Job, JobState},
	};

	fn order(keys: &[String]) -> Vec<String> {
		let items: Vec<(BString, BString)> = keys
			.iter()
			.map(|k| (BString::from(k.as_str()), BString::default()))
			.collect();
		assoc_order_sized(&items, Attrs::NONE)
			.into_iter()
			.map(|(k, _)| k.to_string())
			.collect()
	}

	fn keys(ks: &[&str]) -> Vec<String> {
		ks.iter().map(|k| (*k).to_owned()).collect()
	}

	// Goldens: bash 5.3.20 `declare -A a; a[k]=…; echo "${!a[@]}"`.
	#[test]
	fn assoc_iteration_follows_bash_hash_buckets() {
		assert_eq!(order(&keys(&["one", "two", "three"])), keys(&["two", "three", "one"]));
		assert_eq!(
			order(&keys(&["one", "two", "three", "0", "four"])),
			keys(&["four", "0", "two", "three", "one"])
		);
		assert_eq!(order(&keys(&["ack", "oen"])), keys(&["oen", "ack"]));
	}

	// Goldens: bash 5.3.20 `RANDOM=S; echo $RANDOM …`.
	#[test]
	fn random_follows_bash() {
		let mut r = Random::default();
		r.seed(42);
		assert_eq!([r.next(), r.next(), r.next()], [17772, 26794, 1435]);
		r.seed(0);
		assert_eq!([r.next(), r.next()], [20814, 24386]);
		r.seed(-5);
		assert_eq!(r.next(), 17653);
		r.seed(4_294_967_338);
		assert_eq!(r.next(), 17772, "only the low 32 bits seed");
	}

	#[test]
	fn random_state_round_trips_through_its_text() {
		let mut r = Random::default();
		r.seed(42);
		r.next();
		let mut back = Random::decode(&r.encode()).unwrap();
		assert_eq!(back, r);
		assert_eq!(back.next(), 26794, "continues the sequence");
		assert_eq!(Random::decode(b"7"), None);
		assert_eq!(Random::decode(b"x:1"), None);
	}

	// Golden: 2100 keys `k1`…`k2100` grow bash's table (1024 → 4096 buckets).
	#[test]
	fn assoc_iteration_after_growth() {
		let ks: Vec<String> = (1..=2100).map(|i| format!("k{i}")).collect();
		let o = order(&ks);
		assert_eq!(o[..5], keys(&["k1698", "k1699", "k1696", "k1697", "k1694"]));
		assert_eq!(o[o.len() - 3..], keys(&["k1044", "k1049", "k1048"]));
	}

	fn shell() -> (crate::bash::MemStore, Root, Vproc) {
		let mut store = crate::bash::MemStore::new();
		let root = Root::load(&mut store).unwrap();
		let vp = Vproc::new(Vpid(1), None, FdTable::default(), BString::from("/"), None, false);
		(store, root, vp)
	}

	fn subshell(parent: &Vproc) -> Vproc {
		Vproc::new(
			Vpid(parent.vpid.0 + 1),
			Some(parent.vpid),
			FdTable::default(),
			BString::from("/"),
			Some(Overlay::default()),
			true,
		)
	}

	fn func_scope_named(name: &str) -> Scope {
		Scope { func: Some(name.into()), ..Scope::default() }
	}

	fn invalidate(root: &mut Root, store: &mut crate::bash::MemStore) {
		let epoch = store.epoch();
		root.invalidate(store, epoch);
	}

	/// The option as the record table says, bypassing the bitset.
	fn option_record(store: &mut dyn StateStore, vp: &Vproc, opt: OptId) -> bool {
		opt_value(opt, record(store, vp, Key::Opt(opt)).unwrap())
	}

	#[test]
	fn option_bits_follow_every_write_path() {
		use strum::IntoEnumIterator;
		let (mut store, mut root, mut vp) = shell();
		let check = |root: &mut Root, store: &mut crate::bash::MemStore, vp: &Vproc| {
			for opt in OptId::iter() {
				let want = option_record(store, vp, opt);
				assert_eq!(option(root, store, vp, opt).unwrap(), want, "{opt}");
			}
		};
		check(&mut root, &mut store, &vp);
		assert!(!option(&mut root, &mut store, &vp, OptId::Noglob).unwrap());
		assert!(option(&mut root, &mut store, &vp, OptId::Braceexpand).unwrap());
		// `set`/`shopt` at the root, read back after the bit was derived.
		store_record(
			&mut root,
			&mut store,
			&mut vp,
			KeyBuf::Opt(OptId::Noglob),
			Some(Record::Opt(true)),
		);
		store_record(&mut root, &mut store, &mut vp, KeyBuf::Opt(OptId::Braceexpand), None);
		assert!(option(&mut root, &mut store, &vp, OptId::Noglob).unwrap());
		let on = option(&mut root, &mut store, &vp, OptId::Braceexpand).unwrap();
		assert!(on, "removed: the default");
		check(&mut root, &mut store, &vp);
		// A subshell's overlay shadows the root bit both ways.
		let mut sub = subshell(&vp);
		store_record(
			&mut root,
			&mut store,
			&mut sub,
			KeyBuf::Opt(OptId::Noglob),
			Some(Record::Opt(false)),
		);
		store_record(
			&mut root,
			&mut store,
			&mut sub,
			KeyBuf::Opt(OptId::Xtrace),
			Some(Record::Opt(true)),
		);
		assert!(!option(&mut root, &mut store, &sub, OptId::Noglob).unwrap());
		assert!(option(&mut root, &mut store, &sub, OptId::Xtrace).unwrap());
		assert!(option(&mut root, &mut store, &vp, OptId::Noglob).unwrap());
		assert!(!option(&mut root, &mut store, &vp, OptId::Xtrace).unwrap());
		check(&mut root, &mut store, &sub);
		// ENOEXEC reset and `local -` restore go through the same writes.
		reset_options(&mut root, &mut store, &mut vp);
		check(&mut root, &mut store, &vp);
		restore_set_options(&mut root, &mut store, &mut vp, b"errexit:noglob").unwrap();
		assert!(option(&mut root, &mut store, &vp, OptId::Errexit).unwrap());
		assert!(!option(&mut root, &mut store, &vp, OptId::Braceexpand).unwrap());
		check(&mut root, &mut store, &vp);
		// An out-of-band store change: the bits derived before it stand
		// until the epoch is seen, then every one is read again.
		assert!(!option(&mut root, &mut store, &vp, OptId::Pipefail).unwrap());
		store
			.put_out_of_band(Key::Opt(OptId::Pipefail), Record::Opt(true))
			.unwrap();
		store
			.put_out_of_band(Key::Opt(OptId::Errexit), Record::Opt(false))
			.unwrap();
		let on = option(&mut root, &mut store, &vp, OptId::Pipefail).unwrap();
		assert!(!on, "same epoch: derived bit kept");
		invalidate(&mut root, &mut store);
		assert!(option(&mut root, &mut store, &vp, OptId::Pipefail).unwrap());
		assert!(!option(&mut root, &mut store, &vp, OptId::Errexit).unwrap());
		check(&mut root, &mut store, &vp);
	}

	// Golden: bash 5.3.20 `bash -c 'echo $SHELLOPTS; set -e; echo $SHELLOPTS'`.
	#[test]
	fn option_vars_are_rewritten_only_when_they_change() {
		let (mut store, mut root, mut vp) = shell();
		init_option_vars(&mut root, &mut store).unwrap();
		let value = |root: &Root, store: &mut crate::bash::MemStore, vp: &Vproc| {
			lookup(root, store, vp, b"SHELLOPTS")
				.unwrap()
				.map(|v| v.value.clone())
		};
		let defaults = VarValue::Str("braceexpand:hashall:interactive-comments".into());
		assert_eq!(value(&root, &mut store, &vp), Some(defaults.clone()));
		// Nothing changed: no write (a `$( )` with `errexit` off).
		let mut sub = subshell(&vp);
		sync_option_vars(&mut root, &mut store, &mut sub).unwrap();
		assert!(sub.overlay.as_ref().unwrap().vars.is_empty());
		// A change is written where the vproc writes.
		store_record(
			&mut root,
			&mut store,
			&mut sub,
			KeyBuf::Opt(OptId::Errexit),
			Some(Record::Opt(true)),
		);
		sync_option_vars(&mut root, &mut store, &mut sub).unwrap();
		let mine = value(&root, &mut store, &sub);
		let errexit = VarValue::Str("braceexpand:errexit:hashall:interactive-comments".into());
		assert_eq!(mine, Some(errexit));
		assert_eq!(value(&root, &mut store, &vp), Some(defaults));
		// An exported SHELLOPTS stays exported and readonly.
		let exported = Var::scalar("stale", Attrs::READONLY.with(Attrs::EXPORT));
		store_var(&mut root, &mut store, &mut vp, b"SHELLOPTS", Some(exported), Level::Global);
		sync_option_vars(&mut root, &mut store, &mut vp).unwrap();
		let v = lookup(&root, &mut store, &vp, b"SHELLOPTS")
			.unwrap()
			.unwrap();
		assert_eq!(v.attrs, Attrs::READONLY.with(Attrs::EXPORT));
		assert_eq!(v.value, VarValue::Str("braceexpand:hashall:interactive-comments".into()));
	}

	#[test]
	fn lookup_sees_scopes_overlay_root_and_namerefs() {
		let (mut store, mut root, mut vp) = shell();
		store
			.put_out_of_band(Key::Var(BStr::new("a")), Record::Var(Var::scalar("root", Attrs::NONE)))
			.unwrap();
		invalidate(&mut root, &mut store);
		let get = |root: &Root, store: &mut crate::bash::MemStore, vp: &Vproc, name: &str| {
			lookup(root, store, vp, name.as_bytes())
				.unwrap()
				.and_then(Var::as_scalar)
				.map(<[u8]>::to_vec)
		};
		let a = get(&root, &mut store, &vp, "a");
		assert_eq!(a, Some(b"root".to_vec()), "read from the store");
		assert_eq!(get(&root, &mut store, &vp, "nope"), None);
		let reference = Var::scalar("a", Attrs::NAMEREF);
		store_var(&mut root, &mut store, &mut vp, b"r", Some(reference), Level::Global);
		assert_eq!(get(&root, &mut store, &vp, "r"), Some(b"root".to_vec()));
		// A function scope (in the store for the root vproc): a local hides
		// the root, an unset local hides it as unset, a local nameref
		// resolves through the scopes.
		push_scope(&mut root, &mut store, &mut vp, func_scope_named("f"));
		assert_eq!(scope_count(&root, &vp), 1);
		assert!(vp.scopes.is_empty(), "the root vproc's scopes live in the store");
		store_var(
			&mut root,
			&mut store,
			&mut vp,
			b"a",
			Some(Var::scalar("local", Attrs::NONE)),
			Level::Local,
		);
		assert_eq!(
			store.record(Key::Local { depth: 0, name: BStr::new("a") }),
			Some(&Record::Var(Var::scalar("local", Attrs::NONE))),
			"written through"
		);
		assert_eq!(get(&root, &mut store, &vp, "a"), Some(b"local".to_vec()));
		assert_eq!(get(&root, &mut store, &vp, "r"), Some(b"local".to_vec()));
		store_var(
			&mut root,
			&mut store,
			&mut vp,
			b"q",
			Some(Var::scalar("a", Attrs::NAMEREF)),
			Level::Local,
		);
		assert_eq!(get(&root, &mut store, &vp, "q"), Some(b"local".to_vec()));
		unset_var(&mut root, &mut store, &mut vp, b"a", false);
		assert_eq!(get(&root, &mut store, &vp, "a"), None);
		assert!(
			lookup_declared(&root, &mut store, &vp, b"a")
				.unwrap()
				.is_some()
		);
		assert!(drop_scope(&mut root, &mut store, &mut vp));
		assert_eq!(
			store.record(Key::Local { depth: 0, name: BStr::new("q") }),
			None,
			"popped with its scope"
		);
		assert_eq!(get(&root, &mut store, &vp, "a"), Some(b"root".to_vec()));
		// A subshell's own value, then the root's again for the parent.
		let mut sub = subshell(&vp);
		store_var(
			&mut root,
			&mut store,
			&mut sub,
			b"a",
			Some(Var::scalar("sub", Attrs::NONE)),
			Level::Global,
		);
		assert_eq!(get(&root, &mut store, &sub, "r"), Some(b"sub".to_vec()));
		assert_eq!(get(&root, &mut store, &vp, "r"), Some(b"root".to_vec()));
		// A circular reference reads as unset.
		store_var(
			&mut root,
			&mut store,
			&mut vp,
			b"c",
			Some(Var::scalar("c", Attrs::NAMEREF)),
			Level::Global,
		);
		assert_eq!(get(&root, &mut store, &vp, "c"), None);
	}

	#[test]
	fn locale_token_changes_with_every_locale_write() {
		let (mut store, mut root, mut vp) = shell();
		let names: &[&[u8]] = &[b"LC_ALL", b"LC_CTYPE", b"LANG"];
		let t0 = locale_token(&root, &mut store, &vp, names).unwrap();
		store_var(
			&mut root,
			&mut store,
			&mut vp,
			b"x",
			Some(Var::scalar("1", Attrs::NONE)),
			Level::Global,
		);
		assert_eq!(locale_token(&root, &mut store, &vp, names), Some(t0), "other names do not count");
		store_var(
			&mut root,
			&mut store,
			&mut vp,
			b"LANG",
			Some(Var::scalar("C", Attrs::NONE)),
			Level::Global,
		);
		let t1 = locale_token(&root, &mut store, &vp, names).unwrap();
		assert_ne!(t1, t0);
		// In place (`declare -x LC_CTYPE`, `LC_CTYPE+=x`).
		let c = Some(Var::scalar("C", Attrs::NONE));
		store_var(&mut root, &mut store, &mut vp, b"LC_CTYPE", c, Level::Global);
		let t2 = locale_token(&root, &mut store, &vp, names).unwrap();
		let edit = VarEdit::Set { elem: None, value: b"en_US.UTF-8", append: false };
		assert!(edit_var(&mut root, &mut store, &mut vp, b"LC_CTYPE", Level::Dynamic, edit).unwrap());
		let t3 = locale_token(&root, &mut store, &vp, names).unwrap();
		assert_ne!(t3, t2);
		unset_var(&mut root, &mut store, &mut vp, b"LANG", false);
		let t4 = locale_token(&root, &mut store, &vp, names).unwrap();
		assert_ne!(t4, t3);
		// Bound in a scope (temporary environment, `local`) or a subshell:
		// no token; back to the root's once the scope is gone.
		push_scope(&mut root, &mut store, &mut vp, func_scope_named("f"));
		assert_eq!(
			locale_token(&root, &mut store, &vp, names),
			Some(t4),
			"an empty scope binds nothing"
		);
		store_var(
			&mut root,
			&mut store,
			&mut vp,
			b"LC_ALL",
			Some(Var::scalar("C", Attrs::NONE)),
			Level::Local,
		);
		assert_eq!(locale_token(&root, &mut store, &vp, names), None);
		drop_scope(&mut root, &mut store, &mut vp);
		assert_eq!(locale_token(&root, &mut store, &vp, names), Some(t4));
		let mut sub = subshell(&vp);
		assert_eq!(locale_token(&root, &mut store, &sub, names), Some(t4));
		store_var(
			&mut root,
			&mut store,
			&mut sub,
			b"LANG",
			Some(Var::scalar("C", Attrs::NONE)),
			Level::Global,
		);
		assert_eq!(locale_token(&root, &mut store, &sub, names), None);
		// An out-of-band store change.
		store
			.put_out_of_band(
				Key::Var(BStr::new("LANG")),
				Record::Var(Var::scalar("C.UTF-8", Attrs::NONE)),
			)
			.unwrap();
		invalidate(&mut root, &mut store);
		assert_ne!(locale_token(&root, &mut store, &vp, names), Some(t4));
	}

	#[test]
	fn exported_matches_the_filtered_scan() {
		let (mut store, mut root, mut vp) = shell();
		let x = Attrs::EXPORT;
		let rec = |v: &str, attrs| Record::Var(Var::scalar(v, attrs));
		store
			.put_out_of_band(Key::Var(BStr::new("stored")), rec("s", x))
			.unwrap();
		store
			.put_out_of_band(Key::Var(BStr::new("cached")), rec("old", x))
			.unwrap();
		store
			.put_out_of_band(Key::Var(BStr::new("plain")), rec("p", Attrs::NONE))
			.unwrap();
		invalidate(&mut root, &mut store);
		store_var(
			&mut root,
			&mut store,
			&mut vp,
			b"cached",
			Some(Var::scalar("new", x)),
			Level::Global,
		);
		// No element 0: no scalar view, not exported.
		let arr = Var { attrs: x, value: VarValue::Indexed(vec![(1, "b".into())]) };
		store_var(&mut root, &mut store, &mut vp, b"arr", Some(arr), Level::Global);
		store_var(&mut root, &mut store, &mut vp, b"gone", Some(Var::scalar("g", x)), Level::Global);
		// `export foo` without a value: hidden, not listed, at every level.
		let declared = x.with(Attrs::INVISIBLE);
		store_var(
			&mut root,
			&mut store,
			&mut vp,
			b"decl",
			Some(Var::scalar("", declared)),
			Level::Global,
		);
		store_var(&mut root, &mut store, &mut vp, b"hid", Some(Var::scalar("h", x)), Level::Global);
		store
			.put_out_of_band(Key::Var(BStr::new("sdecl")), rec("", declared))
			.unwrap();
		let func = |src: &str, attrs| Record::Func {
			mode: ModeId::Bash,
			sticky: None,
			source: BString::from(src).into(),
			unit: UnitId([0; 32]),
			attrs,
			file: BString::default(),
		};
		store
			.put_out_of_band(Key::Func(BStr::new("sf")), func("sf () \n{ :; }", x))
			.unwrap();
		invalidate(&mut root, &mut store);
		store_record(
			&mut root,
			&mut store,
			&mut vp,
			KeyBuf::Func("rf".into()),
			Some(func("rf () \n{ :; }", x)),
		);
		store_record(
			&mut root,
			&mut store,
			&mut vp,
			KeyBuf::Func("hidden".into()),
			Some(func("h", Attrs::NONE)),
		);
		let mut sub = subshell(&vp);
		store_var(&mut root, &mut store, &mut sub, b"gone", None, Level::Global);
		store_var(
			&mut root,
			&mut store,
			&mut sub,
			b"plain",
			Some(Var::scalar("p2", x)),
			Level::Global,
		);
		store_var(
			&mut root,
			&mut store,
			&mut sub,
			b"hid",
			Some(Var::scalar("", declared)),
			Level::Global,
		);
		store_record(&mut root, &mut store, &mut sub, KeyBuf::Func("sf".into()), None);
		sub.scopes.push(func_scope_named("f"));
		// `local stored` (unset) keeps the exported outer one; a local
		// value shadows it; an outer scope's unset hides.
		let invisible = Var::scalar("", Attrs::INVISIBLE);
		store_var(&mut root, &mut store, &mut sub, b"stored", Some(invisible.clone()), Level::Local);
		store_var(
			&mut root,
			&mut store,
			&mut sub,
			b"cached",
			Some(Var::scalar("loc", Attrs::NONE)),
			Level::Local,
		);
		store_var(&mut root, &mut store, &mut sub, b"lx", Some(Var::scalar("l", x)), Level::Local);
		// The same at the root vproc, whose scopes are in the store.
		push_scope(&mut root, &mut store, &mut vp, func_scope_named("g"));
		store_var(&mut root, &mut store, &mut vp, b"stored", Some(invisible), Level::Local);
		store_var(&mut root, &mut store, &mut vp, b"rl", Some(Var::scalar("r", x)), Level::Local);
		store_var(&mut root, &mut store, &mut vp, b"hid", None, Level::Local);
		for who in [&vp, &sub] {
			let mut want: Vec<(BString, BString)> = scan(&root, &mut store, who, Table::Var)
				.unwrap()
				.into_iter()
				.filter_map(|(k, r)| match (k, r) {
					(KeyBuf::Var(n), Record::Var(v)) if v.attrs.contains(x) => {
						value_scalar(&v.value).map(|s| (n, BString::from(s)))
					},
					_ => None,
				})
				.collect();
			let mut got = Vec::new();
			exported(&root, &mut store, who, &mut got).unwrap();
			want.sort();
			got.sort();
			assert_eq!(got, want);
			let mut want_f: Vec<(BString, BString)> = scan(&root, &mut store, who, Table::Func)
				.unwrap()
				.into_iter()
				.filter_map(|(k, r)| match (k, r) {
					(KeyBuf::Func(n), Record::Func { source, attrs, .. }) if attrs.contains(x) => {
						Some((n, (*source).clone()))
					},
					_ => None,
				})
				.collect();
			let mut got_f = Vec::new();
			exported_funcs(&mut store, who, &mut got_f).unwrap();
			want_f.sort();
			got_f.sort();
			assert_eq!(got_f, want_f);
		}
		let pairs = |ps: &[(&str, &str)]| -> Vec<(BString, BString)> {
			ps.iter()
				.map(|(a, b)| (BString::from(*a), BString::from(*b)))
				.collect()
		};
		let mut got = Vec::new();
		exported(&root, &mut store, &sub, &mut got).unwrap();
		got.sort();
		assert_eq!(got, pairs(&[("lx", "l"), ("plain", "p2"), ("stored", "s")]));
		let mut got = Vec::new();
		exported(&root, &mut store, &vp, &mut got).unwrap();
		got.sort();
		assert_eq!(got, pairs(&[("cached", "new"), ("gone", "g"), ("rl", "r"), ("stored", "s")]));
	}

	#[test]
	fn disabled_builtins_flag_follows_the_record() {
		let (mut store, mut root, _) = shell();
		assert!(!root.builtins_disabled(&mut store).unwrap());
		let key = KeyBuf::Misc(MiscKey::DisabledBuiltins);
		root.set_record(&mut store, key.clone(), Some(Record::Words(vec!["echo".into()])));
		assert!(root.builtins_disabled(&mut store).unwrap());
		root.set_record(&mut store, key.clone(), Some(Record::Words(Vec::new())));
		assert!(!root.builtins_disabled(&mut store).unwrap());
		root.set_record(&mut store, key, None);
		assert!(!root.builtins_disabled(&mut store).unwrap());
		let cd = Record::Words(vec!["cd".into()]);
		store
			.put_out_of_band(Key::Misc(MiscKey::DisabledBuiltins), cd)
			.unwrap();
		assert!(!root.builtins_disabled(&mut store).unwrap(), "same epoch: derived flag kept");
		invalidate(&mut root, &mut store);
		assert!(root.builtins_disabled(&mut store).unwrap());
	}

	/// The store's fine-grained changes of a root variable leave it exactly
	/// as the in-memory edit of a scope's or an overlay's does.
	#[test]
	fn edit_var_in_the_store_matches_the_edit_in_memory() {
		let s = |v: &str| BString::from(v);
		let vars = [
			Var::scalar("ab", Attrs::NONE),
			Var::scalar("", Attrs::INVISIBLE),
			Var::scalar("7", Attrs::EXPORT),
			Var { attrs: Attrs::INDEXED, value: VarValue::Indexed(vec![(0, s("x")), (5, s("y"))]) },
			Var { attrs: Attrs::INDEXED, value: VarValue::Indexed(Vec::new()) },
			Var {
				attrs: Attrs::ASSOC,
				value: VarValue::Assoc(vec![(s("k"), s("v")), (s("0"), s("z"))].into()),
			},
			Var { attrs: Attrs::INVISIBLE.with(Attrs::INDEXED), value: VarValue::Indexed(Vec::new()) },
		];
		let k = BStr::new("k");
		let n = BStr::new("n");
		let edits = || {
			vec![
				VarEdit::Set { elem: None, value: b"new", append: false },
				VarEdit::Set { elem: None, value: b"+", append: true },
				VarEdit::Set { elem: Some(Elem::Index(5)), value: b"q", append: false },
				VarEdit::Set { elem: Some(Elem::Index(5)), value: b"+", append: true },
				VarEdit::Set { elem: Some(Elem::Index(5)), value: b"", append: true },
				VarEdit::Set { elem: Some(Elem::Index(3)), value: b"q", append: true },
				VarEdit::Set { elem: Some(Elem::Key(k)), value: b"w", append: true },
				VarEdit::Set { elem: Some(Elem::Key(n)), value: b"w", append: false },
				VarEdit::Number { elem: None, value: b"42" },
				VarEdit::Number { elem: Some(Elem::Index(2)), value: b"1" },
				VarEdit::Number { elem: Some(Elem::Key(k)), value: b"9" },
				VarEdit::Remove(Elem::Index(5)),
				VarEdit::Remove(Elem::Index(3)),
				VarEdit::Remove(Elem::Key(k)),
				VarEdit::Remove(Elem::Key(n)),
				VarEdit::Push(vec![s("p"), s("q")]),
				VarEdit::AddAttrs(Attrs::EXPORT),
				VarEdit::Replace(Var::scalar("r", Attrs::READONLY)),
			]
		};
		for var in &vars {
			for (i, edit) in edits().into_iter().enumerate() {
				let (mut store, mut root, mut vp) = shell();
				store_var(&mut root, &mut store, &mut vp, b"v", Some(var.clone()), Level::Global);
				let mut want = var.clone();
				edits().swap_remove(i).apply(&mut want);
				assert!(edit_var(&mut root, &mut store, &mut vp, b"v", Level::Dynamic, edit).unwrap());
				assert!(root.take_fault().is_none());
				let got = store.record(Key::Var(BStr::new("v")));
				assert_eq!(got, Some(&Record::Var(want.clone())), "{var:?} edit {i}");
				// Told what the variable showed, the edit skips reading it
				// and still ends the same.
				let (mut store, mut root, mut vp) = shell();
				store_var(&mut root, &mut store, &mut vp, b"v", Some(var.clone()), Level::Global);
				let edit = edits().swap_remove(i);
				let seen = Seen::of(var);
				assert!(
					edit_seen(&mut root, &mut store, &mut vp, b"v", Level::Dynamic, edit, seen).unwrap()
				);
				let got = store.record(Key::Var(BStr::new("v")));
				assert_eq!(got, Some(&Record::Var(want)), "{var:?} edit {i} seen {seen:?}");
			}
		}
		// Nothing bound: nothing done.
		let (mut store, mut root, mut vp) = shell();
		let edit = VarEdit::Push(vec![s("x")]);
		assert!(!edit_var(&mut root, &mut store, &mut vp, b"none", Level::Dynamic, edit).unwrap());
		assert!(store.is_empty());
	}

	#[test]
	fn root_scopes_and_subshell_scopes_behave_alike() {
		let (mut store, mut root, mut vp) = shell();
		let mut sub = subshell(&vp);
		let both = |root: &mut Root,
		            store: &mut crate::bash::MemStore,
		            vp: &mut Vproc,
		            sub: &mut Vproc,
		            f: &dyn Fn(&mut Root, &mut crate::bash::MemStore, &mut Vproc)| {
			f(root, store, vp);
			f(root, store, sub);
		};
		let x = Var::scalar("1", Attrs::NONE);
		both(&mut root, &mut store, &mut vp, &mut sub, &|r, s, v| {
			push_scope(r, s, v, Scope {
				func: Some("f".into()),
				positional: Some(vec!["a".into()]),
				..Scope::default()
			});
			store_var(r, s, v, b"x", Some(Var::scalar("1", Attrs::NONE)), Level::Local);
			store_var(r, s, v, b"u", None, Level::Local);
			push_scope(r, s, v, Scope::default());
			scope_set(r, s, v, 1, b"t", Some(Var::scalar("tmp", Attrs::NONE)));
		});
		for v in [&vp, &sub] {
			assert_eq!(scope_count(&root, v), 2);
			assert!(in_function(&root, &mut store, v).unwrap());
			assert_eq!(func_scope(&root, &mut store, v).unwrap(), Some(0));
			assert_eq!(func_name(&root, &mut store, v).unwrap(), Some(BString::from("f")));
			assert_eq!(binding_scope(&root, &mut store, v, b"t").unwrap(), Some(1));
			assert_eq!(binding_scope(&root, &mut store, v, b"u").unwrap(), Some(0));
			assert_eq!(scope_var(&mut store, v, 0, b"x").unwrap(), Some(Some(x.clone())));
			assert_eq!(scope_var(&mut store, v, 0, b"u").unwrap(), Some(None));
			assert_eq!(scope_var(&mut store, v, 1, b"x").unwrap(), None);
			assert!(scope_binds(&mut store, v, 1, b"t").unwrap());
			assert_eq!(scope_func(&mut store, v, 1).unwrap(), None);
			assert_eq!(positional(&root, &mut store, v).unwrap(), vec![BString::from("a")]);
		}
		assert_eq!(
			copy_scopes(&root, &mut store, &vp).unwrap(),
			copy_scopes(&root, &mut store, &sub).unwrap()
		);
		// The hidden temporary scope comes back under one pushed meanwhile.
		both(&mut root, &mut store, &mut vp, &mut sub, &|r, s, v| {
			let hidden = pop_scope(r, s, v).unwrap();
			push_scope(r, s, v, Scope { func: Some(BString::default()), ..Scope::default() });
			insert_scope(r, s, v, 1, hidden);
			set_positional(r, s, v, vec!["b".into(), "c".into()]);
			scope_clear(r, s, v, 1);
		});
		let root_scopes = copy_scopes(&root, &mut store, &vp).unwrap();
		assert_eq!(root_scopes, copy_scopes(&root, &mut store, &sub).unwrap());
		assert_eq!(root_scopes.len(), 3);
		assert_eq!(root_scopes[0].positional, Some(vec![BString::from("b"), BString::from("c")]));
		assert!(root_scopes[1].vars.is_empty() && root_scopes[1].func.is_none());
		assert_eq!(root_scopes[2].func, Some(BString::default()));
		both(&mut root, &mut store, &mut vp, &mut sub, &|r, s, v| {
			while drop_scope(r, s, v) {}
		});
		assert_eq!(scope_count(&root, &vp), 0);
		assert!(sub.scopes.is_empty());
		assert_eq!(store.record(Key::Scope(0)), None);
		assert_eq!(positional(&root, &mut store, &vp).unwrap(), Vec::<BString>::new());
	}

	/// The root's scope masks and nameref flag answer as the store does:
	/// past the 64 tracked scopes, after pops, and after writes the engine
	/// did not make (rebuilt on invalidation).
	#[test]
	fn root_scope_facts_follow_the_store() {
		let (mut store, mut root, mut vp) = shell();
		let scalar = |v: &str| Some(Var::scalar(v, Attrs::NONE));
		let params = |root: &Root, store: &mut crate::bash::MemStore, vp: &Vproc| {
			positional_ref(root, store, vp).unwrap().to_vec()
		};
		for depth in 0..70_u32 {
			let scope = Scope {
				func: Some(format!("f{depth}").into()),
				positional: (depth % 3 == 0).then(|| vec![depth.to_string().into()]),
				..Scope::default()
			};
			push_scope(&mut root, &mut store, &mut vp, scope);
			if depth == 2 || depth == 68 {
				store_var(&mut root, &mut store, &mut vp, b"x", scalar("v"), Level::Local);
			}
		}
		assert_eq!(binding_scope(&root, &mut store, &vp, b"x").unwrap(), Some(68));
		assert_eq!(func_scope(&root, &mut store, &vp).unwrap(), Some(69));
		assert_eq!(params(&root, &mut store, &vp), vec![BString::from("69")]);
		for _ in 0..4 {
			assert!(drop_scope(&mut root, &mut store, &mut vp));
		}
		assert_eq!(binding_scope(&root, &mut store, &vp, b"x").unwrap(), Some(2));
		assert_eq!(func_scope(&root, &mut store, &vp).unwrap(), Some(65));
		assert_eq!(params(&root, &mut store, &vp), vec![BString::from("63")]);
		// A scope pushed where a popped one bound `x` binds nothing.
		while scope_count(&root, &vp) > 2 {
			assert!(drop_scope(&mut root, &mut store, &mut vp));
		}
		push_scope(&mut root, &mut store, &mut vp, func_scope_named("g"));
		assert_eq!(binding_scope(&root, &mut store, &vp, b"x").unwrap(), None);
		assert_eq!(params(&root, &mut store, &vp), vec![BString::from("0")]);
		// Written out of band: seen once the epoch is checked.
		let local = Key::Local { depth: 1, name: BStr::new("y") };
		store
			.put_out_of_band(local, Record::Var(Var::scalar("oob", Attrs::NONE)))
			.unwrap();
		store
			.put_out_of_band(Key::Var(BStr::new("a")), Record::Var(Var::scalar("A", Attrs::NONE)))
			.unwrap();
		store
			.put_out_of_band(Key::Var(BStr::new("r")), Record::Var(Var::scalar("a", Attrs::NAMEREF)))
			.unwrap();
		invalidate(&mut root, &mut store);
		assert_eq!(binding_scope(&root, &mut store, &vp, b"y").unwrap(), Some(1));
		let r = lookup(&root, &mut store, &vp, b"r").unwrap().cloned();
		assert_eq!(r, Some(Var::scalar("A", Attrs::NONE)), "the nameref is followed");
		assert_eq!(deref(&root, &mut store, &vp, b"r").unwrap(), Deref::To {
			name:  BString::from("a"),
			index: None,
		});
		// A fresh root over the same store derives the same facts.
		let mut again = Root::load(&mut store).unwrap();
		assert_eq!(binding_scope(&again, &mut store, &vp, b"y").unwrap(), Some(1));
		assert_eq!(func_scope(&again, &mut store, &vp).unwrap(), Some(2));
		assert!(may_be_nameref(&again, &vp));
		while drop_scope(&mut again, &mut store, &mut vp) {}
		assert_eq!(params(&again, &mut store, &vp), Vec::<BString>::new());
	}

	#[test]
	fn sync_root_writes_what_changed_and_load_root_reads_it_back() {
		let (mut store, mut root, mut vp) = shell();
		sync_root(&mut root, &mut store, &vp);
		assert!(store.is_empty(), "nothing changed since the defaults");
		vp.status = 3;
		vp.pipestatus = vec![0, 3];
		vp.last_bg = LastBg::new(Vpid(1 << 30));
		vp.last_bg.set_os(4242);
		vp.jobs
			.add(JobId(4), Vpid(1 << 30), "sleep 1 &".into(), false, "/".into());
		vp.jobs.get_mut(1).unwrap().os_pid = Some(4242);
		vp.jobs.chld = 2;
		vp.getopts = GetoptsState { optind: Some("2".into()), next: Some((1, 2)), at: None };
		vp.rlimits = vec![(Rlimit::Nofile, Some(64), None)];
		sync_root(&mut root, &mut store, &vp);
		let misc = |store: &crate::bash::MemStore, key| store.record(Key::Misc(key)).cloned();
		assert_eq!(misc(&store, MiscKey::Status), Some(Record::Misc("3".into())));
		// `$!` keeps the OS pid its job is known by.
		assert_eq!(misc(&store, MiscKey::LastBg), Some(Record::Misc("1073741824:4242".into())));
		assert_eq!(
			misc(&store, MiscKey::PipeStatus),
			Some(Record::Words(vec!["0".into(), "3".into()]))
		);
		assert_eq!(misc(&store, MiscKey::JobCurrent), Some(Record::Misc("1".into())));
		assert_eq!(misc(&store, MiscKey::ChldOwed), Some(Record::Misc("2".into())));
		assert!(matches!(store.record(Key::Job(JobId(4))), Some(Record::Job(j)) if j.number == 1));
		// A job's state change rewrites that job only; a removed job goes.
		vp.jobs.get_mut(1).unwrap().state = JobState::Stopped(Signal::Tstp);
		sync_root(&mut root, &mut store, &vp);
		let stopped = |store: &crate::bash::MemStore| {
			matches!(
				store.record(Key::Job(JobId(4))),
				Some(Record::Job(Job { state: JobState::Stopped(_), .. }))
			)
		};
		assert!(stopped(&store));
		let mut fresh =
			Vproc::new(Vpid(1), None, FdTable::default(), BString::from("/"), None, false);
		let mut root2 = Root::load(&mut store).unwrap();
		load_root(&mut root2, &mut store, &mut fresh).unwrap();
		assert_eq!(fresh.status, 3);
		assert_eq!(fresh.pipestatus, vp.pipestatus);
		assert_eq!(fresh.last_bg, vp.last_bg);
		assert_eq!(fresh.jobs, vp.jobs);
		assert_eq!(fresh.getopts, vp.getopts);
		assert_eq!(fresh.rlimits, vp.rlimits);
		// Loaded fields count as written: no rewrite.
		let before = store.clone();
		sync_root(&mut root2, &mut store, &fresh);
		assert_eq!(store, before);
		vp.jobs.remove(1);
		vp.jobs.chld = 0;
		vp.getopts = GetoptsState::default();
		vp.rlimits.clear();
		sync_root(&mut root, &mut store, &vp);
		assert_eq!(store.record(Key::Job(JobId(4))), None);
		assert_eq!(misc(&store, MiscKey::JobCurrent), None);
		assert_eq!(misc(&store, MiscKey::ChldOwed), None);
		assert_eq!(misc(&store, MiscKey::Getopts), None);
		assert_eq!(misc(&store, MiscKey::Rlimits), None);
	}
}
