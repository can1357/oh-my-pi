//! Four-voice recall, reciprocal-rank fusion, deduplication, and scoped
//! fallback.

use std::collections::{HashMap, HashSet, hash_map::Entry};

use omp_core::Str;
use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, IntoStaticStr};

use crate::{
	Result,
	bank::BankId,
	store::{BankStore, MemoryRecord, RankedCandidate},
};

const RRF_K: f64 = 60.0;

/// One independent recall voice.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "lowercase")]
#[strum(ascii_case_insensitive, serialize_all = "lowercase")]
pub enum RecallVoice {
	/// Dense semantic similarity.
	Vector,
	/// Entity/triple and associative-link traversal.
	Graph,
	/// Consolidated episodic lexical/importance recall.
	Episodic,
	/// Recent working-memory lexical recall.
	Working,
}

impl RecallVoice {
	const fn weight(self) -> f64 {
		match self {
			Self::Vector => 0.35,
			Self::Graph => 0.25,
			Self::Episodic => 0.25,
			Self::Working => 0.15,
		}
	}
}

/// Per-voice fused contributions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct VoiceScores {
	/// Vector contribution.
	pub vector:   f64,
	/// Graph contribution.
	pub graph:    f64,
	/// Episodic contribution.
	pub episodic: f64,
	/// Working-memory contribution.
	pub working:  f64,
}

impl VoiceScores {
	fn add(&mut self, voice: RecallVoice, contribution: f64) {
		match voice {
			RecallVoice::Vector => self.vector += contribution,
			RecallVoice::Graph => self.graph += contribution,
			RecallVoice::Episodic => self.episodic += contribution,
			RecallVoice::Working => self.working += contribution,
		}
	}

	fn merge(&mut self, other: Self) {
		self.vector += other.vector;
		self.graph += other.graph;
		self.episodic += other.episodic;
		self.working += other.working;
	}
}

/// One deterministic fused recall result.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecallResult {
	/// Full memory record.
	pub memory:       MemoryRecord,
	/// RRF plus bounded native-score merge.
	pub score:        f64,
	/// Individual voice contributions.
	pub voice_scores: VoiceScores,
	/// Whether this result came from the shared-bank broadening pass.
	pub broadened:    bool,
}

/// Strict search bounds.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RecallBounds {
	/// Maximum returned rows.
	pub limit:        usize,
	/// Approximate token ceiling across returned content.
	pub token_budget: usize,
	/// Maximum candidates accepted per voice before fusion.
	pub voice_limit:  usize,
}

impl Default for RecallBounds {
	fn default() -> Self {
		Self { limit: 8, token_budget: 5000, voice_limit: 32 }
	}
}

impl RecallBounds {
	pub(crate) fn normalized(self) -> Self {
		Self {
			limit:        self.limit.clamp(1, 50),
			token_budget: self.token_budget.clamp(1, 32 * 1024),
			voice_limit:  self.voice_limit.clamp(1, 100),
		}
	}
}

/// Stateless recall engine over ordered scoped banks.
pub struct RecallEngine<'a> {
	stores:       &'a [BankStore],
	project_bank: &'a BankId,
	shared_bank:  Option<&'a BankId>,
}

impl<'a> RecallEngine<'a> {
	/// Creates recall over project-first scoped stores.
	pub const fn new(
		stores: &'a [BankStore],
		project_bank: &'a BankId,
		shared_bank: Option<&'a BankId>,
	) -> Self {
		Self { stores, project_bank, shared_bank }
	}

	/// Recalls through vector, graph, episodic, and working-memory voices.
	pub fn recall(
		&self,
		query: &str,
		query_embedding: Option<&[f32]>,
		bounds: RecallBounds,
	) -> Result<Vec<RecallResult>> {
		let bounds = bounds.normalized();
		let terms = query_terms(query);
		let broadened = self
			.shared_bank
			.and_then(|shared| derive_shared_fallback(query, self.project_bank, shared));
		let mut voices = HashMap::<RecallVoice, Vec<VoiceCandidate>>::new();
		for store in self.stores {
			let shared = self.shared_bank.is_some_and(|bank| bank == store.bank());
			self.collect_store(
				store,
				query,
				&terms,
				query_embedding,
				bounds.voice_limit,
				false,
				&mut voices,
			)?;
			if shared && let Some(fallback) = broadened.as_deref() {
				let fallback_terms = query_terms(fallback);
				self.collect_store(
					store,
					fallback,
					&fallback_terms,
					query_embedding,
					bounds.voice_limit,
					true,
					&mut voices,
				)?;
			}
		}
		Ok(fuse(voices, bounds))
	}

