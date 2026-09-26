//! Llama hyper-parameters, the weights file reader, and the decoder contract
//! shared by the CPU and Metal backends.

use std::{
	collections::HashMap,
	fs::File,
	io::{Read, Seek, SeekFrom},
	path::Path,
};

use anyhow::{Context, bail, ensure};
use serde::Deserialize;

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

	/// `RoPE` `(cos, sin)` tables, row-major `[max_position_embeddings, head_dim /
	/// 2]`.
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

/// Source of named f32 tensors (`name` → `(shape, values)`).
pub trait TensorSource {
	/// Load `name` as f32.
	///
	/// # Errors
	/// Fails for missing tensors, unsupported dtypes, and I/O errors.
	fn tensor(&mut self, name: &str) -> anyhow::Result<(Vec<usize>, Vec<f32>)>;

	/// Load `name` and check its shape.
	///
	/// # Errors
	/// As [`TensorSource::tensor`], plus shape mismatches.
	fn expect(&mut self, name: &str, shape: &[usize]) -> anyhow::Result<Vec<f32>> {
		let (actual, values) = self.tensor(name)?;
		ensure!(actual == shape, "tensor {name}: shape {actual:?}, expected {shape:?}");
		Ok(values)
	}
}

#[derive(Deserialize)]
struct Entry {
	dtype:        String,
	shape:        Vec<usize>,
	data_offsets: (u64, u64),
}

/// Reader for a `.safetensors` file that pulls one tensor at a time, so
/// loading never holds more than one tensor's bytes.
pub struct SafeTensors {
	file:       File,
	data_start: u64,
	entries:    HashMap<String, Entry>,
}

impl SafeTensors {
	/// Parse the header of `path`.
	///
	/// # Errors
	/// Fails for unreadable or malformed files.
	pub fn open(path: &Path) -> anyhow::Result<Self> {
		let mut file = File::open(path).with_context(|| format!("open {}", path.display()))?;
		let mut len = [0u8; 8];
		file
			.read_exact(&mut len)
			.context("safetensors header length")?;
		let len = u64::from_le_bytes(len);
		ensure!(len < 100 << 20, "safetensors header is implausibly large");
		let mut header = vec![0u8; len as usize];
		file.read_exact(&mut header).context("safetensors header")?;
		let mut raw: HashMap<String, serde_json::Value> =
			serde_json::from_slice(&header).context("parse safetensors header")?;
		raw.remove("__metadata__");
		let entries = raw
			.into_iter()
			.map(|(name, value)| Ok((name, serde_json::from_value(value)?)))
			.collect::<anyhow::Result<_>>()?;
		Ok(Self { file, data_start: 8 + len, entries })
	}
}

impl TensorSource for SafeTensors {
	fn tensor(&mut self, name: &str) -> anyhow::Result<(Vec<usize>, Vec<f32>)> {
		let entry = self
			.entries
			.get(name)
			.with_context(|| format!("tensor {name} missing from weights"))?;
		let (start, end) = entry.data_offsets;
		let elements: usize = entry.shape.iter().product();
		let width = match entry.dtype.as_str() {
			"BF16" => 2,
			"F32" => 4,
			other => bail!("tensor {name}: unsupported dtype {other}"),
		};
		ensure!(
			end - start == (elements * width) as u64,
			"tensor {name}: size does not match its shape"
		);
		let mut bytes = vec![0u8; elements * width];
		self.file.seek(SeekFrom::Start(self.data_start + start))?;
		self
			.file
			.read_exact(&mut bytes)
			.with_context(|| format!("read tensor {name}"))?;
		let values = if width == 2 {
			// bf16 is the upper half of an f32.
			bytes
				.as_chunks::<2>().0.iter()
				.map(|b| f32::from_bits(u32::from(u16::from_le_bytes([b[0], b[1]])) << 16))
				.collect()
		} else {
			bytes
				.as_chunks::<4>().0.iter()
				.map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
				.collect()
		};
		Ok((entry.shape.clone(), values))
	}
}

#[cfg(test)]
pub(super) mod tests {
	use super::*;

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

	/// Reproducible pseudo-random weights for [`tiny_config`] (xorshift64*
	/// seeded per tensor name, so load order does not matter).
	pub struct RandomWeights {
		config: LlamaConfig,
		seed:   u64,
		state:  u64,
	}

	impl RandomWeights {
		pub fn new(config: &LlamaConfig, seed: u64) -> Self {
			Self { config: config.clone(), seed, state: 1 }
		}

		fn next(&mut self) -> f32 {
			let mut s = self.state;
			s ^= s >> 12;
			s ^= s << 25;
			s ^= s >> 27;
			self.state = s;
			(s.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 40) as f32 / (1u64 << 24) as f32 - 0.5
		}
	}

	impl TensorSource for RandomWeights {
		fn tensor(&mut self, name: &str) -> anyhow::Result<(Vec<usize>, Vec<f32>)> {
			self.state = name
				.bytes()
				.fold(self.seed ^ 0xcbf2_9ce4_8422_2325, |h, b| {
					(h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
				}) | 1;
			let c = &self.config;
			let (h, i, kv) =
				(c.hidden_size, c.intermediate_size, c.num_key_value_heads * c.head_dim());
			let shape = match name.rsplit('.').nth(1).unwrap_or_default() {
				"embed_tokens" => vec![c.vocab_size, h],
				"q_proj" | "o_proj" => vec![h, h],
				"k_proj" | "v_proj" => vec![kv, h],
				"gate_proj" | "up_proj" => vec![i, h],
				"down_proj" => vec![h, i],
				_ => vec![h],
			};
			// Norm gains near 1; matrices scaled by fan-in like a real init, so
			// activations stay O(1) through the layers.
			let norm = shape.len() == 1;
			let gain = 2.0 / (*shape.last().unwrap_or(&1) as f32).sqrt();
			let values = (0..shape.iter().product())
				.map(|_| {
					if norm {
						self.next().abs() + 0.75
					} else {
						self.next() * gain
					}
				})
				.collect();
			Ok((shape, values))
		}
	}
}
