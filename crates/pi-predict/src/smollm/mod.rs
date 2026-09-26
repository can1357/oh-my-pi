//! SmolLM2-135M completion engine: a pretrained base LM used zero-shot with
//! token-healed, prefix-constrained decoding (a port of the research
//! prototype `transformer@smol135-mem-tp15`, MLX in Python).
//!
//! # Method
//! - Context: [`PREAMBLE`], the user's recent typed prompts (1500–2500 UTF-16
//!   units, fed by [`Predictor::observe`], blank-line separated), then the last
//!   ~400 units of `before` starting at a word ([`context_window`]).
//! - Token healing: `before + prefix` is tokenized and cut at the token that
//!   holds the word start, so `" dep"` stays one token; the cut-off lead
//!   (usually the space) is re-spelled by the search.
//! - [`search::complete_nbest`]: best-first, prefix-constrained search to a
//!   word boundary; confidence = P(word) / prefix-consistent mass, which
//!   includes "the prefix already is the word".
//! - Typed-past exclusion: a word offered with confidence ≥ 0.15 earlier in the
//!   same word is not offered again (the next of 3 alternatives is).
//! - KV reuse ([`session`]): the longest cached token prefix is kept, so a
//!   submitted prompt extends the head, a new word extends the context (both
//!   append-mostly by construction), and every search node is scored once per
//!   word.
//!
//! Decoders: [`metal`] (candle, macOS) and the portable [`cpu`] one, both
//! with 8-bit block weights and f32 activations, quantized at load from the
//! upstream bf16 safetensors that
//! `packages/coding-agent/src/predict/smollm-weights.ts` downloads. macOS
//! uses Metal when a GPU is available; `PI_SMOLLM_DEVICE=cpu|metal`
//! overrides the choice.
//!
//! # Parity (research harness, `test-small`, KSR % at quiet / balanced / parity)
//! A simulated typist replays 600 held-out history.db prompts through N-API;
//! compared against the MLX prototype (bf16 on the GPU):
//!
//! | mode   | this engine (Metal)   | prototype                                       |
//! |--------|-----------------------|-------------------------------------------------|
//! | online | 17.34 / 21.53 / 21.88 | 17.04 / 21.49 / 21.88 (`smol135-mem-tp15`)      |
//! | cold   | 17.35 / 21.53 / 21.87 | 17.07 / 21.48 / 21.87 (`smol135-mem-tp15`)      |
//! | static | 16.19 / 20.76 / 21.26 | 16.17 / 20.75 / 21.29 (`smol135-mem` + τ 0.15 replay) |
//!
//! # Cost (replay bench, M4 Max, test-small online)
//! - Metal: `complete` p50 10.1 ms, p90 19.9, p99 30.0 (first query after a
//!   submitted prompt: p50 21.5, p99 48.6); open 0.3 s, first query ~40 ms;
//!   +250 MiB RSS. A single-token forward is ~2.3 ms at 700 cached tokens,
//!   and a query averages ~3.9 of them (three alternatives for typed-past).
//! - CPU (`PI_SMOLLM_DEVICE=cpu`, 8 workers): p50 16 ms, p99 80 ms, +160
//!   MiB RSS; ~1.7 ms per forward at short context, ~3.6 ms at 700 tokens.
//! - Weights: 269 MB bf16 download, ~145 MB resident as 8-bit blocks.

mod config;
mod cpu;
#[cfg(target_os = "macos")]
mod metal;
mod search;
mod session;
mod tokenizer;

use std::{
	collections::{HashSet, VecDeque},
	path::{Path, PathBuf},
};

use anyhow::Context as _;
use serde::{Deserialize, Serialize};

use self::{
	config::{Decoder, LlamaConfig, SafeTensors},
	cpu::CpuLlama,
	search::{SearchParams, TokenIndex},
	session::Session,
	tokenizer::Tokenizer,
};
use crate::{
	Config, Predictor, Query, Suggestion,
	prose::{is_js_space, is_typed_like},
};

