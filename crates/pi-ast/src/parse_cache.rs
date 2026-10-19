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
//! Retention is an LRU budgeted by estimated tree memory ([`tree_cost`]), not
//! by source length: a tree runs 8-72x its source. Entries also record which
//! caller paths they are the current or previous version of. A path's
//! previous version is first in line for eviction, and its version before
//! that is dropped at once, since no lookup through that path can hit those
//! bytes again. An error-free current version seeds an incremental reparse of
//! new content.
//!
//! `Tree` is `Send` but not `Sync`, so entries live behind a [`Mutex`] and the
//! lock is only ever held for map probes, a byte comparison, and
//! `ts_tree_copy` refcount bumps — never across a parse or a tree walk.

use std::{
	collections::HashMap,
	sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError},
};

use anyhow::{Result, anyhow};
use tree_sitter::{InputEdit, Language, Point, Tree};

use crate::language::{
	SupportLang,
	grammar::{self, GrammarError, LanguageGrammar},
};

/// Arbitrary fixed seed (golden-ratio constant). Fixed, not random, so a key is
/// reproducible across calls within a process; it never leaves the process, so
/// there is nothing to harden against `HashDoS` here.
const HASH_SEED: u64 = 0x9e37_79b9_7f4a_7c15;

/// Estimated retained bytes per source byte; covers the retained source copy
/// plus token data that scales with text length.
const COST_PER_SOURCE_BYTE: usize = 16;

/// Estimated retained bytes per visible syntax node.
const COST_PER_NODE: usize = 64;

/// [`COST_PER_NODE`] for Markdown, whose grammar keeps most of its nodes
/// hidden: measured trees ran 200-430 bytes per visible node, against 50-220
/// for the code grammars.
const COST_PER_MARKDOWN_NODE: usize = 256;

/// Budget for all retained slots, in [`tree_cost`] bytes.
///
/// The smallest budget under which re-reading a working set of large
/// (150-350 KB) files caches as well as the old source-length bound did;
/// typical sessions stay at a fraction of it. One hot ~2 MB file can still be
/// cached (it evicts everything else, which is what LRU should do when that
/// file *is* the working set).
pub const MAX_RETAINED_BYTES: usize = 64 << 20;

/// Largest source worth parsing for retention.
///
/// At a typical density of one visible node per 4 source bytes (TypeScript
/// and Python run ~1 per 4.3), a larger tree would exceed
/// [`MAX_RETAINED_BYTES`] on its own. This is only a pre-filter: a smaller but
/// node-dense source can still exceed the budget and be dropped after
/// parsing. Larger files are still parsed on demand.
pub const MAX_ENTRY_SOURCE_BYTES: usize =
	MAX_RETAINED_BYTES / (COST_PER_SOURCE_BYTE + COST_PER_NODE / 4);

/// Slot ceiling, independent of size.
///
/// Bounds the LRU scan and the path scan. Twelve covers the realistic hot set
/// for a coding agent (the handful of files being read and edited).
pub const MAX_ENTRIES: usize = 12;

/// Estimated heap retained by a cached `tree` over `code`.
///
/// tree-sitter exposes no allocation size, and visible-node count misses hidden
/// nodes, so this is a linear fit. Against measured allocations for 241 files
/// of this repository it landed at 0.5-3x the real figure: TypeScript 1.2-2.7x,
/// Python 0.9-1.5x, Rust 0.5-1.3x, Markdown 0.9-1.9x.
fn tree_cost(code: &str, tree: &Tree, lang: SupportLang) -> usize {
	let per_node = match lang {
		SupportLang::Markdown => COST_PER_MARKDOWN_NODE,
		_ => COST_PER_NODE,
	};
	code.len() * COST_PER_SOURCE_BYTE + tree.root_node().descendant_count() * per_node
}

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

/// Paths one entry can be bound to. Identical files share an entry; past this
/// many, the binding that became current longest ago gives way.
const MAX_PATHS_PER_ENTRY: usize = 8;

/// One path's claim on an entry: its current content, or the one before it.
struct Binding {
	path:    Box<str>,
	current: bool,
	/// Lookup ticket ([`Cache::clock`] at lookup) of the read that made this
	/// the path's current version, so concurrent parses order by request.
	since:   u64,
}

struct Entry {
	/// Retained verbatim so a hit is verified by comparison, not by trusting
	/// the hash, and so a superseding parse can diff against it.
	source:   Arc<str>,
	tree:     Tree,
	/// Paths in the key's language whose current or previous content this is.
	/// Identical files share one entry, so there can be several.
	bindings: Vec<Binding>,
	/// [`tree_cost`] charged against the budget.
	cost:     usize,
	/// Value of [`Cache::clock`] at last use; smallest wins eviction among
	/// entries of the same rank (see [`Cache::evict_oldest`]).
	stamp:    u64,
}

impl Entry {
	fn binding(&self, path: &str) -> Option<&Binding> {
		self.bindings.iter().find(|binding| &*binding.path == path)
	}

	/// Only some path's previous version: the first to go under pressure.
	fn is_previous_only(&self) -> bool {
		!self.bindings.is_empty() && self.bindings.iter().all(|binding| !binding.current)
	}
}

/// A path's previous content and tree, the base of an incremental reparse.
struct Base {
	source: Arc<str>,
	tree:   Tree,
}

enum Lookup {
	Hit(Tree),
	Miss(Option<Base>),
}

/// Paths whose latest lookup ticket is remembered exactly for fencing stale
/// parses. Past this, the least recently advanced path is forgotten and its
/// ticket folds into [`Cache::forgotten_ticket_floor`].
const MAX_TRACKED_PATHS: usize = 64;

