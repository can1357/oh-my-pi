//! Personal word n-gram engine: the cheap, instantly available engine that
//! serves `auto` until `SmolLM` has loaded (or when it cannot load).
//!
//! A port of the text-prediction research winner (tracks `ngram` ×
//! `adaptive`): an interpolated absolute-discounting word
//! trigram model over the user's prose history, backed by an embedded Norvig
//! web unigram/bigram prior (`web.rs`), ranked under the typed prefix with a
//! finished-word-aware posterior, typed-past exclusion, a prompt-local cache,
//! a session cache, and vocabulary hygiene.
//!
//! # Model
//! - **Counts** (`model.rs`): prose words only (the editor's gates,
//!   [`crate::prose`]), with their previous one or two prose words as context.
//!   Prompts that look typed count 1, pastes and logs count
//!   [`Params::paste_weight`].
//! - **Ranking** (`query.rs`): word ids are lexicographic ranks, so a prefix is
//!   one id range; a Fenwick tree gives its unigram mass, a max segment tree
//!   its unigram top-k, id-sorted follower lists and the web CSR its bigram
//!   evidence, and an open-addressing table the trigram counts.
//! - **Confidence**: posterior of the best word among *every* word under the
//!   prefix, including the prefix itself (`the|re` shows only when *there*
//!   clearly beats stopping at *the*), mixed with the prompt-local and session
//!   caches, renormalized without the words typed past at shorter prefixes.
//! - **Hygiene**: words outside the web vocabulary and the dictionary need
//!   [`Params::min_count`] typed occurrences; rare misspellings fold into an
//!   edit-distance-1 real word at learn time (not across apostrophes, not at
//!   the first or last letter); habitual slips of a word the user also types
//!   are never offered; pastes never make a word suggestible.
//!
//! # Operating points
//! Prefixes may be a single letter (`figure o|ut`); the rest of the word is
//! ranked with the same model, where left context does most of the work.
//! The show thresholds are the tuned *balanced* points (≤ 70 wrong ghosts per
//! 100 words on the research harness, `dev` split):
//! - τ1 = 0.30 ([`Params::show_threshold_k1`]) at a single letter;
//! - τ = 0.27 ([`Params::show_threshold_k2_after_k1`]) for 2+ letters when
//!   the client asks from the first letter, since single-letter ghosts spend
//!   part of the budget;
//! - τ = 0.17 ([`Params::show_threshold`]) for 2+ letters when the client's
//!   gate starts at two letters.
//!
//! The engine infers the client's gate from the shortest prefix it was asked
//! about for the current word. Typed-past exclusion replays the prefixes
//! from that length on, each at its own threshold, so a word shown at one
//! letter and typed past is ruled out at two. A dev check found no gain from
//! requiring bigram/trigram evidence at one letter. Typed-past exclusion
//! always assumes these thresholds, and τ1 also floors
//! [`crate::Config::show_threshold`]; otherwise the override changes gating
//! only.
//!
//! # Parity (research harness, `test` split, 5,038 prompts)
//! A simulated typist replays held-out history.db prompts through N-API and
//! accepts the first exactly right ghost with Tab; KSR % (net keystrokes
//! saved) at the quiet / balanced / parity budgets (≤ 30 / 70 / 140 wrong
//! ghosts per 100 words).
//!
//! Two-letter gate (ceiling 30.74 %):
//!
//! | mode   | rust-ngram            | ngram@tp30            | adaptive@default      |
//! |--------|-----------------------|-----------------------|-----------------------|
//! | static | 13.88 / 20.35 / 20.76 | 13.47 / 20.05 / 20.47 | 12.96 / 19.81 / 20.40 |
//! | online | 14.93 / 21.07 / 21.37 | 14.47 / 20.76 / 21.07 | 13.90 / 20.55 / 21.01 |
//! | cold   | 13.00 / 19.40 / 19.96 | 12.52 / 18.93 / 19.49 | 12.33 / 19.04 / 19.74 |
//!
//! Single-letter gate (ceiling 44.35 %). "Two letters only" is this engine
//! never showing single-letter ghosts on the same queries. The product point
//! gates at (τ1, τ) = (0.30, 0.27):
//!
//! | mode   | rust-ngram            | two letters only      | product point   |
//! |--------|-----------------------|-----------------------|-----------------|
//! | static | 13.35 / 23.36 / 24.30 | 14.14 / 20.44 / 20.76 | 23.30 @ 67.5 w  |
//! | online | 14.62 / 24.45 / 25.30 | 15.45 / 21.18 / 21.37 | 24.34 @ 67.1 w  |
//! | cold   | 12.87 / 22.15 / 23.39 | 13.27 / 19.52 / 19.96 | 22.17 @ 69.6 w  |
//!
//! At the quiet budget single letters cost 0.4–0.9 KSR: the thresholds
//! target the balanced budget, and typed-past exclusion assumes them.
//!
//! Engine-side costs (replay bench over the same prompts, M4 Max, 52,950
//! bootstrap rows): `complete` p50 3.6–4.0 µs, p99 14–17
//! µs with a two-letter gate; with single letters p50 4.7–5.1 µs, p99 23–39
//! µs overall and p50 5.8–7.6 µs, p99 28–59 µs at one letter;
//! `observe` p50 0.03 ms, p99 0.2–0.3 ms (a vocabulary compaction every
//! 4,096 new words takes ~20 ms); bootstrap 2.3 s; heap 52 MiB after bootstrap
//! (62 MiB peak), 38 MiB restored; snapshot 3.8 MiB, written in ~80 ms,
//! restored in ~65 ms. The embedded web prior is 2.6 MB compressed, ~9 MiB
//! decoded.
//!
//! The calibrated per-(prefix, word) feedback bias from the adaptive track
//! was measured on `dev` and not adopted: +0.03 (online) and +0.06 (cold)
//! balanced KSR, within noise, once typed-past exclusion is on.
//!
//! # Persistence
//! [`Predictor::persist`] writes a versioned zstd snapshot
//! (`snapshot.rs`) to `ngram.snapshot` in [`crate::Config::state_dir`]
//! atomically (temp file + rename); [`open`] restores it and rejects an
//! unknown version or a corrupt file so the caller can wipe the directory
//! and re-ingest history.

