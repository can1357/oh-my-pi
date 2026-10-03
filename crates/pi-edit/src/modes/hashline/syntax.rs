//! Tree-sitter helpers (`packages/hashline/src/syntax.ts`).

use std::{
	collections::{HashMap, VecDeque},
	sync::{LazyLock, Mutex},
};

use pi_ast::{
	block::{
		BlockRangeOptions, EnclosingBoundaryOptions, LineRange, NodeSpan, enclosing_block_boundaries,
		node_chain_at,
	},
	summary::{SummaryOptions, summarize_code},
};
use xxhash_rust::xxh64::xxh64;

const CACHE_MAX: usize = 256;
type Key = (u64, usize, String, u32, u32);

#[derive(Default)]
struct SyntaxCache {
	chains:         HashMap<Key, Vec<NodeSpan>>,
	chain_order:    VecDeque<Key>,
	boundaries:     HashMap<Key, Vec<u32>>,
	boundary_order: VecDeque<Key>,
	parses:         HashMap<Key, bool>,
	parse_order:    VecDeque<Key>,
}

static CACHE: LazyLock<Mutex<SyntaxCache>> = LazyLock::new(|| Mutex::new(SyntaxCache::default()));

fn key(text: &str, path: &str, start: u32, end: u32) -> Key {
	(xxh64(text.as_bytes(), 0), text.len(), path.to_owned(), start, end)
}

fn insert_fifo<T>(map: &mut HashMap<Key, T>, order: &mut VecDeque<Key>, key: Key, value: T) {
	if map.len() >= CACHE_MAX
		&& let Some(oldest) = order.pop_front()
	{
		map.remove(&oldest);
	}
	order.push_back(key.clone());
	map.insert(key, value);
}

/// Named-node chain containing a 1-indexed line, innermost first.
pub fn node_chain(lines: &[String], path: &str, line: u32) -> Vec<NodeSpan> {
	let text = lines.join("\n");
	let cache_key = key(&text, path, line, line);
	if let Ok(cache) = CACHE.lock()
		&& let Some(cached) = cache.chains.get(&cache_key)
	{
		return cached.clone();
	}
	let chain = node_chain_at(BlockRangeOptions {
		code: text,
		lang: None,
		path: Some(path.to_owned()),
		line,
	})
	.ok()
	.flatten()
	.unwrap_or_default();
	if let Ok(mut cache) = CACHE.lock() {
		let SyntaxCache { chains, chain_order, .. } = &mut *cache;
		insert_fifo(chains, chain_order, cache_key, chain.clone());
	}
	chain
}

/// Syntax block boundaries enclosing a line range.
pub fn enclosing_boundaries(lines: &[String], path: &str, start: u32, end: u32) -> Vec<u32> {
	let text = lines.join("\n");
	let cache_key = key(&text, path, start, end);
	if let Ok(cache) = CACHE.lock()
		&& let Some(cached) = cache.boundaries.get(&cache_key)
	{
		return cached.clone();
	}
	let boundaries = enclosing_block_boundaries(EnclosingBoundaryOptions {
		code:   text,
		lang:   None,
		path:   Some(path.to_owned()),
		ranges: vec![LineRange { start_line: start, end_line: end }],
	})
	.ok()
	.flatten()
	.unwrap_or_default();
	if let Ok(mut cache) = CACHE.lock() {
		let SyntaxCache { boundaries: values, boundary_order, .. } = &mut *cache;
		insert_fifo(values, boundary_order, cache_key, boundaries.clone());
	}
	boundaries
}

/// Whether text parses cleanly for the supplied path language.
pub fn parses_cleanly(path: Option<&str>, text: &str) -> bool {
	let Some(path) = path else { return false };
	let cache_key = key(text, path, 0, 0);
	if let Ok(cache) = CACHE.lock()
		&& let Some(cached) = cache.parses.get(&cache_key)
	{
		return *cached;
	}
	let parsed = summarize_code(SummaryOptions {
		code:               text.to_owned(),
		lang:               None,
		path:               Some(path.to_owned()),
		min_body_lines:     None,
		min_comment_lines:  None,
		unfold_until_lines: None,
		unfold_limit_lines: None,
	})
	.is_ok_and(|summary| summary.parsed);
	if let Ok(mut cache) = CACHE.lock() {
		let SyntaxCache { parses, parse_order, .. } = &mut *cache;
		insert_fifo(parses, parse_order, cache_key, parsed);
	}
	parsed
}