struct Cache {
	entries:                HashMap<Key, Entry>,
	/// Per path, the ticket of the lookup that last made it current in each
	/// language. Kept apart from `entries` so the fence outlives evicted or
	/// rejected trees.
	path_tickets:           HashMap<Box<str>, Vec<(SupportLang, u64)>>,
	/// Newest ticket among forgotten paths. A completion for an untracked path
	/// whose lookup is older than this may be stale, so it is cached without
	/// moving the path: losing one reparse base beats rolling a path back.
	forgotten_ticket_floor: u64,
	retained_bytes:         usize,
	clock:                  u64,
	hits:                   u64,
	misses:                 u64,
	evictions:              u64,
	superseded:             u64,
	max_entries:            usize,
	max_retained_bytes:     usize,
}

impl Cache {
	fn new(max_entries: usize, max_retained_bytes: usize) -> Self {
		Self {
			entries: HashMap::new(),
			path_tickets: HashMap::new(),
			forgotten_ticket_floor: 0,
			retained_bytes: 0,
			clock: 0,
			hits: 0,
			misses: 0,
			evictions: 0,
			superseded: 0,
			max_entries,
			max_retained_bytes,
		}
	}

	fn get(&mut self, key: &Key, code: &str, path: Option<&str>) -> Lookup {
		self.clock += 1;
		let stamp = self.clock;
		if let Some(entry) = self.entries.get_mut(key)
			&& &*entry.source == code
		{
			entry.stamp = stamp;
			// `ts_tree_copy`: an atomic refcount bump on immutable subtree
			// data, so the clone can be walked off-lock on any thread.
			let tree = entry.tree.clone();
			self.hits += 1;
			if let Some(path) = path {
				self.advance_path(*key, path, stamp);
			}
			return Lookup::Hit(tree);
		}
		self.misses += 1;
		// The path's current version seeds the reparse unless it is broken:
		// then its successor is usually broken too (auto-repair probes a file's
		// broken variants back to back), and an incremental parse with errors
		// is discarded anyway.
		let base = path.and_then(|path| {
			self
				.entries
				.iter()
				.find(|(other, entry)| {
					other.lang == key.lang && entry.binding(path).is_some_and(|binding| binding.current)
				})
				.filter(|(_, entry)| !entry.tree.root_node().has_error())
				.map(|(_, entry)| Base { source: entry.source.clone(), tree: entry.tree.clone() })
		});
		Lookup::Miss(base)
	}

	/// Whether `path` got its current version in `lang` from a lookup newer
	/// than the one that issued `ticket`, or might have and has since been
	/// forgotten. A path re-tracked under another language carries no ticket
	/// for `lang`, so it falls back to the forgotten floor too.
	fn path_moved_since(&self, lang: SupportLang, path: &str, ticket: u64) -> bool {
		let latest = self
			.path_tickets
			.get(path)
			.and_then(|tickets| tickets.iter().find(|&&(other, _)| other == lang))
			.map(|&(_, latest)| latest);
		match latest {
			Some(latest) => latest > ticket,
			None => ticket < self.forgotten_ticket_floor,
		}
	}

	/// Record that lookup `ticket` made `path` current in `lang`.
	fn note_path(&mut self, lang: SupportLang, path: &str, ticket: u64) {
		if let Some(tickets) = self.path_tickets.get_mut(path) {
			if let Some((_, latest)) = tickets.iter_mut().find(|(other, _)| *other == lang) {
				*latest = (*latest).max(ticket);
			} else {
				tickets.push((lang, ticket));
			}
			return;
		}
		if self.path_tickets.len() >= MAX_TRACKED_PATHS
			&& let Some((oldest, newest_ticket)) = self
				.path_tickets
				.iter()
				.map(|(path, tickets)| {
					(path, tickets.iter().map(|&(_, latest)| latest).max().unwrap_or(0))
				})
				.min_by_key(|&(_, newest_ticket)| newest_ticket)
				.map(|(path, newest_ticket)| (path.clone(), newest_ticket))
		{
			self.path_tickets.remove(&oldest);
			self.forgotten_ticket_floor = self.forgotten_ticket_floor.max(newest_ticket);
		}
		self
			.path_tickets
			.insert(Box::from(path), vec![(lang, ticket)]);
	}

	/// Store a tree parsed after the lookup that issued `ticket`.
	fn insert(
		&mut self,
		key: Key,
		code: &str,
		tree: &Tree,
		path: Option<&str>,
		cost: usize,
		ticket: u64,
	) {
		self.clock += 1;
		// A parse that started before its path moved on to newer content is
		// cached, but must not move the path back.
		let path = path.filter(|path| !self.path_moved_since(key.lang, path, ticket));
		// The path now holds `code`; its version before last is dead whether
		// or not this tree fits.
		if let Some(path) = path {
			self.advance_path(key, path, ticket);
		}
		if let Some(entry) = self.entries.get_mut(&key)
			&& &*entry.source == code
		{
			// A concurrent parse of the same bytes landed first: keep its entry
			// and the bindings it has collected (`advance_path` added ours).
			entry.stamp = self.clock;
			return;
		}
		if cost > self.max_retained_bytes {
			return;
		}
		if let Some(previous) = self.entries.remove(&key) {
			self.retained_bytes -= previous.cost;
		}
		while self.entries.len() >= self.max_entries
			|| self.retained_bytes + cost > self.max_retained_bytes
		{
			if !self.evict_oldest() {
				break;
			}
		}
		self.retained_bytes += cost;
		self.entries.insert(key, Entry {
			source: Arc::from(code),
			tree: tree.clone(),
			bindings: path.map_or_else(Vec::new, |path| {
				vec![Binding { path: Box::from(path), current: true, since: ticket }]
			}),
			cost,
			stamp: self.clock,
		});
	}

