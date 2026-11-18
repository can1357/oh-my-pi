//! Tree-sitter helpers (`packages/hashline/src/syntax.ts`).

use std::{
	collections::{HashMap, VecDeque},
	path::Path,
	sync::{LazyLock, Mutex},
};

use pi_ast::{
	SupportLang,
	block::{
		BlockRangeOptions, EnclosingBoundaryOptions, LineRange, NodeSpan, enclosing_block_boundaries,
		node_chain_at,
	},
	parse_cache::parse_cached,
	summary::parse_code_status,
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
pub fn node_chain(lines: &[&str], path: &str, line: u32) -> Vec<NodeSpan> {
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
pub fn enclosing_boundaries(lines: &[&str], path: &str, start: u32, end: u32) -> Vec<u32> {
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
	let Some(path) = path.filter(|path| has_syntax_oracle(path)) else {
		return false;
	};
	let cache_key = key(text, path, 0, 0);
	if let Ok(cache) = CACHE.lock()
		&& let Some(cached) = cache.parses.get(&cache_key)
	{
		return *cached;
	}
	let parsed = parse_code_status(text, None, Some(path)).is_ok_and(|language| language.is_some());
	if let Ok(mut cache) = CACHE.lock() {
		let SyntaxCache { parses, parse_order, .. } = &mut *cache;
		insert_fifo(parses, parse_order, cache_key, parsed);
	}
	parsed
}

/// 1-indexed line spans of the syntax errors (`ERROR` and `MISSING` nodes) in
/// `text`, in document order. Empty when the text parses cleanly or `path` has
/// no syntax oracle.
pub fn syntax_error_spans(path: Option<&str>, text: &str) -> Vec<(u32, u32)> {
	let Some(path) = path.filter(|path| has_syntax_oracle(path)) else {
		return Vec::new();
	};
	let Some(language) = SupportLang::from_path(Path::new(path)) else {
		return Vec::new();
	};
	let Ok(Some(tree)) = parse_cached(text, language, Some(path)) else {
		return Vec::new();
	};
	let mut spans = Vec::new();
	let mut stack = vec![tree.root_node()];
	while let Some(node) = stack.pop() {
		if node.is_error() || node.is_missing() {
			spans.push((node.start_position().row as u32 + 1, node.end_position().row as u32 + 1));
			continue;
		}
		if !node.has_error() {
			continue;
		}
		let mut cursor = node.walk();
		let start = stack.len();
		stack.extend(node.children(&mut cursor));
		stack[start..].reverse();
	}
	spans
}

/// Whether a parse of `path` says anything about the file being valid.
///
/// Not for grammars whose `ERROR` nodes are mostly gaps rather than broken
/// files, as reported against real compilers and parsers:
/// - Markdown: every character sequence is a CommonMark document (a GFM table
///   row with an empty `||` cell is an `ERROR`).
/// - SQL and PowerShell: dialect and cmdlet syntax the grammars lack.
/// - Bash: heredocs and `case` patterns inside functions.
/// - CSS (also `.scss`): `@container` queries and SCSS syntax.
/// - HTML, Vue, Svelte, Astro: template syntax (Jinja, directives, blocks).
/// - C, C++, Objective-C: preprocessor conditionals split constructs, and `.h`
///   C++ headers parse with the C grammar.
/// - Kotlin and Swift: newer language syntax.
pub(crate) fn has_syntax_oracle(path: &str) -> bool {
	!matches!(
		SupportLang::from_path(Path::new(path)),
		Some(
			SupportLang::Markdown
				| SupportLang::Sql
				| SupportLang::Powershell
				| SupportLang::Bash
				| SupportLang::Css
				| SupportLang::Html
				| SupportLang::Vue
				| SupportLang::Svelte
				| SupportLang::Astro
				| SupportLang::C
				| SupportLang::Cpp
				| SupportLang::ObjC
				| SupportLang::Kotlin
				| SupportLang::Swift
		)
	)
}
