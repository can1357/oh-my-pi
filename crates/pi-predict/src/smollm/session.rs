//! KV-cache bookkeeping between the decoder and the search.
//!
//! The cache holds one token sequence: head (BOS + preamble + recent-prompt
//! memory), then the current word's context, then the search path being
//! scored. Each request re-uses the longest common prefix with what is cached,
//! so the head is computed once per memory change, the context once per word,
//! and every search node once per word (memoized by token path). When the
//! search jumps to another branch, the branch's tokens are put back from
//! per-node KV snapshots instead of being re-scored, so a node costs exactly
//! one single-token forward.

use std::{collections::HashMap, sync::Arc};

use super::{
	config::{Decoder, KvRow},
	search::Rows,
};

pub struct Session {
	model:    Box<dyn Decoder>,
	/// Token ids backing the KV cache (always `model.len()` long).
	cached:   Vec<u32>,
	head:     Vec<u32>,
	/// Head plus the current word's context.
	prefix:   Vec<u32>,
	/// Next-token log-probs by search path, for the current context.
	memo:     HashMap<Vec<u32>, Arc<[f32]>>,
	/// KV of each search path's last token, for the current context.
	kv:       HashMap<Vec<u32>, KvRow>,
	/// Row after the head alone: the root for a prompt's first word.
	head_row: Option<Arc<[f32]>>,
	vocab:    usize,
}

impl Session {
	pub fn new(model: Box<dyn Decoder>) -> Self {
		let vocab = model.vocab_size();
		Self {
			model,
			cached: Vec::new(),
			head: Vec::new(),
			prefix: Vec::new(),
			memo: HashMap::new(),
			kv: HashMap::new(),
			head_row: None,
			vocab,
		}
	}

	/// Replace the head; the cached rows of the old one are dropped.
	pub fn set_head(&mut self, head: Vec<u32>) {
		if head != self.head {
			self.head = head;
			self.head_row = None;
		}
		self.prefix.clear();
		self.memo.clear();
		self.kv.clear();
	}

	/// Start a new word: `context` follows the head, and its root row is
	/// scored now.
	///
	/// # Errors
	/// Propagates model failures.
	pub fn set_context(&mut self, context: &[u32]) -> anyhow::Result<()> {
		self.memo.clear();
		self.kv.clear();
		self.prefix.clear();
		self.prefix.extend_from_slice(&self.head);
		self.prefix.extend_from_slice(context);
		if let (true, Some(row)) = (context.is_empty(), &self.head_row) {
			self.memo.insert(Vec::new(), row.clone());
			return Ok(());
		}
		self.row(&[]).map(drop)
	}

	/// Forget every cached row and KV entry (after a model error).
	pub fn reset(&mut self) {
		self.model.truncate(0);
		self.cached.clear();
		self.memo.clear();
		self.kv.clear();
		self.prefix.clear();
		self.head_row = None;
	}

	/// Cut the cache back to `from` tokens, append `tokens`, and return the
	/// rows after `tokens[keep_from..]`.
	fn extend(&mut self, from: usize, tokens: &[u32], keep_from: usize) -> anyhow::Result<Vec<f32>> {
		self.model.truncate(from);
		self.cached.truncate(from);
		match self.model.forward(tokens, keep_from) {
			Ok(rows) => {
				self.cached.extend_from_slice(tokens);
				Ok(rows)
			},
			Err(error) => {
				self.cached.clear();
				Err(error)
			},
		}
	}
}