	/// Make `key` (resident or not) `path`'s current version as of lookup
	/// `since`: the old current version becomes the previous one, and the old
	/// previous version loses its binding — and its slot, unless another path
	/// still binds it.
	fn advance_path(&mut self, key: Key, path: &str, since: u64) {
		self.note_path(key.lang, path, since);
		if let Some(binding) = self.entries.get_mut(&key).and_then(|entry| {
			entry
				.bindings
				.iter_mut()
				.find(|binding| &*binding.path == path)
		}) && binding.current
		{
			binding.since = binding.since.max(since);
			return;
		}
		let mut released: Option<Key> = None;
		for (other, entry) in &mut self.entries {
			if *other == key || other.lang != key.lang {
				continue;
			}
			if let Some(index) = entry
				.bindings
				.iter()
				.position(|binding| &*binding.path == path)
			{
				if entry.bindings[index].current {
					entry.bindings[index].current = false;
				} else {
					entry.bindings.swap_remove(index);
					if entry.bindings.is_empty() {
						// A path has one previous version, so at most one release.
						released = Some(*other);
					}
				}
			}
		}
		if let Some(dead) = released.and_then(|dead| self.entries.remove(&dead)) {
			self.retained_bytes -= dead.cost;
			self.superseded += 1;
		}
		let Some(entry) = self.entries.get_mut(&key) else {
			return;
		};
		if let Some(binding) = entry
			.bindings
			.iter_mut()
			.find(|binding| &*binding.path == path)
		{
			binding.current = true;
			binding.since = since;
			return;
		}
		if entry.bindings.len() >= MAX_PATHS_PER_ENTRY
			&& let Some(oldest) =
				(0..entry.bindings.len()).min_by_key(|&index| entry.bindings[index].since)
		{
			entry.bindings.swap_remove(oldest);
		}
		entry
			.bindings
			.push(Binding { path: Box::from(path), current: true, since });
	}

	/// Drop one slot: a path's previous version if there is one, else the
	/// least recently used. `false` when there was nothing left to drop, which
	/// is what terminates [`Self::insert`]'s eviction loop.
	fn evict_oldest(&mut self) -> bool {
		// Linear over at most `max_entries` slots: cheaper than maintaining an
		// intrusive LRU list at this size.
		let Some(&oldest) = self
			.entries
			.iter()
			.min_by_key(|(_, entry)| (!entry.is_previous_only(), entry.stamp))
			.map(|(key, _)| key)
		else {
			return false;
		};
		if let Some(entry) = self.entries.remove(&oldest) {
			self.retained_bytes -= entry.cost;
			self.evictions += 1;
		}
		true
	}

	/// Drop every entry and zero the counters, preserving the configured bounds.
	fn clear(&mut self) {
		self.entries.clear();
		self.retained_bytes = 0;
		self.clock = 0;
		self.hits = 0;
		self.misses = 0;
		self.evictions = 0;
		self.superseded = 0;
		self.path_tickets.clear();
		self.forgotten_ticket_floor = 0;
	}
}

static CACHE: LazyLock<Mutex<Cache>> =
	LazyLock::new(|| Mutex::new(Cache::new(MAX_ENTRIES, MAX_RETAINED_BYTES)));

/// Every critical section is a handful of infallible map operations plus a
/// refcount bump, so panicking while holding the lock is not reachable.
/// Recovering the guard anyway means a hypothetical panic could never escalate
/// into every later parse panicking.
fn lock() -> MutexGuard<'static, Cache> {
	CACHE.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Position after `text` when it starts at `start`; columns are bytes.
fn advance(start: Point, text: &[u8]) -> Point {
	let mut point = start;
	for &byte in text {
		if byte == b'\n' {
			point.row += 1;
			point.column = 0;
		} else {
			point.column += 1;
		}
	}
	point
}

/// The single edit turning `old` into `new`: everything between their common
/// prefix and common suffix.
fn input_edit(old: &str, new: &str) -> InputEdit {
	let (old_bytes, new_bytes) = (old.as_bytes(), new.as_bytes());
	let mut prefix = old_bytes
		.iter()
		.zip(new_bytes)
		.take_while(|(a, b)| a == b)
		.count();
	while !old.is_char_boundary(prefix) {
		prefix -= 1;
	}
	let mut suffix = old_bytes[prefix..]
		.iter()
		.rev()
		.zip(new_bytes[prefix..].iter().rev())
		.take_while(|(a, b)| a == b)
		.count();
	while !old.is_char_boundary(old.len() - suffix) || !new.is_char_boundary(new.len() - suffix) {
		suffix -= 1;
	}
	let (old_end, new_end) = (old.len() - suffix, new.len() - suffix);
	let start_position = advance(Point::new(0, 0), &old_bytes[..prefix]);
	InputEdit {
		start_byte: prefix,
		old_end_byte: old_end,
		new_end_byte: new_end,
		start_position,
		old_end_position: advance(start_position, &old_bytes[prefix..old_end]),
		new_end_position: advance(start_position, &new_bytes[prefix..new_end]),
	}
}

/// Parse `code`, reusing `base` incrementally when one is given.
///
/// Incremental and fresh parses of error-free source produce the same tree,
/// but error recovery can settle differently. A tree with errors is therefore
/// always a fresh parse, so a result never depends on what was cached before.
///
/// An edit spanning more than half of `code` goes straight to the fresh parse:
/// the incremental parse would reuse little, and if its result turned out
/// broken it would be a whole wasted parse (auto-repair's first probe of a
/// multi-hunk edit is exactly that).
fn parse_from(language: &Language, code: &str, base: Option<Base>) -> Result<Option<Tree>> {
	if let Some(Base { source, mut tree }) = base {
		let edit = input_edit(&source, code);
		if 2 * (edit.old_end_byte.max(edit.new_end_byte) - edit.start_byte) <= code.len() {
			tree.edit(&edit);
			if let Some(tree) = grammar::parse(language, code, Some(&tree))?
				&& !tree.root_node().has_error()
			{
				return Ok(Some(tree));
			}
		}
	}
	grammar::parse(language, code, None)
}

