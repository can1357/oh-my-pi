//! In-house word-completion engines for the prompt composer.
//!
//! Every engine answers "what is the rest of the word being typed?" for one
//! [`Query`] and learns from submitted prompts. Engines are napi-free;
//! `pi_natives::predict` runs each one on a dedicated thread behind the
//! `TextPredictor` N-API class, which the machine-global text-prediction
//! daemon serves to every omp process.
//!
//! # Architecture
//! ```text
//! editor (TUI) ──JSONL/unix socket──► text-prediction daemon (Bun worker)
//!                                        └─ TextPredictor (N-API, pi_natives::predict)
//!                                             └─ Box<dyn Predictor> on an engine thread
//!                                                  ├─ ngram::open   (`auto` until SmolLM loads)
//!                                                  ├─ smollm::open  (SmolLM2-135M, `auto`)
//!                                                  └─ apple::open   (NSSpellChecker, macOS only)
//! ```
//!
//! # Example
//! ```ignore
//! let mut engine = pi_predict::open(Method::Ngram, &config)?;
//! engine.observe("can you refactor the parser");
//! let hint = engine.complete(&Query { before: "can you ", prefix: "re" });
//! ```

use std::{path::PathBuf, str::FromStr};

pub mod apple;
pub mod ngram;
pub mod prose;
pub mod smollm;

/// Editor state when ghost text is requested.
#[derive(Clone, Copy, Debug)]
pub struct Query<'a> {
	/// Prompt text before the word being typed (may span lines and contain
	/// code). The client may truncate it to a recent tail.
	pub before: &'a str,
	/// Letters of the current prose word typed so far (`[\p{L}\p{M}']+`),
	/// at least 2 characters; may already be a finished word.
	pub prefix: &'a str,
}

/// Ghost text to paint after [`Query::prefix`].
#[derive(Clone, Debug, PartialEq)]
pub struct Suggestion {
	/// Non-empty characters appended after the prefix.
	pub suffix:     String,
	/// Engine-calibrated probability that `suffix` is exactly right.
	pub confidence: f32,
}

/// Construction options shared by every engine.
#[derive(Clone, Debug, Default)]
pub struct Config {
	/// Private directory the engine persists learned state into.
	pub state_dir:      PathBuf,
	/// Directory holding downloaded model weights (`SmolLM2` only).
	pub model_dir:      Option<PathBuf>,
	/// Minimum confidence [`Predictor::complete`] returns; `None` = the
	/// engine's tuned default. Evaluation passes `f32::NEG_INFINITY` to trace
	/// the full curve. Internal policies that model what the user was shown
	/// (typed-past exclusion) keep using the tuned default, so this override
	/// changes gating only.
	pub show_threshold: Option<f32>,
}

/// A word-completion engine. Called from one engine thread only.
pub trait Predictor: Send {
	/// Best completion for `query`, already gated by the show threshold, or
	/// `None` to show nothing. Must not change learned state; `&mut` exists
	/// only for inference caches (e.g. a KV cache keyed by `before`).
	fn complete(&mut self, query: &Query<'_>) -> Option<Suggestion>;
	/// Learn from one submitted prompt (bootstrap history rows and live
	/// submissions go through this same path). Engines own their filtering of
	/// code, pastes, and misspellings.
	fn observe(&mut self, prompt: &str);
	/// Learn from a suggestion the user accepted (Tab) or typed past.
	fn feedback(&mut self, query: &Query<'_>, suggestion: &str, accepted: bool);
	/// Flush learned state to [`Config::state_dir`].
	///
	/// # Errors
	/// Returns an error when the state directory cannot be written.
	fn persist(&mut self) -> anyhow::Result<()>;
}

/// Engines implemented in this crate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
	/// Personal word n-gram + web prior; serves `auto` until `SmolLM` has loaded.
	Ngram,
	/// SmolLM2-135M base model with token-healed, prefix-constrained decoding.
	SmolLm,
	/// macOS `NSSpellChecker` dictionary completion (errors elsewhere).
	Apple,
}

impl Method {
	/// Parse a wire name (`ngram`, `smollm`, `apple`), as used by settings,
	/// the daemon protocol, and `TextPredictor`.
	///
	/// # Errors
	/// Returns an error for any other name.
	pub fn parse(name: &str) -> anyhow::Result<Self> {
		match name {
			"ngram" => Ok(Self::Ngram),
			"smollm" => Ok(Self::SmolLm),
			"apple" => Ok(Self::Apple),
			other => anyhow::bail!("unknown text prediction method {other:?}"),
		}
	}
}

impl FromStr for Method {
	type Err = anyhow::Error;

	fn from_str(name: &str) -> anyhow::Result<Self> {
		Self::parse(name)
	}
}

/// Open (or restore from [`Config::state_dir`]) the engine for `method`.
///
/// # Errors
/// Returns an error when persisted state or model weights cannot be loaded.
pub fn open(method: Method, config: &Config) -> anyhow::Result<Box<dyn Predictor>> {
	match method {
		Method::Ngram => ngram::open(config),
		Method::SmolLm => smollm::open(config),
		Method::Apple => apple::open(config),
	}
}
