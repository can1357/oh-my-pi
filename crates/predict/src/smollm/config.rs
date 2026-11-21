//! Llama hyper-parameters, the weights loader, and the decoder contract
//! shared by the CPU and Metal backends.

use std::{
	fs::File,
	io::{Read, Seek},
	path::Path,
};

use anyhow::{Context, ensure};
use serde::Deserialize;

use super::gguf::{Gguf, Q8Blocks};

/// Keys and values of one cached position (every layer), as the backend
/// stores them.
pub enum KvRow {
	/// CPU: `[layer][keys | values][kv_width]`.
	Host(Box<[f32]>),
	/// Metal: per layer the key then the value, each `[1, kv_heads, 1,
	/// head_dim]`.
	#[cfg(target_os = "macos")]
	Device(Vec<candle_core::Tensor>),
}

/// A causal decoder over one trimmable KV sequence.
pub trait Decoder: Send {
	/// Row width of [`Decoder::forward`]'s output.
	fn vocab_size(&self) -> usize;
	/// Drop cached tokens beyond `len`.
	fn truncate(&mut self, len: usize);
	/// Keys and values of the last cached position.
	///
	/// # Errors
	/// Fails when the cache is empty or on device errors.
	fn last_kv(&self) -> anyhow::Result<KvRow>;
	/// Put `row` back at position `at` (at most the cached length) and cut
	/// the cache to `at + 1`: re-entering a branch without re-scoring it.
	///
	/// # Errors
	/// Fails for rows of another backend and device errors.
	fn restore(&mut self, at: usize, row: &KvRow) -> anyhow::Result<()>;
	/// Append `tokens` to the cached sequence and return the next-token
	/// log-probabilities (row-major `[tokens.len() - keep_from, vocab]`)
	/// after each of `tokens[keep_from..]`.
	///
	/// # Errors
	/// Fails when the sequence exceeds the model's position limit or the
	/// device fails; the cache is then empty.
	fn forward(&mut self, tokens: &[u32], keep_from: usize) -> anyhow::Result<Vec<f32>>;
}

/// Hyper-parameters read from `config.json`.
#[derive(Clone, Debug, Deserialize)]
pub struct LlamaConfig {
	/// Residual width.
	pub hidden_size:             usize,
	/// MLP inner width.
	pub intermediate_size:       usize,
	/// Decoder layers.
	pub num_hidden_layers:       usize,
	/// Query heads.
	pub num_attention_heads:     usize,
	/// Key/value heads (grouped-query attention).
	pub num_key_value_heads:     usize,
	/// Vocabulary size (rows of the embedding).
	pub vocab_size:              usize,
	/// `RMSNorm` epsilon.
	pub rms_norm_eps:            f64,
	/// `RoPE` base.
	#[serde(default = "default_rope_theta")]
	pub rope_theta:              f64,
	/// Longest supported sequence.
	#[serde(default = "default_max_positions")]
	pub max_position_embeddings: usize,
	/// Beginning-of-sequence token.
	#[serde(default)]
	pub bos_token_id:            Option<u32>,
	/// The LM head reuses the token embedding.
	#[serde(default)]
	pub tie_word_embeddings:     bool,
	#[serde(default)]
	model_type:                  String,
	#[serde(default)]
	rope_scaling:                Option<serde_json::Value>,
	#[serde(default)]
	rope_interleaved:            bool,
	#[serde(default)]
	attention_bias:              bool,
	#[serde(default)]
	mlp_bias:                    bool,
}

const fn default_rope_theta() -> f64 {
	10_000.0
}

const fn default_max_positions() -> usize {
	2048
}

impl LlamaConfig {
	/// Read and validate `config.json`.
	///
	/// # Errors
	/// Fails for unreadable files and architectures the decoders cannot run.
	pub fn load(path: &Path) -> anyhow::Result<Self> {
		let text = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
		let config: Self =
			serde_json::from_slice(&text).with_context(|| format!("parse {}", path.display()))?;
		ensure!(config.model_type == "llama", "unsupported model_type {:?}", config.model_type);
		config.validate()?;
		Ok(config)
	}