/// Head text before the memory: frames the context as a typed chat message.
const PREAMBLE: &str = include_str!("preamble.txt");
/// Context taken from `before`, in UTF-16 units.
const CONTEXT_UNITS: usize = 400;
/// How much further back [`context_window`] may start to reach an anchor.
const CONTEXT_SLACK: usize = 256;
/// One word in this many anchors context windows.
const ANCHOR_EVERY: u32 = 16;
/// Recent-prompt memory in the head after a trim, in UTF-16 units.
const MEMORY_UNITS: usize = 1500;
/// Memory size that triggers a trim back to [`MEMORY_UNITS`].
const MEMORY_MAX_UNITS: usize = 2500;
/// Typed-past exclusion threshold τ: a suggestion at or above it counts as
/// shown. Equals the tuned show threshold (the research operating point).
const TYPED_PAST: f32 = 0.15;
/// Default [`Config::show_threshold`].
const SHOW_THRESHOLD: f32 = 0.15;
/// Alternatives searched so typed-past exclusion has a fallback.
const ALTERNATIVES: usize = 3;
/// Persisted recent-prompt memory in [`Config::state_dir`].
const STATE_FILE: &str = "memory.json";
const STATE_VERSION: u32 = 1;

/// Open the `SmolLM2` engine from weights in `config.model_dir` and restore the
/// recent-prompt memory from `config.state_dir`.
///
/// # Errors
/// Fails when `model_dir` is unset, the weights or tokenizer cannot be
/// loaded, or the persisted memory is corrupt.
pub fn open(config: &Config) -> anyhow::Result<Box<dyn Predictor>> {
	let model_dir = config
		.model_dir
		.as_deref()
		.context("smollm needs Config::model_dir (the downloaded weights)")?;
	let llama = LlamaConfig::load(&model_dir.join("config.json"))?;
	let bos = llama.bos_token_id.unwrap_or(0);
	let decoder = load_decoder(model_dir, llama)?;
	Ok(Box::new(SmolLm::open(model_dir, &config.state_dir, config.show_threshold, decoder, bos)?))
}

/// Load the weights onto Metal when available (macOS), else the CPU.
fn load_decoder(model_dir: &Path, config: LlamaConfig) -> anyhow::Result<Box<dyn Decoder>> {
	let path = model_dir.join("model.safetensors");
	let mut weights = SafeTensors::open(&path)?;
	let requested = std::env::var("PI_SMOLLM_DEVICE").ok();
	#[cfg(target_os = "macos")]
	if requested.as_deref() != Some("cpu") {
		match candle_core::Device::new_metal(0) {
			Ok(device) => {
				return Ok(Box::new(metal::MetalLlama::load(config, &mut weights, &device)?));
			},
			Err(error) if requested.as_deref() == Some("metal") => return Err(error.into()),
			Err(_) => {},
		}
	}
	anyhow::ensure!(
		requested.as_deref() != Some("metal"),
		"PI_SMOLLM_DEVICE=metal needs macOS with a Metal GPU"
	);
	Ok(Box::new(CpuLlama::load(config, &mut weights)?))
}

fn utf16_len(text: &str) -> usize {
	text.chars().map(char::len_utf16).sum()
}

/// Last `units` UTF-16 units of `before`, starting after a whitespace so no
/// word is cut in half.
fn context_tail(before: &str, units: usize) -> &str {
	let mut count = 0;
	let mut start = before.len();
	for (at, c) in before.char_indices().rev() {
		count += c.len_utf16();
		if count > units {
			break;
		}
		start = at;
	}
	if start == 0 {
		return before;
	}
	let tail = &before[start..];
	match tail.char_indices().find(|&(_, c)| is_js_space(c)) {
		Some((at, c)) => &tail[at + c.len_utf8()..],
		None => tail,
	}
}

/// Whether the word starting `text` anchors context windows: 1 in
/// [`ANCHOR_EVERY`] words, by a stable hash of the word itself.
fn is_anchor(text: &str) -> bool {
	let word = text.split(is_js_space).next().unwrap_or_default();
	// FNV-1a: stable across runs and platforms.
	let hash = word
		.bytes()
		.fold(0x811c_9dc5u32, |h, b| (h ^ u32::from(b)).wrapping_mul(0x0100_0193));
	hash % ANCHOR_EVERY == 0
}