mod hygiene;
mod model;
mod query;
mod snapshot;
mod structures;
#[cfg(test)]
mod tests;
mod text;
mod vocab;
mod web;

use std::path::{Path, PathBuf};

use anyhow::Context;
pub use model::Params;

use crate::{Config, Predictor, Query, Suggestion};

/// Snapshot file inside the state directory.
const SNAPSHOT_FILE: &str = "ngram.snapshot";

/// The n-gram engine.
pub struct NgramPredictor {
	model:     model::Model,
	query:     query::QueryState,
	/// Caller override of the show thresholds (see [`Config::show_threshold`]).
	gate:      Option<f32>,
	state_dir: PathBuf,
}

/// Open the n-gram engine with the tuned [`Params`], restoring persisted
/// state from `config.state_dir`.
///
/// # Errors
/// Returns an error when the snapshot exists but cannot be read, has an
/// unknown version, or is corrupt.
pub fn open(config: &Config) -> anyhow::Result<Box<dyn Predictor>> {
	Ok(Box::new(NgramPredictor::open(config, Params::default())?))
}

impl NgramPredictor {
	/// Open with explicit `params` (tuning and benchmarks), restoring
	/// persisted state from `config.state_dir`.
	///
	/// # Errors
	/// Returns an error when the snapshot exists but cannot be read, has an
	/// unknown version, or is corrupt.
	pub fn open(config: &Config, params: Params) -> anyhow::Result<Self> {
		let web = web::web_prior()?;
		let gate = config.show_threshold;
		let path = config.state_dir.join(SNAPSHOT_FILE);
		let model = match std::fs::read(&path) {
			Ok(bytes) => snapshot::decode(&bytes, params, web)
				.with_context(|| format!("restore {}", path.display()))?,
			Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
				model::Model::new(params, web)
			},
			Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
		};
		Ok(Self {
			model,
			query: query::QueryState::default(),
			gate,
			state_dir: config.state_dir.clone(),
		})
	}

	/// Heap bytes of the learned model and query scratch, plus the shared
	/// static web prior.
	pub fn heap_bytes(&self) -> usize {
		self.model.heap_bytes() + self.query.heap_bytes() + self.model.web.heap_bytes()
	}
}

/// Write `bytes` to `dir/name` atomically: a temp file in the same directory,
/// then a rename over the target.
fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> anyhow::Result<()> {
	std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
	let target = dir.join(name);
	let temp = dir.join(format!("{name}.{}.tmp", std::process::id()));
	let written = std::fs::write(&temp, bytes)
		.and_then(|()| std::fs::File::open(&temp)?.sync_all())
		.and_then(|()| std::fs::rename(&temp, &target));
	if let Err(error) = written {
		let _ = std::fs::remove_file(&temp);
		return Err(error).with_context(|| format!("write {}", target.display()));
	}
	Ok(())
}

impl Predictor for NgramPredictor {
	fn complete(&mut self, query: &Query<'_>) -> Option<Suggestion> {
		let (suffix, confidence, threshold) =
			self
				.query
				.complete(&self.model, query.before, query.prefix)?;
		let confidence = confidence as f32;
		// Single letters keep their floor under an override: like typed-past
		// exclusion, it is part of the engine's policy.
		let single = query.prefix.chars().nth(1).is_none();
		let gate = match self.gate {
			Some(gate) if single => gate.max(threshold),
			Some(gate) => gate,
			None => threshold,
		};
		(confidence >= gate).then_some(Suggestion { suffix, confidence })
	}

	fn observe(&mut self, prompt: &str) {
		self.model.learn(prompt);
	}

	fn feedback(&mut self, _query: &Query<'_>, _suggestion: &str, _accepted: bool) {
		// Accepted words are learned when the prompt is submitted, and in-word
		// rejections are already modeled by typed-past exclusion. A calibrated
		// per-(prefix, word) feedback bias measured no gain on top of it.
	}

	fn persist(&mut self) -> anyhow::Result<()> {
		self.model.prune_trigrams();
		let bytes = snapshot::encode(&self.model)?;
		write_atomic(&self.state_dir, SNAPSHOT_FILE, &bytes)
	}
}
