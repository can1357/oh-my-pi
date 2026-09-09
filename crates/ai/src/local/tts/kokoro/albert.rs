//! ALBERT (A Lite BERT) implementation for the PL-BERT encoder.
//!
//! ALBERT uses cross-layer parameter sharing and factorized embedding
//! parameterization. For Kokoro's PL-BERT, the embedding size equals
//! the hidden size (768), so no factorization projection is needed.

use candle_core::{DType, Module, Result, Tensor};
use candle_nn::{self as nn, VarBuilder};

use super::config::PlbertConfig;

// ---------------------------------------------------------------------------
// ALBERT Embeddings
// ---------------------------------------------------------------------------

/// Builds normalized token, position, and token-type embeddings for PL-BERT.
pub struct AlbertEmbeddings {
	word_embeddings:       nn::Embedding,
	position_embeddings:   nn::Embedding,
	token_type_embeddings: nn::Embedding,
	layer_norm_weight:     Tensor,
	layer_norm_bias:       Tensor,
	layer_norm_eps:        f32,
}

impl AlbertEmbeddings {
	/// Loads embedding weights from the PL-BERT checkpoint.
	pub fn load(config: &PlbertConfig, vocab_size: usize, vb: VarBuilder) -> Result<Self> {
		let emb_size = config.embedding_size;
		let word_embeddings = nn::embedding(vocab_size, emb_size, vb.pp("word_embeddings"))?;
		let position_embeddings =
			nn::embedding(config.max_position_embeddings, emb_size, vb.pp("position_embeddings"))?;
		let token_type_embeddings = nn::embedding(2, emb_size, vb.pp("token_type_embeddings"))?;

		let ln_vb = vb.pp("LayerNorm");
		let layer_norm_weight = ln_vb.get(emb_size, "weight")?;
		let layer_norm_bias = ln_vb.get(emb_size, "bias")?;

		Ok(Self {
			word_embeddings,
			position_embeddings,
			token_type_embeddings,
			layer_norm_weight,
			layer_norm_bias,
			layer_norm_eps: 1e-12,
		})
	}

	/// Combines token, position, and token-type embeddings for the input tokens.
	pub fn forward(&self, input_ids: &Tensor) -> Result<Tensor> {
		let (_b, seq_len) = input_ids.dims2()?;

		let word_emb = self.word_embeddings.forward(input_ids)?;

		// Position ids: [0, 1, 2, ..., seq_len-1]
		let position_ids = Tensor::arange(0u32, seq_len as u32, input_ids.device())?.unsqueeze(0)?;
		let pos_emb = self.position_embeddings.forward(&position_ids)?;

		// Token type ids: all zeros
		let token_type_ids = Tensor::zeros(input_ids.shape(), DType::U32, input_ids.device())?;
		let tt_emb = self.token_type_embeddings.forward(&token_type_ids)?;

		let embeddings = (word_emb + pos_emb)?.broadcast_add(&tt_emb)?;
		nn::ops::layer_norm(
			&embeddings,
			&self.layer_norm_weight,
			&self.layer_norm_bias,
			self.layer_norm_eps,
		)
	}
}

// ---------------------------------------------------------------------------
// ALBERT Attention
// ---------------------------------------------------------------------------

struct AlbertAttention {
	query:     nn::Linear,
	key:       nn::Linear,
	value:     nn::Linear,
	dense:     nn::Linear,
	ln_weight: Tensor,
	ln_bias:   Tensor,
	num_heads: usize,
	head_dim:  usize,
}

impl AlbertAttention {
	fn load(config: &PlbertConfig, vb: VarBuilder) -> Result<Self> {
		let h = config.hidden_size;
		let num_heads = config.num_attention_heads;
		let head_dim = h / num_heads;

		let query = nn::linear(h, h, vb.pp("query"))?;
		let key = nn::linear(h, h, vb.pp("key"))?;
		let value = nn::linear(h, h, vb.pp("value"))?;
		let dense = nn::linear(h, h, vb.pp("dense"))?;

		let ln_vb = vb.pp("LayerNorm");
		let ln_weight = ln_vb.get(h, "weight")?;
		let ln_bias = ln_vb.get(h, "bias")?;

		Ok(Self { query, key, value, dense, ln_weight, ln_bias, num_heads, head_dim })
	}

	fn forward(&self, hidden_states: &Tensor, attention_mask: &Tensor) -> Result<Tensor> {
		let (batch_size, sequence_length, _hidden_size) = hidden_states.dims3()?;
		let residual = hidden_states.clone();

		// Project Q, K, V and reshape to [B, heads, T, head_dim]
		let query_states = self
			.query
			.forward(hidden_states)?
			.reshape((batch_size, sequence_length, self.num_heads, self.head_dim))?
			.transpose(1, 2)?
			.contiguous()?;
		let key_states = self
			.key
			.forward(hidden_states)?
			.reshape((batch_size, sequence_length, self.num_heads, self.head_dim))?
			.transpose(1, 2)?
			.contiguous()?;
		let value_states = self
			.value
			.forward(hidden_states)?
			.reshape((batch_size, sequence_length, self.num_heads, self.head_dim))?
			.transpose(1, 2)?
			.contiguous()?;

		// Attention scores: [B, heads, T, T]
		let scale = (self.head_dim as f32).sqrt();
		let scores = (query_states.matmul(&key_states.transpose(2, 3)?)? * (1.0f64 / scale as f64))?;

		// Apply attention mask: mask is [B, 1, 1, T], 0 for attend, large neg for
		// masked
		let scores = scores.broadcast_add(attention_mask)?;

		// Softmax
		let attn_weights = candle_nn::ops::softmax_last_dim(&scores)?;

		// Apply attention to values
		let context = attn_weights
			.matmul(&value_states)?
			.transpose(1, 2)?
			.reshape((batch_size, sequence_length, self.num_heads * self.head_dim))?;

		// Output projection + residual + layer norm
		let output = self.dense.forward(&context)?;
		let output = (output + residual)?;
		nn::ops::layer_norm(&output, &self.ln_weight, &self.ln_bias, 1e-12)
	}
}

