//! Metal decoder (macOS) on candle: GGML `Q8_0` weights, f32 activations.
//!
//! Batch-1 GPU decoding is bound by kernel dispatch, and candle's quantized
//! mat-vec kernels beat its dense f16 GEMM path by ~2.5× there (1.8 vs
//! 4.7 ms per token for SmolLM2-135M on an M4 Max), at near-f32 accuracy.

use anyhow::ensure;
use candle_core::{
	D, DType, Device, Module, Tensor,
	quantized::{GgmlDType, QMatMul, QTensor},
};
use candle_nn::ops::rms_norm;

use super::config::{Decoder, KvRow, LlamaConfig, TensorSource};

/// Rows at or below this count go through the quantized mat-vec kernel once
/// per row; candle's quantized mat-mat kernel only pays off for real batches
/// (2 rows cost 2.8× one row through it; 8 rows are faster as a batch).
const MAT_VEC_ROWS: usize = 4;

/// `x · wᵀ` for `x: [n, k]`.
fn project(w: &QMatMul, x: &Tensor) -> candle_core::Result<Tensor> {
	let (n, k) = x.dims2()?;
	if n == 1 || n > MAT_VEC_ROWS {
		return w.forward(x);
	}
	let out = w.forward(&x.reshape((n, 1, k))?)?;
	let width = out.dim(2)?;
	out.reshape((n, width))
}

struct Layer {
	attn_norm: Tensor,
	/// `[q; k; v]` fused into one `[hidden + 2·kv, hidden]` matrix.
	qkv:       QMatMul,
	out:       QMatMul,
	mlp_norm:  Tensor,
	/// `[gate; up]` fused into one `[2·inter, hidden]` matrix.
	gate_up:   QMatMul,
	down:      QMatMul,
}

/// Per layer `[1, kv_heads, capacity, head_dim]`.
struct KvCache {
	keys:     Vec<Tensor>,
	values:   Vec<Tensor>,
	capacity: usize,
}

/// Initial KV capacity in tokens; doubles on demand.
const INITIAL_CAPACITY: usize = 1024;

/// `SmolLM2` on a candle device (Metal in production).
pub struct MetalLlama {
	config: LlamaConfig,
	device: Device,
	/// Token embedding for lookups.
	embed:  Tensor,
	/// Tied LM head (the embedding as a projection).
	head:   QMatMul,
	layers: Vec<Layer>,
	norm:   Tensor,
	cos:    Tensor,
	sin:    Tensor,
	cache:  KvCache,
	len:    usize,
	/// Keys then values per layer appended by the last forward,
	/// `[1, kv_heads, n, head_dim]` each (fresh tensors, never written again).
	fresh:  Vec<Tensor>,
}

