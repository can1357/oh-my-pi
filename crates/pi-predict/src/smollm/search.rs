//! Prefix-constrained best-first decoding to a word boundary.
//!
//! The caller token-heals the context: it cuts the context at the token that
//! holds the word start, so every path here must first spell `target` (the
//! healed lead, usually a space, plus the typed prefix) and then continue
//! with word-character tokens until a boundary token. Paths are scored by
//! joint log-probability (uniform-cost search), so the first finished word
//! popped is the most probable completion; per-step normalization would walk
//! into non-canonical splits such as `Im`+`ple`.
//!
//! Confidence is P(word) / Z, where Z is the probability mass consistent with
//! the prefix, including "the prefix already is the whole word" (tokens that
//! spell the rest of the target and then a boundary, and the boundary mass
//! after an exact spelling). Z starts at the root's consistent mass and is
//! refined only when a partial token is expanded, so it is an upper bound and
//! the confidence is conservative.

use std::{
	cmp::Ordering,
	collections::{BinaryHeap, HashMap},
	sync::Arc,
};

use crate::prose::is_word_char;

/// Token-text lookups for prefix-constrained decoding.
pub struct TokenIndex {
	texts:        Vec<Option<Box<str>>>,
	/// Tokens whose text starts with a word character (continue a word).
	cont_ids:     Vec<u32>,
	/// Every other token, including specials and partial characters: each
	/// ends the word.
	boundary_ids: Vec<u32>,
	/// `(text, id)` sorted by text bytes, for "starts with" ranges.
	sorted:       Vec<(Box<str>, u32)>,
	/// Exact text → ids, for "is a proper prefix of" lookups.
	exact:        HashMap<Box<str>, Vec<u32>>,
}

impl TokenIndex {
	/// Index `texts[id]` (`None` = the token can never spell a word).
	pub fn new(texts: Vec<Option<Box<str>>>) -> Self {
		let mut cont_ids = Vec::new();
		let mut boundary_ids = Vec::new();
		let mut sorted = Vec::new();
		let mut exact: HashMap<Box<str>, Vec<u32>> = HashMap::new();
		for (id, text) in texts.iter().enumerate() {
			let id = id as u32;
			match text {
				Some(text) if text.chars().next().is_some_and(is_word_char) => cont_ids.push(id),
				_ => boundary_ids.push(id),
			}
			if let Some(text) = text {
				sorted.push((text.clone(), id));
				exact.entry(text.clone()).or_default().push(id);
			}
		}
		sorted.sort();
		Self { texts, cont_ids, boundary_ids, sorted, exact }
	}

	fn text(&self, id: u32) -> &str {
		self.texts[id as usize].as_deref().unwrap_or_default()
	}

	/// Tokens whose text starts with `r` (including `r` itself).
	fn starting_with<'a>(&'a self, r: &'a str) -> impl Iterator<Item = u32> + 'a {
		let lo = self
			.sorted
			.partition_point(|(text, _)| text.as_bytes() < r.as_bytes());
		self.sorted[lo..]
			.iter()
			.take_while(move |(text, _)| text.starts_with(r))
			.map(|&(_, id)| id)
	}

	/// Tokens whose text is a proper, non-empty prefix of `r`.
	fn proper_prefixes_of<'a>(&'a self, r: &'a str) -> impl Iterator<Item = u32> + 'a {
		r.char_indices()
			.skip(1)
			.filter_map(|(at, _)| self.exact.get(&r[..at]))
			.flatten()
			.copied()
	}

	/// Tokens consistent with the remaining target `r` whose word continues
	/// (proper prefixes of `r`, or tokens covering it and going on with word
	/// chars), and the ones that spell `r` and then hit a boundary.
	fn prefix_children(&self, r: &str) -> (Vec<u32>, Vec<u32>) {
		let mut cand: Vec<u32> = self.proper_prefixes_of(r).collect();
		let mut ends = Vec::new();
		for id in self.starting_with(r) {
			let ext = &self.text(id)[r.len()..];
			if ext.chars().next().is_some_and(|c| !is_word_char(c)) {
				ends.push(id);
			} else {
				cand.push(id);
			}
		}
		(cand, ends)
	}
}