/// The context `before` a word: the last [`CONTEXT_UNITS`] UTF-16 units,
/// extended back (by at most [`CONTEXT_SLACK`]) to the nearest word start
/// whose word [`is_anchor`]. The start then only moves when a new anchor
/// scrolls past the 400-unit mark (every ~16 words), so consecutive words
/// share their context prefix and its KV cache. Without an anchor in range
/// it falls back to [`context_tail`]. A pure function of `before`.
fn context_window(before: &str) -> &str {
	let total = utf16_len(before);
	if total <= CONTEXT_UNITS {
		return before;
	}
	let (lo, hi) = (total.saturating_sub(CONTEXT_UNITS + CONTEXT_SLACK), total - CONTEXT_UNITS);
	let mut units = 0;
	let mut after_space = false;
	let mut anchor = None;
	for (at, c) in before.char_indices() {
		if units > hi {
			break;
		}
		let space = is_js_space(c);
		if units >= lo && after_space && !space && is_anchor(&before[at..]) {
			anchor = Some(at);
		}
		after_space = space;
		units += c.len_utf16();
	}
	anchor.map_or_else(|| context_tail(before, CONTEXT_UNITS), |at| &before[at..])
}

/// Token-heal `context + prefix`: the context's tokens up to the one holding
/// the word start, and the text of that token before the word (the lead the
/// search must re-spell, usually a space).
fn heal(tokenizer: &Tokenizer, context: &str, prefix: &str) -> (Vec<u32>, String) {
	let text = format!("{context}{prefix}");
	let mut encoding = tokenizer.encode(&text);
	let start = context.len();
	let cut_token = encoding
		.offsets
		.iter()
		.position(|&(_, end)| end > start)
		.unwrap_or(encoding.ids.len());
	let cut = encoding
		.offsets
		.get(cut_token)
		.map_or(start, |&(from, _)| from);
	if !text.is_char_boundary(cut) {
		// The word's first token also holds part of a character before it.
		return (tokenizer.encode(context).ids, String::new());
	}
	encoding.ids.truncate(cut_token);
	(encoding.ids, text[cut..start].to_owned())
}

/// Recent typed-like prompts in the head, oldest first. The window only
/// grows by appending, so a new prompt extends the head's KV cache instead
/// of re-scoring it, until it passes [`MEMORY_MAX_UNITS`]; then the oldest
/// prompts drop until it fits [`MEMORY_UNITS`] again.
#[derive(Default)]
struct Memory {
	recent: VecDeque<String>,
	/// UTF-16 units of [`Memory::text`].
	units:  usize,
	/// The head no longer matches `recent`.
	dirty:  bool,
}

impl Memory {
	fn remember(&mut self, prompt: &str) {
		if !is_typed_like(prompt) {
			return;
		}
		self.units += utf16_len(prompt) + 2;
		self.recent.push_back(prompt.to_owned());
		if self.units > MEMORY_MAX_UNITS {
			while self.units > MEMORY_UNITS && self.recent.len() > 1 {
				if let Some(old) = self.recent.pop_front() {
					self.units -= utf16_len(&old) + 2;
				}
			}
		}
		self.dirty = true;
	}

	/// The window, each prompt followed by a blank line.
	fn text(&self) -> String {
		let mut text = String::with_capacity(self.units * 2);
		for prompt in &self.recent {
			text.push_str(prompt);
			text.push_str("\n\n");
		}
		text
	}
}

#[derive(Serialize, Deserialize)]
struct State {
	version: u32,
	/// Recent typed prompts, oldest first.
	recent:  Vec<String>,
}

/// Words offered (confidence ≥ τ) while the current word is typed.
#[derive(Default)]
struct Shown {
	before:       String,
	prefix_units: usize,
	words:        HashSet<String>,
}

impl Shown {
	/// A new word starts when `before` changes or the prefix stops growing.
	fn track(&mut self, before: &str, prefix: &str) {
		let units = utf16_len(prefix);
		if before != self.before || units <= self.prefix_units {
			self.words.clear();
			if before != self.before {
				before.clone_into(&mut self.before);
			}
		}
		self.prefix_units = units;
	}

	fn key(prefix: &str, suffix: &str) -> String {
		format!("{prefix}{suffix}").to_lowercase()
	}
}

/// The word being completed: its context text and healed lead.
struct Word {
	context: String,
	lead:    String,
}