impl MetalLlama {
	/// Upload and quantize the weights from `source` onto `device`.
	///
	/// # Errors
	/// Fails for missing or mis-shaped tensors and device errors.
	pub fn load(
		config: LlamaConfig,
		source: &mut impl TensorSource,
		device: &Device,
	) -> anyhow::Result<Self> {
		config.validate()?;
		ensure!(device.is_metal(), "the Metal decoder needs a Metal device");
		let c = &config;
		let (h, inter) = (c.hidden_size, c.intermediate_size);
		let kv = c.num_key_value_heads * c.head_dim();
		let dense = |values: Vec<f32>, shape: &[usize]| -> anyhow::Result<Tensor> {
			Ok(Tensor::from_vec(values, shape, device)?)
		};
		let project = |values: Vec<f32>, rows: usize, cols: usize| -> anyhow::Result<QMatMul> {
			Ok(QMatMul::from_qtensor(QTensor::quantize(
				&dense(values, &[rows, cols])?,
				GgmlDType::Q8_0,
			)?)?)
		};
		let embed = source.expect("model.embed_tokens.weight", &[c.vocab_size, h])?;
		let lookup = Tensor::from_slice(&embed, (c.vocab_size, h), device)?.to_dtype(DType::F16)?;
		let head = project(embed, c.vocab_size, h)?;
		let mut layers = Vec::with_capacity(c.num_hidden_layers);
		for i in 0..c.num_hidden_layers {
			let p = format!("model.layers.{i}");
			let mut w =
				|name: &str, shape: &[usize]| source.expect(&format!("{p}.{name}.weight"), shape);
			let mut qkv = w("self_attn.q_proj", &[h, h])?;
			qkv.extend(w("self_attn.k_proj", &[kv, h])?);
			qkv.extend(w("self_attn.v_proj", &[kv, h])?);
			let mut gate_up = w("mlp.gate_proj", &[inter, h])?;
			gate_up.extend(w("mlp.up_proj", &[inter, h])?);
			layers.push(Layer {
				attn_norm: dense(w("input_layernorm", &[h])?, &[h])?,
				qkv:       project(qkv, h + 2 * kv, h)?,
				out:       project(w("self_attn.o_proj", &[h, h])?, h, h)?,
				mlp_norm:  dense(w("post_attention_layernorm", &[h])?, &[h])?,
				gate_up:   project(gate_up, 2 * inter, h)?,
				down:      project(w("mlp.down_proj", &[h, inter])?, h, inter)?,
			});
		}
		let norm = dense(source.expect("model.norm.weight", &[h])?, &[h])?;
		let (cos, sin) = c.rope_tables();
		let half = c.head_dim() / 2;
		let positions = c.max_position_embeddings;
		let cos = dense(cos, &[positions, half])?;
		let sin = dense(sin, &[positions, half])?;
		let cache = KvCache::new(c, device, INITIAL_CAPACITY)?;
		Ok(Self {
			embed: lookup,
			head,
			layers,
			norm,
			cos,
			sin,
			cache,
			len: 0,
			config,
			device: device.clone(),
			fresh: Vec::new(),
		})
	}

