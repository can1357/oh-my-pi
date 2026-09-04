//! Workspace-standard fast non-cryptographic hashing.
//!
//! [foldhash](https://docs.rs/foldhash) won omp's hasher benchmark on every
//! workload class (integer keys, short string keys, and multi-KiB buffers)
//! against fxhash, ahash, xxh3, and `SipHash`. Every discretionary in-memory
//! hash — map states, cache keys, dirty-check fingerprints — routes through
//! these aliases so the choice stays in one place.
//!
//! Digests are deterministic across processes (fixed seed) but carry no
//! stability or collision-resistance promise: anything persisted, signed, or
//! attacker-facing uses [`crate::Hash32`] instead.

use std::{
	collections::{HashMap, HashSet},
	hash::{BuildHasher, Hasher as _},
};

/// The workspace-standard fast [`BuildHasher`], deterministic across runs.
pub type FastState = foldhash::fast::FixedState;

/// A [`HashMap`] keyed with the workspace-standard fast hasher.
pub type FastHashMap<K, V> = HashMap<K, V, FastState>;

/// A [`HashSet`] keyed with the workspace-standard fast hasher.
pub type FastHashSet<T> = HashSet<T, FastState>;

/// Returns the deterministic 64-bit fast hash of `bytes`.
///
/// For in-memory fingerprints and cache keys only; see the module docs for
/// the [`crate::Hash32`] boundary.
#[inline]
pub fn fast_hash64(bytes: impl AsRef<[u8]>) -> u64 {
	let mut hasher = FastState::default().build_hasher();
	hasher.write(bytes.as_ref());
	hasher.finish()
}

#[cfg(test)]
mod tests {
	use super::{FastHashMap, fast_hash64};

	#[test]
	fn fast_hash64_is_deterministic_and_spreads() {
		assert_eq!(fast_hash64(b"omp"), fast_hash64(b"omp"));
		assert_ne!(fast_hash64(b"omp"), fast_hash64(b"omq"));
		assert_ne!(fast_hash64(b""), fast_hash64(b"\0"));
	}

	#[test]
	fn fast_map_default_construction_works() {
		let mut map = FastHashMap::default();
		map.insert("key", 1);
		assert_eq!(map.get("key"), Some(&1));
	}
}