/// Parse `code` as `lang`, reusing a cached [`Tree`] when the exact same bytes
/// were last parsed as the same language and have not been evicted.
///
/// `path` identifies the file `code` came from. It never affects the result:
/// it only lets new content for that path retire versions older than the
/// previous one and reuse a recent tree for an incremental reparse.
///
/// Semantics match a bare `Parser::new()` / `set_language` / `parse` sequence
/// exactly: `Err` when the grammar fails to load, `Ok(None)` when `parse`
/// yields nothing or `lang`'s wasm grammar is not installed (callers treat it
/// like an unsupported language), `Ok(Some(tree))` otherwise. Trees carrying
/// syntax errors are
/// cached like any other — `has_error()` is a property of the tree, so callers
/// that reject on it reach the identical verdict from a cached tree, and
/// repeated "does this parse" probes over the same broken file get the speedup
/// too.
pub fn parse_cached(code: &str, lang: SupportLang, path: Option<&str>) -> Result<Option<Tree>> {
	let key = key_for(code, lang);
	// Scope the guard to this block so the lock is released before the parse.
	// The ticket orders this lookup against the path's later versions.
	let (lookup, ticket) = {
		let mut cache = lock();
		(cache.get(&key, code, path), cache.clock)
	};
	let base = match lookup {
		Lookup::Hit(tree) => return Ok(Some(tree)),
		Lookup::Miss(base) => base,
	};
	let language = match lang.grammar().load() {
		Ok(language) => language,
		Err(GrammarError::NotInstalled { .. }) => return Ok(None),
		Err(err) => return Err(err.into()),
	};
	let Some(tree) = parse_from(&language, code, base)
		.map_err(|err| anyhow!("Failed to load tree-sitter language: {err}"))?
	else {
		return Ok(None);
	};
	let cost = tree_cost(code, &tree, lang);
	lock().insert(key, code, &tree, path, cost, ticket);
	Ok(Some(tree))
}

/// Occupancy and counters, for diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ParseCacheStats {
	pub entries:        usize,
	/// Sum of [`tree_cost`] over resident entries.
	pub retained_bytes: usize,
	pub hits:           u64,
	pub misses:         u64,
	pub evictions:      u64,
	/// Entries dropped because their path moved on by two newer versions.
	pub superseded:     u64,
}