	/// Check the shape constraints both decoders rely on.
	///
	/// # Errors
	/// Names the first unsupported feature.
	pub fn validate(&self) -> anyhow::Result<()> {
		ensure!(
			self
				.rope_scaling
				.as_ref()
				.is_none_or(serde_json::Value::is_null)
				&& !self.rope_interleaved,
			"rope scaling / interleaved rope is unsupported"
		);
		ensure!(!self.attention_bias && !self.mlp_bias, "projection biases are unsupported");
		ensure!(self.tie_word_embeddings, "only tied LM heads are supported");
		let heads = self.num_attention_heads;
		ensure!(
			heads > 0
				&& self.num_key_value_heads > 0
				&& self.hidden_size.is_multiple_of(heads)
				&& heads.is_multiple_of(self.num_key_value_heads)
				&& (self.hidden_size / heads).is_multiple_of(2),
			"inconsistent attention shape"
		);
		ensure!(
			self.hidden_size.is_multiple_of(32) && self.intermediate_size.is_multiple_of(32),
			"widths must be multiples of the 32-value quantization block"
		);
		Ok(())
	}

	/// Width of one attention head.
	pub const fn head_dim(&self) -> usize {
		self.hidden_size / self.num_attention_heads
	}

	/// `RoPE` `(cos, sin)` tables, row-major `[max_position_embeddings, head_dim
	/// / 2]`.
	pub fn rope_tables(&self) -> (Vec<f32>, Vec<f32>) {
		let half = self.head_dim() / 2;
		let inv_freq: Vec<f64> = (0..half)
			.map(|i| {
				1.0 / self
					.rope_theta
					.powf(2.0 * i as f64 / self.head_dim() as f64)
			})
			.collect();
		let count = self.max_position_embeddings * half;
		let (mut cos, mut sin) = (Vec::with_capacity(count), Vec::with_capacity(count));
		for pos in 0..self.max_position_embeddings {
			for f in &inv_freq {
				let angle = pos as f64 * f;
				cos.push(angle.cos() as f32);
				sin.push(angle.sin() as f32);
			}
		}
		(cos, sin)
	}
}

/// A projection matrix of one decoder layer.
#[derive(Clone, Copy, Debug)]
pub enum Proj {
	Q,
	K,
	V,
	Out,
	Gate,
	Up,
	Down,
}

/// The weights of a llama.cpp GGUF export (`Q8_0` matrices, F32 norms),
/// checked against `config.json` and handed out in the Hugging Face layout
/// both decoders use.
pub struct LlamaWeights<R> {
	file:   Gguf<R>,
	config: LlamaConfig,
}

impl LlamaWeights<File> {
	/// Open the GGUF at `path` for `config`.
	///
	/// # Errors
	/// Fails for unreadable or malformed files, non-llama exports, and
	/// configs the decoders cannot run.
	pub fn open(path: &Path, config: LlamaConfig) -> anyhow::Result<Self> {
		Self::new(Gguf::open(path)?, config).with_context(|| format!("load {}", path.display()))
	}
}

impl<R: Read + Seek> LlamaWeights<R> {
	/// Wrap an indexed GGUF file.
	///
	/// # Errors
	/// Fails for exports of another architecture and configs the decoders
	/// cannot run.
	pub fn new(file: Gguf<R>, config: LlamaConfig) -> anyhow::Result<Self> {
		config.validate()?;
		// The q/k row order below is llama.cpp's llama conversion.
		ensure!(
			file.architecture() == Some("llama"),
			"GGUF architecture {:?}, expected \"llama\"",
			file.architecture()
		);
		Ok(Self { file, config })
	}

	/// Hyper-parameters the shapes are checked against.
	pub const fn config(&self) -> &LlamaConfig {
		&self.config
	}

	/// Token embedding `[vocab, hidden]`, also the tied LM head.
	///
	/// # Errors
	/// Fails for missing, mistyped, or mis-shaped tensors and I/O errors.
	pub fn embedding(&mut self) -> anyhow::Result<Q8Blocks> {
		let (rows, cols) = (self.config.vocab_size, self.config.hidden_size);
		let mut bytes = vec![0u8; rows * Q8Blocks::row_bytes(cols)];
		self
			.file
			.q8_0_into("token_embd.weight", rows, cols, &mut bytes)?;
		Ok(Q8Blocks { rows, cols, bytes })
	}

