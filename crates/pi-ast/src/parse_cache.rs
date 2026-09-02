//! Bounded, content-addressed tree-sitter parse cache.
//!
//! Every structural entry point in this crate ([`crate::block`],
//! [`crate::summary`]) is dominated by one cost: `Parser::parse` over the whole
//! file. Measured on an M4 Max (release, warm page cache) that is ~13.5 ms for
//! an 81 KB / 2057-line TypeScript file and ~187 ms for a 1.05 MB file, while
//! everything else those functions do totals well under a millisecond.
//!
//! The results themselves are not cacheable: `enclosing_block_boundaries`
//! depends on the caller's visible `ranges`, which differ on every call. The
//! reusable artifact is the [`Tree`], so the cache lives here and hands out
//! cheap clones of it.
//!
//! `Tree` is `Send` but not `Sync`, so entries live behind a [`Mutex`] and the
//! lock is only ever held for a map probe, a byte comparison, and a
//! `ts_tree_copy` refcount bump — never across a parse or a tree walk.

use std::{
	collections::HashMap,
	sync::{LazyLock, Mutex, MutexGuard, PoisonError},
};

use anyhow::{Result, anyhow};
use ast_grep_core::tree_sitter::LanguageExt;
use tree_sitter::{Parser, Tree};

use crate::language::SupportLang;

/// Arbitrary fixed seed (golden-ratio constant). Fixed, not random, so a key is
/// reproducible across calls within a process; it never leaves the process, so
/// there is nothing to harden against `HashDoS` here.
const HASH_SEED: u64 = 0x9e37_79b9_7f4a_7c15;

/// Largest source that may occupy a slot.
///
/// A tree-sitter tree runs roughly an order of magnitude larger than its
/// source, so admitting an arbitrarily large file would let one `read` of a
/// multi-megabyte blob dominate process RSS. Files above this are still parsed,
/// just never retained.
pub const MAX_ENTRY_SOURCE_BYTES: usize = 4 << 20;

/// Ceiling on retained source bytes across all slots.
///
/// Equal to [`MAX_ENTRY_SOURCE_BYTES`] so a single hot large file can still be
/// cached (it evicts everything else, which is what LRU should do when that
/// file *is* the working set).
pub const MAX_TOTAL_SOURCE_BYTES: usize = 4 << 20;

/// Slot ceiling, independent of byte size.
///
/// Bounds the tree footprint against a burst of small files. Twelve covers the
/// realistic hot set for a coding agent (the handful of files being read and
/// edited) while keeping the LRU scan trivially cheap.
pub const MAX_ENTRIES: usize = 12;

/// Cache key. The 64-bit hash is a *bucket selector only*: a hit additionally
/// verifies [`Entry::source`] against the request byte-for-byte before the tree
/// is handed back, so a hash collision can only ever cost a re-parse (the
/// colliding slot is overwritten) and can never return a tree built from
/// different content. `len` is folded in because it is free and makes
/// accidental bucket sharing rarer; `lang` is in the key because the same bytes
/// parsed as TypeScript and as Python are different trees and must not share a
/// slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct Key {
	hash: u64,
	len:  usize,
	lang: SupportLang,
}

fn key_for(code: &str, lang: SupportLang) -> Key {
	Key { hash: xxhash_rust::xxh64::xxh64(code.as_bytes(), HASH_SEED), len: code.len(), lang }
}

struct Entry {
	/// Retained verbatim so a hit is verified by comparison, not by trusting
	/// the hash.
	source: Box<str>,
	tree:   Tree,
	/// Value of [`Cache::clock`] at last use; smallest wins eviction.
	stamp:  u64,
}

struct Cache {
	entries:         HashMap<Key, Entry>,
	source_bytes:    usize,
	clock:           u64,
	hits:            u64,
	misses:          u64,
	evictions:       u64,
	max_entries:     usize,
	max_total_bytes: usize,
	max_entry_bytes: usize,
}

impl Cache {
	fn new(max_entries: usize, max_total_bytes: usize, max_entry_bytes: usize) -> Self {
		Self {
			entries: HashMap::new(),
			source_bytes: 0,
			clock: 0,
			hits: 0,
			misses: 0,
			evictions: 0,
			max_entries,
			max_total_bytes,
			max_entry_bytes,
		}
	}