	fn collect_store(
		&self,
		store: &BankStore,
		query: &str,
		terms: &[Str],
		query_embedding: Option<&[f32]>,
		limit: usize,
		broadened: bool,
		voices: &mut HashMap<RecallVoice, Vec<VoiceCandidate>>,
	) -> Result<()> {
		if let Some(query_vector) = query_embedding.and_then(normalize) {
			let vector = vector_candidates(store, &query_vector, limit)?;
			voices.entry(RecallVoice::Vector).or_default().extend(
				vector
					.into_iter()
					.map(|candidate| VoiceCandidate::new(candidate, broadened)),
			);
		}
		let graph = voices.entry(RecallVoice::Graph).or_default();
		graph.extend(
			store
				.search_facts(query, limit)?
				.into_iter()
				.map(|candidate| VoiceCandidate::new(candidate, broadened)),
		);
		graph.extend(
			store
				.graph_candidates(terms, limit)?
				.into_iter()
				.map(|candidate| VoiceCandidate::new(candidate, broadened)),
		);
		voices.entry(RecallVoice::Episodic).or_default().extend(
			store
				.search_episodic(query, limit)?
				.into_iter()
				.map(|candidate| VoiceCandidate::new(candidate, broadened)),
		);
		voices.entry(RecallVoice::Working).or_default().extend(
			store
				.search_working(query, limit)?
				.into_iter()
				.map(|candidate| VoiceCandidate::new(candidate, broadened)),
		);
		if looks_temporal(query) {
			voices.entry(RecallVoice::Working).or_default().extend(
				store
					.recent_working(limit)?
					.into_iter()
					.map(|candidate| VoiceCandidate::new(candidate, broadened)),
			);
		}
		Ok(())
	}
}

struct VoiceCandidate {
	record:    MemoryRecord,
	native:    f64,
	broadened: bool,
}

impl VoiceCandidate {
	fn new(candidate: RankedCandidate, broadened: bool) -> Self {
		Self { record: candidate.record, native: candidate.score.clamp(0.0, 1.0), broadened }
	}
}

fn vector_candidates(
	store: &BankStore,
	query: &[f32],
	limit: usize,
) -> Result<Vec<RankedCandidate>> {
	let mut output = Vec::new();
	for stored in store.vectors()? {
		if stored.vector.len() != query.len() {
			continue;
		}
		let cosine = stored
			.vector
			.iter()
			.zip(query)
			.map(|(left, right)| f64::from(*left) * f64::from(*right))
			.sum::<f64>();
		if let Some(record) = store.get(stored.memory_id.as_str())? {
			output.push(RankedCandidate { record, score: f64::midpoint(cosine, 1.0).clamp(0.0, 1.0) });
		}
	}
	output.sort_by(|left, right| {
		right
			.score
			.total_cmp(&left.score)
			.then_with(|| left.record.id.cmp(&right.record.id))
	});
	output.truncate(limit);
	Ok(output)
}