impl Rows for Session {
	fn row(&mut self, path: &[u32]) -> anyhow::Result<Arc<[f32]>> {
		if let Some(row) = self.memo.get(path) {
			return Ok(row.clone());
		}
		let mut full = Vec::with_capacity(self.prefix.len() + path.len());
		full.extend_from_slice(&self.prefix);
		full.extend_from_slice(path);
		let common = self
			.cached
			.iter()
			.zip(&full)
			.take_while(|(a, b)| a == b)
			.count();
		// A fully cached sequence still needs its last token re-scored.
		let mut from = common.min(full.len() - 1);
		let head = self.head.len();
		if from < head {
			// The head changed: score it alone first so its last row can root
			// every prompt-first word until the memory changes again.
			let row: Arc<[f32]> = self
				.extend(from, &full[from..head], head - 1 - from)?
				.into();
			self.head_row = Some(row.clone());
			if full.len() == head {
				self.memo.insert(Vec::new(), row.clone());
				return Ok(row);
			}
			from = head;
		}
		// Re-enter the branch: restore path tokens from their snapshots.
		let base = self.prefix.len();
		while from + 1 < full.len() && from >= base {
			let Some(row) = self.kv.get(&full[base..=from]) else {
				break;
			};
			if let Err(error) = self.model.restore(from, row) {
				self.cached.clear();
				return Err(error);
			}
			self.cached.truncate(from);
			self.cached.push(full[from]);
			from += 1;
		}
		let keep = from.max(base - 1);
		let rows = self.extend(from, &full[from..], keep - from)?;
		if !path.is_empty() {
			self.kv.insert(path.to_vec(), self.model.last_kv()?);
		}
		let mut last = None;
		for (k, row) in rows.chunks_exact(self.vocab).enumerate() {
			let end = keep + k + 1;
			let row: Arc<[f32]> = row.into();
			self
				.memo
				.insert(full[self.prefix.len()..end].to_vec(), row.clone());
			last = Some(row);
		}
		last.ok_or_else(|| anyhow::anyhow!("decoder returned no rows"))
	}
}

#[cfg(test)]
pub(super) mod tests {
	use super::{super::cpu::tests::random, *};

	/// Drive a session through words, branches, and head changes, checking
	/// every row against a fresh full pass of `reference`.
	pub fn rows_match_fresh_scoring(
		decoder: Box<dyn Decoder>,
		mut reference: Box<dyn Decoder>,
		tolerance: f32,
	) {
		let mut session = Session::new(decoder);
		let mut expect = |tokens: &[u32]| {
			reference.truncate(0);
			reference.forward(tokens, tokens.len() - 1).expect("fresh")
		};
		let close = |a: &[f32], b: &[f32]| a.iter().zip(b).all(|(x, y)| (x - y).abs() < tolerance);

		session.set_head(vec![0, 5, 6]);
		session.set_context(&[7, 8]).expect("context");
		let deep = session.row(&[1, 2]).expect("deep");
		assert!(close(&deep, &expect(&[0, 5, 6, 7, 8, 1, 2])));
		// Sibling path: the cache is cut back to the shared prefix.
		let sibling = session.row(&[3]).expect("sibling");
		assert!(close(&sibling, &expect(&[0, 5, 6, 7, 8, 3])));
		// Branch re-entry: [3]'s KV comes back from its snapshot.
		session.row(&[1]).expect("other branch");
		let reentered = session.row(&[3, 4]).expect("re-entered branch");
		assert!(close(&reentered, &expect(&[0, 5, 6, 7, 8, 3, 4])));
		let deeper = session.row(&[3, 4, 9]).expect("deeper");
		assert!(close(&deeper, &expect(&[0, 5, 6, 7, 8, 3, 4, 9])));
		// Next word: context grows past the old path.
		session.set_context(&[7, 8, 1, 9]).expect("next word");
		let root = session.row(&[]).expect("root");
		assert!(close(&root, &expect(&[0, 5, 6, 7, 8, 1, 9])));
		// Prompt-first word (empty context) after a memory change.
		session.set_head(vec![0, 4]);
		session.set_context(&[]).expect("empty context");
		assert!(close(&session.row(&[]).expect("head root"), &expect(&[0, 4])));
		session.set_context(&[10]).expect("context after head");
		session.set_context(&[]).expect("empty context again");
		assert!(close(&session.row(&[2]).expect("path"), &expect(&[0, 4, 2])));
	}

	#[test]
	fn cpu_rows_match_fresh_scoring_across_words_branches_and_heads() {
		rows_match_fresh_scoring(Box::new(random(12, 3)), Box::new(random(12, 3)), 1e-4);
	}
}