/// Leading word-character run of `text`, and whether a boundary char
/// follows it inside `text`.
fn word_run(text: &str) -> (&str, bool) {
	match text.char_indices().find(|&(_, c)| !is_word_char(c)) {
		Some((at, _)) => (&text[..at], true),
		None => (text, false),
	}
}

/// `log Σ exp(row[id])` over `ids`.
fn logsumexp(row: &[f32], ids: &[u32]) -> f64 {
	let max = ids
		.iter()
		.map(|&id| row[id as usize])
		.fold(f32::NEG_INFINITY, f32::max);
	if max == f32::NEG_INFINITY {
		return f64::NEG_INFINITY;
	}
	let sum: f64 = ids
		.iter()
		.map(|&id| f64::from(row[id as usize] - max).exp())
		.sum();
	f64::from(max) + sum.ln()
}

/// Search width and depth limits.
#[derive(Clone, Copy, Debug)]
pub struct SearchParams {
	/// Node expansions (model forwards) for the best completion; each extra
	/// requested alternative adds four.
	pub max_expand: usize,
	/// Children kept per node while the prefix is still being spelled.
	pub top_prefix: usize,
	/// Word-continuation children kept per node after the prefix.
	pub top_free:   usize,
	/// Longest completion in characters beyond the prefix.
	pub max_chars:  usize,
}

impl Default for SearchParams {
	fn default() -> Self {
		Self { max_expand: 12, top_prefix: 6, top_free: 3, max_chars: 24 }
	}
}

/// Next-token log-probabilities after the context plus a token path.
pub trait Rows {
	/// Log-probabilities over the vocabulary after `path`.
	///
	/// # Errors
	/// Propagates model failures.
	fn row(&mut self, path: &[u32]) -> anyhow::Result<Arc<[f32]>>;
}

struct Node {
	cost:      f64,
	seq:       u64,
	path:      Vec<u32>,
	/// Part of the target not yet spelled.
	remaining: String,
	/// Word characters produced beyond the target.
	out:       String,
	/// The word ended inside the last token.
	terminal:  bool,
}

impl PartialEq for Node {
	fn eq(&self, other: &Self) -> bool {
		self.cmp(other) == Ordering::Equal
	}
}

impl Eq for Node {}