// ---------------------------------------------------------------------------
// ALBERT FFN
// ---------------------------------------------------------------------------

struct AlbertFFN {
	intermediate: nn::Linear,
	output:       nn::Linear,
	ln_weight:    Tensor,
	ln_bias:      Tensor,
}

impl AlbertFFN {
	/// Load from the `albert_layer` `VarBuilder` (not prefixed with "ffn").
	/// Weight keys: ffn.weight, ffn.bias, `ffn_output.weight`,
	/// `ffn_output.bias`,              `full_layer_layer_norm.weight`,
	/// `full_layer_layer_norm.bias`
	fn load(config: &PlbertConfig, vb: VarBuilder) -> Result<Self> {
		let h = config.hidden_size;
		let i = config.intermediate_size;
		let intermediate = nn::linear(h, i, vb.pp("ffn"))?;
		let output = nn::linear(i, h, vb.pp("ffn_output"))?;
		let ln_vb = vb.pp("full_layer_layer_norm");
		let ln_weight = ln_vb.get(h, "weight")?;
		let ln_bias = ln_vb.get(h, "bias")?;
		Ok(Self { intermediate, output, ln_weight, ln_bias })
	}

	fn forward(&self, hidden_states: &Tensor) -> Result<Tensor> {
		let residual = hidden_states.clone();
		let h = self.intermediate.forward(hidden_states)?;
		let h = h.gelu_erf()?;
		let h = self.output.forward(&h)?;
		let h = (h + residual)?;
		nn::ops::layer_norm(&h, &self.ln_weight, &self.ln_bias, 1e-12)
	}
}

// ---------------------------------------------------------------------------
// ALBERT Layer (shared across all "virtual" layers)
// ---------------------------------------------------------------------------

struct AlbertLayer {
	attention: AlbertAttention,
	ffn:       AlbertFFN,
}

impl AlbertLayer {
	fn load(config: &PlbertConfig, vb: VarBuilder) -> Result<Self> {
		let attention = AlbertAttention::load(config, vb.pp("attention"))?;
		let ffn = AlbertFFN::load(config, vb.clone())?;
		Ok(Self { attention, ffn })
	}

	fn forward(&self, hidden_states: &Tensor, attention_mask: &Tensor) -> Result<Tensor> {
		let h = self.attention.forward(hidden_states, attention_mask)?;
		self.ffn.forward(&h)
	}
}

// ---------------------------------------------------------------------------
// CustomAlbert — the full ALBERT model (returns last_hidden_state)
// ---------------------------------------------------------------------------

/// Runs the shared ALBERT encoder layers used by Kokoro's PL-BERT frontend.
pub struct CustomAlbert {
	embeddings:           AlbertEmbeddings,
	embedding_projection: nn::Linear,
	shared_layer:         AlbertLayer,
	num_hidden_layers:    usize,
}

impl CustomAlbert {
	/// Loads the PL-BERT encoder weights from a checkpoint.
	pub fn load(config: &PlbertConfig, vocab_size: usize, vb: VarBuilder) -> Result<Self> {
		let embeddings = AlbertEmbeddings::load(config, vocab_size, vb.pp("embeddings"))?;

		// Projection from embedding_size to hidden_size
		let embedding_projection = nn::linear(
			config.embedding_size,
			config.hidden_size,
			vb.pp("encoder").pp("embedding_hidden_mapping_in"),
		)?;

		// ALBERT shares one layer across all hidden layers.
		// Weight path: encoder.albert_layer_groups.0.albert_layers.0.*
		let shared_layer = AlbertLayer::load(
			config,
			vb.pp("encoder")
				.pp("albert_layer_groups")
				.pp("0")
				.pp("albert_layers")
				.pp("0"),
		)?;

		Ok(Self {
			embeddings,
			embedding_projection,
			shared_layer,
			num_hidden_layers: config.num_hidden_layers,
		})
	}

	/// `input_ids`: [B, T] (u32), `attention_mask`: [B, T] (i64, 1=attend,
	/// 0=mask) Returns: [B, T, `hidden_size`]
	pub fn forward(&self, input_ids: &Tensor, attention_mask: &Tensor) -> Result<Tensor> {
		let emb = self.embeddings.forward(input_ids)?;
		// Project from embedding_size to hidden_size
		let hidden_states = self.embedding_projection.forward(&emb)?;

		// Convert attention_mask from [B, T] {0,1} to [B, 1, 1, T] with 0.0 / -10000.0
		let extended_mask = attention_mask
			.to_dtype(hidden_states.dtype())?
			.unsqueeze(1)?
			.unsqueeze(1)?;
		// mask: 1 -> 0.0 (attend), 0 -> -10000.0 (ignore)
		let extended_mask = ((1.0 - extended_mask)? * (-10000.0))?;

		let mut h = hidden_states;
		for _ in 0..self.num_hidden_layers {
			h = self.shared_layer.forward(&h, &extended_mask)?;
		}

		Ok(h)
	}
}
