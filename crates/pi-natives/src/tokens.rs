//! Token counting via the embedded utok universal tokenizer.
//!
//! Encodings:
//!
//!   - `O200kBase` — GPT-4o / o1 / GPT-5 (the modern `OpenAI` default).
//!   - `Cl100kBase` — GPT-3.5 / GPT-4 / older models.
//!   - `ClaudeV3` / `ClaudeV47` / `ClaudeV5` / `ClaudeV5Sonnet` — offline
//!     reconstructions of Anthropic's `count_tokens` (see [`crate::utok`]): v3
//!     serves Claude 3 through Opus 4.6, v4.7 serves Opus 4.7–4.9, v5 the
//!     5-series.
//!   - `Qwen3` — Qwen 3.5 / 3.6 / 3.8 (248k vocabulary, NFC input).
//!   - `DeepSeekV3` — `DeepSeek` V3 through V4 (identical base BPE).
//!   - `KimiK2` — Kimi K2 through K3.
//!   - `Glm5` — GLM-5.x exact; GLM-4.x near-exact (ID-preserving subset).
//!
//! `o200k_base` is the default. All vocabularies are zstd-embedded in the
//! binary and decoded once on first use. Counting consumes the JS string's
//! UTF-16 code units directly (no UTF-8 transcode on the napi crossing).

use napi::{
	JsString,
	bindgen_prelude::{Array, Either},
};
use napi_derive::napi;
use pi_shell::rayon_global_pool_available;
use rayon::prelude::*;

use crate::{js, utok};

/// Tokenizer encoding to use.
#[napi(string_enum)]
pub enum Encoding {
	/// GPT-4o / o1 / GPT-5 (default).
	O200kBase,
	/// GPT-3.5 / GPT-4 / older.
	Cl100kBase,
	/// Claude 3 … Opus 4.6 (ctok v3 reconstruction).
	ClaudeV3,
	/// Claude Opus 4.7–4.9 (ctok v4.7 reconstruction).
	ClaudeV47,
	/// Claude Opus 5+ (ctok v5 reconstruction).
	ClaudeV5,
	/// Claude Sonnet/Fable 5+ (live-measured non-opus v5 frame).
	ClaudeV5Sonnet,
	/// Qwen 3.5 / 3.6 / 3.8 (248k vocabulary).
	Qwen3,
	/// `DeepSeek` V3 … V4 (identical base BPE).
	DeepSeekV3,
	/// Kimi K2 … K3.
	KimiK2,
	/// GLM-5.x exact; GLM-4.x near-exact.
	Glm5,
}

impl Encoding {
	fn utok(encoding: Option<Self>) -> utok::Encoding {
		match encoding.unwrap_or(Self::O200kBase) {
			Self::O200kBase => utok::Encoding::O200kBase,
			Self::Cl100kBase => utok::Encoding::Cl100kBase,
			Self::ClaudeV3 => utok::Encoding::ClaudeV3,
			Self::ClaudeV47 => utok::Encoding::ClaudeV47,
			Self::ClaudeV5 => utok::Encoding::ClaudeV5,
			Self::ClaudeV5Sonnet => utok::Encoding::ClaudeV5Sonnet,
			Self::Qwen3 => utok::Encoding::Qwen3,
			Self::DeepSeekV3 => utok::Encoding::DeepSeekV3,
			Self::KimiK2 => utok::Encoding::KimiK2,
			Self::Glm5 => utok::Encoding::Glm5,
		}
	}
}

/// Count tokens in `input`.
///
/// `input` may be a single string or an array of strings; an array returns
/// the sum across all elements (counted in parallel when the global rayon pool
/// is available). Always returns a single token total — use this for any
/// aggregate budget question without paying a per-element napi crossing.
///
/// Measures user/model content, not wire-protocol tokens: BPE encodings
/// use ordinary encoding (no special-token handling) and the Claude
/// encodings count message content without the fixed per-message frame.
/// Defaults to `o200k_base`; pass a `Claude*` encoding for exact Claude
/// counts, or the matching family encoding for Qwen/DeepSeek/Kimi/GLM.
#[napi]
pub fn count_tokens(
	#[napi(ts_arg_type = "string | string[]")] input: Either<JsString, Array>,
	encoding: Option<Encoding>,
) -> napi::Result<u32> {
	let enc = Encoding::utok(encoding);
	match input {
		Either::A(text) => Ok(enc.count(&*js::utf16(text)?)),
		Either::B(array) => {
			// Node-API handles are thread-affine, so every element is read here on
			// the JS thread — into one buffer, so the batch costs one allocation
			// rather than one per string. Only the counting fans out.
			let mut units = Vec::new();
			let mut spans = Vec::with_capacity(array.len() as usize);
			for index in 0..array.len() {
				let text = array
					.get::<JsString>(index)?
					.ok_or_else(|| napi::Error::from_reason("array changed during token counting"))?;
				spans.push(js::utf16_append(text, &mut units)?);
			}
			// Scheduling a Rayon job costs more than tokenizing a small prompt
			// batch. Keep those batches on the N-API thread; large batches still
			// amortize the pool handoff across enough independent strings.
			const PARALLEL_BATCH_MIN: usize = 16;
			Ok(if spans.len() >= PARALLEL_BATCH_MIN && rayon_global_pool_available() {
				spans
					.par_iter()
					.map(|span| enc.count(&units[span.clone()]))
					.sum()
			} else {
				spans
					.iter()
					.map(|span| enc.count(&units[span.clone()]))
					.sum()
			})
		},
	}
}
