//! Exact and similar recall cache with bank-generation invalidation.

use std::collections::{HashSet, VecDeque};

use omp_core::Str;
use parking_lot::Mutex;

use crate::{
	Result,
	recall::{RecallBounds, RecallResult},
	store::{BankStore, IndexGeneration},
};

const DEFAULT_CAPACITY: usize = 128;
const MAX_CACHED_RESULT_BYTES: usize = 256 * 1024;

/// Generation identity of one bank at cache insertion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BankStamp {
	bank:       Str,
	generation: IndexGeneration,
}

/// Snapshot current generation fences for ordered recall banks.
pub fn stamps(stores: &[BankStore]) -> Result<Vec<BankStamp>> {
	stores
		.iter()
		.map(|store| {
			Ok(BankStamp {
				bank:       Str::new(store.bank().as_str()),
				generation: store.generations()?,
			})
		})
		.collect()
}

#[derive(Clone)]
struct CacheEntry {
	query:     Str,
	tokens:    HashSet<Str>,
	embedding: Option<Vec<f32>>,
	stamps:    Vec<BankStamp>,
	bounds:    RecallBounds,
	results:   Vec<RecallResult>,
}

/// Bounded recall cache. Entries are evicted oldest-first and never survive an
/// index generation change.
pub struct RecallCache {
	entries:  Mutex<VecDeque<CacheEntry>>,
	capacity: usize,
}

impl Default for RecallCache {
	fn default() -> Self {
		Self::new()
	}
}

impl RecallCache {
	/// Creates the default 128-entry cache.
	pub fn new() -> Self {
		Self::with_capacity(DEFAULT_CAPACITY)
	}

	/// Creates a cache with a bounded capacity.
	pub fn with_capacity(capacity: usize) -> Self {
		Self { entries: Mutex::new(VecDeque::new()), capacity: capacity.clamp(1, 1024) }
	}

	/// Returns an exact query hit under identical bank generations.
	pub fn exact(
		&self,
		query: &str,
		current: &[BankStamp],
		bounds: RecallBounds,
	) -> Option<Vec<RecallResult>> {
		let normalized = normalize_query(query);
		let mut entries = self.entries.lock();
		entries.retain(|entry| entry.stamps == current);
		let index = entries
			.iter()
			.position(|entry| entry.query == normalized && entry.bounds == bounds)?;
		let entry = entries.remove(index)?;
		let results = entry.results.clone();
		entries.push_back(entry);
		Some(results)
	}

	/// Returns a high-confidence similar-query hit.
	///
	/// Dense cosine `>= 0.95` wins when both query embeddings exist; otherwise
	/// token Jaccard `>= 0.85` is required. Empty token sets never match.
	pub fn similar(
		&self,
		query: &str,
		embedding: Option<&[f32]>,
		current: &[BankStamp],
		bounds: RecallBounds,
	) -> Option<Vec<RecallResult>> {
		let tokens = token_set(query);
		let embedding = embedding.and_then(normalize_embedding);
		let mut entries = self.entries.lock();
		entries.retain(|entry| entry.stamps == current);
		let mut best: Option<(usize, f32)> = None;
		for (index, entry) in entries
			.iter()
			.enumerate()
			.filter(|(_, entry)| entry.bounds == bounds)
		{
			let score = match (embedding.as_deref(), entry.embedding.as_deref()) {
				(Some(left), Some(right)) if left.len() == right.len() => cosine(left, right),
				_ => jaccard(&tokens, &entry.tokens),
			};
			let threshold = if embedding.is_some() && entry.embedding.is_some() {
				0.95
			} else {
				0.85
			};
			if score >= threshold && best.is_none_or(|(_, current_score)| score > current_score) {
				best = Some((index, score));
			}
		}
		let (index, _) = best?;
		let entry = entries.remove(index)?;
		let results = entry.results.clone();
		entries.push_back(entry);
		Some(results)
	}

	/// Inserts one bounded result set.
	pub fn insert(
		&self,
		query: &str,
		embedding: Option<&[f32]>,
		stamps: Vec<BankStamp>,
		bounds: RecallBounds,
		results: Vec<RecallResult>,
	) {
		let bytes = results
			.iter()
			.map(|result| result.memory.content.len())
			.sum::<usize>();
		if bytes > MAX_CACHED_RESULT_BYTES {
			return;
		}
		let query = normalize_query(query);
		let entry = CacheEntry {
			tokens: token_set(query.as_str()),
			query,
			embedding: embedding.and_then(normalize_embedding),
			stamps,
			bounds,
			results,
		};
		let mut entries = self.entries.lock();
		entries.retain(|existing| existing.query != entry.query || existing.bounds != entry.bounds);
		entries.push_back(entry);
		while entries.len() > self.capacity {
			entries.pop_front();
		}
	}

	/// Atomically invalidates every exact and similar tier.
	pub fn clear(&self) {
		self.entries.lock().clear();
	}
}

fn normalize_query(query: &str) -> Str {
	Str::new(
		query
			.split_whitespace()
			.collect::<Vec<_>>()
			.join(" ")
			.to_lowercase(),
	)
}

fn token_set(query: &str) -> HashSet<Str> {
	query
		.split(|character: char| !character.is_alphanumeric() && character != '_')
		.filter(|term| term.chars().count() >= 2)
		.map(|term| Str::new(term.to_lowercase()))
		.collect()
}

fn normalize_embedding(vector: &[f32]) -> Option<Vec<f32>> {
	if vector.is_empty() || vector.iter().any(|value| !value.is_finite()) {
		return None;
	}
	let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
	if norm == 0.0 {
		return None;
	}
	Some(vector.iter().map(|value| value / norm).collect())
}

fn cosine(left: &[f32], right: &[f32]) -> f32 {
	left
		.iter()
		.zip(right)
		.map(|(left, right)| left * right)
		.sum()
}

fn jaccard(left: &HashSet<Str>, right: &HashSet<Str>) -> f32 {
	if left.is_empty() || right.is_empty() {
		return 0.0;
	}
	let intersection = left.intersection(right).count();
	let union = left.len() + right.len() - intersection;
	intersection as f32 / union as f32
}