	#[allow(clippy::many_single_char_names, reason = "q/k/v/n/c follow the transformer notation")]
	fn forward_inner(&mut self, tokens: &[u32], keep_from: usize) -> anyhow::Result<Vec<f32>> {
		let c = &self.config;
		let (pos, n) = (self.len, tokens.len());
		ensure!(
			pos + n <= c.max_position_embeddings,
			"sequence exceeds {} positions",
			c.max_position_embeddings
		);
		if pos + n > self.cache.capacity {
			self.cache.grow(pos + n, pos)?;
		}
		let (heads, kv_heads, head_dim) =
			(c.num_attention_heads, c.num_key_value_heads, c.head_dim());
		let total = pos + n;
		let scale = 1.0 / (head_dim as f64).sqrt();
		let cos = self.cos.narrow(0, pos, n)?;
		let sin = self.sin.narrow(0, pos, n)?;
		// Longer batches use the fused full-attention kernel, which needs an
		// explicit causal mask over [cached | new] (broadcast over heads).
		let mask = if n > 8 {
			let mut rows = Vec::with_capacity(n * total);
			for i in 0..n {
				rows.extend((0..total).map(|j| {
					if j <= pos + i {
						0.0f32
					} else {
						f32::NEG_INFINITY
					}
				}));
			}
			Some(
				Tensor::from_vec(rows, (1, 1, n, total), &self.device)?
					.broadcast_as((1, heads, n, total))?,
			)
		} else {
			None
		};

		let ids = Tensor::new(tokens, &self.device)?;
		let mut x = self.embed.index_select(&ids, 0)?.to_dtype(DType::F32)?;
		let eps = c.rms_norm_eps as f32;
		let hidden = c.hidden_size;
		let kv_width = kv_heads * head_dim;
		let mut fresh = Vec::with_capacity(2 * self.layers.len());
		for (index, layer) in self.layers.iter().enumerate() {
			let h = rms_norm(&x, &layer.attn_norm, eps)?;
			let qkv = project(&layer.qkv, &h)?;
			// `[1, n, heads, head_dim]` views of the fused projection.
			let split = |start: usize, width: usize, count: usize| -> candle_core::Result<Tensor> {
				qkv.narrow(1, start, width)?
					.reshape((1, n, count, head_dim))
			};
			let q =
				candle_nn::rotary_emb::rope_thd(&split(0, hidden, heads)?.contiguous()?, &cos, &sin)?;
			let k = candle_nn::rotary_emb::rope_thd(
				&split(hidden, kv_width, kv_heads)?.contiguous()?,
				&cos,
				&sin,
			)?;
			let v = split(hidden + kv_width, kv_width, kv_heads)?;
			let (key_cache, value_cache) = (&self.cache.keys[index], &self.cache.values[index]);
			let (k, v) = (k.transpose(1, 2)?.contiguous()?, v.transpose(1, 2)?.contiguous()?);
			key_cache.slice_set(&k, 2, pos)?;
			value_cache.slice_set(&v, 2, pos)?;
			fresh.push(k);
			fresh.push(v);

			let attended = if let Some(mask) = &mask {
				let keys = key_cache.narrow(2, 0, total)?;
				let values = value_cache.narrow(2, 0, total)?;
				let q = q.transpose(1, 2)?.contiguous()?;
				candle_nn::ops::sdpa(&q, &keys, &values, Some(mask), false, scale as f32, 1.0)?
					.transpose(1, 2)?
					.reshape((n, hidden))?
			} else {
				// Up to 8 queries: one fused vector-attention call each, over
				// the keys it may see (the vector kernel takes no mask). Each
				// query gets its own buffer: candle 0.9 passes the kernel an
				// element offset where Metal expects bytes.
				let mut rows = Vec::with_capacity(n);
				for l in 0..n {
					let visible = pos + l + 1;
					let q = q.narrow(1, l, 1)?.reshape((1, heads, 1, head_dim))?;
					let q = if l == 0 { q } else { q.affine(1.0, 0.0)? };
					let keys = key_cache.narrow(2, 0, visible)?;
					let values = value_cache.narrow(2, 0, visible)?;
					rows.push(
						candle_nn::ops::sdpa(&q, &keys, &values, None, false, scale as f32, 1.0)?
							.reshape((1, hidden))?,
					);
				}
				if n == 1 {
					rows.swap_remove(0)
				} else {
					Tensor::cat(&rows, 0)?
				}
			};
			x = (x + project(&layer.out, &attended)?)?;

			let h = rms_norm(&x, &layer.mlp_norm, eps)?;
			let gate_up = project(&layer.gate_up, &h)?;
			let inter = c.intermediate_size;
			let act = (candle_nn::ops::silu(&gate_up.narrow(1, 0, inter)?)?
				* gate_up.narrow(1, inter, inter)?)?;
			x = (x + project(&layer.down, &act.contiguous()?)?)?;
		}
		self.len = total;
		self.fresh = fresh;

		let x = x.narrow(0, keep_from, n - keep_from)?;
		let logits = project(&self.head, &rms_norm(&x.contiguous()?, &self.norm, eps)?)?;
		let max = logits.max_keepdim(D::Minus1)?;
		let shifted = logits.broadcast_sub(&max)?;
		let log_z = shifted.exp()?.sum_keepdim(D::Minus1)?.log()?;
		Ok(shifted
			.broadcast_sub(&log_z)?
			.flatten_all()?
			.to_vec1::<f32>()?)
	}
}

impl Decoder for MetalLlama {
	fn vocab_size(&self) -> usize {
		self.config.vocab_size
	}

	fn truncate(&mut self, len: usize) {
		self.len = self.len.min(len);
		// Rows of the last forward beyond the cut are no longer the last
		// position.
		self.fresh.clear();
	}

	fn last_kv(&self) -> anyhow::Result<KvRow> {
		ensure!(!self.fresh.is_empty(), "no forward since the last cut");
		// The fresh tensors are the newest positions; take the last one.
		let rows = self
			.fresh
			.iter()
			.map(|t| {
				let n = t.dim(2)?;
				if n == 1 {
					Ok(t.clone())
				} else {
					t.narrow(2, n - 1, 1)?.contiguous()
				}
			})
			.collect::<candle_core::Result<_>>()?;
		Ok(KvRow::Device(rows))
	}

	fn restore(&mut self, at: usize, row: &KvRow) -> anyhow::Result<()> {
		let KvRow::Device(rows) = row else {
			anyhow::bail!("KV row from another backend")
		};
		ensure!(at <= self.len, "restore past the cached length");
		ensure!(rows.len() == 2 * self.layers.len(), "KV row of another model");
		if at + 1 > self.cache.capacity {
			self.cache.grow(at + 1, at)?;
		}
		for ((keys, values), pair) in self
			.cache
			.keys
			.iter()
			.zip(&self.cache.values)
			.zip(rows.as_chunks::<2>().0)
		{
			keys.slice_set(&pair[0], 2, at)?;
			values.slice_set(&pair[1], 2, at)?;
		}
		self.len = at + 1;
		self.fresh.clone_from(rows);
		Ok(())
	}