impl PartialOrd for Node {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

impl Ord for Node {
	/// Reversed so `BinaryHeap` pops the cheapest node, oldest first on ties.
	fn cmp(&self, other: &Self) -> Ordering {
		other
			.cost
			.total_cmp(&self.cost)
			.then_with(|| other.seq.cmp(&self.seq))
	}
}

/// Up to `n` distinct completions `(suffix, confidence)` of `target`, most
/// probable first. `target` is the healed lead plus the typed prefix.
///
/// # Errors
/// Propagates model failures from `rows`.
pub fn complete_nbest(
	index: &TokenIndex,
	params: SearchParams,
	target: &str,
	n: usize,
	rows: &mut impl Rows,
) -> anyhow::Result<Vec<(String, f32)>> {
	let mut heap = BinaryHeap::new();
	let mut seq = 0u64;
	let mut push = |heap: &mut BinaryHeap<Node>, cost, path, remaining, out, terminal| {
		seq += 1;
		heap.push(Node { cost, seq, path, remaining, out, terminal });
	};
	push(&mut heap, 0.0, Vec::new(), target.to_owned(), String::new(), false);
	// Prefix-consistent probability mass (upper bound), refined as partial
	// tokens are expanded.
	let mut mass = 1.0f64;
	let mut expanded = 0;
	let budget = params.max_expand + 4 * n.saturating_sub(1);
	let mut found: Vec<(String, f64)> = Vec::new();
	let add = |found: &mut Vec<(String, f64)>, out: String, logp: f64| {
		if !found.iter().any(|(word, _)| *word == out) {
			found.push((out, logp));
		}
	};

	while found.len() < n {
		let Some(node) = heap.pop() else { break };
		let logp = -node.cost;
		if node.terminal {
			add(&mut found, node.out, logp);
			continue;
		}
		if expanded >= budget {
			break;
		}
		expanded += 1;
		let row = rows.row(&node.path)?;
		let node_mass = logp.exp();
		if !node.remaining.is_empty() {
			let r = node.remaining.as_str();
			let (cand, ends) = index.prefix_children(r);
			// Z keeps "the prefix is the whole word" (tokens that spell r then
			// a boundary): the editor also asks on finished words.
			let kept: Vec<u32> = cand.iter().chain(&ends).copied().collect();
			if kept.is_empty() {
				mass -= node_mass;
				continue;
			}
			mass = node_mass.mul_add(logsumexp(&row, &kept).exp_m1(), mass);
			let mut ranked: Vec<(u32, f32)> = cand.iter().map(|&id| (id, row[id as usize])).collect();
			ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
			for &(id, lp) in ranked.iter().take(params.top_prefix) {
				let text = index.text(id);
				let mut path = node.path.clone();
				path.push(id);
				let cost = node.cost - f64::from(lp);
				if text.len() <= r.len() {
					push(&mut heap, cost, path, r[text.len()..].to_owned(), String::new(), false);
				} else {
					// A boundary inside the covering token closes the word there.
					let (run, closed) = word_run(&text[r.len()..]);
					push(&mut heap, cost, path, String::new(), run.to_owned(), closed);
				}
			}
			continue;
		}
		if !node.out.is_empty() {
			// "Stop here": the word ends before the next token.
			let boundary = logsumexp(&row, &index.boundary_ids);
			push(
				&mut heap,
				node.cost - boundary,
				node.path.clone(),
				String::new(),
				node.out.clone(),
				true,
			);
		}
		if node.out.chars().count() >= params.max_chars {
			continue;
		}
		for (id, lp) in top_k(&row, &index.cont_ids, params.top_free) {
			let (run, closed) = word_run(index.text(id));
			let mut path = node.path.clone();
			path.push(id);
			push(
				&mut heap,
				node.cost - f64::from(lp),
				path,
				String::new(),
				format!("{}{run}", node.out),
				closed,
			);
		}
	}
	// Budget spent: top up with the best finished words already queued.
	let mut finished: Vec<Node> = heap.into_iter().filter(|node| node.terminal).collect();
	finished.sort_by(|a, b| b.cmp(a));
	for node in finished {
		if found.len() >= n {
			break;
		}
		add(&mut found, node.out, -node.cost);
	}
	if mass <= 0.0 {
		return Ok(Vec::new());
	}
	found.sort_by(|a, b| b.1.total_cmp(&a.1));
	Ok(found
		.into_iter()
		.map(|(word, logp)| (word, (logp.exp() / mass).min(1.0) as f32))
		.collect())
}

/// The `k` highest `row[id]` over `ids`, best first.
fn top_k(row: &[f32], ids: &[u32], k: usize) -> Vec<(u32, f32)> {
	let mut best: Vec<(u32, f32)> = Vec::with_capacity(k + 1);
	for &id in ids {
		let lp = row[id as usize];
		if best.len() == k && best.last().is_some_and(|&(_, worst)| lp <= worst) {
			continue;
		}
		let at = best.partition_point(|&(_, other)| other >= lp);
		best.insert(at, (id, lp));
		best.truncate(k);
	}
	best
}

#[cfg(test)]
mod tests {
	use super::*;

	/// A toy LM over a handful of token texts: `table[path]` lists
	/// `(token, probability)`; the rest of the mass is spread evenly.
	struct Toy {
		vocab: usize,
		table: HashMap<Vec<u32>, Vec<(u32, f32)>>,
		calls: usize,
	}

	impl Rows for Toy {
		fn row(&mut self, path: &[u32]) -> anyhow::Result<Arc<[f32]>> {
			self.calls += 1;
			let listed = self.table.get(path).cloned().unwrap_or_default();
			let rest = 1.0 - listed.iter().map(|(_, p)| p).sum::<f32>();
			let even = (rest.max(1e-9) / (self.vocab - listed.len()) as f32).ln();
			let mut row = vec![even; self.vocab];
			for (id, p) in listed {
				row[id as usize] = p.ln();
			}
			Ok(row.into())
		}
	}

	const TEXTS: &[&str] =
		&[".", " ", " d", " dep", " de", "p", "loy", "end", "s", "th", "e", " the", "re", "ep"];

	fn id(text: &str) -> u32 {
		TEXTS.iter().position(|t| *t == text).expect("token") as u32
	}

	fn index() -> TokenIndex {
		TokenIndex::new(TEXTS.iter().map(|t| Some(Box::from(*t))).collect())
	}