	fn get(&mut self, key: &Key, code: &str) -> Option<Tree> {
		self.clock += 1;
		let stamp = self.clock;
		let tree = match self.entries.get_mut(key) {
			Some(entry) if &*entry.source == code => {
				entry.stamp = stamp;
				// `ts_tree_copy`: an atomic refcount bump on immutable subtree
				// data, so the clone can be walked off-lock on any thread.
				entry.tree.clone()
			},
			_ => {
				self.misses += 1;
				return None;
			},
		};
		self.hits += 1;
		Some(tree)
	}

	fn insert(&mut self, key: Key, code: &str, tree: &Tree) {
		if code.len() > self.max_entry_bytes {
			return;
		}
		if let Some(previous) = self.entries.remove(&key) {
			self.source_bytes -= previous.source.len();
		}
		while self.entries.len() >= self.max_entries
			|| self.source_bytes + code.len() > self.max_total_bytes
		{
			if !self.evict_oldest() {
				break;
			}
		}
		self.clock += 1;
		self.source_bytes += code.len();
		self.entries.insert(key, Entry {
			source: Box::from(code),
			tree:   tree.clone(),
			stamp:  self.clock,
		});
	}

	/// Drop the least-recently-used slot. `false` when there was nothing left
	/// to drop, which is what terminates [`Self::insert`]'s eviction loop.
	fn evict_oldest(&mut self) -> bool {
		// Linear over at most `max_entries` slots: cheaper than maintaining an
		// intrusive LRU list at this size.
		let Some(&oldest) = self
			.entries
			.iter()
			.min_by_key(|(_, entry)| entry.stamp)
			.map(|(key, _)| key)
		else {
			return false;
		};
		if let Some(entry) = self.entries.remove(&oldest) {
			self.source_bytes -= entry.source.len();
			self.evictions += 1;
		}
		true
	}

	/// Drop every entry and zero the counters, preserving the configured bounds.
	fn clear(&mut self) {
		self.entries.clear();
		self.source_bytes = 0;
		self.clock = 0;
		self.hits = 0;
		self.misses = 0;
		self.evictions = 0;
	}
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| {
	Mutex::new(Cache::new(MAX_ENTRIES, MAX_TOTAL_SOURCE_BYTES, MAX_ENTRY_SOURCE_BYTES))
});

/// Every critical section is a handful of infallible map operations plus a
/// refcount bump, so panicking while holding the lock is not reachable.
/// Recovering the guard anyway means a hypothetical panic could never escalate
/// into every later parse panicking.
fn lock() -> MutexGuard<'static, Cache> {
	CACHE.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Parse `code` as `lang`, reusing a cached [`Tree`] when the exact same bytes
/// were last parsed as the same language and have not been evicted.
///
/// Semantics match a bare `Parser::new()` / `set_language` / `parse` sequence
/// exactly: `Err` when the grammar fails to load, `Ok(None)` when `parse`
/// yields nothing, `Ok(Some(tree))` otherwise. Trees carrying syntax errors are
/// cached like any other — `has_error()` is a property of the tree, so callers
/// that reject on it reach the identical verdict from a cached tree, and
/// repeated "does this parse" probes over the same broken file get the speedup
/// too.
pub fn parse_cached(code: &str, lang: SupportLang) -> Result<Option<Tree>> {
	let key = key_for(code, lang);
	// Bound the guard to a `let` so it drops at the end of this statement: an
	// `if let` scrutinee would hold the lock across the early return.
	let cached = lock().get(&key, code);
	if let Some(tree) = cached {
		return Ok(Some(tree));
	}
	let mut parser = Parser::new();
	parser
		.set_language(&lang.get_ts_language())
		.map_err(|err| anyhow!("Failed to load tree-sitter language: {err}"))?;
	let Some(tree) = parser.parse(code, None) else {
		return Ok(None);
	};
	lock().insert(key, code, &tree);
	Ok(Some(tree))
}

/// Occupancy and counters, for diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ParseCacheStats {
	pub entries:      usize,
	pub source_bytes: usize,
	pub hits:         u64,
	pub misses:       u64,
	pub evictions:    u64,
}

pub fn parse_cache_stats() -> ParseCacheStats {
	let cache = lock();
	ParseCacheStats {
		entries:      cache.entries.len(),
		source_bytes: cache.source_bytes,
		hits:         cache.hits,
		misses:       cache.misses,
		evictions:    cache.evictions,
	}
}

