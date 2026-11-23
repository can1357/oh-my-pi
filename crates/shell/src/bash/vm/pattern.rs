//! Compiled shell patterns shared by every shell of an engine.

use std::sync::Arc;

use bstr::BString;
use hashbrown::HashMap;
use parking_lot::Mutex;

use crate::bash::pattern::{PatOpts, Pattern};

/// Most distinct pattern texts kept; a miss past it empties the cache
/// first. Each text keeps one entry per option set it was compiled with
/// (at most 64), so memory stays proportional to the patterns a script
/// actually uses.
const CACHE_ENTRIES: usize = 4096;

/// The compiled forms of one pattern text, by options.
type Variants = Vec<(PatOpts, Arc<Pattern>)>;

/// Compiled patterns by text and options. Compiling is a pure function of
/// both, so shells of one engine share the results.
#[derive(Default)]
pub struct Cache {
	map: Mutex<HashMap<BString, Variants>>,
}

impl Cache {
	/// The compiled form of `src` under `opts`, compiling it on a miss.
	pub fn get(&self, src: &[u8], opts: PatOpts) -> Arc<Pattern> {
		if let Some((_, hit)) = self
			.map
			.lock()
			.get(src)
			.and_then(|variants| variants.iter().find(|(o, _)| *o == opts))
		{
			return Arc::clone(hit);
		}
		let pat = Arc::new(Pattern::compile(src, opts));
		let mut map = self.map.lock();
		if let Some(variants) = map.get_mut(src) {
			variants.push((opts, Arc::clone(&pat)));
		} else {
			if map.len() >= CACHE_ENTRIES {
				map.clear();
			}
			map.insert(BString::from(src), vec![(opts, Arc::clone(&pat))]);
		}
		pat
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn options_are_part_of_the_key() {
		let cache = Cache::default();
		let plain = cache.get(b"A*", PatOpts::default());
		let nocase = cache.get(b"A*", PatOpts { nocase: true, ..PatOpts::default() });
		assert!(!plain.matches(b"abc"));
		assert!(nocase.matches(b"abc"));
		assert!(Arc::ptr_eq(&plain, &cache.get(b"A*", PatOpts::default())));
	}
}