	/// Final norm gain.
	///
	/// # Errors
	/// As [`LlamaWeights::embedding`].
	pub fn output_norm(&mut self) -> anyhow::Result<Vec<f32>> {
		self.file.f32("output_norm.weight", self.config.hidden_size)
	}

	/// Pre-attention and pre-MLP norm gains of `layer`.
	///
	/// # Errors
	/// As [`LlamaWeights::embedding`].
	pub fn norms(&mut self, layer: usize) -> anyhow::Result<(Vec<f32>, Vec<f32>)> {
		let h = self.config.hidden_size;
		Ok((
			self.file.f32(&format!("blk.{layer}.attn_norm.weight"), h)?,
			self.file.f32(&format!("blk.{layer}.ffn_norm.weight"), h)?,
		))
	}

	/// Projections `parts` of `layer` stacked by rows (e.g. the fused `[q; k;
	/// v]`), with q and k rows back in the checkpoint's rotate-half order.
	///
	/// # Errors
	/// As [`LlamaWeights::embedding`].
	pub fn stacked(&mut self, layer: usize, parts: &[Proj]) -> anyhow::Result<Q8Blocks> {
		let c = &self.config;
		let (h, inter, head_dim) = (c.hidden_size, c.intermediate_size, c.head_dim());
		let kv = c.num_key_value_heads * head_dim;
		let shapes: Vec<_> = parts
			.iter()
			.map(|part| match part {
				Proj::Q => ("attn_q", h, h),
				Proj::K => ("attn_k", kv, h),
				Proj::V => ("attn_v", kv, h),
				Proj::Out => ("attn_output", h, h),
				Proj::Gate => ("ffn_gate", inter, h),
				Proj::Up => ("ffn_up", inter, h),
				Proj::Down => ("ffn_down", h, inter),
			})
			.collect();
		let cols = shapes.first().context("nothing to stack")?.2;
		ensure!(shapes.iter().all(|s| s.2 == cols), "cannot stack {parts:?}");
		let row_bytes = Q8Blocks::row_bytes(cols);
		let rows = shapes.iter().map(|s| s.1).sum();
		let mut bytes = vec![0u8; rows * row_bytes];
		let mut scratch = Vec::new();
		let mut at = 0;
		for (&part, (name, rows, _)) in parts.iter().zip(shapes) {
			let name = format!("blk.{layer}.{name}.weight");
			let permuted = matches!(part, Proj::Q | Proj::K);
			let out = &mut bytes[at..at + rows * row_bytes];
			if permuted {
				scratch.resize(out.len(), 0);
				self.file.q8_0_into(&name, rows, cols, &mut scratch)?;
				unpermute_rows(&scratch, out, row_bytes, head_dim);
			} else {
				self.file.q8_0_into(&name, rows, cols, out)?;
			}
			at += rows * row_bytes;
		}
		Ok(Q8Blocks { rows, cols, bytes })
	}
}

/// Undo llama.cpp's q/k conversion permutation (`LlamaModel.permute`, which
/// interleaves each head's rotate-half pairs for GGML's `RoPE`): row `2i + j`
/// of a file head is row `j·head_dim/2 + i` of the checkpoint head. Whole
/// rows move, so the blocks along them stay intact.
fn unpermute_rows(file: &[u8], out: &mut [u8], row_bytes: usize, head_dim: usize) {
	let half = head_dim / 2;
	let head_bytes = head_dim * row_bytes;
	for (src, dst) in file
		.chunks_exact(head_bytes)
		.zip(out.chunks_exact_mut(head_bytes))
	{
		for (r, row) in src.chunks_exact(row_bytes).enumerate() {
			let (i, j) = (r / 2, r % 2);
			let to = (j * half + i) * row_bytes;
			dst[to..to + row_bytes].copy_from_slice(row);
		}
	}
}

#[cfg(test)]
pub(super) mod tests {
	use std::io::Cursor;

	use super::{
		super::gguf::{
			Q8_BLOCK,
			tests::{Writer, f16_bits},
		},
		*,
	};