	/// A token path and its next-token probabilities.
	type ToyEntry<'a> = (&'a [&'a str], &'a [(&'a str, f32)]);

	fn toy(entries: &[ToyEntry<'_>]) -> Toy {
		let table = entries
			.iter()
			.map(|(path, next)| {
				(path.iter().map(|t| id(t)).collect(), next.iter().map(|&(t, p)| (id(t), p)).collect())
			})
			.collect();
		Toy { vocab: TEXTS.len(), table, calls: 0 }
	}

	#[test]
	fn completions_spell_the_prefix_through_any_split() {
		// " dep" is spelled by " dep" or by " de"+"p"; "end" is only likely after
		// the split.
		let mut lm = toy(&[
			(&[], &[(" dep", 0.5), (" de", 0.3), (" d", 0.1)]),
			(&[" dep"], &[("loy", 0.6)]),
			(&[" de"], &[("p", 0.9)]),
			(&[" de", "p"], &[("end", 0.8)]),
			(&[" dep", "loy"], &[(".", 0.95)]),
			(&[" de", "p", "end"], &[(".", 0.95)]),
		]);
		let alts =
			complete_nbest(&index(), SearchParams::default(), " dep", 3, &mut lm).expect("search");
		assert_eq!(alts[0].0, "loy", "{alts:?}");
		let end = alts
			.iter()
			.find(|(w, _)| w == "end")
			.expect("split path found");
		// 0.3·0.9·0.8·P(boundary) over Z ≈ 0.88; the unsplit " dep"+"end" path is
		// < 0.01.
		assert!(end.1 > 0.15, "{alts:?}");
		for (word, conf) in &alts {
			assert!(word.chars().all(is_word_char), "suffix {word:?} is word chars only");
			assert!((0.0..=1.0).contains(conf));
		}
	}

	#[test]
	fn a_likely_finished_word_gets_low_confidence() {
		// After " the" the model mostly ends the word (" " / ".") and rarely goes
		// on with "re".
		let there: (&[&str], &[(&str, f32)]) = (&[" the", "re"], &[(".", 0.95)]);
		let finished = toy(&[
			(&[], &[(" the", 0.9)]),
			(&[" the"], &[(" ", 0.6), (".", 0.3), ("re", 0.05)]),
			there,
		]);
		let open = toy(&[(&[], &[(" the", 0.9)]), (&[" the"], &[("re", 0.9)]), there]);
		let conf = |mut lm: Toy| {
			let alts =
				complete_nbest(&index(), SearchParams::default(), " the", 1, &mut lm).expect("search");
			assert_eq!(alts.first().map(|(w, _)| w.as_str()), Some("re"));
			alts[0].1
		};
		let (finished, open) = (conf(finished), conf(open));
		assert!(finished < 0.1, "finished-word mass stays in Z: {finished}");
		assert!(open > 0.8, "{open}");
	}

	#[test]
	fn a_token_spelling_prefix_then_boundary_counts_as_finished() {
		// " the." would be one token in real vocabularies; here "the" + boundary
		// inside a covering token.
		let texts = [" the.", " the", "re", "."];
		let index = TokenIndex::new(texts.iter().map(|t| Some(Box::from(*t))).collect());
		let mut lm = Toy {
			vocab: texts.len(),
			table: HashMap::from([
				(vec![], vec![(0, 0.8), (1, 0.2)]),
				(vec![1], vec![(2, 0.9)]),
				(vec![1, 2], vec![(3, 0.9)]),
			]),
			calls: 0,
		};
		let alts =
			complete_nbest(&index, SearchParams::default(), " the", 1, &mut lm).expect("search");
		assert_eq!(alts[0].0, "re");
		assert!(alts[0].1 < 0.2, "the covering ' the.' token is finished-word mass: {alts:?}");
	}

	#[test]
	fn inconsistent_prefix_yields_nothing() {
		let mut lm = toy(&[(&[], &[(" the", 0.9)])]);
		let alts =
			complete_nbest(&index(), SearchParams::default(), " zq", 3, &mut lm).expect("search");
		assert!(alts.is_empty());
	}

	#[test]
	fn expansions_respect_the_budget() {
		let mut lm = toy(&[(&[], &[(" dep", 0.9)])]);
		let params = SearchParams { max_expand: 3, ..SearchParams::default() };
		let _ = complete_nbest(&index(), params, " dep", 1, &mut lm).expect("search");
		assert!(lm.calls <= 3, "{} forwards", lm.calls);
	}
}