pub fn parse_cache_stats() -> ParseCacheStats {
	let cache = lock();
	ParseCacheStats {
		entries:        cache.entries.len(),
		retained_bytes: cache.retained_bytes,
		hits:           cache.hits,
		misses:         cache.misses,
		evictions:      cache.evictions,
		superseded:     cache.superseded,
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
	fn cache(max_entries: usize, max_retained_bytes: usize) -> Cache {
		Cache::new(max_entries, max_retained_bytes)
	}

	fn tree_of(code: &str, lang: SupportLang) -> Tree {
		let language = lang.grammar().load().expect("grammar loads");
		grammar::parse(&language, code, None)
			.expect("grammar loads")
			.expect("parse produces a tree")
	}

	/// The ticket a fresh lookup would issue, as `parse_cached` captures it.
	fn lookup_ticket(cache: &mut Cache) -> u64 {
		cache.clock += 1;
		cache.clock
	}

	/// Parse `code` as TypeScript and store it under `path`; returns its cost.
	fn put(cache: &mut Cache, code: &str, path: Option<&str>) -> usize {
		let tree = tree_of(code, TS);
		let cost = tree_cost(code, &tree, TS);
		let ticket = lookup_ticket(cache);
		cache.insert(key_for(code, TS), code, &tree, path, cost, ticket);
		cost
	}

	fn hit(cache: &mut Cache, code: &str) -> Option<Tree> {
		match cache.get(&key_for(code, TS), code, None) {
			Lookup::Hit(tree) => Some(tree),
			Lookup::Miss(_) => None,
		}
	}

	/// A child node's id is the address of its shared subtree data, so equal
	/// ids prove two trees share that subtree rather than parsing it twice.
	/// (The *root* node's id is the address of the `root` field inside the
	/// `TSTree` struct itself, which a copy necessarily relocates.)
	fn subtree_id(tree: &Tree, index: usize) -> usize {
		tree.root_node().child(index).expect("top-level decl").id()
	}

	const TS: SupportLang = SupportLang::TypeScript;

	#[test]
	fn hit_returns_a_clone_of_the_stored_tree() {
		let mut cache = cache(MAX_ENTRIES, MAX_RETAINED_BYTES);
		let code = "function f() {\n  a();\n}\n";
		let key = key_for(code, TS);
		let tree = tree_of(code, TS);

		assert!(hit(&mut cache, code).is_none(), "cold lookup misses");
		cache.insert(key, code, &tree, None, tree_cost(code, &tree, TS), cache.clock);
		let warm = hit(&mut cache, code).expect("warm lookup hits");

		assert_eq!(subtree_id(&warm, 0), subtree_id(&tree, 0), "hit must share the stored tree");
		// The id genuinely discriminates: an independent parse of the same bytes
		// allocates fresh subtree data.
		assert_ne!(subtree_id(&tree_of(code, TS), 0), subtree_id(&tree, 0), "id must discriminate");
		assert_eq!((cache.hits, cache.misses, cache.entries.len()), (1, 1, 1));
	}

	#[test]
	fn language_is_part_of_the_key() {
		let code = "def greet(name):\n    return name\n";
		let py_key = key_for(code, SupportLang::Python);
		let ts_key = key_for(code, TS);
		assert_ne!(py_key, ts_key, "same bytes, different language, different key");

		let mut cache = cache(MAX_ENTRIES, MAX_RETAINED_BYTES);
		let tree = tree_of(code, SupportLang::Python);
		cache.insert(
			py_key,
			code,
			&tree,
			None,
			tree_cost(code, &tree, SupportLang::Python),
			cache.clock,
		);
		assert!(
			hit(&mut cache, code).is_none(),
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
		let mut cache = cache(MAX_ENTRIES, MAX_RETAINED_BYTES);
		let tree = tree_of(stored, TS);
		cache.insert(forged, stored, &tree, None, tree_cost(stored, &tree, TS), cache.clock);

		assert!(
			matches!(cache.get(&forged, probe, None), Lookup::Miss(None)),
			"byte comparison must turn a collision into a miss"
		);
		assert_eq!(cache.misses, 1);
	}

	#[test]
	fn entry_bound_evicts_least_recently_used() {
		let mut cache = cache(2, MAX_RETAINED_BYTES);
		let sources = ["const a = 1;\n", "const b = 2;\n", "const c = 3;\n"];

		put(&mut cache, sources[0], None);
		put(&mut cache, sources[1], None);
		// Touch slot 0 so slot 1 becomes the least recently used.
		assert!(hit(&mut cache, sources[0]).is_some());
		put(&mut cache, sources[2], None);

		assert_eq!(cache.entries.len(), 2, "entry bound holds");
		assert_eq!(cache.evictions, 1);
		assert!(hit(&mut cache, sources[0]).is_some(), "recently used slot survives");
		assert!(hit(&mut cache, sources[1]).is_none(), "least recently used slot evicted");
		assert!(hit(&mut cache, sources[2]).is_some(), "newest slot resident");
	}

	#[test]
	fn tree_cost_budget_evicts_and_reclaims_accounting() {
		let sources = ["const a = 1;\n", "const b = 2;\n", "const c = 3;\n"];
		let cost = tree_cost(sources[0], &tree_of(sources[0], TS), TS);
		// Room for exactly two of these trees.
		let mut cache = cache(64, cost * 2);

		for code in sources {
			assert_eq!(put(&mut cache, code, None), cost, "same shape, same cost");
			assert!(cache.retained_bytes <= cost * 2, "budget must hold after every insert");
		}

		assert_eq!(cache.entries.len(), 2);
		assert_eq!(cache.evictions, 1);
		// Exact accounting, not just the bound: a subtraction missed on eviction
		// would leave `retained_bytes` drifting upward until the cache starved.
		assert_eq!(cache.retained_bytes, cost * 2);
		assert!(hit(&mut cache, sources[0]).is_none(), "oldest slot evicted by the budget");
	}

	#[test]
	fn tree_cost_tracks_tree_size_not_source_length() {
		// The dense source is no longer, but packs far more syntax.
		let sparse = format!("const text = \"{}\";\n", "x".repeat(64));
		let dense = format!("const a = [{}];\n", "1,".repeat(32));
		assert!(dense.len() <= sparse.len());
		assert!(
			tree_cost(&dense, &tree_of(&dense, TS), TS)
				> 2 * tree_cost(&sparse, &tree_of(&sparse, TS), TS),
			"a node-dense tree must cost more than a string literal of equal length"
		);
	}

	#[test]
	fn tree_over_the_budget_is_never_retained() {
		let code = "function f() {\n  a();\n}\n";
		let cost = tree_cost(code, &tree_of(code, TS), TS);
		let mut cache = cache(MAX_ENTRIES, cost - 1);

		put(&mut cache, code, None);

		assert_eq!(cache.entries.len(), 0, "oversized tree is parsed but not cached");
		assert_eq!(cache.retained_bytes, 0);
		assert_eq!(cache.evictions, 0, "rejection must not evict a healthy slot");
		assert!(hit(&mut cache, code).is_none());
	}

	#[test]
	fn reinsert_of_a_resident_key_does_not_double_count_bytes() {
		let mut cache = cache(MAX_ENTRIES, MAX_RETAINED_BYTES);
		let code = "const a = 1;\n";

		let cost = put(&mut cache, code, None);
		put(&mut cache, code, None);

		assert_eq!(cache.entries.len(), 1);
		assert_eq!(cache.retained_bytes, cost);
		assert_eq!(cache.evictions, 0);
	}

	#[test]
	fn a_path_keeps_its_current_and_previous_version_only() {
		let mut cache = cache(MAX_ENTRIES, MAX_RETAINED_BYTES);
		let (v1, v2, v3) = ("const a = 1;\n", "const a = 2;\n", "const a = 3;\n");
		let other = "const b = 1;\n";
		put(&mut cache, v1, Some("a.ts"));
		let other_cost = put(&mut cache, other, Some("b.ts"));
		let py_tree = tree_of(v1, SupportLang::Python);
		let py_cost = tree_cost(v1, &py_tree, SupportLang::Python);
		cache.insert(
			key_for(v1, SupportLang::Python),
			v1,
			&py_tree,
			Some("a.ts"),
			py_cost,
			cache.clock,
		);
		let v2_cost = put(&mut cache, v2, Some("a.ts"));

		// Before and after an edit both stay resident, so a diff of the two hits.
		assert!(hit(&mut cache, v1).is_some());
		assert!(hit(&mut cache, v2).is_some());
		assert_eq!(cache.superseded, 0);

		let v3_cost = put(&mut cache, v3, Some("a.ts"));

		assert!(hit(&mut cache, v1).is_none(), "two versions behind is gone");
		assert!(hit(&mut cache, v2).is_some());
		assert!(hit(&mut cache, v3).is_some());
		assert!(hit(&mut cache, other).is_some(), "another path is untouched");
		assert!(
			matches!(cache.get(&key_for(v1, SupportLang::Python), v1, None), Lookup::Hit(_)),
			"the same path in another language is a different binding"
		);
		assert_eq!((cache.superseded, cache.evictions), (1, 0));
		assert_eq!(cache.retained_bytes, v2_cost + v3_cost + other_cost + py_cost);
	}

	#[test]
	fn a_hit_makes_its_content_the_paths_current_version() {
		let mut cache = cache(MAX_ENTRIES, MAX_RETAINED_BYTES);
		let (v1, v2, v3) = ("const a = 1;\n", "const a = 2;\n", "const a = 3;\n");
		put(&mut cache, v1, None);
		put(&mut cache, v2, Some("a.ts"));
		put(&mut cache, v3, Some("a.ts"));

		assert!(matches!(cache.get(&key_for(v1, TS), v1, Some("a.ts")), Lookup::Hit(_)));

		let next = "const a = 4;\n";
		let Lookup::Miss(Some(base)) = cache.get(&key_for(next, TS), next, Some("a.ts")) else {
			panic!("a miss on a bound path returns a version as the reparse base");
		};
		assert_eq!(&*base.source, v1, "the hit content is the current version");
		assert!(hit(&mut cache, v2).is_none(), "the least recent of the path's versions is dropped");
		assert!(hit(&mut cache, v3).is_some());
		assert_eq!(cache.superseded, 1);
	}

	#[test]
	fn identical_files_keep_their_shared_entry_until_neither_needs_it() {
		let mut cache = cache(MAX_ENTRIES, MAX_RETAINED_BYTES);
		let shared = "const a = 1;\n";
		put(&mut cache, shared, Some("a.ts"));
		assert!(matches!(cache.get(&key_for(shared, TS), shared, Some("b.ts")), Lookup::Hit(_)));
		put(&mut cache, "const a = 2;\n", Some("b.ts"));
		put(&mut cache, "const a = 3;\n", Some("b.ts"));

		assert!(hit(&mut cache, shared).is_some(), "a.ts still holds these bytes");
		assert_eq!(cache.superseded, 0);
		let next = "const a = 4;\n";
		let Lookup::Miss(Some(base)) = cache.get(&key_for(next, TS), next, Some("a.ts")) else {
			panic!("a.ts keeps its reparse base after b.ts moves on");
		};
		assert_eq!(&*base.source, shared);
	}

	/// The content `path`'s next reparse would start from.
	fn reparse_base(cache: &mut Cache, path: &str) -> Option<Arc<str>> {
		let probe = "const never_cached = 0;\n";
		match cache.get(&key_for(probe, TS), probe, Some(path)) {
			Lookup::Miss(base) => base.map(|base| base.source),
			Lookup::Hit(_) => unreachable!("the probe is never stored"),
		}
	}

	#[test]
	fn concurrent_parses_of_identical_files_keep_both_bindings() {
		let mut cache = cache(MAX_ENTRIES, MAX_RETAINED_BYTES);
		let shared = "const a = 1;\n";
		let tree = tree_of(shared, TS);
		let cost = tree_cost(shared, &tree, TS);
		// Both lookups miss before either parse lands.
		let ticket = lookup_ticket(&mut cache);
		cache.insert(key_for(shared, TS), shared, &tree, Some("a.ts"), cost, ticket);
		cache.insert(key_for(shared, TS), shared, &tree_of(shared, TS), Some("b.ts"), cost, ticket);

		assert_eq!(reparse_base(&mut cache, "a.ts").as_deref(), Some(shared));
		assert_eq!(reparse_base(&mut cache, "b.ts").as_deref(), Some(shared));
		assert_eq!(cache.retained_bytes, cost, "one entry, charged once");
	}

	#[test]
	fn a_stale_parse_is_cached_without_rolling_its_path_back() {
		let mut cache = cache(MAX_ENTRIES, MAX_RETAINED_BYTES);
		let (old, new) = ("const a = 1;\n", "const a = 2;\n");
		// A background parse of `old` looks up, then a newer read of `new` lands
		// before it finishes.
		let stale_ticket = lookup_ticket(&mut cache);
		put(&mut cache, new, Some("a.ts"));
		let tree = tree_of(old, TS);
		let cost = tree_cost(old, &tree, TS);
		cache.insert(key_for(old, TS), old, &tree, Some("a.ts"), cost, stale_ticket);

		assert_eq!(reparse_base(&mut cache, "a.ts").as_deref(), Some(new), "`new` stays current");
		assert!(hit(&mut cache, old).is_some(), "the stale tree is still cached");
		assert!(hit(&mut cache, new).is_some());
	}

	#[test]
	fn the_stale_fence_survives_its_path_being_forgotten() {
		let mut cache = cache(MAX_ENTRIES, MAX_RETAINED_BYTES);
		let (old, new) = ("const a = 1;\n", "const a = 2;\n");
		let stale_ticket = lookup_ticket(&mut cache);
		put(&mut cache, new, Some("a.ts"));
		// Enough other paths advance to push a.ts out of the exact ticket map.
		for i in 0..MAX_TRACKED_PATHS {
			put(&mut cache, &format!("const other = {i};\n"), Some(&format!("o{i}.ts")));
		}
		assert!(!cache.path_tickets.contains_key("a.ts"));

		let tree = tree_of(old, TS);
		let cost = tree_cost(old, &tree, TS);
		cache.insert(key_for(old, TS), old, &tree, Some("a.ts"), cost, stale_ticket);

		assert!(hit(&mut cache, old).is_some(), "the stale tree is still cached");
		assert_eq!(
			reparse_base(&mut cache, "a.ts"),
			None,
			"but it cannot become a.ts's current version"
		);
	}

	#[test]
	fn the_stale_fence_survives_its_path_returning_in_another_language() {
		let mut cache = cache(MAX_ENTRIES, MAX_RETAINED_BYTES);
		let (old, new) = ("const a = 1;\n", "const a = 2;\n");
		let stale_ticket = lookup_ticket(&mut cache);
		put(&mut cache, new, Some("a.ts"));
		for i in 0..MAX_TRACKED_PATHS {
			put(&mut cache, &format!("const other = {i};\n"), Some(&format!("o{i}.ts")));
		}
		assert!(!cache.path_tickets.contains_key("a.ts"));
		// a.ts is tracked again, but only with a Python ticket.
		let py = "x = 1\n";
		let py_tree = tree_of(py, SupportLang::Python);
		let py_cost = tree_cost(py, &py_tree, SupportLang::Python);
		let py_ticket = lookup_ticket(&mut cache);
		cache.insert(
			key_for(py, SupportLang::Python),
			py,
			&py_tree,
			Some("a.ts"),
			py_cost,
			py_ticket,
		);
		assert!(cache.path_tickets.contains_key("a.ts"));

		let tree = tree_of(old, TS);
		let cost = tree_cost(old, &tree, TS);
		cache.insert(key_for(old, TS), old, &tree, Some("a.ts"), cost, stale_ticket);

		assert!(hit(&mut cache, old).is_some(), "the stale tree is still cached");
		assert_eq!(
			reparse_base(&mut cache, "a.ts"),
			None,
			"but it cannot become a.ts's TypeScript version"
		);
	}

	#[test]
	fn the_stale_fence_outlives_a_rejected_newer_tree() {
		let old = "const a = 1;\n";
		let new = "function f() {\n  a();\n  b();\n}\n";
		let old_cost = tree_cost(old, &tree_of(old, TS), TS);
		// Room for `old` only, so the newer tree is parsed but never retained.
		let mut cache = cache(MAX_ENTRIES, old_cost);
		let stale_ticket = lookup_ticket(&mut cache);
		put(&mut cache, new, Some("a.ts"));
		assert!(hit(&mut cache, new).is_none());

		let tree = tree_of(old, TS);
		cache.insert(key_for(old, TS), old, &tree, Some("a.ts"), old_cost, stale_ticket);

		assert!(hit(&mut cache, old).is_some(), "the stale tree is still cached");
		assert_eq!(reparse_base(&mut cache, "a.ts"), None, "but it is not a.ts's current version");
	}

	#[test]
	fn concurrent_parses_of_one_path_order_by_request_not_completion() {
		let mut cache = cache(MAX_ENTRIES, MAX_RETAINED_BYTES);
		let (first, second) = ("const a = 1;\n", "const a = 2;\n");
		let first_ticket = lookup_ticket(&mut cache);
		let second_ticket = lookup_ticket(&mut cache);
		// The earlier request also finishes first.
		for (code, ticket) in [(first, first_ticket), (second, second_ticket)] {
			let tree = tree_of(code, TS);
			let cost = tree_cost(code, &tree, TS);
			cache.insert(key_for(code, TS), code, &tree, Some("a.ts"), cost, ticket);
		}

		assert_eq!(reparse_base(&mut cache, "a.ts").as_deref(), Some(second));
	}

	#[test]
	fn bindings_per_entry_are_bounded() {
		let mut cache = cache(MAX_ENTRIES, MAX_RETAINED_BYTES);
		let shared = "const a = 1;\n";
		put(&mut cache, shared, Some("p0.ts"));
		for i in 1..=2 * MAX_PATHS_PER_ENTRY {
			let path = format!("p{i}.ts");
			assert!(matches!(cache.get(&key_for(shared, TS), shared, Some(&path)), Lookup::Hit(_)));
		}

		let entry = &cache.entries[&key_for(shared, TS)];
		assert_eq!(entry.bindings.len(), MAX_PATHS_PER_ENTRY);
		let newest = format!("p{}.ts", 2 * MAX_PATHS_PER_ENTRY);
		assert!(entry.binding(&newest).is_some(), "the newest path is kept");
		assert!(entry.binding("p0.ts").is_none(), "the oldest path gave way");
	}

	#[test]
	fn a_pathless_hit_does_not_reorder_a_paths_versions() {
		let mut cache = cache(MAX_ENTRIES, MAX_RETAINED_BYTES);
		let (v1, v2, v3) = ("const a = 1;\n", "const a = 2;\n", "const a = 3;\n");
		put(&mut cache, v1, Some("a.ts"));
		put(&mut cache, v2, Some("a.ts"));
		assert!(hit(&mut cache, v1).is_some());

		let Lookup::Miss(Some(base)) = cache.get(&key_for(v3, TS), v3, Some("a.ts")) else {
			panic!("v2 is the current version");
		};
		assert_eq!(&*base.source, v2);
		put(&mut cache, v3, Some("a.ts"));
		assert!(hit(&mut cache, v1).is_none(), "v1 is two versions behind");
		assert!(hit(&mut cache, v2).is_some(), "v2 is the previous version");
	}

	#[test]
	fn only_an_error_free_current_version_seeds_a_reparse() {
		let mut cache = cache(MAX_ENTRIES, MAX_RETAINED_BYTES);
		let next = "const a = 9;\n";
		let reparse_base = |cache: &mut Cache| match cache.get(&key_for(next, TS), next, Some("a.ts"))
		{
			Lookup::Miss(base) => base.map(|base| base.source),
			Lookup::Hit(_) => panic!("`next` is never stored"),
		};
		put(&mut cache, "const a = 1;\n", Some("a.ts"));
		put(&mut cache, "const a = (1;\n", Some("a.ts"));
		assert_eq!(reparse_base(&mut cache), None, "a broken current version seeds nothing");

		put(&mut cache, "const a = 2;\n", Some("a.ts"));
		assert_eq!(reparse_base(&mut cache).as_deref(), Some("const a = 2;\n"));
	}

	#[test]
	fn a_paths_previous_version_is_evicted_before_other_files() {
		let mut cache = cache(3, MAX_RETAINED_BYTES);
		put(&mut cache, "const b = 1;\n", Some("b.ts"));
		put(&mut cache, "const a = 1;\n", Some("a.ts"));
		put(&mut cache, "const a = 2;\n", Some("a.ts"));

		put(&mut cache, "const c = 1;\n", Some("c.ts"));

		assert!(hit(&mut cache, "const a = 1;\n").is_none(), "the previous version goes first");
		assert!(hit(&mut cache, "const b = 1;\n").is_some(), "an older but current file survives");
		assert!(hit(&mut cache, "const a = 2;\n").is_some());
		assert_eq!((cache.evictions, cache.superseded), (1, 0));
	}

	#[test]
	fn a_rejected_tree_still_retires_versions_behind_it() {
		let (v1, v2) = ("const a = 1;\n", "const a = 2;\n");
		let v3 = "function f() {\n  a();\n  b();\n}\n";
		let small = tree_cost(v1, &tree_of(v1, TS), TS);
		let mut cache = cache(MAX_ENTRIES, 2 * small);
		put(&mut cache, v1, Some("a.ts"));
		put(&mut cache, v2, Some("a.ts"));

		put(&mut cache, v3, Some("a.ts"));

		assert!(hit(&mut cache, v3).is_none(), "v3 is over budget");
		assert!(hit(&mut cache, v1).is_none(), "v1 is two versions behind");
		assert!(hit(&mut cache, v2).is_some());
		assert_eq!(cache.retained_bytes, small);
	}

	fn base_of(code: &str) -> Base {
		Base { source: Arc::from(code), tree: tree_of(code, TS) }
	}

	#[test]
	fn incremental_reparse_matches_a_fresh_parse_and_reuses_unchanged_subtrees() {
		let language = TS.grammar().load().expect("grammar loads");
		let old = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 'é';\n}\n";
		let edits = [
			// In place, one line.
			"function a() {\n  return 2;\n}\n\nfunction b() {\n  return 'é';\n}\n",
			// Inserted lines shift every later row.
			"function a() {\n  const x = 1;\n  return x;\n}\n\nfunction b() {\n  return 'é';\n}\n",
			// Edit right after a multi-byte character, which shares its lead byte.
			"function a() {\n  return 1;\n}\n\nfunction b() {\n  return 'è';\n}\n",
			// Deletion to the end.
			"function a() {\n  return 1;\n}\n",
			// Prepend.
			"// header\nfunction a() {\n  return 1;\n}\n\nfunction b() {\n  return 'é';\n}\n",
		];
		for new in edits {
			let base = base_of(old);
			let reused = subtree_id(&base.tree, 1);
			let tree = parse_from(&language, new, Some(base))
				.expect("parses")
				.expect("tree");
			let fresh = tree_of(new, TS);
			assert_eq!(tree.root_node().to_sexp(), fresh.root_node().to_sexp(), "edit {new:?}");
			assert_eq!(
				tree.root_node().end_position(),
				fresh.root_node().end_position(),
				"edit {new:?}"
			);
			if new.starts_with("function a() {\n  return 2;") {
				assert_eq!(
					subtree_id(&tree, 1),
					reused,
					"the untouched function is reused, not reparsed"
				);
			}
		}
	}

	#[test]
	fn an_edit_spanning_most_of_the_file_parses_fresh() {
		let language = TS.grammar().load().expect("grammar loads");
		let old = "function a() {}\nfunction b() {}\nfunction c() {}\nfunction d() {}\nfunction \
		           t1() {}\nfunction t2() {}\n";
		// Rewrites a..d and keeps t1, t2. The node right after an edit is always
		// copied (its padding changes), but an incremental parse would reuse t2.
		let new = "function w() { return 1; }\nfunction x() { return 2; }\nfunction y() { return 3; \
		           }\nfunction z() { return 4; }\nfunction t1() {}\nfunction t2() {}\n";
		let base = base_of(old);
		// Keep the base alive so its subtree addresses cannot be recycled.
		let kept = base.tree.clone();
		let tail = subtree_id(&kept, 5);

		let tree = parse_from(&language, new, Some(base))
			.expect("parses")
			.expect("tree");

		assert_eq!(tree.root_node().to_sexp(), tree_of(new, TS).root_node().to_sexp());
		assert_ne!(subtree_id(&tree, 5), tail, "a wide edit must not run the incremental parse");
	}

	#[test]
	fn a_broken_result_is_always_a_fresh_parse() {
		let language = TS.grammar().load().expect("grammar loads");
		let old = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";
		// The error sits in `b`, so an incremental parse would reuse `a` whole.
		let broken = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2 +;\n}\n";
		let base = base_of(old);
		// Keep the base alive so its subtree addresses cannot be recycled.
		let kept = base.tree.clone();
		let base_ids: Vec<usize> = (0..kept.root_node().child_count())
			.map(|i| subtree_id(&kept, i))
			.collect();

		let tree = parse_from(&language, broken, Some(base))
			.expect("parses")
			.expect("tree");

		assert!(tree.root_node().has_error());
		assert_eq!(tree.root_node().to_sexp(), tree_of(broken, TS).root_node().to_sexp());
		assert!(
			(0..tree.root_node().child_count()).all(|i| !base_ids.contains(&subtree_id(&tree, i))),
			"no subtree may come from the base"
		);
	}

	#[test]
	fn clear_empties_the_cache_but_keeps_its_bounds() {
		let mut cache = cache(3, 1 << 20);
		put(&mut cache, "const a = 1;\n", Some("a.ts"));
		put(&mut cache, "const a = 2;\n", Some("a.ts"));
		put(&mut cache, "const a = 3;\n", Some("a.ts"));
		assert_eq!(cache.entries.len(), 2);

		cache.clear();

		assert_eq!(cache.entries.len(), 0);
		assert_eq!(
			(cache.retained_bytes, cache.hits, cache.misses, cache.evictions, cache.superseded),
			(0, 0, 0, 0, 0)
		);
		assert_eq!((cache.max_entries, cache.max_retained_bytes), (3, 1 << 20));
	}
}