struct SmolLm {
	tokenizer:      Tokenizer,
	index:          TokenIndex,
	session:        Session,
	bos:            u32,
	memory:         Memory,
	shown:          Shown,
	word:           Option<Word>,
	show_threshold: f32,
	state_dir:      PathBuf,
}

impl SmolLm {
	fn open(
		model_dir: &Path,
		state_dir: &Path,
		show_threshold: Option<f32>,
		decoder: Box<dyn Decoder>,
		bos: u32,
	) -> anyhow::Result<Self> {
		let tokenizer = Tokenizer::load(&model_dir.join("tokenizer.json"))?;
		let vocab = decoder.vocab_size();
		let texts = (0..vocab as u32)
			.map(|id| tokenizer.token_text(id).map(Box::from))
			.collect();
		let mut memory = Memory::default();
		match std::fs::read(state_dir.join(STATE_FILE)) {
			Ok(bytes) => {
				let state: State =
					serde_json::from_slice(&bytes).context("parse smollm memory.json")?;
				anyhow::ensure!(
					state.version == STATE_VERSION,
					"unknown smollm state version {}",
					state.version
				);
				for prompt in state.recent {
					memory.remember(&prompt);
				}
			},
			Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
			Err(error) => return Err(error).context("read smollm memory.json"),
		}
		memory.dirty = true;
		Ok(Self {
			tokenizer,
			index: TokenIndex::new(texts),
			session: Session::new(decoder),
			bos,
			memory,
			shown: Shown::default(),
			word: None,
			show_threshold: show_threshold.unwrap_or(SHOW_THRESHOLD),
			state_dir: state_dir.to_owned(),
		})
	}

	fn try_complete(&mut self, query: &Query<'_>) -> anyhow::Result<Option<Suggestion>> {
		let prefix = query.prefix;
		if prefix.is_empty() {
			return Ok(None);
		}
		self.shown.track(query.before, prefix);
		if std::mem::take(&mut self.memory.dirty) {
			let mut head = vec![self.bos];
			head.extend(
				self
					.tokenizer
					.encode(&format!("{PREAMBLE}{}", self.memory.text()))
					.ids,
			);
			self.session.set_head(head);
			self.word = None;
		}
		let context = context_window(query.before);
		if self
			.word
			.as_ref()
			.is_none_or(|word| word.context != context)
		{
			let (ids, lead) = heal(&self.tokenizer, context, prefix);
			self.session.set_context(&ids)?;
			self.word = Some(Word { context: context.to_owned(), lead });
		}
		let lead = self.word.as_ref().map_or("", |word| word.lead.as_str());
		let target = format!("{lead}{prefix}");
		let alternatives = search::complete_nbest(
			&self.index,
			SearchParams::default(),
			&target,
			ALTERNATIVES,
			&mut self.session,
		)?;
		let Some((suffix, confidence)) = alternatives
			.into_iter()
			.find(|(suffix, _)| !self.shown.words.contains(&Shown::key(prefix, suffix)))
		else {
			return Ok(None);
		};
		if confidence >= TYPED_PAST {
			self.shown.words.insert(Shown::key(prefix, &suffix));
		}
		Ok((confidence >= self.show_threshold).then_some(Suggestion { suffix, confidence }))
	}
}

impl Predictor for SmolLm {
	fn complete(&mut self, query: &Query<'_>) -> Option<Suggestion> {
		if let Ok(suggestion) = self.try_complete(query) { suggestion } else {
  				// A failed forward leaves no usable cache; start clean next time.
  				self.session.reset();
  				self.memory.dirty = true;
  				self.word = None;
  				None
  			}
	}

	fn observe(&mut self, prompt: &str) {
		self.memory.remember(prompt);
	}