/// Drop every cached tree and zero the counters.
pub fn clear_parse_cache() {
	lock().clear();
}

#[cfg(test)]
mod tests {
	use super::*;

	/// The process-global cache is shared with every other test in this crate
	/// running in parallel, so occupancy, eviction, and counter behaviour are
	/// asserted on private instances instead. `block.rs` covers the global path
	/// end to end, where the assertions are boundary values that hold no matter
	/// what else is resident.
	fn cache(max_entries: usize, max_total_bytes: usize, max_entry_bytes: usize) -> Cache {
		Cache::new(max_entries, max_total_bytes, max_entry_bytes)
	}

	fn tree_of(code: &str, lang: SupportLang) -> Tree {
		let mut parser = Parser::new();
		parser
			.set_language(&lang.get_ts_language())
			.expect("grammar loads");
		parser.parse(code, None).expect("parse produces a tree")
	}

	const TS: SupportLang = SupportLang::TypeScript;

	#[test]
	fn hit_returns_a_clone_of_the_stored_tree() {
		let mut cache = cache(MAX_ENTRIES, MAX_TOTAL_SOURCE_BYTES, MAX_ENTRY_SOURCE_BYTES);
		let code = "function f() {\n  a();\n}\n";
		let key = key_for(code, TS);
		let tree = tree_of(code, TS);

		assert!(cache.get(&key, code).is_none(), "cold lookup misses");
		cache.insert(key, code, &tree);
		let hit = cache.get(&key, code).expect("warm lookup hits");

		// A child node's id is the address of its shared subtree data, so a
		// matching id proves the hit is a `ts_tree_copy` of the stored tree
		// rather than a second parse. (The *root* node's id is the address of
		// the `root` field inside the `TSTree` struct itself, which a copy
		// necessarily relocates, so it cannot be used here.)
		let subtree_id = |tree: &Tree| tree.root_node().child(0).expect("top-level decl").id();
		assert_eq!(subtree_id(&hit), subtree_id(&tree), "hit must share the stored tree");
		// The id genuinely discriminates: an independent parse of the same bytes
		// allocates fresh subtree data.
		assert_ne!(subtree_id(&tree_of(code, TS)), subtree_id(&tree), "id must discriminate");
		assert_eq!((cache.hits, cache.misses, cache.entries.len()), (1, 1, 1));
		assert_eq!(cache.source_bytes, code.len());
	}

	#[test]
	fn language_is_part_of_the_key() {
		let code = "def greet(name):\n    return name\n";
		let py_key = key_for(code, SupportLang::Python);
		let ts_key = key_for(code, TS);
		assert_ne!(py_key, ts_key, "same bytes, different language, different key");

		let mut cache = cache(MAX_ENTRIES, MAX_TOTAL_SOURCE_BYTES, MAX_ENTRY_SOURCE_BYTES);
		cache.insert(py_key, code, &tree_of(code, SupportLang::Python));
		assert!(
			cache.get(&ts_key, code).is_none(),
			"a Python tree must never satisfy a TypeScript request"
		);
	}

	#[test]
	fn one_byte_of_difference_changes_the_key() {
		// Equal length, one byte apart, so `len` cannot separate them.
		let a = "const a = 1;\n";
		let b = "const a = 2;\n";
		assert_eq!(a.len(), b.len());
		assert_ne!(key_for(a, TS), key_for(b, TS));
	}

	#[test]
	fn verified_equality_rejects_a_colliding_slot() {
		// A real xxh64 collision is not findable, so forge the condition: store
		// `stored` under the key that `probe` hashes to. A cache that trusted
		// the hash would hand back `stored`'s tree for a `probe` lookup.
		let stored = "const a = 1;\n";
		let probe = "const b = 2;\n";
		assert_eq!(stored.len(), probe.len(), "collision needs a matching len field");

		let forged = key_for(probe, TS);
		let mut cache = cache(MAX_ENTRIES, MAX_TOTAL_SOURCE_BYTES, MAX_ENTRY_SOURCE_BYTES);
		cache.insert(forged, stored, &tree_of(stored, TS));

		assert!(
			cache.get(&forged, probe).is_none(),
			"byte comparison must turn a collision into a miss"
		);
		assert_eq!(cache.misses, 1);
	}