	/// A tiny llama shape for decoder tests.
	pub fn tiny_config(vocab: usize) -> LlamaConfig {
		LlamaConfig {
			// head_dim 32: the smallest Metal's fused attention supports.
			hidden_size:             128,
			intermediate_size:       96,
			num_hidden_layers:       2,
			num_attention_heads:     4,
			num_key_value_heads:     2,
			vocab_size:              vocab,
			rms_norm_eps:            1e-5,
			rope_theta:              10_000.0,
			max_position_embeddings: 64,
			bos_token_id:            Some(0),
			tie_word_embeddings:     true,
			model_type:              "llama".into(),
			rope_scaling:            None,
			rope_interleaved:        false,
			attention_bias:          false,
			mlp_bias:                false,
		}
	}

	/// xorshift64* stream seeded per tensor name, so write order does not
	/// matter.
	struct Rng(u64);

	impl Rng {
		fn new(seed: u64, name: &str) -> Self {
			Self(
				name.bytes().fold(seed ^ 0xcbf2_9ce4_8422_2325, |h, b| {
					(h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
				}) | 1,
			)
		}

		/// Uniform in `[-0.5, 0.5)`.
		fn next(&mut self) -> f32 {
			let mut s = self.0;
			s ^= s >> 12;
			s ^= s << 25;
			s ^= s >> 27;
			self.0 = s;
			(s.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 40) as f32 / (1u64 << 24) as f32 - 0.5
		}
	}

	/// llama.cpp's `LlamaModel.permute` on whole rows:
	/// `w.reshape(heads, 2, head_dim / 2, cols).swapaxes(1, 2)`.
	fn llama_cpp_permute(rows: &[u8], row_bytes: usize, head_dim: usize) -> Vec<u8> {
		let half = head_dim / 2;
		let heads = rows.len() / row_bytes / head_dim;
		let row = |h: usize, j: usize, i: usize| {
			let at = ((h * 2 + j) * half + i) * row_bytes;
			&rows[at..at + row_bytes]
		};
		let mut out = Vec::with_capacity(rows.len());
		for h in 0..heads {
			for i in 0..half {
				for j in 0..2 {
					out.extend_from_slice(row(h, j, i));
				}
			}
		}
		out
	}

	fn load(writer: Writer, config: &LlamaConfig) -> anyhow::Result<LlamaWeights<Cursor<Vec<u8>>>> {
		LlamaWeights::new(Gguf::new(Cursor::new(writer.finish()))?, config.clone())
	}

	/// Reproducible pseudo-random weights for `config`, as llama.cpp would
	/// export them: a GGUF with q/k rows permuted, 64-byte alignment, and
	/// metadata the reader skips.
	pub fn random_weights(config: &LlamaConfig, seed: u64) -> LlamaWeights<Cursor<Vec<u8>>> {
		let c = config;
		let (h, inter, head_dim) = (c.hidden_size, c.intermediate_size, c.head_dim());
		let kv = c.num_key_value_heads * head_dim;
		let mut writer = Writer::new(Some(64));
		writer.string("general.architecture", "llama");
		writer.noise();
		// Norm gains near 1; matrices scaled by fan-in like a real init, so
		// activations stay O(1) through the layers.
		let mut norm = |name: &str| {
			let mut rng = Rng::new(seed, name);
			let gains: Vec<f32> = (0..h).map(|_| rng.next().abs() + 0.75).collect();
			writer.f32(name, &gains);
		};
		norm("output_norm.weight");
		for layer in 0..c.num_hidden_layers {
			norm(&format!("blk.{layer}.attn_norm.weight"));
			norm(&format!("blk.{layer}.ffn_norm.weight"));
		}
		let mut matrix = |name: &str, rows: usize, cols: usize| {
			let mut rng = Rng::new(seed, name);
			let step = 1.0 / (cols as f32).sqrt() / 127.0;
			let mut bytes = Vec::with_capacity(rows * Q8Blocks::row_bytes(cols));
			for _ in 0..rows * cols / Q8_BLOCK {
				bytes.extend(f16_bits(step * (0.5 + rng.next().abs())).to_le_bytes());
				bytes
					.extend((0..Q8_BLOCK).map(|_| ((rng.next() * 254.0).round() as i8).cast_unsigned()));
			}
			if name.ends_with("attn_q.weight") || name.ends_with("attn_k.weight") {
				bytes = llama_cpp_permute(&bytes, Q8Blocks::row_bytes(cols), head_dim);
			}
			writer.q8_0(name, rows, cols, bytes);
		};
		matrix("token_embd.weight", c.vocab_size, h);
		for layer in 0..c.num_hidden_layers {
			let p = format!("blk.{layer}");
			matrix(&format!("{p}.attn_q.weight"), h, h);
			matrix(&format!("{p}.attn_k.weight"), kv, h);
			matrix(&format!("{p}.attn_v.weight"), kv, h);
			matrix(&format!("{p}.attn_output.weight"), h, h);
			matrix(&format!("{p}.ffn_gate.weight"), inter, h);
			matrix(&format!("{p}.ffn_up.weight"), inter, h);
			matrix(&format!("{p}.ffn_down.weight"), h, inter);
		}
		load(writer, config).expect("random weights")
	}