	fn forward(&mut self, tokens: &[u32], keep_from: usize) -> anyhow::Result<Vec<f32>> {
		ensure!(keep_from < tokens.len(), "nothing to score");
		let result = self.forward_inner(tokens, keep_from);
		if result.is_err() {
			self.len = 0;
			self.fresh.clear();
		}
		result
	}
}

impl KvCache {
	fn new(config: &LlamaConfig, device: &Device, capacity: usize) -> anyhow::Result<Self> {
		let shape = (1, config.num_key_value_heads, capacity, config.head_dim());
		let mut keys = Vec::with_capacity(config.num_hidden_layers);
		let mut values = Vec::with_capacity(config.num_hidden_layers);
		for _ in 0..config.num_hidden_layers {
			keys.push(Tensor::zeros(shape, DType::F32, device)?);
			values.push(Tensor::zeros(shape, DType::F32, device)?);
		}
		Ok(Self { keys, values, capacity })
	}

	/// Reallocate to hold at least `needed` tokens, keeping the first `keep`.
	fn grow(&mut self, needed: usize, keep: usize) -> anyhow::Result<()> {
		let capacity = needed.next_power_of_two();
		for tensor in self.keys.iter_mut().chain(self.values.iter_mut()) {
			let (b, h, _, d) = tensor.dims4()?;
			let grown = Tensor::zeros((b, h, capacity, d), tensor.dtype(), tensor.device())?;
			if keep > 0 {
				grown.slice_set(&tensor.narrow(2, 0, keep)?.contiguous()?, 2, 0)?;
			}
			*tensor = grown;
		}
		self.capacity = capacity;
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::{
		super::{
			config::tests::{RandomWeights, tiny_config},
			cpu::tests::random,
		},
		*,
	};

	#[test]
	fn metal_session_rows_match_fresh_scoring() {
		let Ok(device) = Device::new_metal(0) else {
			return;
		};
		let config = tiny_config(12);
		let load = || -> Box<dyn Decoder> {
			let mut model =
				MetalLlama::load(config.clone(), &mut RandomWeights::new(&config, 3), &device)
					.expect("load");
			model.cache = KvCache::new(&config, &device, 2).expect("cache");
			Box::new(model)
		};
		super::super::session::tests::rows_match_fresh_scoring(load(), load(), 1e-3);
	}

	#[test]
	fn metal_matches_the_cpu_decoder_through_cache_growth_and_trims() {
		let Ok(device) = Device::new_metal(0) else {
			return;
		};
		let vocab = 40;
		let config = tiny_config(vocab);
		let mut metal =
			MetalLlama::load(config.clone(), &mut RandomWeights::new(&config, 5), &device)
				.expect("load");
		// Small capacity so the test also covers growth.
		metal.cache = KvCache::new(&config, &device, 2).expect("cache");
		let mut cpu = random(vocab, 5);
		// 12 tokens take the masked full-attention kernel, shorter ones the
		// per-query vector kernel.
		let tokens = [1u32, 7, 3, 9, 4, 4, 2, 30, 8, 8, 19, 21];
		// The backends quantize differently (and Metal looks embeddings up in
		// f16), which leaves ~0.01 of noise; layout bugs (RoPE halves,
		// KV-head mapping, masks) cost far more.
		let close = |a: &[f32], b: &[f32]| {
			a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 0.05)
		};
		assert!(close(
			&metal.forward(&tokens, 0).expect("metal"),
			&cpu.forward(&tokens, 0).expect("cpu")
		));
		metal.truncate(3);
		cpu.truncate(3);
		assert!(close(
			&metal.forward(&[11], 0).expect("metal"),
			&cpu.forward(&[11], 0).expect("cpu")
		));
		assert!(close(
			&metal.forward(&[12, 13], 0).expect("metal"),
			&cpu.forward(&[12, 13], 0).expect("cpu")
		));
	}
}