	/// The pretrained LM learns only through the recent-prompt memory, and
	/// typed-past exclusion already follows what was shown; accept/reject
	/// feedback added nothing in the research runs.
	fn feedback(&mut self, _query: &Query<'_>, _suggestion: &str, _accepted: bool) {}

	fn persist(&mut self) -> anyhow::Result<()> {
		std::fs::create_dir_all(&self.state_dir)
			.with_context(|| format!("create {}", self.state_dir.display()))?;
		let state =
			State { version: STATE_VERSION, recent: self.memory.recent.iter().cloned().collect() };
		let path = self.state_dir.join(STATE_FILE);
		let partial = path.with_extension("json.tmp");
		std::fs::write(&partial, serde_json::to_vec(&state)?)
			.with_context(|| format!("write {}", partial.display()))?;
		std::fs::rename(&partial, &path).with_context(|| format!("replace {}", path.display()))?;
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn context_tail_cuts_forward_to_a_whitespace() {
		assert_eq!(context_tail("short text", 400), "short text");
		assert_eq!(context_tail("abc defgh ijk", 8), "ijk", "the partial word 'efgh' is dropped");
		assert_eq!(context_tail("abcdefghijk", 4), "hijk", "no whitespace: keep the raw tail");
	}

	#[test]
	fn context_window_start_is_stable_while_typing() {
		let words: Vec<String> = (0..400)
			.map(|i| format!("word{}x", i * 7919 % 1000))
			.collect();
		let mut text = String::new();
		let (mut starts, mut changes, mut last) = (0, 0, None);
		for word in &words {
			text.push_str(word);
			text.push(' ');
			let window = context_window(&text);
			let start = text.len() - window.len();
			let units = utf16_len(window);
			if utf16_len(&text) > CONTEXT_UNITS + CONTEXT_SLACK {
				starts += 1;
				// The fallback may drop one partial word below 400 units.
				assert!(
					(CONTEXT_UNITS - 16..=CONTEXT_UNITS + CONTEXT_SLACK).contains(&units),
					"{units}"
				);
				assert!(start == 0 || text.as_bytes()[start - 1] == b' ', "starts at a word");
				changes += usize::from(last.is_some_and(|l| l != start));
			}
			last = Some(start);
		}
		assert!(
			changes * 4 < starts,
			"{changes} start moves over {starts} words: the KV prefix is reused"
		);
	}

	#[test]
	fn memory_grows_by_appending_and_trims_to_the_newest() {
		let mut memory = Memory::default();
		memory.remember("/model set something");
		assert!(!memory.dirty, "slash commands are not typed prose");
		let prompt = |i: usize| format!("please refactor the parser module number {i} carefully");
		let mut trims = 0;
		let mut text = String::new();
		for i in 0..200 {
			memory.remember(&prompt(i));
			let next = memory.text();
			assert!(next.ends_with(&format!("{}\n\n", prompt(i))), "newest last");
			assert!(utf16_len(&next) <= MEMORY_MAX_UNITS);
			assert_eq!(utf16_len(&next), memory.units);
			if next.starts_with(&text) {
				// Append: the cached head stays a prefix of the new one.
			} else {
				trims += 1;
				assert!(utf16_len(&next) <= MEMORY_UNITS, "a trim goes back to the target size");
			}
			text = next;
		}
		assert!((1..20).contains(&trims), "{trims} trims over 200 prompts");
		let mut restored = Memory::default();
		for kept in &memory.recent {
			restored.remember(kept);
		}
		assert_eq!(restored.text(), text, "replaying the persisted window restores it exactly");
	}

	#[test]
	fn typed_past_resets_on_a_new_word() {
		let mut shown = Shown::default();
		shown.track("fix the ", "pa");
		shown.words.insert(Shown::key("pa", "rser"));
		shown.track("fix the ", "par");
		assert!(shown.words.contains("parser"), "same word, longer prefix keeps exclusions");
		shown.track("fix the ", "pa");
		assert!(shown.words.is_empty(), "a shorter prefix is a new word (backspace or retype)");
		shown.words.insert(Shown::key("pa", "rser"));
		shown.track("fix the parser ", "pa");
		assert!(shown.words.is_empty(), "new before");
	}

	fn tiny_tokenizer() -> Tokenizer {
		tokenizer::tests::tiny()
	}

	#[test]
	fn healing_cuts_at_the_token_holding_the_word_start() {
		let tokenizer = tiny_tokenizer();
		// " dep" is one token, so the context ends before the space and the
		// search re-spells " dep".
		let (ids, lead) = heal(&tokenizer, "a ", "dep");
		assert_eq!(lead, " ");
		assert_eq!(ids, tokenizer.encode("a").ids);
		// After a newline the word starts its own token: nothing to re-spell.
		let (ids, lead) = heal(&tokenizer, "a\n", "dep");
		assert_eq!(lead, "");
		assert_eq!(ids, tokenizer.encode("a\n").ids);
	}
}