	#[test]
	fn q_and_k_rows_come_back_in_checkpoint_order() {
		let config = tiny_config(8);
		let (h, head_dim) = (config.hidden_size, config.head_dim());
		let kv = config.num_key_value_heads * head_dim;
		let row_bytes = Q8Blocks::row_bytes(h);
		// Checkpoint rows tagged with their matrix and index.
		let tagged = |tag: u8, rows: usize| -> Vec<u8> {
			(0..rows)
				.flat_map(|r| {
					let mut row = vec![0u8; row_bytes];
					row[..2].copy_from_slice(&f16_bits(1.0).to_le_bytes());
					row[2..4].copy_from_slice(&[tag, r as u8]);
					row
				})
				.collect()
		};
		let (q, k, v) = (tagged(1, h), tagged(2, kv), tagged(3, kv));
		let mut writer = Writer::new(None);
		writer.string("general.architecture", "llama");
		writer.q8_0("blk.0.attn_q.weight", h, h, llama_cpp_permute(&q, row_bytes, head_dim));
		writer.q8_0("blk.0.attn_k.weight", kv, h, llama_cpp_permute(&k, row_bytes, head_dim));
		writer.q8_0("blk.0.attn_v.weight", kv, h, v.clone());
		let mut weights = load(writer, &config).expect("weights");
		let qkv = weights
			.stacked(0, &[Proj::Q, Proj::K, Proj::V])
			.expect("qkv");
		assert_eq!(qkv.rows, h + 2 * kv);
		assert!(qkv.bytes == [q, k, v].concat(), "rows out of checkpoint order");
	}

	fn error<T>(result: anyhow::Result<T>) -> String {
		format!("{:#}", result.err().expect("an error"))
	}

	#[test]
	fn tensors_of_the_wrong_type_or_shape_are_rejected() {
		let config = tiny_config(8);
		let h = config.hidden_size;
		let mut writer = Writer::new(None);
		writer.string("general.architecture", "llama");
		writer.q8_0("output_norm.weight", 1, h, vec![0; Q8Blocks::row_bytes(h)]);
		writer.f32("blk.0.attn_norm.weight", &vec![1.0; h]);
		writer.f32("blk.0.ffn_norm.weight", &vec![1.0; h]);
		writer.f32("blk.0.attn_output.weight", &vec![0.0; h * h]);
		writer.q8_0("blk.0.ffn_down.weight", h, h, vec![0; h * Q8Blocks::row_bytes(h)]);
		let mut weights = load(writer, &config).expect("weights");
		assert!(error(weights.output_norm()).contains("Q8_0, expected F32"));
		assert_eq!(weights.norms(0).expect("norms").0.len(), h);
		assert!(error(weights.stacked(0, &[Proj::Out])).contains("F32, expected Q8_0"));
		assert!(error(weights.stacked(0, &[Proj::Down])).contains("shape"));
		assert!(error(weights.stacked(0, &[Proj::Q])).contains("missing"));
		assert!(error(load(Writer::new(None), &config)).contains("architecture"));
	}
}
