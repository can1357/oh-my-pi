//! Deterministic Public Web result aggregation.

use std::{collections::HashMap, time::Duration};

use omp_core::Str;
use url::Url;

use super::search::SearchDocument;

/// Soft deadline: enough time for fast engines.
pub const SOFT_DEADLINE: Duration = Duration::from_secs(5);
/// Hard deadline for bounded partial success.
pub const HARD_DEADLINE: Duration = Duration::from_secs(30);

/// One engine's completed contribution.
#[derive(Clone, Debug, PartialEq)]
pub struct EngineResults {
	/// Stable engine identifier.
	pub engine:    Str,
	/// Results in engine rank order.
	pub documents: Vec<SearchDocument>,
}

/// A URL with cross-engine consensus evidence.
#[derive(Clone, Debug, PartialEq)]
pub struct ConsensusResult {
	/// Representative document from its best-ranked engine.
	pub document:        SearchDocument,
	/// Number of distinct engines returning the normalized URL.
	pub engine_count:    u32,
	/// Sum of reciprocal ranks used as the stable score.
	pub consensus_score: f32,
}

/// Merges completed engine pages, normalizing tracking noise and retaining the
/// best representative. Sorting prefers agreement, then reciprocal-rank score,
/// then normalized URL for deterministic ties.
pub fn aggregate_public_web(pages: &[EngineResults], limit: usize) -> Vec<ConsensusResult> {
	let mut by_url: HashMap<String, ConsensusResult> = HashMap::new();
	for page in pages {
		for (index, document) in page.documents.iter().enumerate() {
			let Some(key) = normalized_url(document.url.as_str()) else {
				continue;
			};
			let reciprocal = 1.0 / (index.saturating_add(1) as f32);
			by_url
				.entry(key)
				.and_modify(|result| {
					result.engine_count = result.engine_count.saturating_add(1);
					result.consensus_score += reciprocal;
					if document.score.unwrap_or(f32::NEG_INFINITY)
						> result.document.score.unwrap_or(f32::NEG_INFINITY)
					{
						result.document = document.clone();
					}
				})
				.or_insert_with(|| ConsensusResult {
					document:        document.clone(),
					engine_count:    1,
					consensus_score: reciprocal,
				});
		}
	}
	let mut results: Vec<_> = by_url.into_values().collect();
	results.sort_by(|left, right| {
		right
			.engine_count
			.cmp(&left.engine_count)
			.then_with(|| right.consensus_score.total_cmp(&left.consensus_score))
			.then_with(|| left.document.url.cmp(&right.document.url))
	});
	results.truncate(limit);
	results
}

fn normalized_url(raw: &str) -> Option<String> {
	let mut url = Url::parse(raw).ok()?;
	url.set_fragment(None);
	let retained: Vec<(String, String)> = url
		.query_pairs()
		.filter(|(key, _)| {
			!matches!(key.as_ref(), "fbclid" | "gclid" | "mc_cid" | "mc_eid")
				&& !key.starts_with("utm_")
		})
		.map(|(key, value)| (key.into_owned(), value.into_owned()))
		.collect();
	url.set_query(None);
	if !retained.is_empty() {
		url.query_pairs_mut().extend_pairs(retained);
	}
	if url.path() != "/" {
		let path = url.path().trim_end_matches('/').to_owned();
		url.set_path(&path);
	}
	Some(url.to_string())
}