fn fuse(
	mut voices: HashMap<RecallVoice, Vec<VoiceCandidate>>,
	bounds: RecallBounds,
) -> Vec<RecallResult> {
	let mut fused = HashMap::<Str, RecallResult>::new();
	for voice in
		[RecallVoice::Vector, RecallVoice::Graph, RecallVoice::Episodic, RecallVoice::Working]
	{
		let Some(candidates) = voices.get_mut(&voice) else {
			continue;
		};
		candidates.sort_by(|left, right| {
			right
				.native
				.total_cmp(&left.native)
				.then_with(|| left.record.id.cmp(&right.record.id))
		});
		let mut seen = HashSet::<Str>::new();
		for (rank, candidate) in candidates
			.iter()
			.filter(|candidate| seen.insert(candidate.record.id.clone()))
			.enumerate()
		{
			let contribution = f64::mul_add(
				(voice.weight() * candidate.native),
				0.01,
				voice.weight() / (RRF_K + (rank + 1) as f64),
			);
			let result = fused
				.entry(candidate.record.id.clone())
				.or_insert_with(|| RecallResult {
					memory:       candidate.record.clone(),
					score:        0.0,
					voice_scores: VoiceScores::default(),
					broadened:    candidate.broadened,
				});
			result.score += contribution;
			result.voice_scores.add(voice, contribution);
			result.broadened &= candidate.broadened;
			if prefer_record(&candidate.record, &result.memory) {
				result.memory = candidate.record.clone();
			}
		}
	}

	let mut by_content = HashMap::<Str, RecallResult>::new();
	for result in fused.into_values() {
		let key = normalized_content(result.memory.content.as_str());
		match by_content.entry(key) {
			Entry::Vacant(entry) => {
				entry.insert(result);
			},
			Entry::Occupied(mut entry) => {
				let current = entry.get_mut();
				current.score += result.score;
				current.voice_scores.merge(result.voice_scores);
				current.broadened &= result.broadened;
				if prefer(&result, current) {
					current.memory = result.memory;
				}
			},
		}
	}
	let mut results = by_content.into_values().collect::<Vec<_>>();
	results.sort_by(|left, right| {
		right
			.score
			.total_cmp(&left.score)
			.then_with(|| right.memory.timestamp.cmp(&left.memory.timestamp))
			.then_with(|| left.memory.id.cmp(&right.memory.id))
	});
	let mut selected = Vec::new();
	let mut tokens = 0usize;
	for result in results {
		if selected.len() == bounds.limit {
			break;
		}
		let estimate = result.memory.content.len().div_ceil(4).max(1);
		if tokens.saturating_add(estimate) > bounds.token_budget {
			continue;
		}
		tokens += estimate;
		selected.push(result);
	}
	selected
}

fn prefer_record(left: &MemoryRecord, right: &MemoryRecord) -> bool {
	left.importance > right.importance
		|| (left.importance == right.importance
			&& (left.timestamp > right.timestamp
				|| (left.timestamp == right.timestamp && left.bank < right.bank)))
}

fn prefer(left: &RecallResult, right: &RecallResult) -> bool {
	left.score > right.score
		|| (left.score == right.score
			&& (left.memory.timestamp > right.memory.timestamp
				|| (left.memory.timestamp == right.memory.timestamp
					&& left.memory.id < right.memory.id)))
}

fn normalize(vector: &[f32]) -> Option<Vec<f32>> {
	if vector.is_empty() || vector.iter().any(|value| !value.is_finite()) {
		return None;
	}
	let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
	if norm == 0.0 {
		return None;
	}
	Some(vector.iter().map(|value| value / norm).collect())
}

/// Removes literal project-bank terms for a second shared-bank recall pass.
pub fn derive_shared_fallback(query: &str, project: &BankId, shared: &BankId) -> Option<String> {
	if project == shared {
		return None;
	}
	let bank_terms = project
		.as_str()
		.split(|character: char| !character.is_ascii_alphanumeric())
		.filter(|term| !term.is_empty())
		.map(str::to_ascii_lowercase)
		.collect::<HashSet<_>>();
	if bank_terms.is_empty() {
		return None;
	}
	let mut kept = Vec::new();
	for token in query.split_whitespace() {
		let normalized = token
			.trim_matches(|character: char| !character.is_ascii_alphanumeric())
			.to_ascii_lowercase();
		if !normalized.is_empty() && !bank_terms.contains(&normalized) {
			kept.push(token);
		}
	}
	let broadened = kept.join(" ").trim().to_owned();
	if broadened.is_empty() || normalized_content(&broadened) == normalized_content(query) {
		None
	} else {
		Some(broadened)
	}
}

fn query_terms(query: &str) -> Vec<Str> {
	let mut terms = query
		.split(|character: char| !character.is_alphanumeric() && character != '_')
		.filter(|term| term.chars().count() >= 3)
		.map(|term| Str::new(term.to_lowercase()))
		.take(32)
		.collect::<Vec<_>>();
	terms.sort_unstable();
	terms.dedup();
	terms
}

fn normalized_content(content: &str) -> Str {
	Str::new(
		content
			.split_whitespace()
			.collect::<Vec<_>>()
			.join(" ")
			.to_lowercase(),
	)
}

fn looks_temporal(query: &str) -> bool {
	let query = query.to_ascii_lowercase();
	["yesterday", "today", "recent", "last", "latest", "this week", "this month", "ago", "before"]
		.iter()
		.any(|term| query.contains(term))
}