	#[test]
	fn entry_bound_evicts_least_recently_used() {
		let mut cache = cache(2, MAX_TOTAL_SOURCE_BYTES, MAX_ENTRY_SOURCE_BYTES);
		let sources = ["const a = 1;\n", "const b = 2;\n", "const c = 3;\n"];
		let keys: Vec<Key> = sources.iter().map(|code| key_for(code, TS)).collect();

		cache.insert(keys[0], sources[0], &tree_of(sources[0], TS));
		cache.insert(keys[1], sources[1], &tree_of(sources[1], TS));
		// Touch slot 0 so slot 1 becomes the least recently used.
		assert!(cache.get(&keys[0], sources[0]).is_some());
		cache.insert(keys[2], sources[2], &tree_of(sources[2], TS));

		assert_eq!(cache.entries.len(), 2, "entry bound holds");
		assert_eq!(cache.evictions, 1);
		assert!(cache.get(&keys[0], sources[0]).is_some(), "recently used slot survives");
		assert!(cache.get(&keys[1], sources[1]).is_none(), "least recently used slot evicted");
		assert!(cache.get(&keys[2], sources[2]).is_some(), "newest slot resident");
	}

	#[test]
	fn byte_bound_evicts_and_reclaims_accounting() {
		let code_len = "const a = 1;\n".len();
		// Room for exactly two of these sources.
		let mut cache = cache(64, code_len * 2, MAX_ENTRY_SOURCE_BYTES);
		let sources = ["const a = 1;\n", "const b = 2;\n", "const c = 3;\n"];

		for code in sources {
			let key = key_for(code, TS);
			cache.insert(key, code, &tree_of(code, TS));
			assert!(
				cache.source_bytes <= code_len * 2,
				"byte bound must hold after every insert: {} > {}",
				cache.source_bytes,
				code_len * 2
			);
		}

		assert_eq!(cache.entries.len(), 2);
		assert_eq!(cache.evictions, 1);
		// Exact accounting, not just the bound: a subtraction missed on eviction
		// would leave `source_bytes` drifting upward until the cache starved.
		assert_eq!(cache.source_bytes, code_len * 2);
		assert!(
			cache.get(&key_for(sources[0], TS), sources[0]).is_none(),
			"oldest slot evicted by the byte bound"
		);
	}

	#[test]
	fn source_over_the_entry_bound_is_never_retained() {
		let code = "function f() {\n  a();\n}\n";
		let mut cache = cache(MAX_ENTRIES, MAX_TOTAL_SOURCE_BYTES, code.len() - 1);
		let key = key_for(code, TS);

		cache.insert(key, code, &tree_of(code, TS));

		assert_eq!(cache.entries.len(), 0, "oversized source is parsed but not cached");
		assert_eq!(cache.source_bytes, 0);
		assert_eq!(cache.evictions, 0, "rejection must not evict a healthy slot");
		assert!(cache.get(&key, code).is_none());
	}

	#[test]
	fn reinsert_of_a_resident_key_does_not_double_count_bytes() {
		let mut cache = cache(MAX_ENTRIES, MAX_TOTAL_SOURCE_BYTES, MAX_ENTRY_SOURCE_BYTES);
		let code = "const a = 1;\n";
		let key = key_for(code, TS);
		let tree = tree_of(code, TS);

		cache.insert(key, code, &tree);
		cache.insert(key, code, &tree);

		assert_eq!(cache.entries.len(), 1);
		assert_eq!(cache.source_bytes, code.len());
		assert_eq!(cache.evictions, 0);
	}

	#[test]
	fn clear_empties_the_cache_but_keeps_its_bounds() {
		let mut cache = cache(3, 1024, 512);
		let code = "const a = 1;\n";
		cache.insert(key_for(code, TS), code, &tree_of(code, TS));
		assert_eq!(cache.entries.len(), 1);

		cache.clear();

		assert_eq!(cache.entries.len(), 0);
		assert_eq!((cache.source_bytes, cache.hits, cache.misses, cache.evictions), (0, 0, 0, 0));
		assert_eq!((cache.max_entries, cache.max_total_bytes, cache.max_entry_bytes), (3, 1024, 512));
	}
}
